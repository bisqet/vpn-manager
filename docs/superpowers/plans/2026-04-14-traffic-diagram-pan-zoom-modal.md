# Traffic diagram pan, zoom, and expand modal — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add **d3.zoom** pan/wheel-zoom and a **Reset view** control to `ChainTrafficDiagram`, plus a **modal** on `ChainsPage` opened from an **expand** icon in the Traffic diagram card header, matching `docs/superpowers/specs/2026-04-14-traffic-diagram-pan-zoom-modal-design.md`.

**Architecture:** A **`diagramKey` string** (pure helper + unit tests) drives **identity resets** when the chain or hop ordering changes. Each diagram instance keeps **`d3.zoom`** transform in a **`useRef`** so D3 redraws do not lose pan/zoom. All drawn geometry lives under one **inner `<g>`**; **`svg.selectAll("*").remove()`** is replaced by clearing **only** that group’s descendants (or remove/recreate the inner group each run while **re-`svg.call(zoom.transform, …)`** after draw so zoom state stays on the SVG). **`ChainsPage`** owns modal open state, **Escape** / **Close**, a **second `ResizeObserver`**, and passes the **same `diagramKey`** to inline and modal diagrams.

**Tech stack:** React 18, TypeScript, **d3** v7, Bun test runner, existing Vite app (`apps/web`).

**Spec:** `docs/superpowers/specs/2026-04-14-traffic-diagram-pan-zoom-modal-design.md`

---

### Task 1: `trafficDiagramKey` helper (TDD)

**Files:**

- Create: `apps/web/src/trafficDiagramKey.ts`
- Create: `apps/web/src/trafficDiagramKey.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/trafficDiagramKey.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { trafficDiagramKey } from "./trafficDiagramKey";

describe("trafficDiagramKey", () => {
  test("edit mode encodes chain id and hop ids in position order", () => {
    expect(
      trafficDiagramKey({
        mode: "edit",
        chainId: 5,
        hopIdsInOrder: [10, 11],
      }),
    ).toBe("edit:5:10,11");
  });

  test("create mode encodes draft vpn profile id order", () => {
    expect(
      trafficDiagramKey({
        mode: "create",
        draftVpnProfileIdsInOrder: ["3", "7", "3"],
      }),
    ).toBe("create:3,7,3");
  });

  test("create mode normalizes empty draft list", () => {
    expect(
      trafficDiagramKey({
        mode: "create",
        draftVpnProfileIdsInOrder: [],
      }),
    ).toBe("create:");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from repo root):

```bash
bun --cwd apps/web test src/trafficDiagramKey.test.ts
```

Expected: FAIL (module `./trafficDiagramKey` not found or export missing).

- [ ] **Step 3: Implement `trafficDiagramKey`**

Create `apps/web/src/trafficDiagramKey.ts`:

```typescript
export type TrafficDiagramKeyInput =
  | {
      mode: "edit";
      chainId: number;
      hopIdsInOrder: number[];
    }
  | {
      mode: "create";
      draftVpnProfileIdsInOrder: string[];
    };

export function trafficDiagramKey(input: TrafficDiagramKeyInput): string {
  if (input.mode === "edit") {
    return `edit:${input.chainId}:${input.hopIdsInOrder.join(",")}`;
  }
  return `create:${input.draftVpnProfileIdsInOrder.join(",")}`;
}
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
bun --cwd apps/web test src/trafficDiagramKey.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/trafficDiagramKey.ts apps/web/src/trafficDiagramKey.test.ts
git commit -m "feat(web): add trafficDiagramKey helper for diagram identity"
```

---

### Task 2: `ChainTrafficDiagram` — zoom, inner `<g>`, reset, `diagramKey`

**Files:**

- Modify: `apps/web/src/components/ChainTrafficDiagram.tsx`

**Imports to add (top of file):** `useCallback`, `useRef` (already have `useRef`), `useEffect` from `"react"`; `type ZoomBehavior`, `type ZoomTransform` from `"d3"` if you use explicit types; ensure `* as d3` remains.

**Props:** extend `ChainTrafficDiagramProps` with **`diagramKey: string`** (required so callers cannot forget identity resets).

Refs inside the component (conceptual — place declarations next to `svgRef`):

```typescript
const transformRef = useRef<d3.ZoomTransform>(d3.zoomIdentity);
const prevDiagramKeyRef = useRef<string | null>(null);
const zoomBehaviorRef = useRef<d3.ZoomBehavior<SVGSVGElement, unknown> | null>(null);
```

**Key change on mount / identity:** at the **start** of the existing `useLayoutEffect`, before building the graph:

```typescript
if (prevDiagramKeyRef.current !== diagramKey) {
  prevDiagramKeyRef.current = diagramKey;
  transformRef.current = d3.zoomIdentity;
}
```

**SVG structure:** each `useLayoutEffect` run:

1. `const svg = d3.select(svgEl);`
2. `svg.selectAll("*").remove();` then append a single **`g.chain-traffic-zoom-root`** (the **`zoomRoot`** selection). Draw **everything** (empty message, draft-only graph, full graph) **inside** that `g` only — no leftover nodes outside it.
3. After all drawing into `zoomRoot`, create **`d3.zoom`**, store it in **`zoomBehaviorRef`**, and apply:

```typescript
const zoom = d3
  .zoom<SVGSVGElement, unknown>()
  .scaleExtent([0.35, 4])
  .on("zoom", (event) => {
    transformRef.current = event.transform;
    zoomRoot.attr("transform", event.transform.toString());
  });

svg.call(zoom);
zoomBehaviorRef.current = zoom;
svg.call(zoom.transform, transformRef.current);
```

Use **`zoomRoot`** as the d3 selection for the inner `<g>` (variable name your choice). **Filter:** keep default wheel zoom (`d3.zoom` default filter allows wheel unless `ctrlKey` for mac zoom — spec wants **wheel without modifier**; d3 default already allows wheel zoom on non-ctrl wheel for linear zoom).

**Wheel / page scroll:** on the **React wrapper** around the SVG (the `outerStyle` div), add **`onWheel={(e) => { e.preventDefault(); }}`** only when **not** empty state if you want the page to scroll when the placeholder is tiny — spec asks wheel zoom on the **diagram**; for the empty one-line message, allowing page scroll is acceptable. **Minimum:** `onWheel` + `preventDefault` on the wrapper when `!showEmpty` so zooming does not scroll the Chains page.

**Reset control (React):** above the `<svg>`, render a toolbar row (flex, end-aligned):

```tsx
{!showEmpty ? (
  <div style={{ display: "flex", justifyContent: "flex-end", padding: "8px 12px 0" }}>
    <button type="button" className="..." style={...} onClick={handleResetView}>
      Reset view
    </button>
  </div>
) : null}
```

```typescript
const handleResetView = useCallback(() => {
  const svgEl = svgRef.current;
  const zoom = zoomBehaviorRef.current;
  if (!svgEl || !zoom) {
    transformRef.current = d3.zoomIdentity;
    return;
  }
  const svg = d3.select(svgEl);
  transformRef.current = d3.zoomIdentity;
  svg.transition().duration(150).call(zoom.transform, d3.zoomIdentity);
}, []);
```

If **`transition`** causes type friction, use `svg.call(zoom.transform, d3.zoomIdentity)` without transition.

**Branches to wrap:** every path that currently appends to `svg` directly (empty text, draft-only, full graph) must append under **`zoomRoot`** instead, and set **`svg.attr("viewBox", …)`** / **`svg.attr("width", …)`** as today. **Do not** put the legend “outside” the zoom group if the spec expects the whole diagram to zoom — the spec implies the **graphic** zooms; including legend in the zoom group is consistent.

**Dependency array:** add **`diagramKey`** to the `useLayoutEffect` dependency array.

- [ ] **Step 1:** Implement the above in `ChainTrafficDiagram.tsx` (single cohesive edit).

- [ ] **Step 2: Typecheck**

```bash
cd apps/web && bunx tsc -b
```

Expected: PASS (will fail until `ChainsPage` passes `diagramKey` — complete Task 3 in same branch before final green, or add a temporary default only if you split PRs; **prefer** implementing Task 3 immediately after so `tsc` stays green).

- [ ] **Step 3: Manual smoke (local)**

Run `bun --cwd apps/server dev` and `bun --cwd apps/web dev`, open `/chains`, edit a chain with 2+ hops: **drag** pans, **wheel** zooms, **Reset** restores framing, page does not scroll behind while wheeling over the diagram.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/ChainTrafficDiagram.tsx
git commit -m "feat(web): pan, zoom, and reset on chain traffic diagram"
```

---

### Task 3: `ChainsPage` — `diagramKey`, header expand, modal

**Files:**

- Modify: `apps/web/src/pages/ChainsPage.tsx`

- [ ] **Step 1: Compute `diagramKey` with `useMemo`**

Near other `useMemo` blocks (after `sortedHopsForDiagram` / `hopRows` are available):

```typescript
import { trafficDiagramKey } from "../trafficDiagramKey";

const trafficDiagramKeyValue = useMemo(() => {
  if (editorState.mode === "create") {
    return trafficDiagramKey({
      mode: "create",
      draftVpnProfileIdsInOrder: hopRows.map((row) => row.vpnProfileId),
    });
  }
  return trafficDiagramKey({
    mode: "edit",
    chainId: editorState.chainId,
    hopIdsInOrder: sortedHopsForDiagram.map((h) => h.id),
  });
}, [editorState, hopRows, sortedHopsForDiagram]);
```

Pass **`diagramKey={trafficDiagramKeyValue}`** to **both** `ChainTrafficDiagram` instances (inline + modal) in later steps.

- [ ] **Step 2: Modal state + refs + Escape + focus**

Add:

```typescript
const [diagramModalOpen, setDiagramModalOpen] = useState(false);
const modalDiagramContainerRef = useRef<HTMLDivElement>(null);
const [modalDiagramWidth, setModalDiagramWidth] = useState(0);
const modalCloseButtonRef = useRef<HTMLButtonElement>(null);
```

**ResizeObserver for modal** (mirror the existing `diagramContainerRef` pattern in a `useLayoutEffect` that depends on `diagramModalOpen`):

```typescript
useLayoutEffect(() => {
  if (!diagramModalOpen) {
    return;
  }
  const el = modalDiagramContainerRef.current;
  if (!el) {
    return;
  }
  const ro = new ResizeObserver(() => {
    setModalDiagramWidth(el.getBoundingClientRect().width);
  });
  ro.observe(el);
  setModalDiagramWidth(el.getBoundingClientRect().width);
  return () => ro.disconnect();
}, [diagramModalOpen]);
```

**Escape** closes modal (no backdrop close):

```typescript
useEffect(() => {
  if (!diagramModalOpen) {
    return;
  }
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      setDiagramModalOpen(false);
    }
  };
  window.addEventListener("keydown", onKeyDown);
  return () => window.removeEventListener("keydown", onKeyDown);
}, [diagramModalOpen]);
```

**Focus** on open:

```typescript
useEffect(() => {
  if (diagramModalOpen) {
    modalCloseButtonRef.current?.focus();
  }
}, [diagramModalOpen]);
```

- [ ] **Step 3: Restructure Traffic diagram card header**

Replace the lone `<h3>Traffic diagram</h3>` block with a flex header (reuse `sectionHeaderStyle` already in the file — same as other section headers):

```tsx
<div style={sectionHeaderStyle}>
  <h3 style={sectionTitleStyle}>Traffic diagram</h3>
  <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
    <button
      type="button"
      aria-haspopup="dialog"
      aria-expanded={diagramModalOpen}
      aria-label="Expand diagram"
      onClick={() => setDiagramModalOpen(true)}
      style={ghostButtonStyle}
    >
      {/* simple unicode or inline SVG expand icon */}
      ⛶
    </button>
  </div>
</div>
```

Use a minimal **icon** (unicode or 12×12 SVG) consistent with the app’s look; **replace `⛶`** with a proper expand glyph if the design system has one.

**Adjust `sectionTitleStyle` margin** for this header: the title inside the flex row should not duplicate large bottom margin — set `style={{ ...sectionTitleStyle, margin: 0 }}` on this `h3` so spacing stays tight.

Keep the **helper `<p>`** immediately **below** the header row (unchanged copy).

- [ ] **Step 4: Pass `diagramKey` to inline `ChainTrafficDiagram`**

```tsx
<ChainTrafficDiagram
  diagramKey={trafficDiagramKeyValue}
  draftLabels={draftDiagramLabels}
  hops={isCreateMode ? [] : sortedHopsForDiagram}
  routingByChainHopId={routingByChainHopId}
  routingFailedChainHopIds={routingFailedChainHopIds}
  routingLoading={routingLoading}
  width={diagramWidth}
/>
```

- [ ] **Step 5: Modal markup** (portal optional — `position: fixed` overlay at end of the page component’s return is fine)

```tsx
{diagramModalOpen ? (
  <div
    role="presentation"
    style={{
      position: "fixed",
      inset: 0,
      zIndex: 50,
      background: "rgba(15, 23, 42, 0.45)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: "24px",
    }}
  >
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="traffic-diagram-dialog-title"
      style={{
        width: "min(96vw, 1100px)",
        maxHeight: "90vh",
        overflow: "auto",
        borderRadius: "16px",
        background: "#ffffff",
        boxShadow: "0 24px 64px rgba(15, 23, 42, 0.2)",
        padding: "20px",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
        <h3 id="traffic-diagram-dialog-title" style={{ ...sectionTitleStyle, margin: 0 }}>
          Traffic diagram
        </h3>
        <button
          ref={modalCloseButtonRef}
          type="button"
          aria-label="Close diagram"
          onClick={() => setDiagramModalOpen(false)}
          style={ghostButtonStyle}
        >
          Close
        </button>
      </div>
      <div ref={modalDiagramContainerRef} style={{ width: "100%", minHeight: 240 }}>
        {modalDiagramWidth > 0 ? (
          <ChainTrafficDiagram
            diagramKey={trafficDiagramKeyValue}
            draftLabels={draftDiagramLabels}
            hops={isCreateMode ? [] : sortedHopsForDiagram}
            routingByChainHopId={routingByChainHopId}
            routingFailedChainHopIds={routingFailedChainHopIds}
            routingLoading={routingLoading}
            width={modalDiagramWidth}
          />
        ) : null}
      </div>
    </div>
  </div>
) : null}
```

**Backdrop:** do **not** attach `onClick` on the dimmed overlay to close (per spec v1).

- [ ] **Step 6: Typecheck**

```bash
cd apps/web && bunx tsc -b
```

Expected: PASS.

- [ ] **Step 7: Manual smoke**

Expand icon → modal opens, **focus** on Close, **Escape** closes, **inline** diagram still works; **independent** zoom in modal vs inline; switch chain → both reset framing via shared `diagramKey`.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/pages/ChainsPage.tsx
git commit -m "feat(web): expand traffic diagram in modal on Chains page"
```

---

### Task 4: Verification and polish pass

**Files:**

- Modify (only if needed): `apps/web/src/components/ChainTrafficDiagram.tsx`, `apps/web/src/pages/ChainsPage.tsx`

- [ ] **Step 1: Run full web tests**

```bash
bun --cwd apps/web test src
```

Expected: PASS.

- [ ] **Step 2: Run `tsc` again**

```bash
cd apps/web && bunx tsc -b
```

Expected: PASS.

- [ ] **Step 3: Final commit** (only if you made polish fixes)

```bash
git add -A
git commit -m "chore(web): polish traffic diagram modal and zoom"
```

Skip this commit if there is nothing to change.

---

## Plan self-review

| Spec section | Task coverage |
|--------------|---------------|
| §1 Pan / wheel zoom / reset / expand / independent state | Tasks 2–3 |
| §2 Approach 1 (`d3.zoom` in component) | Task 2 |
| §3 UX (header expand, modal, no backdrop close, Reset) | Tasks 2–3 |
| §4 Architecture (`diagramKey`, ref transform, wheel) | Tasks 1–3 |
| §5 Edge cases (`width <= 0`) | Task 3 modal width gate; existing inline gate |
| §6 Non-goals | Not implemented |
| §7 Verification | Tasks 1–4 |

**Placeholder scan:** none. **Type consistency:** `trafficDiagramKey` discriminated union matches `editorState` usage in Task 3.

---

**Plan complete and saved to `docs/superpowers/plans/2026-04-14-traffic-diagram-pan-zoom-modal.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach do you want?**
