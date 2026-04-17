# Browser terminal right-click copy/paste (SSH + setup) — design

**Date:** 2026-04-17  
**Status:** Approved (conversation 2026-04-17)

## Decision log

| Topic | Choice |
|-------|--------|
| Surfaces | **`SshTerminalSheet`** and **`SetupTerminalSheet`** (`apps/web/src/pages/VpnsPage.tsx`), same behavior on both. |
| Right-click model | **Classic terminal (option A):** if xterm has a **non-empty selection** → **copy** to system clipboard; if **no selection** → **paste** from system clipboard into the PTY via xterm. **No** normal browser context menu on plain right-click. |
| Implementation strategy | **Shared web helper** that registers listeners on the terminal container after `term.open(container)`; not a server or WebSocket change. |
| xterm upgrade | **Not required** for this feature; `@xterm/xterm` 5.x public typings expose `rightClickSelectsWord`, not a turnkey copy/paste mode, so behavior is implemented explicitly. |
| Shift+right-click | **Out of scope** (user chose plain option A, not a hybrid that restores the browser menu on modifier). |

## Goals

1. Operators can **copy** transcript or shell output with **mouse select + right-click**, and **paste** into the session with **right-click** when nothing is selected, matching common Windows terminal expectations.
2. Behavior is **identical** for interactive **SSH** and **setup** terminals so muscle memory transfers.
3. **Prevent** the default browser `contextmenu` on the terminal surface for this gesture so paste/copy is predictable.

## Non-goals

- Middle-click paste, mobile long-press, or changing **Ctrl+C / Ctrl+V** semantics inside xterm.
- Shift+right-click (or other modifier) to expose the native browser context menu.
- Clipboard access from **non-secure** origins beyond what the browser already allows for `navigator.clipboard` (document limitation in spec; app is expected on HTTPS or localhost).

## Architecture

### New helper (suggested location)

`apps/web/src/lib/attachTerminalRightClickCopyPaste.ts` (name may be adjusted in implementation) exporting a function such as:

`attachTerminalRightClickCopyPaste(term: Terminal, container: HTMLElement): () => void`

- **Returns** an unsubscribe/cleanup function so `useEffect` teardown can remove listeners alongside `terminal.dispose()`.

### Event handling

1. Listen for **`contextmenu`** on `container` in the **capture** phase; call **`preventDefault()`** and **`stopPropagation()`** when the event target is inside the terminal surface we own (the opened xterm root under `container`), so the browser does not show its menu.
2. **Branch:**
   - If `term.getSelection().trim()` is non-empty: `navigator.clipboard.writeText(selection)`, then `term.clearSelection()` after successful write so the next right-click is a paste.
   - Else: `navigator.clipboard.readText()` then `term.paste(text)` (preserves xterm bracketed paste behavior toward the PTY).
3. **Firefox:** If manual QA shows `contextmenu` alone is insufficient (known xterm/Firefox interaction issues with the hidden textarea), add a targeted **`mousedown`** listener for `button === 2` mirroring the same branch logic, without double-firing copy/paste (implementation plan picks the minimal pattern).

### Integration points

- **`SshTerminalSheet`:** after `term.open(container)` and `fitAddon.fit()`, call attach; cleanup on effect return.
- **`SetupTerminalSheet`:** same pattern in its `useEffect` where the terminal is created.

No changes to **`apps/server`**, SSH WebSocket framing, or setup bridge protocols.

## Error handling and UX

- Clipboard **`readText` / `writeText`** rejections (permission denied, unsupported context): **no modal**; optionally `console.debug` for developers. Operators already use click-to-copy elsewhere in the app where errors are surfaced; here silence avoids interrupting a live shell session.
- Do not swallow unrelated errors inside shared utilities beyond clipboard calls.

## Testing

| Layer | Expectation |
|-------|-------------|
| **Manual** | Windows: Chrome, Edge, Firefox — select+RMB copies; RMB with no selection pastes; HTTPS or localhost. |
| **Automated (optional)** | Unit-test the helper with mocked `Terminal` (`getSelection`, `clearSelection`, `paste`) and synthetic `contextmenu` events if the DOM setup stays simple; otherwise manual-only is acceptable for v1. |

## Risks

| Risk | Mitigation |
|------|------------|
| Clipboard API requires **secure context** | Document; matches typical deployment. |
| **Double events** (mousedown + contextmenu) | Implement paste/copy once per user gesture (implementation plan). |
| **Paste** brings large/binary-looking text | Same as any terminal; no extra server validation in scope. |

## Open points for implementation plan

1. Exact **file name** and whether to co-locate tests under `apps/web/src/lib/*.test.ts`.
2. Whether **`clearSelection()`** after copy should be unconditional on write success only (recommended) or always.
