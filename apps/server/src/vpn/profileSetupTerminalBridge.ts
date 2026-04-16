// @ts-expect-error TS7016 -- ssh2 has no bundled declarations in this workspace
import { Client } from "ssh2";
import type { WSContext } from "hono/ws";
import type { Database } from "bun:sqlite";
import type { Env } from "../env";
import type { AppSettingsDto } from "../db/appSettings";
import { encryptXuiSecretsJson } from "../crypto/xuiSecrets";
import { buildSsh2ConnectOptions } from "./ssh2ConnectOptions";
import {
  beginSetupRun,
  endSetupRun,
  signalSetupRunCancel,
} from "./setupRunRegistry";
import type { ProfileSetupTerminalRow } from "./profileSetupTerminalGate";
import {
  runInstallShSetupSession,
  type InstallShSetupResult,
} from "./runInstallShSetupSession";

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

type SetupShellStream = {
  on: (event: string, cb: (...args: unknown[]) => void) => void;
  off?: (event: string, cb: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, cb: (...args: unknown[]) => void) => void;
  stderr: { on: (event: string, cb: (...args: unknown[]) => void) => void };
  write: (data: Buffer | string) => void;
  setWindow: (rows: number, cols: number, height: number, width: number) => void;
  end: () => void;
};

type RunInstallShSetupSessionOptions = Parameters<typeof runInstallShSetupSession>[0];
type RunInstallShSetupSessionLike = (options: RunInstallShSetupSessionOptions) => Promise<InstallShSetupResult>;

async function persistInstallSessionResult(options: {
  db: Database;
  env: Pick<Env, "masterKey">;
  profileId: number;
  result: InstallShSetupResult;
}): Promise<void> {
  const { db, env, profileId, result } = options;

  if (result.outcome === "success") {
    const { ciphertext, nonce } = await encryptXuiSecretsJson(env.masterKey, {
      v: 1,
      adminUsername: result.adminUsername,
      adminPassword: result.adminPassword,
    });

    db.query(
      `UPDATE vpn_profiles SET
        operational_status = 'working',
        xui_secrets_ciphertext = ?,
        xui_secrets_nonce = ?,
        xui_web_base_path = ?,
        last_setup_error = NULL,
        last_setup_at = datetime('now'),
        updated_at = datetime('now')
      WHERE id = ?`,
    ).run(ciphertext, nonce, result.webBasePath, profileId);
    return;
  }

  const transcriptTail = result.plainTranscript.trim().slice(-3500);
  const detail = transcriptTail.length > 0
    ? `${result.reason}\n\n${transcriptTail}`
    : result.reason;

  db.query(
    `UPDATE vpn_profiles SET
      last_setup_error = ?,
      last_setup_at = datetime('now'),
      updated_at = datetime('now')
    WHERE id = ?`,
  ).run(detail, profileId);
}

export function createProfileSetupTerminalWebSocketHandlers(options: {
  db: Database;
  env: Pick<Env, "masterKey">;
  profileId: number;
  row: ProfileSetupTerminalRow;
  sshPassword: string;
  getAppSettings: () => AppSettingsDto;
  ClientImpl?: typeof Client;
  /** For testing only: replace the install.sh setup session. */
  _runInstallShSetupSession?: typeof runInstallShSetupSession;
  /** For testing only: override DB persistence after session completion. */
  _afterInstall?: (result: InstallShSetupResult) => Promise<void>;
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
    _runInstallShSetupSession: runInstallShSetupSessionImpl,
    _afterInstall: afterInstall,
  } = options;

  const state: {
    conn: InstanceType<typeof Client> | null;
    stream: SetupShellStream | null;
    detached: boolean;
    runEnded: boolean;
    automationRunning: boolean;
  } = {
    conn: null,
    stream: null,
    detached: false,
    runEnded: false,
    automationRunning: false,
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
  const doRunInstallShSetupSession: RunInstallShSetupSessionLike =
    runInstallShSetupSessionImpl ?? runInstallShSetupSession;
  const doAfterInstall =
    afterInstall ??
    ((result: InstallShSetupResult) =>
      persistInstallSessionResult({ db, env, profileId, result }));

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
            stream: SetupShellStream,
          ) => {
            if (err) {
              finalizeRun();
              ws.close(1011, webSocketCloseReasonFromError(err, "shell error"));
              return;
            }

            state.stream = stream;
            state.automationRunning = true;

            const ptyDataSubscribers = new Set<(chunk: Uint8Array) => void>();
            const forwardPtyStdout = (data: unknown) => {
              const bytes = toUint8Array(data);
              try {
                ws.send(bytes);
              } catch {
                // ws may already be closed (detach scenario)
              }
              for (const h of ptyDataSubscribers) {
                h(bytes);
              }
            };
            stream.on("data", forwardPtyStdout);

            stream.stderr.on("data", (data: unknown) => {
              const bytes = toUint8Array(data);
              try {
                ws.send(bytes);
              } catch {
                // ws may already be closed
              }
            });

            void doRunInstallShSetupSession({
              write: (data) =>
                stream.write(
                  typeof data === "string"
                    ? data
                    : Buffer.from(data.buffer, data.byteOffset, data.byteLength),
                ),
              subscribePtyData: (handler) => {
                ptyDataSubscribers.add(handler);
                return () => {
                  ptyDataSubscribers.delete(handler);
                };
              },
              panelHostname: row.panel_hostname.trim(),
              signal,
            })
              .then(async (result) => {
                state.automationRunning = false;
                await doAfterInstall(result);
                const outcome = result.outcome;
                try {
                  ws.send(JSON.stringify({ type: "setupComplete", outcome }));
                  ws.close(1000, "done");
                } catch {
                  // ws closed (e.g. detach — client already disconnected)
                }
              })
              .catch((driverErr: unknown) => {
                state.automationRunning = false;
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
          return;
        }

        if (state.automationRunning) {
          return;
        }

        state.stream.write(Buffer.from(data, "utf8"));
        return;
      }

      if (state.automationRunning) {
        return;
      }

      if (data instanceof ArrayBuffer) {
        state.stream.write(Buffer.from(data));
      } else if (data instanceof Uint8Array) {
        state.stream.write(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
      }
    },

    onClose(evt: CloseEvent, _ws: WSContext) {
      const code = evt.code;

      if (code === 4401) {
        // "Continue in background": keep SSH alive; driver's .finally calls finalizeRun.
        state.detached = true;
        return;
      }

      if (code === 4400) {
        signalSetupRunCancel(profileId);
        return;
      }

      finalizeRun();
    },
  };
}
