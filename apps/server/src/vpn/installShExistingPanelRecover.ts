import { randomBytes } from "node:crypto";
import { runPromptDriver } from "./installShPromptDriver";

/** Distinct from normal shell output so we can complete the expect driver. */
export const VPNMGR_RECOVER_MARKER_AFTER_SHOW = "__VPNMGR_RECOVER_AFTER_SHOW__";
export const VPNMGR_RECOVER_MARKER_AFTER_SET = "__VPNMGR_RECOVER_AFTER_SET__";

const XUI_CLI = "/usr/local/x-ui/x-ui";

function randomAlnum(length: number): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += chars[bytes[i]! % chars.length]!;
  }
  return out;
}

/**
 * Parses the last `webBasePath:` line from `x-ui setting -show true` style output
 * (3x-ui prints `webBasePath: /segment` or `webBasePath: segment`).
 */
export function parseLastWebBasePathFromSettingShow(plain: string): string | null {
  const re = /^\s*webBasePath:\s*(.+)$/gim;
  let last: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(plain)) !== null) {
    last = m[1]!.trim();
  }
  if (!last) return null;
  const stripped = last.replace(/^\//, "");
  return stripped.length > 0 ? stripped : null;
}

/** Reads `port:` from the output block between our last `setting -show true` and the completion marker. */
export function parsePanelPortFromLastSettingShowOutput(plain: string, showMarker: string): number | null {
  const markerIdx = plain.lastIndexOf(showMarker);
  if (markerIdx < 0) return null;
  const cmdNeedle = `${XUI_CLI} setting -show true`;
  const cmdIdx = plain.lastIndexOf(cmdNeedle, markerIdx);
  /** Shell usually echoes the command; if not, scan a short window before the marker. */
  const segment =
    cmdIdx >= 0 ? plain.slice(cmdIdx, markerIdx) : plain.slice(Math.max(0, markerIdx - 12_000), markerIdx);
  const re = /^\s*port:\s*(\d+)\s*$/gim;
  let last: number | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(segment)) !== null) {
    const n = Number(m[1]);
    if (Number.isInteger(n) && n >= 1 && n <= 65535) last = n;
  }
  return last;
}

export type RecoverSecretsOptions = {
  write: (data: string | Uint8Array) => void;
  subscribePtyData: (handler: (chunk: Uint8Array) => void) => () => void;
  plaintext: { append(chunk: Uint8Array): void; getPlaintext(): string };
  signal: AbortSignal;
};

/**
 * When upstream `install.sh` finishes without the "Panel Installation Complete!" banner
 * (common on reinstall when credentials already exist), there are no plaintext credentials
 * to parse. We read `webBasePath` from the panel CLI, then set **new** random admin credentials
 * so VPN Manager can store a known login (previous admin password stops working).
 */
export async function recoverPanelSecretsWhenNoInstallBanner(
  options: RecoverSecretsOptions,
): Promise<{ adminUsername: string; adminPassword: string; webBasePath: string; panelPort: number | null } | null> {
  const { write, subscribePtyData, plaintext, signal } = options;

  const showDriver = await runPromptDriver({
    write: (s) => write(s),
    subscribeData: subscribePtyData,
    rules: [],
    plaintext,
    globalTimeoutMs: 25_000,
    signal,
    completionIncludes: VPNMGR_RECOVER_MARKER_AFTER_SHOW,
    tailDrainAfterCompleteMs: 400,
    afterSubscribe: () => {
      write(`\n${XUI_CLI} setting -show true 2>&1\necho '${VPNMGR_RECOVER_MARKER_AFTER_SHOW}'\n`);
    },
  });

  if (showDriver.status !== "completed") {
    return null;
  }

  const fullPlain = plaintext.getPlaintext();
  const webBasePath = parseLastWebBasePathFromSettingShow(fullPlain);
  if (!webBasePath) {
    return null;
  }
  const panelPort = parsePanelPortFromLastSettingShowOutput(fullPlain, VPNMGR_RECOVER_MARKER_AFTER_SHOW);

  const adminUsername = randomAlnum(10);
  const adminPassword = randomAlnum(16);

  const setDriver = await runPromptDriver({
    write: (s) => write(s),
    subscribeData: subscribePtyData,
    rules: [],
    plaintext,
    globalTimeoutMs: 45_000,
    signal,
    completionIncludes: VPNMGR_RECOVER_MARKER_AFTER_SET,
    tailDrainAfterCompleteMs: 500,
    afterSubscribe: () => {
      write(
        `\n${XUI_CLI} setting -username '${adminUsername}' -password '${adminPassword}' 2>&1\necho '${VPNMGR_RECOVER_MARKER_AFTER_SET}'\n`,
      );
    },
  });

  if (setDriver.status !== "completed") {
    return null;
  }

  return { adminUsername, adminPassword, webBasePath, panelPort };
}
