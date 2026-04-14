import { describe, expect, test } from "bun:test";
import {
  SETUP_PHASE_TIMEOUT_MS,
  runPhaseScriptOnPtyStream,
} from "./setupShellDriver";

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function extractMarkerFromCommand(cmd: string): string | null {
  const m = cmd.match(/VPNMGR_PHASE_EXIT_[A-Za-z0-9]+/);
  return m ? m[0]! : null;
}

type FakePtyOptions = {
  exitCode?: number;
  delayMs?: number;
  /** If true, never emit the marker line */
  omitMarker?: boolean;
};

function createFakePty(opts: FakePtyOptions = {}) {
  let onDataHandler: ((chunk: Uint8Array) => void) | undefined;

  return {
    write(chunk: Uint8Array | string) {
      const cmd = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      if (opts.omitMarker) return;
      const marker = extractMarkerFromCommand(cmd);
      if (!marker) return;
      const exitCode = opts.exitCode ?? 0;
      const delay = opts.delayMs ?? 0;
      const emit = () => {
        const noise = "remote# ";
        onDataHandler?.(utf8(`${noise}running phase…\n${marker}:${exitCode}\n`));
      };
      if (delay > 0) setTimeout(emit, delay);
      else queueMicrotask(emit);
    },
    onData(handler: (chunk: Uint8Array) => void) {
      onDataHandler = handler;
      return () => {
        onDataHandler = undefined;
      };
    },
  };
}

describe("runPhaseScriptOnPtyStream", () => {
  test("runs phase script and parses zero exit from marker line", async () => {
    const pty = createFakePty({ exitCode: 0 });
    const res = await runPhaseScriptOnPtyStream({
      write: pty.write,
      onData: pty.onData,
      script: "echo hello",
      timeoutMs: 5_000,
    });
    expect(res.code).toBe(0);
    expect(res.captured).toContain("VPNMGR_PHASE_EXIT_");
    expect(res.captured).toMatch(/VPNMGR_PHASE_EXIT_[A-Za-z0-9]+:0/);
  });

  test("parses non-zero exit code from marker line", async () => {
    const pty = createFakePty({ exitCode: 3 });
    const res = await runPhaseScriptOnPtyStream({
      write: pty.write,
      onData: pty.onData,
      script: "exit 3",
      timeoutMs: 5_000,
    });
    expect(res.code).toBe(3);
    expect(res.captured).toMatch(/VPNMGR_PHASE_EXIT_[A-Za-z0-9]+:3/);
  });

  test("rejects when marker line does not arrive before timeout", async () => {
    const pty = createFakePty({ omitMarker: true });
    const p = runPhaseScriptOnPtyStream({
      write: pty.write,
      onData: pty.onData,
      script: "sleep 999",
      timeoutMs: 30,
    });
    await expect(p).rejects.toThrow(/timed out/i);
  });
});

describe("SETUP_PHASE_TIMEOUT_MS", () => {
  test("matches setup runner phase timeout (10 minutes)", () => {
    expect(SETUP_PHASE_TIMEOUT_MS).toBe(600_000);
  });
});
