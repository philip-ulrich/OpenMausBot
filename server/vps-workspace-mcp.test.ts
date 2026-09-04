import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { vpsContainerName } from "./vps-computer.ts";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

interface McpClient {
  child: ChildProcessWithoutNullStreams;
  log: string;
  request(method: string, params?: Record<string, unknown>): Promise<any>;
  close(): Promise<void>;
}

async function client(): Promise<McpClient> {
  const bin = await mkdtemp(join(tmpdir(), "openmausbot-vps-workspace-"));
  temporary.push(bin);
  const fakeDocker = join(bin, "docker");
  const log = join(bin, "docker.log");
  await writeFile(log, "");
  await writeFile(
    fakeDocker,
    '#!/bin/sh\nprintf \'ARGS:%s\\n\' "$*" >&2\nprintf \'ARGS:%s\\n\' "$*" >> "$FAKE_DOCKER_LOG"\ninput=$(cat)\nprintf \'INPUT:%s\\n\' "$input" >&2\nprintf \'INPUT:%s\\n\' "$input" >> "$FAKE_DOCKER_LOG"\nprintf \'command output\\n\'\n',
    { mode: 0o700 },
  );
  await chmod(fakeDocker, 0o700);

  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL("./vps-workspace-mcp.ts", import.meta.url)),
      "production-vps",
      vpsContainerName("workspace-test"),
    ],
    {
      env: { ...process.env, OMB_EXTRA_PATH: bin, FAKE_DOCKER_LOG: log, NODE_NO_WARNINGS: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  child.stdin.on("error", () => {});
  let buffer = "";
  let nextId = 1;
  const pending = new Map<number, (message: any) => void>();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  });

  return {
    child,
    log,
    request(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`MCP request ${method} timed out`)), 5_000);
        pending.set(id, (message) => {
          clearTimeout(timeout);
          resolve(message);
        });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    },
    close() {
      return new Promise((resolve) => {
        child.once("close", () => resolve());
        child.stdin.end();
      });
    },
  };
}

describe.skipIf(process.platform === "win32")("VPS workspace MCP", () => {
  it("publishes direct coding tools and keeps shell text off process argv", async () => {
    const mcp = await client();
    const listed = await mcp.request("tools/list");
    expect(listed.result.tools.map((tool: any) => tool.name)).toEqual([
      "workspace_exec",
      "workspace_read_file",
      "workspace_write_file",
      "workspace_apply_patch",
      "workspace_open_in_vscode",
    ]);

    const command = "printf super-secret-command";
    const called = await mcp.request("tools/call", {
      name: "workspace_exec",
      arguments: { command, cwd: "project", timeout_seconds: 5 },
    });
    const text = called.result.content[0].text as string;
    expect(called.result.isError).toBe(false);
    expect(text).toContain("-H ssh://production-vps exec -i -u cua");
    expect(text).toContain("-w /home/cua/workspace/project");
    expect(text).toContain("bash -s");
    expect(text).toContain(`INPUT:${command}`);
    expect(text.split("INPUT:")[0]).not.toContain(command);
    await mcp.close();
  });

  it("rejects file paths that escape the bot workspace before invoking Docker", async () => {
    const mcp = await client();
    const called = await mcp.request("tools/call", {
      name: "workspace_read_file",
      arguments: { path: "../../etc/passwd" },
    });
    expect(called.result.isError).toBe(true);
    expect(called.result.content[0].text).toContain("stay inside");
    expect(await readFile(mcp.log, "utf8")).toBe("");
    await mcp.close();
  });

  it("routes file writes, checked patches, and VS Code to the assigned container", async () => {
    const mcp = await client();
    const written = await mcp.request("tools/call", {
      name: "workspace_write_file",
      arguments: { path: "project/src/a.ts", content: "export const a = 1;\n" },
    });
    expect(written.result.isError).toBe(false);

    const patch = "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+new\n";
    const applied = await mcp.request("tools/call", {
      name: "workspace_apply_patch",
      arguments: { cwd: "project", patch },
    });
    expect(applied.result.isError).toBe(false);

    const opened = await mcp.request("tools/call", {
      name: "workspace_open_in_vscode",
      arguments: { path: "project" },
    });
    expect(opened.result.isError).toBe(false);

    const log = await readFile(mcp.log, "utf8");
    expect(log).toContain("openmausbot-write /home/cua/workspace/project/src/a.ts");
    expect(log).toContain("INPUT:export const a = 1;");
    expect(log.match(/git -C \/home\/cua\/workspace\/project apply/g)).toHaveLength(2);
    expect(log).toContain("INPUT:diff --git a/a b/a");
    expect(log).toContain("exec -d -u cua -e HOME=/home/cua -e DISPLAY=:1");
    expect(log).toContain("code --no-sandbox --reuse-window /home/cua/workspace/project");
    await mcp.close();
  });
});
