# Traffic diagram — pan, zoom, and expand modal — design

**Date:** 2026-04-14  
**Status:** Approved (design sign-off in session)  
**Scope:** **Web UI only** — interactive **pan** and **wheel zoom** on the chain **traffic diagram**, a **Reset view** control, and an **expand** action that opens the diagram in a **large modal overlay**. No changes to routing APIs, graph semantics in `chainTrafficGraph.ts`, or hop data models except props needed for diagram identity (see §4).

## 1. Problem and intent

The traffic diagram on **Chains** is informative but **fixed** in scale: users cannot inspect dense graphs comfortably, and the inline card height limits how much of the diagram is visible at once.

**Product goals (approved in session):**

1. **Pan** — drag with the primary pointer to move the diagram content within the SVG viewport.
2. **Zoom** — **mouse wheel** over the diagram zooms **without** a modifier key; wheel events on the diagram must **not** scroll the Chains page behind it.
3. **Reset view** — a visible control restores **scale 1** and **translation zero** on the diagram content.
4. **Expand** — a control in the **top-right** of the Traffic diagram card (aligned with the section heading row) opens a **modal** with a **larger** diagram; **not** the browser Fullscreen API as the primary experience.
5. **Independent state** — the **inline** diagram and the **modal** diagram each maintain **their own** pan/zoom transform (opening or closing the modal does not alter the inline transform).

## 2. Approaches considered

| # | Approach | Pros | Cons |
|---|----------|------|------|
| 1 | **`d3.zoom` inside `ChainTrafficDiagram`** — inner `<g>` for all drawn content; transform kept in a **ref** across D3 redraws | Matches existing D3 lifecycle; no new dependencies | Component file grows slightly |
| 2 | **`ZoomableSvg` wrapper** | Clear separation of zoom vs layout | More props/callback wiring between layers |
| 3 | **Third-party pan–zoom (e.g. react-zoom-pan-pinch)** | Less custom zoom code | Risk of conflict with D3’s full redraw; extra bundle weight |

**Recommendation (approved):** **Approach 1** — implement with **`d3.zoom`** co-located with `ChainTrafficDiagram`, extracting a small helper only if the file becomes hard to follow.

## 3. UX — placement and modal

**Expand control**

- **Position:** top-right of the **Traffic diagram** card — same horizontal band as the **“Traffic diagram”** `h3`, with the icon button **right-aligned** (flex row: title + spacer + button).
- **Accessibility:** treat as a dialog trigger — e.g. `aria-haspopup="dialog"`, `aria-expanded={open}`, and an accessible name such as **“Expand diagram”** or **“Open diagram in large view”**.

**Modal**

- **Presentation:** dimmed **backdrop** + centered (or near-centered) **large panel** occupying most of the viewport; diagram SVG uses the panel’s content width.
- **Dismissal:** **Close** control (icon button with text or `aria-label`) and **Escape** close the modal and return focus to the expand trigger.
- **Backdrop clicks:** **do not** close the modal in v1 (avoids accidental dismiss; only **Close** and **Escape**). This can be revisited in a follow-up spec if desired.

**Reset view**

- **Inline:** place **Reset view** where it is visible without overlapping the graph — e.g. a compact control in the **diagram chrome** (top area of the white diagram frame, or beside the expand icon in the card header — implementation may choose the clearest layout consistent with existing spacing).
- **Modal:** include **Reset view** in the modal header/toolbar area near **Close**.

## 4. Architecture and state

**DOM / D3**

- All content currently drawn by D3 in `useLayoutEffect` must be appended under a single inner **`<g>`** (e.g. `contentRoot`). **`d3.zoom`** attaches to the **`<svg>`** (or, if needed for hit targets, a full-viewport transparent `<rect>` under the zoom behavior) and updates **`transform(translate, scale)`** on that inner group.
- **Transform storage:** keep the active **`d3.zoomIdentity`-compatible transform** in a **`useRef`**, not React state, to avoid re-renders on every pan/zoom tick. After each **full redraw** (effect re-run), **re-apply** the ref transform to `contentRoot` so pan/zoom survives width/routing-driven repaints.

**When to reset transform automatically**

- **On “logical diagram identity” change:** reset pan/zoom to identity when the user switches to a **different chain**, toggles **create vs edit** in a way that changes the rendered hop set, or when the **ordered hop ids** (by position) change — so a new or reordered chain starts from a default framing.
- **Do not** reset solely because **routing** data refreshes for the **same** hops (e.g. refetch completes): preserve the user’s zoom/pan unless the identity key changed.

**Implementation mechanism for identity**

- Add an explicit prop to `ChainTrafficDiagram`, e.g. **`diagramKey: string`**, computed on **`ChainsPage`** from mode, selected chain id (if any), and ordered hop ids. The diagram compares previous vs current key in the effect (or `useEffect`/`useLayoutEffect` preamble) and, on change, clears the transform ref and applies identity to `contentRoot` before drawing.

**Modal wiring (`ChainsPage`)**

- **State:** boolean `diagramModalOpen` (or equivalent).
- **Second measurement:** the modal body hosts a **`ResizeObserver`** (same pattern as the inline diagram wrapper) so **`width`** passed to the modal `ChainTrafficDiagram` tracks the panel width.
- **Props parity:** modal instance receives the **same** `hops`, `routingByChainHopId`, `routingFailedChainHopIds`, `routingLoading`, and `draftLabels` as the inline diagram; **`diagramKey`** should be **shared** so both instances reset together when the chain/hops identity changes (each still holds its own transform ref **until** key change — on key change, both reset).

**Wheel and scroll**

- Ensure wheel interaction over the **diagram** is handled so the **page does not scroll** when the user intends to zoom. **`d3.zoom`**’s default filter typically allows wheel zoom; verify in implementation that the **Chains** page layout does not receive stray wheel deltas when the pointer is over the SVG.

## 5. Edge cases and errors

- **`width <= 0`:** keep current behavior — do not render a broken SVG or attach zoom to a zero-size surface; modal may briefly have zero width before the first observer callback.
- **Empty / draft-only diagram:** pan/zoom and reset may be **no-ops** or low-value but should **not** throw; expand remains available if the diagram still renders placeholder content.

## 6. Non-goals

- Browser **Fullscreen API** as the default expand path (out of scope for this spec; modal only).
- **Persisted** zoom/pan across sessions or routes.
- **Pinch-to-zoom** on touch (not required for v1; future enhancement if needed).
- Changing **graph layout algorithms** or **routing rule** semantics.

## 7. Verification

- Run **`bunx tsc -b`** from `apps/web` after changes.
- **Manual:** pan and wheel-zoom inline; open modal, pan/zoom independently; **Reset** in each surface; **Esc** and **Close** dismiss modal; change **chain** or **reorder hops** and confirm **both** surfaces return to identity framing; routing reload **without** hop identity change **preserves** zoom on inline diagram.

## 8. Files expected

- **`apps/web/src/components/ChainTrafficDiagram.tsx`** — inner `<g>`, `d3.zoom`, transform ref, **Reset view** UI, `diagramKey` handling.
- **`apps/web/src/pages/ChainsPage.tsx`** — expand button in diagram card header, modal markup, focus management, second `ResizeObserver` for modal width, pass `diagramKey`.
