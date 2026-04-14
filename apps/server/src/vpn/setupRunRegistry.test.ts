import { afterEach, describe, expect, test } from "bun:test";
import {
  beginSetupRun,
  endSetupRun,
  isSetupRunActive,
  signalSetupRunCancel,
} from "./setupRunRegistry";

const profileId = 1;

afterEach(() => {
  endSetupRun(profileId);
});

describe("setupRunRegistry", () => {
  test("second beginSetupRun fails while first is active; endSetupRun clears", () => {
    const first = beginSetupRun(profileId);
    expect(first).toEqual({ ok: true, signal: expect.any(AbortSignal) });

    expect(beginSetupRun(profileId)).toEqual({ ok: false });

    endSetupRun(profileId);

    const again = beginSetupRun(profileId);
    expect(again.ok).toBe(true);
    if (again.ok) {
      expect(again.signal).toBeInstanceOf(AbortSignal);
    }
  });

  test("signalSetupRunCancel aborts the signal (listener)", () => {
    const started = beginSetupRun(profileId);
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    let aborted = false;
    started.signal.addEventListener("abort", () => {
      aborted = true;
    });

    signalSetupRunCancel(profileId);

    expect(aborted).toBe(true);
    expect(started.signal.aborted).toBe(true);
  });

  test("isSetupRunActive reflects registry map", () => {
    expect(isSetupRunActive(profileId)).toBe(false);

    beginSetupRun(profileId);
    expect(isSetupRunActive(profileId)).toBe(true);

    endSetupRun(profileId);
    expect(isSetupRunActive(profileId)).toBe(false);
  });
});
