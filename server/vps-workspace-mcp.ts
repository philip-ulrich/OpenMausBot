// Direct coding tools for the per-bot self-hosted VPS container. Cua Driver
// intentionally owns only the visible desktop surface; this sibling MCP gives
// coding agents an efficient shell and precise file operations without
// exposing the Mac host or making them type commands through terminal pixels.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { posix } from "node:path";
import readline from "node:readline";

import { CONTROL_REFUSAL_PLAIN, createControlClient } from "./control-client.ts";
import { augmentedPath } from "./env-path.ts";
import { isValidSshAlias } from "./config.ts";
import { vpsDockerArgs } from "./vps-computer.ts";

const [sshAlias = "", container = ""] = process.argv.slice(2);
const CONTAINER = /^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/;
const WORKSPACE = "/home/cua/workspace";
const DEFAULT_TIMEOUT_SECONDS = 120;
const MAX_TIMEOUT_SECONDS = 900;
const MAX_COMMAND_LENGTH = 100_000;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

if (!isValidSshAlias(sshAlias) || !CONTAINER.test(container)) {
  process.stderr.write("invalid VPS workspace MCP connection\n");
  process.exit(2);
}

type Json = Record<string, unknown>;

export const WORKSPACE_TOOLS = [
  {
    name: "workspace_exec",
    description:
      "Run a Bash command directly inside this bot's isolated Linux desktop container. Commands start in /home/cua/workspace unless cwd is supplied. Prefer this over typing commands into a visible terminal. Returns exit code, stdout, and stderr.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        command: { type: "string", minLength: 1, maxLength: MAX_COMMAND_LENGTH },
        cwd: { type: "string", description: "Workspace-relative directory, such as project/src. Defaults to the workspace root." },
        timeout_seconds: { type: "integer", minimum: 1, maximum: MAX_TIMEOUT_SECONDS, description: "Default 120; maximum 900." },
      },
      required: ["command"],
    },
  },
  {
    name: "workspace_read_file",
    description:
      "Read a UTF-8 text file from this bot's /home/cua/workspace without using the desktop UI. Paths are workspace-relative.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string", minLength: 1 },
        start_line: { type: "integer", minimum: 1, description: "First line to return; default 1." },
        max_lines: { type: "integer", minimum: 1, maximum: 5000, description: "Maximum lines to return; default 500." },
      },
      required: ["path"],
    },
  },
  {
    name: "workspace_write_file",
    description:
      "Atomically replace a UTF-8 file inside this bot's /home/cua/workspace, creating parent directories. Use workspace_apply_patch for small edits to existing files.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string", minLength: 1 },
        content: { type: "string", maxLength: MAX_FILE_BYTES },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "workspace_apply_patch",
    description:
      "Apply a standard unified Git patch inside a repository in this bot's workspace. The patch is checked before it is applied.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        patch: { type: "string", minLength: 1, maxLength: MAX_FILE_BYTES },
        cwd: { type: "string", description: "Workspace-relative repository directory. Defaults to the workspace root." },
      },
      required: ["patch"],
    },
  },
  {
    name: "workspace_open_in_vscode",
    description:
      "Open a workspace-relative file or directory in the visible VS Code desktop session. Omit path to open /home/cua/workspace.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { path: { type: "string" } },
    },
  },
] as const;

function workspacePath(value: unknown, allowRoot = false): string {
  if (value === undefined || value === "") {
    if (allowRoot) return WORKSPACE;
    throw new Error("path is required");
  }
  if (typeof value !== "string" || value.includes("\0") || value.startsWith("/")) {
    throw new Error("path must be relative to /home/cua/workspace");
  }
  const normalized = posix.normalize(value);
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new Error("path must stay inside /home/cua/workspace");
  }
  return posix.join(WORKSPACE, normalized);
}

function baseExecArgs(extraOptions: string[] = []): string[] {
  return [
    "exec", "-i", "-u", "cua",
    "-e", "HOME=/home/cua",
    "-e", "DISPLAY=:1",
    ...extraOptions,
    container,
  ];
}

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

let active: ChildProcessWithoutNullStreams | null = null;

function runDocker(args: string[], options: { input?: string; timeoutSeconds?: number } = {}): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", vpsDockerArgs(sshAlias, args), {
      shell: false,
      env: { ...process.env, PATH: augmentedPath() },
      stdio: ["pipe", "pipe", "pipe"],
    });
    active = child;
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let truncated = false;
    const collect = (current: Buffer, chunk: Buffer) => {
      const combined = Buffer.concat([current, chunk]);
      if (combined.length <= MAX_OUTPUT_BYTES) return combined;
      truncated = true;
      return combined.subarray(combined.length - MAX_OUTPUT_BYTES);
    };
    child.stdout.on("data", (chunk: Buffer) => (stdout = collect(stdout, chunk)));
    child.stderr.on("data", (chunk: Buffer) => (stderr = collect(stderr, chunk)));
    child.stdin.on("error", () => {});
    child.on("error", reject);
    const timeout = setTimeout(() => child.kill("SIGTERM"), (options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000);
    timeout.unref?.();
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (active === child) active = null;
      resolve({ code, stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8"), truncated });
    });
    child.stdin.end(options.input);
  });
}

function formatResult(result: CommandResult): string {
  const parts = [`exit_code: ${result.code ?? "terminated"}`];
  if (result.truncated) parts.push(`[output truncated to the last ${MAX_OUTPUT_BYTES} bytes]`);
  if (result.stdout) parts.push(`stdout:\n${result.stdout}`);
  if (result.stderr) parts.push(`stderr:\n${result.stderr}`);
  return parts.join("\n");
}

async function callTool(name: string, args: Json): Promise<{ text: string; isError?: boolean }> {
  const control = createControlClient();
  if ((await control.state()).held) return { text: CONTROL_REFUSAL_PLAIN, isError: true };

  if (name === "workspace_exec") {
    if (typeof args.command !== "string" || !args.command.trim() || args.command.length > MAX_COMMAND_LENGTH) {
      return { text: "workspace_exec requires a non-empty command.", isError: true };
    }
    const cwd = workspacePath(args.cwd, true);
    const timeout = args.timeout_seconds === undefined ? DEFAULT_TIMEOUT_SECONDS : Number(args.timeout_seconds);
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT_SECONDS) {
      return { text: `timeout_seconds must be an integer from 1 to ${MAX_TIMEOUT_SECONDS}.`, isError: true };
    }
    // The command rides stdin, never argv: prompts often contain credentials,
    // and local/remote process listings must not expose their values.
    const result = await runDocker([...baseExecArgs(["-w", cwd]), "bash", "-s"], {
      input: args.command,
      timeoutSeconds: timeout,
    });
    return { text: formatResult(result), isError: result.code !== 0 };
  }

  if (name === "workspace_read_file") {
    const path = workspacePath(args.path);
    const start = args.start_line === undefined ? 1 : Number(args.start_line);
    const count = args.max_lines === undefined ? 500 : Number(args.max_lines);
    if (!Number.isInteger(start) || start < 1 || !Number.isInteger(count) || count < 1 || count > 5000) {
      return { text: "start_line must be positive and max_lines must be from 1 to 5000.", isError: true };
    }
    const end = start + count - 1;
    const result = await runDocker([...baseExecArgs(), "sed", "-n", `${start},${end}p`, "--", path]);
    return { text: result.stdout || result.stderr || "(empty file)", isError: result.code !== 0 };
  }

  if (name === "workspace_write_file") {
    const path = workspacePath(args.path);
    if (typeof args.content !== "string" || Buffer.byteLength(args.content) > MAX_FILE_BYTES) {
      return { text: `content must be UTF-8 text no larger than ${MAX_FILE_BYTES} bytes.`, isError: true };
    }
    const script = 'umask 077; mkdir -p -- "$(dirname -- "$1")"; tmp="$1.omb.$$"; trap \'rm -f -- "$tmp"\' EXIT; cat > "$tmp" || exit; if [ -e "$1" ]; then chmod --reference="$1" "$tmp"; else chmod 0644 "$tmp"; fi; mv -- "$tmp" "$1"';
    const result = await runDocker([...baseExecArgs(), "sh", "-c", script, "openmausbot-write", path], { input: args.content });
    return { text: result.code === 0 ? `wrote ${Buffer.byteLength(args.content)} bytes to ${String(args.path)}` : formatResult(result), isError: result.code !== 0 };
  }

  if (name === "workspace_apply_patch") {
    if (typeof args.patch !== "string" || !args.patch || Buffer.byteLength(args.patch) > MAX_FILE_BYTES) {
      return { text: `patch must be non-empty and no larger than ${MAX_FILE_BYTES} bytes.`, isError: true };
    }
    const cwd = workspacePath(args.cwd, true);
    const check = await runDocker([...baseExecArgs(), "git", "-C", cwd, "apply", "--check", "-"], { input: args.patch });
    if (check.code !== 0) return { text: `patch check failed\n${formatResult(check)}`, isError: true };
    const result = await runDocker([...baseExecArgs(), "git", "-C", cwd, "apply", "--whitespace=nowarn", "-"], { input: args.patch });
    return { text: result.code === 0 ? "patch applied" : formatResult(result), isError: result.code !== 0 };
  }

  if (name === "workspace_open_in_vscode") {
    const path = workspacePath(args.path, true);
    const result = await runDocker([
      "exec", "-d", "-u", "cua",
      "-e", "HOME=/home/cua",
      "-e", "DISPLAY=:1",
      container,
      "code", "--no-sandbox", "--reuse-window", path,
    ]);
    return { text: result.code === 0 ? `opened ${path} in VS Code` : formatResult(result), isError: result.code !== 0 };
  }

  return { text: `Unknown tool: ${name}`, isError: true };
}

const send = (message: Json) => process.stdout.write(JSON.stringify(message) + "\n");
const ok = (id: unknown, result: unknown) => send({ jsonrpc: "2.0", id, result });
const rpcError = (id: unknown, code: number, message: string) => send({ jsonrpc: "2.0", id, error: { code, message } });

async function handle(message: Json): Promise<void> {
  const id = message.id;
  const method = typeof message.method === "string" ? message.method : "";
  const params = typeof message.params === "object" && message.params !== null ? message.params as Json : {};
  if (method === "initialize") {
    ok(id, { protocolVersion: String(params.protocolVersion ?? "2024-11-05"), capabilities: { tools: {} }, serverInfo: { name: "openmausbot-vps-workspace", version: "1.0.0" } });
  } else if (method === "notifications/initialized") {
    return;
  } else if (method === "notifications/cancelled") {
    active?.kill("SIGTERM");
  } else if (method === "ping") {
    ok(id, {});
  } else if (method === "tools/list") {
    ok(id, { tools: WORKSPACE_TOOLS });
  } else if (method === "tools/call") {
    const name = typeof params.name === "string" ? params.name : "";
    if (!WORKSPACE_TOOLS.some((tool) => tool.name === name)) {
      rpcError(id, -32602, `Unknown tool: ${name}`);
      return;
    }
    const args = typeof params.arguments === "object" && params.arguments !== null && !Array.isArray(params.arguments) ? params.arguments as Json : {};
    try {
      const result = await callTool(name, args);
      ok(id, { content: [{ type: "text", text: result.text }], isError: result.isError === true });
    } catch (error) {
      ok(id, { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true });
    }
  } else if (id !== undefined) {
    rpcError(id, -32601, `Method not found: ${method}`);
  }
}

const lines = readline.createInterface({ input: process.stdin, terminal: false });
lines.on("line", (line) => {
  try {
    void handle(JSON.parse(line) as Json);
  } catch {
    rpcError(null, -32700, "Parse error");
  }
});
lines.on("close", () => {
  active?.kill("SIGTERM");
  process.exitCode = 0;
});
