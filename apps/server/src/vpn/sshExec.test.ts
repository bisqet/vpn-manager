import { describe, expect, test } from "bun:test";
import type { SshExecFn } from "./sshExec";

describe("SshExecFn injection", () => {
  test("fake executor receives remote script", async () => {
    const calls: string[] = [];
    const fake: SshExecFn = async ({ remoteScript }) => {
      calls.push(remoteScript);
      return { code: 0, stdout: "ok", stderr: "" };
    };
    const res = await fake({
      host: "10.0.0.1",
      port: 22,
      user: "root",
      password: "x",
      remoteScript: "echo hi",
      timeoutMs: 1000,
    });
    expect(res.stdout).toBe("ok");
    expect(calls[0]).toBe("echo hi");
  });
});
