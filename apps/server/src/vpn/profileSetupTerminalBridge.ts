// @ts-expect-error TS7016 -- ssh2 has no bundled declarations in this workspace
import { Client } from "ssh2";
import type { WSContext } from "hono/ws";
import type { Database } from "bun:sqlite";
import type { Env } from "../env";
import type { AppSettingsDto } from "../db/appSettings";
import { buildSsh2ConnectOptions } from "./ssh2ConnectOptions";
import {
  beginSetupRun,
  endSetupRun,
  signalSetupRunCancel,
} from "./setupRunRegistry";
import { runPhaseScriptOnPtyStream } from "./setupShellDriver";
import { runLiveSetupPhases } from "./setupLivePhaseLoop";
import type { SetupPhaseResult } from "./setupLivePhaseLoop";
import { buildSetupPhases } from "./setupPhases";
import type { ProfileSetupTerminalRow } from "./profileSetupTerminalGate";
import type { SshExecFn } from "./sshExec";

const XUI_LOCAL_PORT = 2053;

function randomAlnum(length: number): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let s = "";
  for (let i = 0; i < length; i++) s += alphabet[bytes[i]! % alphabet.length]!;
  return s;
}

/** RFC 6455 close reasons: UTF-8, max 123 bytes (no secrets). */
function webSocketCloseReasonFromError(err: Error, fallback: string): string {
  const raw = err.message.replace(/\s+/g, " ").trim();
  if (raw.length === 0) return fallback;
  const enc = new TextEncoder();
  let end = raw.length;
  while (end > 0 && enc.encode(raw.slice(0, end)).byteLength > 123) {
    end -= 1;
  }
  const s = raw.slice(0, end).trim();
  return s.length > 0 ? s : fallback;
}

function toUint8Array(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (Buffer.isBuffer(data)) {
    return new Uint8Array(
      (data as Buffer).buffer,
      (data as Buffer).byteOffset,
      (data as Buffer).byteLength,
    );
  }
  return new TextEncoder().encode(String(data));
}

type RunLiveSetupPhasesLike = (options: {
  db: Database;
  env: Pick<Env, "masterKey">;
  profileId: number;
  row: { host: string; ssh_port: number; ssh_user: string };
  phases: Array<{ id: string; title: string; script: string }>;
  adminUsername: string;
  adminPassword: string;
  webBasePath: string;
  sshPassword: string;
  exec: SshExecFn;
  knownHostsFile: string | undefined;
  signal: AbortSignal;
}) => Promise<{ outcome: "live-success" | "live-failed"; phases: SetupPhaseResult[] }>;

export function createProfileSetupTerminalWebSocketHandlers(options: {
  db: Database;
  env: Pick<Env, "masterKey">;
  profileId: number;
  row: ProfileSetupTerminalRow;
  sshPassword: string;
  getAppSettings: () => AppSettingsDto;
  ClientImpl?: typeof Client;
  /** For testing only: replace the live setup phase loop. */
  _runLiveSetupPhases?: RunLiveSetupPhasesLike;
}): {
  onOpen: (evt: Event, ws: WSContext) => void;
  onMessage: (evt: MessageEvent, ws: WSContext) => void;
  onClose: (evt: CloseEvent, ws: WSContext) => void;
} {
  const {
    db,
    env,
    profileId,
    row,
    sshPassword,
    getAppSettings,
    ClientImpl,
    _runLiveSetupPhases: runLiveSetupPhasesImpl,
  } = options;

  type PhaseDataHandler = (chunk: Uint8Array) => void;

  const state: {
    conn: InstanceType<typeof Client> | null;
    stream: {
      write: (data: Buffer | string) => void;
      setWindow: (rows: number, cols: number, height: number, width: number) => void;
      end: () => void;
    } | null;
    phaseDataCallback: PhaseDataHandler | null;
    detached: boolean;
    runEnded: boolean;
  } = {
    conn: null,
    stream: null,
    phaseDataCallback: null,
    detached: false,
    runEnded: false,
  };

  function cleanup() {
    state.conn?.end();
    state.conn = null;
    state.stream = null;
  }

  function finalizeRun() {
    if (state.runEnded) return;
    state.runEnded = true;
    cleanup();
    endSetupRun(profileId);
  }

  const SshClient: typeof Client = ClientImpl ?? Client;
  const doRunLiveSetupPhases: RunLiveSetupPhasesLike = runLiveSetupPhasesImpl ?? runLiveSetupPhases;

  return {
    onOpen(_evt: Event, ws: WSContext) {
      const beginResult = beginSetupRun(profileId);
      if (!beginResult.ok) {
        ws.close(1011, "setup already running");
        return;
      }
      const { signal } = beginResult;

      const conn = new SshClient();
      state.conn = conn;

      conn.on("ready", () => {
        conn.shell(
          { term: "xterm-256color", cols: 80, rows: 24 },
          (
            err: Error | undefined,
            stream: {
              on: (event: string, cb: (...args: unknown[]) => void) => void;
              stderr: { on: (event: string, cb: (...args: unknown[]) => void) => void };
              write: (data: Buffer | string) => void;
              setWindow: (rows: number, cols: number, height: number, width: number) => void;
              end: () => void;
            },
          ) => {
            if (err) {
              finalizeRun();
              ws.close(1011, webSocketCloseReasonFromError(err, "shell error"));
              return;
            }

            state.stream = stream;

            // Single data listener: forward bytes to WS and feed phase driver if active.
            stream.on("data", (data: unknown) => {
              const bytes = toUint8Array(data);
              try {
                ws.send(bytes);
              } catch {
                // ws may already be closed (detach scenario)
              }
              state.phaseDataCallback?.(bytes);
            });

            stream.stderr.on("data", (data: unknown) => {
              const bytes = toUint8Array(data);
              try {
                ws.send(bytes);
              } catch {
                // ws may already be closed
              }
            });

            stream.on("close", () => {
              finalizeRun();
              if (!state.detached) {
                try {
                  ws.close(1000, "stream closed");
                } catch {
                  // already closed
                }
              }
            });

            // Build credentials and phases for this setup run.
            const settings = getAppSettings();
            const adminUsername = randomAlnum(12);
            const adminPassword = randomAlnum(24);
            const webBasePath = randomAlnum(18);

            const phases = buildSetupPhases({
              panelHostname: row.panel_hostname,
              acmeEmail: settings.acmeEmail,
              xuiLocalPort: XUI_LOCAL_PORT,
              adminUsername,
              adminPassword,
              webBasePath,
            });

            // PTY-based SshExecFn: re-uses the open shell; ignores host/user/pass in args.
            const exec: SshExecFn = ({ remoteScript, timeoutMs }) => {
              return runPhaseScriptOnPtyStream({
                write: (chunk) => {
                  if (typeof chunk === "string") {
                    stream.write(chunk);
                  } else {
                    stream.write(
                      Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength),
                    );
                  }
                },
                onData: (handler: PhaseDataHandler) => {
                  state.phaseDataCallback = handler;
                  return () => {
                    state.phaseDataCallback = null;
                  };
                },
                script: remoteScript,
                timeoutMs,
              }).then(({ code, captured }) => ({
                code,
                stdout: captured,
                stderr: "",
              }));
            };

            // Run setup driver asynchronously; no idle timer (phase timeout handles it).
            doRunLiveSetupPhases({
              db,
              env,
              profileId,
              row: { host: row.host, ssh_port: row.ssh_port, ssh_user: row.ssh_user },
              phases,
              adminUsername,
              adminPassword,
              webBasePath,
              sshPassword,
              exec,
              knownHostsFile: settings.sshKnownHostsFile ?? undefined,
              signal,
            })
              .then((result) => {
                const outcome =
                  result.outcome === "live-success" ? "success" : "failed";
                try {
                  ws.send(JSON.stringify({ type: "setupComplete", outcome }));
                  ws.close(1000, "done");
                } catch {
                  // ws closed (e.g. detach — client already disconnected)
                }
              })
              .catch((driverErr: unknown) => {
                try {
                  ws.send(JSON.stringify({ type: "setupComplete", outcome: "failed" }));
                  const reason =
                    driverErr instanceof Error
                      ? webSocketCloseReasonFromError(driverErr, "driver error")
                      : "driver error";
                  ws.close(1011, reason);
                } catch {
                  // ws closed
                }
              })
              .finally(() => {
                finalizeRun();
              });
          },
        );
      });

      conn.on("error", (err: Error) => {
        finalizeRun();
        try {
          ws.close(1011, webSocketCloseReasonFromError(err, "ssh error"));
        } catch {
          // already closed
        }
      });

      conn.connect(
        buildSsh2ConnectOptions({
          host: row.host,
          port: row.ssh_port,
          username: row.ssh_user,
          password: sshPassword,
          knownHostsFile: getAppSettings().sshKnownHostsFile ?? undefined,
          readyTimeoutMs: 30_000,
        }),
      );
    },

    onMessage(evt: MessageEvent, _ws: WSContext) {
      if (!state.stream) return;

      const { data } = evt;

      if (typeof data === "string") {
        let parsed: unknown;
        if (data.trimStart().startsWith("{")) {
          try {
            parsed = JSON.parse(data);
          } catch {
            // not valid JSON — ignore
          }
        }

        if (
          parsed !== null &&
          parsed !== undefined &&
          typeof parsed === "object" &&
          (parsed as Record<string, unknown>).type === "resize"
        ) {
          const msg = parsed as { cols?: number; rows?: number };
          const cols = typeof msg.cols === "number" ? msg.cols : 80;
          const rows = typeof msg.rows === "number" ? msg.rows : 24;
          state.stream.setWindow(rows, cols, 0, 0);
        }
        // All other text messages are ignored (no keystrokes forwarded to host).
      }
      // Binary messages are also ignored (viewer-only, no raw input forwarding).
    },

    onClose(evt: CloseEvent, _ws: WSContext) {
      const code = evt.code;

      if (code === 4401) {
        // "Continue in background": keep SSH alive; driver's .finally calls finalizeRun.
        state.detached = true;
        return;
      }

      if (code === 4400) {
        // "Stop setup": abort signal so driver exits at next phase boundary.
        signalSetupRunCancel(profileId);
      }

      finalizeRun();
    },
  };
}
