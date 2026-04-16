import { describe, expect, test } from "bun:test";
import { createPtyPlaintextBuffer } from "./ptyPlaintext";

const encoder = new TextEncoder();

describe("createPtyPlaintextBuffer", () => {
  test("strips ANSI SGR sequences like installShTranscriptParser", () => {
    const buf = createPtyPlaintextBuffer();
    buf.append(encoder.encode("ok\x1b[32m user \x1b[0m\x1b[1mdone"));
    expect(buf.getPlaintext()).toBe("ok user done");
  });

  test("decodes UTF-8 split across chunks", () => {
    const buf = createPtyPlaintextBuffer();
    const bytes = encoder.encode("prefix😀suffix");
    buf.append(bytes.subarray(0, 8));
    buf.append(bytes.subarray(8));
    expect(buf.getPlaintext()).toBe("prefix😀suffix");
  });

  test("caps UTF-8 size to 256 KiB from the end without splitting UTF-8", () => {
    const buf = createPtyPlaintextBuffer();
    const marker = "___TAIL_MARKER___";
    const fillerByteLength = 300 * 1024;
    const filler = "a".repeat(fillerByteLength);
    buf.append(encoder.encode(filler));
    buf.append(encoder.encode(marker));
    const out = buf.getPlaintext();
    expect(out.endsWith(marker)).toBe(true);
    expect(encoder.encode(out).length).toBeLessThanOrEqual(256 * 1024);
    expect(out.includes("___TAIL_MARKER___")).toBe(true);
    expect(out.startsWith("a")).toBe(true);
  });

  test("getPlaintext flushes incomplete UTF-8 at end", () => {
    const buf = createPtyPlaintextBuffer();
    const bytes = encoder.encode("x");
    buf.append(bytes.subarray(0, 1));
    // Leading byte of 😀 without rest (U+1F600 = F0 9F 98 80)
    buf.append(new Uint8Array([0xf0]));
    const out = buf.getPlaintext();
    expect(out.startsWith("x")).toBe(true);
    expect(out.length).toBeGreaterThan(1);
  });
});
