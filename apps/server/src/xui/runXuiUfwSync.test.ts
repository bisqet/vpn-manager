import { describe, expect, test } from "bun:test";
import type { SshExecFn } from "../vpn/sshExec";
import { remoteUfwSyncScriptMissing, runXuiUfwSyncWithRetries, UFW_SYNC_REMOTE_BODY } from "./runXuiUfwSync";

describe("runXuiUfwSyncWithRetries", () => {
  test("uses fixed remote script body and stops on exit 0", async () => {
    const calls: string[] = [];
    const sshExec: SshExecFn = async (args) => {
      calls.push(args.remoteScript);
      return { code: 0, stdout: "", stderr: "" };
    };
    await runXuiUfwSyncWithRetries({
      host: "10.0.0.5",
      port: 22,
      user: "root",
      password: "x",
      sshExec,
      timeoutMs: 5_000,
    });
    expect(calls.length).toBe(1);
    expect(calls[0]).toBe(UFW_SYNC_REMOTE_BODY);
  });

  test("retries until max attempts on non-zero exit", async () => {
    let n = 0;
    const sshExec: SshExecFn = async () => {
      n += 1;
      return { code: 1, stdout: "", stderr: "fail" };
    };
    await expect(
      runXuiUfwSyncWithRetries({
        host: "h",
        port: 22,
        user: "root",
        password: "x",
        sshExec,
        timeoutMs: 5_000,
        maxAttempts: 3,
        initialBackoffMs: 1,
      }),
    ).rejects.toThrow(/ufw sync failed/i);
    expect(n).toBe(3);
  });

  test("treats missing remote script as success (no throw, no pointless retries)", async () => {
    let n = 0;
    const sshExec: SshExecFn = async () => {
      n += 1;
      return {
        code: 1,
        stdout: "",
        stderr: "sudo: /usr/local/sbin/vpnmgr-xui-ufw-sync: command not found\n",
      };
    };
    await runXuiUfwSyncWithRetries({
      host: "h",
      port: 22,
      user: "root",
      password: "x",
      sshExec,
      timeoutMs: 5_000,
      maxAttempts: 4,
      initialBackoffMs: 1,
    });
    expect(n).toBe(1);
  });
});

describe("remoteUfwSyncScriptMissing", () => {
  test("detects sudo command not found for our script path", () => {
    expect(
      remoteUfwSyncScriptMissing("sudo: /usr/local/sbin/vpnmgr-xui-ufw-sync: command not found\n", ""),
    ).toBe(true);
  });
});
