import type { SshExecFn } from "../vpn/sshExec";

/** Must be a single literal — passed to `bash -s` on the remote. */
export const UFW_SYNC_REMOTE_BODY = "set -euo pipefail\nexec sudo -n /usr/local/sbin/vpnmgr-xui-ufw-sync\n";

export type RunXuiUfwSyncArgs = {
  host: string;
  port: number;
  user: string;
  password: string;
  knownHostsFile?: string | null;
  sshExec: SshExecFn;
  timeoutMs: number;
  maxAttempts?: number;
  initialBackoffMs?: number;
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function runXuiUfwSyncWithRetries(args: RunXuiUfwSyncArgs): Promise<void> {
  const maxAttempts = args.maxAttempts ?? 4;
  const initialBackoffMs = args.initialBackoffMs ?? 250;
  let lastStderr = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await args.sshExec({
      host: args.host,
      port: args.port,
      user: args.user,
      password: args.password,
      remoteScript: UFW_SYNC_REMOTE_BODY,
      timeoutMs: args.timeoutMs,
      knownHostsFile: args.knownHostsFile ?? undefined,
    });
    if (result.code === 0) return;
    lastStderr = result.stderr;
    if (attempt < maxAttempts) {
      const backoff = initialBackoffMs * 2 ** (attempt - 1);
      await sleep(Math.min(backoff, 2000));
    }
  }
  throw new Error(`ufw sync failed after ${maxAttempts} attempts: ${lastStderr.trim()}`);
}
