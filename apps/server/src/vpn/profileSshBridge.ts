// @ts-expect-error TS7016 -- ssh2 has no bundled declarations in this workspace
import { Client } from "ssh2";
import type { WSContext } from "hono/ws";
import { buildSsh2ConnectOptions } from "./ssh2ConnectOptions";

const IDLE_TIMEOUT_MS = 45 * 60 * 1000;

export function createProfileSshWebSocketHandlers(options: {
  row: { host: string; ssh_port: number; ssh_user: string };
  sshPassword: string;
  env: { sshKnownHostsFile?: string };
  ClientImpl?: typeof Client;
}): {
  onOpen: (evt: Event, ws: WSContext) => void;
  onMessage: (evt: MessageEvent, ws: WSContext) => void;
  onClose: (evt: CloseEvent, ws: WSContext) => void;
} {
  const { row, sshPassword, env, ClientImpl } = options;

  const state: {
    conn: InstanceType<typeof Client> | null;
    stream: {
      write: (data: Buffer) => void;
      setWindow: (rows: number, cols: number, height: number, width: number) => void;
      end: () => void;
    } | null;
    idleTimer: ReturnType<typeof setTimeout> | null;
  } = {
    conn: null,
    stream: null,
    idleTimer: null,
  };

  function resetIdleTimer(ws: WSContext) {
    if (state.idleTimer !== null) {
      clearTimeout(state.idleTimer);
    }
    state.idleTimer = setTimeout(() => {
      state.conn?.end();
      ws.close(4408, "idle");
    }, IDLE_TIMEOUT_MS);
  }

  function cleanup() {
    if (state.idleTimer !== null) {
      clearTimeout(state.idleTimer);
      state.idleTimer = null;
    }
    state.conn?.end();
    state.conn = null;
    state.stream = null;
  }

  const SshClient: typeof Client = ClientImpl ?? Client;

  return {
    onOpen(_evt: Event, ws: WSContext) {
      const conn = new SshClient();
      state.conn = conn;

      conn.on("ready", () => {
        conn.shell(
          { term: "xterm-256color", cols: 80, rows: 24 },
          (err: Error | undefined, stream: {
            on: (event: string, cb: (...args: unknown[]) => void) => void;
            stderr: { on: (event: string, cb: (...args: unknown[]) => void) => void };
            write: (data: Buffer) => void;
            setWindow: (rows: number, cols: number, height: number, width: number) => void;
            end: () => void;
          }) => {
            if (err) {
              cleanup();
              ws.close(1011, "shell error");
              return;
            }

            state.stream = stream;
            resetIdleTimer(ws);

            stream.on("data", (data: unknown) => {
              const bytes =
                data instanceof Uint8Array
                  ? data
                  : Buffer.isBuffer(data)
                    ? new Uint8Array((data as Buffer).buffer, (data as Buffer).byteOffset, (data as Buffer).byteLength)
                    : new TextEncoder().encode(String(data));
              ws.send(bytes);
            });

            stream.stderr.on("data", (data: unknown) => {
              const bytes =
                data instanceof Uint8Array
                  ? data
                  : Buffer.isBuffer(data)
                    ? new Uint8Array((data as Buffer).buffer, (data as Buffer).byteOffset, (data as Buffer).byteLength)
                    : new TextEncoder().encode(String(data));
              ws.send(bytes);
            });

            stream.on("close", () => {
              cleanup();
              ws.close(1000, "stream closed");
            });
          },
        );
      });

      conn.on("error", (_err: Error) => {
        cleanup();
        ws.close(1011, "ssh error");
      });

      conn.connect(
        buildSsh2ConnectOptions({
          host: row.host,
          port: row.ssh_port,
          username: row.ssh_user,
          password: sshPassword,
          knownHostsFile: env.sshKnownHostsFile,
          readyTimeoutMs: 30_000,
        }),
      );
    },

    onMessage(evt: MessageEvent, ws: WSContext) {
      resetIdleTimer(ws);

      if (!state.stream) return;

      const { data } = evt;

      if (typeof data === "string") {
        let parsed: unknown;
        if (data.trimStart().startsWith("{")) {
          try {
            parsed = JSON.parse(data);
          } catch {
            // not valid JSON — treat as raw input
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
        } else {
          state.stream.write(Buffer.from(data, "utf8"));
        }
      } else if (data instanceof ArrayBuffer) {
        state.stream.write(Buffer.from(data));
      } else if (data instanceof Uint8Array) {
        state.stream.write(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
      }
    },

    onClose(_evt: CloseEvent, _ws: WSContext) {
      cleanup();
    },
  };
}
