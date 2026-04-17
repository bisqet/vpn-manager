# Terminal right-click copy/paste (SSH + setup xterm) — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add classic terminal right-click behavior to the in-browser **SSH** and **setup** xterm surfaces: **non-empty selection → copy** to the system clipboard and clear xterm selection; **empty selection → paste** from the clipboard into the PTY via `term.paste`, with the **native browser context menu suppressed** on that gesture.

**Architecture:** A single pure front-end helper `attachTerminalRightClickCopyPaste(term, container)` registers a **`contextmenu` listener in the capture phase** on the same `HTMLElement` passed to `term.open(container)`. It returns a disposer for `useEffect` cleanup. **`SshTerminalSheet`** and **`SetupTerminalSheet`** each call the helper once after `open` + initial `fit`. No API or server changes.

**Tech stack:** React 18, `@xterm/xterm` 5.5, `@xterm/addon-fit` 0.10, Bun test (`bun test` in `apps/web`).

**Authoritative spec:** `docs/superpowers/specs/2026-04-17-terminal-rmb-copy-paste-design.md`

---

## File map (create / modify)

| Path | Role |
|------|------|
| `apps/web/src/lib/attachTerminalRightClickCopyPaste.ts` | Registers capture `contextmenu` on `container`; copy/paste branch; returns detach function. |
| `apps/web/src/lib/attachTerminalRightClickCopyPaste.test.ts` | Bun tests with mocked `navigator.clipboard` and a minimal `term` mock. |
| `apps/web/src/pages/VpnsPage.tsx` | Import helper; after `term.open` / `fitAddon.fit()` in **both** terminal effects, call attach and invoke returned cleanup before `terminal.dispose()`. |

---

### Task 1: `attachTerminalRightClickCopyPaste` (TDD)

**Files:**
- Create: `apps/web/src/lib/attachTerminalRightClickCopyPaste.ts`
- Create: `apps/web/src/lib/attachTerminalRightClickCopyPaste.test.ts`

**Behavior rules (lock these in code and tests):**

1. Only handle events whose **`event.target` is contained in `container`** (`container.contains(event.target as Node)`). Otherwise return without calling `preventDefault` (so other UI keeps working).
2. For handled events: **`preventDefault()`** and **`stopPropagation()`** on the `contextmenu` event.
3. **Branch:** Let `raw = term.getSelection()`. If `raw.trim().length > 0` → **copy path:** `await navigator.clipboard.writeText(raw)`; on **fulfilled** success only, call `term.clearSelection()`. If `raw.trim().length === 0` → **paste path:** `const text = await navigator.clipboard.readText()` then `term.paste(text)` (even when `text` is empty string).
4. **`readText` / `writeText` rejection:** catch, **no throw**, optional `console.debug` with a static tag (e.g. `[terminal-rmb-clipboard]`).
5. **v1:** Do **not** add a separate `mousedown` button-2 handler unless manual Firefox QA in Task 4 proves it necessary (spec allows a follow-up).

- [ ] **Step 1: Write the failing test file**

Create `apps/web/src/lib/attachTerminalRightClickCopyPaste.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run from repo root:

```bash
cd apps/web && bun test src/lib/attachTerminalRightClickCopyPaste.test.ts
```

Expected: **FAIL** (import error or missing export).

- [ ] **Step 3: Implement the helper**

Create `apps/web/src/lib/attachTerminalRightClickCopyPaste.ts`:

```ts
import type { Terminal } from "@xterm/xterm";

/**
 * Classic terminal RMB: selection (trim-non-empty) → copy; else → paste.
 * Suppresses native context menu for events inside `container`.
 */
export function attachTerminalRightClickCopyPaste(term: Terminal, container: HTMLElement): () => void {
  const onContextMenu = (e: MouseEvent) => {
    if (!(e.target instanceof Node) || !container.contains(e.target)) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();

    const raw = term.getSelection();
    const trimmedLen = raw.trim().length;

    void (async () => {
      try {
        if (trimmedLen > 0) {
          await navigator.clipboard.writeText(raw);
          term.clearSelection();
        } else {
          const text = await navigator.clipboard.readText();
          term.paste(text);
        }
      } catch (err) {
        console.debug("[terminal-rmb-clipboard]", err);
      }
    })();
  };

  container.addEventListener("contextmenu", onContextMenu, true);
  return () => container.removeEventListener("contextmenu", onContextMenu, true);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
cd apps/web && bun test src/lib/attachTerminalRightClickCopyPaste.test.ts
```

Expected: **PASS** (all three tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/attachTerminalRightClickCopyPaste.ts apps/web/src/lib/attachTerminalRightClickCopyPaste.test.ts
git commit -m "feat(web): add xterm right-click copy/paste helper"
```

---

### Task 2: Wire SSH + setup terminals

**Files:**
- Modify: `apps/web/src/pages/VpnsPage.tsx`

**Imports:** Add:

```ts
import { attachTerminalRightClickCopyPaste } from "../lib/attachTerminalRightClickCopyPaste";
```

(Adjust relative path: from `pages/` to `lib/` → `../lib/attachTerminalRightClickCopyPaste`.)

**`SshTerminalSheet` effect:** After `term.open(container);` and `fitAddon.fit();`, store the disposer:

```ts
const detachRmb = attachTerminalRightClickCopyPaste(term, container);
```

In the effect **cleanup** (existing `return () => { ... }`), call `detachRmb()` **before** `terminal?.dispose()` (order avoids listening to a disposed terminal).

**`SetupTerminalSheet` effect:** Apply the **identical** pattern in the `useEffect` that constructs its `Terminal` (same variable names or `detachRmbSetup` if you need to avoid shadowing in the same file).

- [ ] **Step 1: Apply edits to `VpnsPage.tsx`**

- [ ] **Step 2: Typecheck / tests**

Run:

```bash
cd apps/web && bun test src
```

Expected: **PASS** (full web unit suite including new tests).

Optional sanity:

```bash
cd apps/web && bunx tsc -b --pretty false
```

Expected: **no errors** (if `tsc -b` is configured for the web package).

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/pages/VpnsPage.tsx
git commit -m "feat(web): enable RMB copy/paste on SSH and setup xterm sheets"
```

---

### Task 3: Manual verification (required)

**Checklist (Windows, HTTPS or `localhost`):**

| Step | SSH sheet | Setup sheet |
|------|-----------|-------------|
| Drag-select text, right-click | Clipboard contains exact selection; selection clears in terminal | Same |
| No selection, right-click after copying elsewhere | Clipboard text appears in shell / PTY | Same (when input policy allows typing) |
| Right-click | No browser default menu over xterm canvas | Same |

**Firefox:** If the native menu still appears or paste is a no-op, file a follow-up: add `mousedown` capture handler for `button === 2` with a **one-gesture** guard (e.g. `event.preventDefault` on `contextmenu` only is insufficient); do **not** duplicate copy/paste in the same gesture.

- [ ] **Step 1: Record results** (pass / fail per browser) in the PR description or a short note; no new markdown file unless the team requires it.

---

## Plan self-review

**1. Spec coverage**

| Spec item | Task |
|-----------|------|
| Both SSH + setup surfaces | Task 2 |
| Selection → copy, empty → paste | Task 1 tests + implementation |
| `preventDefault` / no native menu inside container | Task 1 |
| `clearSelection` after successful copy only | Task 1 (`writeText` then `clearSelection` in same try after await) |
| `term.paste` for paste path | Task 1 |
| Clipboard errors silent + debug | Task 1 `catch` |
| No server / WS changes | File map omits `apps/server` |
| Firefox optional follow-up | Task 3 |

**2. Placeholder scan:** None.

**3. Type consistency:** `Terminal` type from `@xterm/xterm` matches both call sites; helper import path `../lib/` from `src/pages/VpnsPage.tsx` is correct for this repo layout.

---

**Plan complete and saved to `docs/superpowers/plans/2026-04-17-terminal-rmb-copy-paste.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — Dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
