import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
// The `ssh2` package does not ship TypeScript declarations in this workspace.
// @ts-expect-error TS7016 -- `ConnectConfig` matches ssh2 `Client#connect` options.
import type { ConnectConfig } from "ssh2";

type Ssh2HostVerifier = (
  hostKey: Buffer | string,
  verify: (permitted: boolean) => void,
) => void | boolean;

/**
 * Process-lifetime pins for {@link buildSsh2ConnectOptions} when `knownHostsFile`
 * is unset (accept-new style: first-seen key is stored; later connects must match).
 */
const pinnedHostKeysByHostPort = new Map<string, string>();

export type BuildSsh2ConnectOptionsInput = {
  host: string;
  port: number;
  username: string;
  password: string;
  knownHostsFile: string | undefined;
  readyTimeoutMs: number;
};

/**
 * Builds ssh2 `ConnectConfig` with `readyTimeout` and a `hostVerifier` host-key policy.
 *
 * **Known hosts file (`knownHostsFile` set):** On each handshake the file is read
 * synchronously (UTF-8). Verification succeeds only if the file text contains the
 * same base64 substring as OpenSSH would store for the server host key wire blob
 * (`K_S` from the key exchange). This is intentionally minimal (substring match of
 * the key material), not a full `known_hosts` parser. If the file is missing or
 * unreadable, verification fails.
 *
 * **No file (`knownHostsFile` unset):** Pins the SHA-256 fingerprint of the first
 * seen host key per `host:port` for the process lifetime; mismatches on reconnect fail.
 */
export function buildSsh2ConnectOptions(
  input: BuildSsh2ConnectOptionsInput,
): ConnectConfig {
  const { host, port, username, password, knownHostsFile, readyTimeoutMs } = input;

  const hostVerifier: Ssh2HostVerifier = (hostKey, verify) => {
    if (!Buffer.isBuffer(hostKey)) {
      verify(false);
      return;
    }

    if (knownHostsFile !== undefined) {
      let knownHostsText: string;
      try {
        knownHostsText = readFileSync(knownHostsFile, "utf8");
      } catch {
        verify(false);
        return;
      }

      const keyMaterialB64 = hostKey.toString("base64");
      const ok = knownHostsText.includes(keyMaterialB64);
      verify(ok);
      return;
    }

    const mapKey = `${host}:${port}`;
    const fp = createHash("sha256").update(hostKey).digest("hex");
    const prev = pinnedHostKeysByHostPort.get(mapKey);
    if (prev === undefined) {
      pinnedHostKeysByHostPort.set(mapKey, fp);
      verify(true);
    } else {
      verify(prev === fp);
    }
  };

  return {
    host,
    port,
    username,
    password,
    readyTimeout: readyTimeoutMs,
    hostVerifier,
  };
}
