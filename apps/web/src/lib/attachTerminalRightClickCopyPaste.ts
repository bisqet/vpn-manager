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
