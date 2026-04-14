const BS = "\\";
const DQ = '"';
const DOLLAR = "$";

/** Default phase timeout (matches `PHASE_TIMEOUT_MS` in `setupRunner.ts`). */
export const SETUP_PHASE_TIMEOUT_MS = 600_000;

const CAPTURE_MAX_BYTES = 16 * 1024;

const MARKER_PREFIX = "VPNMGR_PHASE_EXIT_";
const MARKER_RANDOM_LEN = 20;

function randomAlnum(length: number): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let s = "";
  for (let i = 0; i < length; i++) s += alphabet[bytes[i]! % alphabet.length]!;
  return s;
}

function makePhaseExitMarker(): string {
  return `${MARKER_PREFIX}${randomAlnum(MARKER_RANDOM_LEN)}`;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Builds a single bash line: decodes base64 UTF-8 script, runs it, prints a unique marker line with exit code.
 * User script bytes never appear unescaped in the outer shell word — only base64 inside single quotes.
 */
function buildPhaseWrapperCommand(marker: string, scriptUtf8: string): string {
  const b64 = Buffer.from(scriptUtf8, "utf8").toString("base64");
  const inner =
    `eval ${BS}${DQ}$(printf %s ${BS}${DQ}${DOLLAR}B64${BS}${DQ} | base64 -d)${BS}${DQ}; ` +
    `ec=${DOLLAR}?; printf ${BS}${DQ}${BS}n${marker}:%s${BS}n${BS}${DQ} ${BS}${DQ}${DOLLAR}ec${BS}${DQ}`;
  return `B64='${b64}' bash -c ${DQ}${inner}${DQ}`;
}

function tailUtf8(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s, "utf8") <= maxBytes) return s;
  let start = Math.max(0, s.length - maxBytes);
  while (start < s.length && Buffer.byteLength(s.slice(start), "utf8") > maxBytes) {
    start += 1;
  }
  return s.slice(start);
}

export type RunPhaseScriptOnPtyStreamOptions = {
  write: (chunk: Uint8Array | string) => void;
  onData: (handler: (chunk: Uint8Array) => void) => () => void;
  script: string;
  timeoutMs?: number;
};

export async function runPhaseScriptOnPtyStream(
  options: RunPhaseScriptOnPtyStreamOptions,
): Promise<{ code: number; captured: string }> {
  const { write, onData, script } = options;
  const timeoutMs = options.timeoutMs ?? SETUP_PHASE_TIMEOUT_MS;
  const marker = makePhaseExitMarker();
  const lineRe = new RegExp(`^${escapeRegExp(marker)}:(\\d+)$`, "m");

  let buf = "";
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let settled = false;
  let unsubscribe: (() => void) | undefined;

  const finish = () => {
    if (settled) return;
    settled = true;
    unsubscribe?.();
  };

  return await new Promise<{ code: number; captured: string }>((resolve, reject) => {
    const timer = setTimeout(() => {
      finish();
      const partial = tailUtf8(buf, CAPTURE_MAX_BYTES);
      reject(
        new Error(
          `Phase script timed out after ${timeoutMs}ms waiting for exit marker` +
            (partial ? ` (partial output: ${partial})` : ""),
        ),
      );
    }, timeoutMs);

    unsubscribe = onData((chunk: Uint8Array) => {
      buf += decoder.decode(chunk, { stream: true });
      const m = buf.match(lineRe);
      if (!m) return;
      const code = Number(m[1]);
      if (!Number.isFinite(code)) return;
      clearTimeout(timer);
      finish();
      resolve({ code, captured: tailUtf8(buf, CAPTURE_MAX_BYTES) });
    });

    const line = `${buildPhaseWrapperCommand(marker, script)}\n`;
    write(line);
  });
}
