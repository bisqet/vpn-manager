const ANSI_SGR = /\x1b\[[0-9;]*m/g;

const UTF8_PLAINTEXT_MAX_BYTES = 256 * 1024;

function stripAnsi(text: string): string {
  return text.replace(ANSI_SGR, "");
}

function truncateUtf8SuffixToMaxBytes(text: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  if (bytes.length <= maxBytes) {
    return text;
  }
  let start = bytes.length - maxBytes;
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) {
    start += 1;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(start));
}

export type PtyPlaintextBuffer = {
  append(chunk: Uint8Array): void;
  getPlaintext(): string;
};

export function createPtyPlaintextBuffer(): PtyPlaintextBuffer {
  let plaintext = "";
  const decoder = new TextDecoder("utf-8", { fatal: false });

  const applyStripAndCap = () => {
    plaintext = stripAnsi(plaintext);
    plaintext = truncateUtf8SuffixToMaxBytes(plaintext, UTF8_PLAINTEXT_MAX_BYTES);
  };

  return {
    append(chunk: Uint8Array): void {
      plaintext += decoder.decode(chunk, { stream: true });
      applyStripAndCap();
    },
    getPlaintext(): string {
      plaintext += decoder.decode();
      applyStripAndCap();
      return plaintext;
    },
  };
}
