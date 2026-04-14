// @ts-expect-error TS7016 -- ssh2 has no bundled declarations in this workspace
import { Client } from "ssh2";
import { buildSsh2ConnectOptions } from "./ssh2ConnectOptions";

export type SshExecArgs = {
  host: string;
  port: number;
  user: string;
  password: string;
  remoteScript: string;
  timeoutMs: number;
  knownHostsFile?: string;
};

export type SshExecResult = { code: number; stdout: string; stderr: string };

export type SshExecFn = (args: SshExecArgs) => Promise<SshExecResult>;

const MAX_CAPTURE = 16_384;

/** Handshake timeout; full phase budget is {@link SshExecArgs.timeoutMs}. */
const SSH_READY_TIMEOUT_MS = 60_000;

function truncate(s: string): string {
  if (s.length <= MAX_CAPTURE) return s;
  return `${s.slice(0, MAX_CAPTURE)}\n… [truncated]`;
}

/**
 * Default SSH executor for remote bash scripts (setup / teardown).
 * Uses the **`ssh2`** package (installed via `bun install`); no system `sshpass` binary.
 */
export function buildSshExecUsingSpawn(): SshExecFn {
  return (args) =>
    new Promise((resolve, reject) => {
      const conn = new Client();
      let settled = false;

      function finish(err: Error | null, result: SshExecResult | null) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          conn.end();
        } catch {
          /* ignore */
        }
        if (err) {
          reject(err);
        } else if (result) {
          resolve(result);
        }
      }

      const timer = setTimeout(() => {
        finish(new Error(`SSH timed out after ${args.timeoutMs}ms`), null);
      }, args.timeoutMs);

      conn.on("ready", () => {
        conn.exec("bash -s", (err: Error | undefined, stream: StreamLike) => {
          if (err) {
            finish(err, null);
            return;
          }

          let stdout = "";
          let stderr = "";

          stream.on("data", (chunk: Buffer | string) => {
            stdout += typeof chunk === "string" ? chunk : chunk.toString();
          });
          stream.stderr.on("data", (chunk: Buffer | string) => {
            stderr += typeof chunk === "string" ? chunk : chunk.toString();
          });

          let exitHandled = false;
          function resolveWithCode(code: number) {
            if (exitHandled) return;
            exitHandled = true;
            finish(null, {
              code,
              stdout: truncate(stdout),
              stderr: truncate(stderr),
            });
          }

          stream.on("exit", (code: number | null | undefined, signal?: string) => {
            if (typeof code === "number" && code >= 0) {
              resolveWithCode(code);
              return;
            }
            if (typeof signal === "string" && signal.length > 0) {
              resolveWithCode(1);
              return;
            }
            resolveWithCode(0);
          });

          stream.on("close", () => {
            if (!exitHandled) {
              resolveWithCode(0);
            }
          });

          stream.on("error", (streamErr: Error) => {
            finish(streamErr, null);
          });

          stream.write(args.remoteScript);
          stream.end();
        });
      });

      conn.on("error", (e: Error) => {
        finish(e, null);
      });

      conn.connect(
        buildSsh2ConnectOptions({
          host: args.host,
          port: args.port,
          username: args.user,
          password: args.password,
          knownHostsFile: args.knownHostsFile,
          readyTimeoutMs: Math.min(SSH_READY_TIMEOUT_MS, args.timeoutMs),
        }),
      );
    });
}

type StreamLike = {
  on: (event: string, cb: (...args: unknown[]) => void) => StreamLike;
  stderr: { on: (event: string, cb: (...args: unknown[]) => void) => unknown };
  write: (data: string) => void;
  end: () => void;
};
