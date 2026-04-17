import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { attachTerminalRightClickCopyPaste } from "./attachTerminalRightClickCopyPaste";

describe("attachTerminalRightClickCopyPaste", () => {
  let container: HTMLDivElement;
  let inner: HTMLDivElement;
  const writeText = mock(() => Promise.resolve());
  const readText = mock(() => Promise.resolve("pasted"));

  beforeEach(() => {
    container = document.createElement("div");
    inner = document.createElement("div");
    container.appendChild(inner);
    document.body.appendChild(container);
    (navigator as any).clipboard = { writeText, readText };
  });

  afterEach(() => {
    document.body.removeChild(container);
    writeText.mockClear();
    readText.mockClear();
  });

  test("copy path: non-whitespace selection writes clipboard and clears selection", async () => {
    const clearSelection = mock(() => {});
    const term = {
      getSelection: () => "  line\n",
      clearSelection,
      paste: mock(() => {}),
    };
    const detach = attachTerminalRightClickCopyPaste(term as any, container);
    const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 });
    Object.defineProperty(ev, "target", { value: inner, enumerable: true });
    inner.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0][0]).toBe("  line\n");
    expect(clearSelection).toHaveBeenCalledTimes(1);
    expect(readText).not.toHaveBeenCalled();
    detach();
  });

  test("paste path: whitespace-only selection reads clipboard and pastes", async () => {
    const paste = mock(() => {});
    const term = {
      getSelection: () => "   \n\t",
      clearSelection: mock(() => {}),
      paste,
    };
    const detach = attachTerminalRightClickCopyPaste(term as any, container);
    const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 });
    Object.defineProperty(ev, "target", { value: inner, enumerable: true });
    inner.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    await Promise.resolve();
    expect(readText).toHaveBeenCalledTimes(1);
    expect(paste).toHaveBeenCalledWith("pasted");
    expect(writeText).not.toHaveBeenCalled();
    detach();
  });

  test("does not intercept contextmenu outside container subtree", () => {
    const outside = document.createElement("div");
    document.body.appendChild(outside);
    const term = {
      getSelection: () => "",
      clearSelection: mock(() => {}),
      paste: mock(() => {}),
    };
    const detach = attachTerminalRightClickCopyPaste(term as any, container);
    const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 });
    Object.defineProperty(ev, "target", { value: outside, enumerable: true });
    outside.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    detach();
    document.body.removeChild(outside);
  });
});
