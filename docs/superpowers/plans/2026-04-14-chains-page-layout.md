# Chains page stacked layout — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor `ChainsPage` to a **single-column stack** with a **horizontal chain rail** and a **full-width traffic diagram** band so `ChainTrafficDiagram` receives a **wider** `width` from `ResizeObserver`, matching `docs/superpowers/specs/2026-04-14-chains-page-layout-design.md`.

**Architecture:** Replace the root two-column CSS grid with a **one-column grid stack** of three cards: **(1)** page title + **New chain** + **chain rail**, **(2)** editor (name, hops, actions), **(3)** diagram only. Move the `diagramContainerRef` + `ChainTrafficDiagram` out of the editor card into the third card so measured width tracks the **full content column**. Extract **layout-only style tokens** to a tiny module covered by a **Bun unit test** so the “no sidebar column” invariant does not regress silently.

**Tech stack:** React 18, Vite, TypeScript, TanStack Query v5, Bun test (`bun test src` in `apps/web`).

---

## File map

| File | Responsibility |
|------|----------------|
| `apps/web/src/chainsPageLayout.ts` | **New.** Exported `CSSProperties` tokens for the stacked root grid and chain rail container (no React imports required beyond `CSSProperties`). |
| `apps/web/src/chainsPageLayout.test.ts` | **New.** Bun tests asserting root grid is single-column and rail overflow intent. |
| `apps/web/src/pages/ChainsPage.tsx` | Reorder JSX into three `<section>` cards; swap `pageGridStyle` for imported stack style; move diagram block; add rail styles; remove unused `pageGridStyle`. |
| `apps/web/src/components/ChainTrafficDiagram.tsx` | **No changes** unless a layout bug appears (out of scope per spec). |

---

### Task 1: Layout tokens (TDD)

**Files:**

- Create: `apps/web/src/chainsPageLayout.ts`
- Create: `apps/web/src/chainsPageLayout.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/chainsPageLayout.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import {
  chainsPageRootStackStyle,
  chainRailStyle,
} from "./chainsPageLayout";

describe("chains page layout tokens", () => {
  test("root stack is a single-column grid (no fixed sidebar track)", () => {
    expect(chainsPageRootStackStyle.display).toBe("grid");
    expect(chainsPageRootStackStyle.gridTemplateColumns).toBe("minmax(0, 1fr)");
    expect(String(chainsPageRootStackStyle.gridTemplateColumns)).not.toContain("280px");
  });

  test("chain rail scrolls horizontally when content overflows", () => {
    expect(chainRailStyle.display).toBe("flex");
    expect(chainRailStyle.flexWrap).toBe("nowrap");
    expect(chainRailStyle.overflowX).toBe("auto");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
bun --cwd apps/web test src/chainsPageLayout.test.ts
```

Expected: **FAIL** (cannot resolve `./chainsPageLayout` or file exports missing).

- [ ] **Step 3: Add minimal module with intentionally wrong root columns**

Create `apps/web/src/chainsPageLayout.ts`:

```typescript
import type { CSSProperties } from "react";

export const chainsPageRootStackStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(280px, 360px) minmax(0, 1fr)",
  gap: "24px",
  alignItems: "start",
};

export const chainRailStyle: CSSProperties = {
  display: "flex",
  flexWrap: "nowrap",
  gap: "12px",
  overflowX: "auto",
  paddingBottom: "4px",
};
```

Run:

```bash
bun --cwd apps/web test src/chainsPageLayout.test.ts
```

Expected: **FAIL** on `root stack is a single-column grid` assertion.

- [ ] **Step 4: Fix exports to match the spec**

Edit `apps/web/src/chainsPageLayout.ts` so `chainsPageRootStackStyle.gridTemplateColumns` is **`"minmax(0, 1fr)"`** (keep `gap` / `alignItems` the same as today’s page root: `24px`, `start`).

Run:

```bash
bun --cwd apps/web test src/chainsPageLayout.test.ts
```

Expected: **PASS**.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/chainsPageLayout.ts apps/web/src/chainsPageLayout.test.ts
git commit -m "test(web): lock chains page stacked layout tokens"
```

---

### Task 2: `ChainsPage` — three stacked cards + chain rail

**Files:**

- Modify: `apps/web/src/pages/ChainsPage.tsx`

**Imports:** add:

```typescript
import {
  chainRailStyle,
  chainsPageRootStackStyle,
} from "../chainsPageLayout";
```

Remove the local `pageGridStyle` constant at the bottom of the file (after wiring), since the stack style now lives in `chainsPageLayout.ts`.

- [ ] **Step 1: Swap the root grid style**

Change the outermost wrapper in the component `return` from:

```tsx
<div style={pageGridStyle}>
```

to:

```tsx
<div style={chainsPageRootStackStyle}>
```

- [ ] **Step 2: Split the old left column into “header + rail” inside one card**

Replace the first `<section style={cardStyle}>` (today: title + **New chain** + vertical list) with a structure like:

```tsx
<section style={cardStyle}>
  <div style={headerRowStyle}>
    <div>
      <div style={eyebrowStyle}>Chains</div>
      <h2 style={pageTitleStyle}>VPN chains</h2>
      <p style={helperTextStyle}>
        Build ordered multi-hop routes by combining the VPN profiles you already manage.
      </p>
    </div>
    <button
      disabled={isSaving}
      onClick={handleNewChain}
      style={primaryButtonStyle}
      type="button"
    >
      New chain
    </button>
  </div>

  {chainsQuery.isPending ? (
    <div style={emptyStateStyle}>Loading chains...</div>
  ) : chainsQuery.isError ? (
    <div style={errorStyle}>{getErrorMessage(chainsQuery.error)}</div>
  ) : chains.length === 0 ? (
    <div style={emptyStateStyle}>No chains yet. Create one to get started.</div>
  ) : (
    <div style={{ marginTop: "20px" }}>
      <div style={chainRailStyle}>
        {chains.map((chain) => {
          const isSelected =
            editorState.mode === "edit" && editorState.chainId === chain.id;
          const isDeletingThisChain =
            isDeleting && deleteMutation.variables === chain.id;

          return (
            <article
              key={chain.id}
              style={{
                ...chainCardStyle,
                borderColor: isSelected ? "#111827" : "#e5e7eb",
                background: isSelected ? "#f9fafb" : "#ffffff",
                minWidth: "240px",
                flex: "0 0 auto",
              }}
            >
              <div style={chainCardContentStyle}>
                <div>
                  <h3 style={chainNameStyle}>{chain.name}</h3>
                  <div style={chainMetaStyle}>
                    {chain.vpnProfileIds.length}{" "}
                    {chain.vpnProfileIds.length === 1 ? "hop" : "hops"}
                  </div>
                </div>
                <div style={actionRowStyle}>
                  <button
                    disabled={isSaving || isDeletingThisChain}
                    onClick={() => loadChainIntoEditor(chain)}
                    style={secondaryButtonStyle}
                    type="button"
                  >
                    {isSelected ? "Editing" : "Edit"}
                  </button>
                  <button
                    disabled={isDeletingThisChain}
                    onClick={() => void handleDelete(chain)}
                    style={dangerButtonStyle}
                    type="button"
                  >
                    {isDeletingThisChain ? "Deleting..." : "Delete"}
                  </button>
                </div>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  )}
</section>
```

Notes:

- Reuse existing styles (`chainCardStyle`, `chainCardContentStyle`, etc.) so visuals stay consistent.
- `minWidth` + `flex: 0 0 auto` keeps each chain card readable while the rail scrolls (`overflowX: "auto"`).

- [ ] **Step 3: Keep the editor in its own middle card (diagram removed)**

The second `<section style={cardStyle}>` should contain **only**:

- `editorHeaderStyle` block (eyebrow / title / helper)
- mutation error banner
- the `<form>...</form>` exactly as today (chain name, hops, actions)

**Delete** from this section the entire `<div ref={diagramContainerRef} style={diagramSectionStyle}> ... ChainTrafficDiagram ... </div>` block (it moves to Task 3).

- [ ] **Step 4: Remove unused list style**

If `listStyle` becomes unused after the rail change, delete the `listStyle` constant from the style block at the bottom of `ChainsPage.tsx` to avoid TS unused warnings.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/ChainsPage.tsx
git commit -m "feat(web): stack chains header and chain rail on ChainsPage"
```

---

### Task 3: Full-width diagram card + `ResizeObserver` wiring

**Files:**

- Modify: `apps/web/src/pages/ChainsPage.tsx`

- [ ] **Step 1: Add a third `<section style={cardStyle}>` after the editor card**

Append:

```tsx
<section style={cardStyle}>
  <h3 style={sectionTitleStyle}>Traffic diagram</h3>
  <p style={helperTextStyle}>
    VPN hop order and per-hop routing. Edit routing rules on the Routing page.
  </p>
  <div ref={diagramContainerRef} style={diagramMeasureStyle}>
    {diagramWidth > 0 ? (
      <ChainTrafficDiagram
        draftLabels={draftDiagramLabels}
        hops={isCreateMode ? [] : sortedHopsForDiagram}
        routingByChainHopId={routingByChainHopId}
        routingFailedChainHopIds={routingFailedChainHopIds}
        routingLoading={routingLoading}
        width={diagramWidth}
      />
    ) : null}
  </div>
</section>
```

- [ ] **Step 2: Replace `diagramSectionStyle` with a measurement wrapper style**

Remove `diagramSectionStyle` (margin-top + border-top were for “below the form inside the same card”). Add `diagramMeasureStyle` next to the other style constants:

```typescript
const diagramMeasureStyle: CSSProperties = {
  marginTop: "12px",
  width: "100%",
};
```

Rationale: the diagram now has its **own** card; a heavy top border between form and diagram is no longer required. Keep a small `marginTop` for breathing room under the helper text.

- [ ] **Step 3: Confirm `useLayoutEffect` still observes `diagramContainerRef`**

No logic change expected: the ref must attach to the **new** full-width wrapper (`diagramMeasureStyle`). On first paint and window resize, `diagramWidth` should jump to roughly the **main column width** (wider than the old right column).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/pages/ChainsPage.tsx
git commit -m "feat(web): move traffic diagram to full-width card on ChainsPage"
```

---

### Task 4: Typecheck + full web unit suite

**Files:**

- None (verification only)

- [ ] **Step 1: Run the web unit tests**

Run:

```bash
bun --cwd apps/web test src
```

Expected: **PASS** (includes `chainTrafficGraph.test.ts` + `chainsPageLayout.test.ts`).

- [ ] **Step 2: Run the TypeScript project build**

Run:

```bash
cd apps/web && bunx tsc -b
```

Expected: **exit code 0**, no diagnostics.

- [ ] **Step 3: Commit (only if you fixed issues)**

If you changed files while fixing type errors, commit them with a message explaining the fix. If no changes were needed, skip this commit.

---

### Task 5: Manual QA checklist (required by spec)

**Files:**

- None

- [ ] **Step 1: Run the dev stack**

Terminal A:

```bash
bun --cwd apps/server dev
```

Terminal B:

```bash
bun --cwd apps/web dev
```

Open the Chains page in the browser.

- [ ] **Step 2: Resize the window**

Drag the window wider/narrower while a chain with **2+ hops** is selected.

Expected: diagram **rescales** smoothly; no console errors from D3.

- [ ] **Step 3: Chain rail overflow**

If you only have a few chains locally, temporarily duplicate entries in the UI is not required—instead narrow the window until the rail scrolls.

Expected: **horizontal scroll** appears (`overflow-x: auto`); **Edit/Delete** remain usable.

- [ ] **Step 4: CRUD smoke**

Create a chain, edit hops, save, delete a chain (or use existing flows).

Expected: same behavior as before the layout change.

- [ ] **Step 5: (Optional) `min-height` polish**

Only if the diagram feels vertically cramped with **one hop**, add a cautious `minHeight` to `diagramMeasureStyle` (e.g. `"320px"`) and re-run Steps 1–2 of Task 4. If it causes clipping or awkward empty states, **revert** the `minHeight` (YAGNI).

---

## Plan self-review

**Spec coverage:**

| Spec section | Plan tasks |
|--------------|------------|
| Single-column root / remove sidebar column | Task 1 (test) + Task 2 Step 1–2 |
| Order: header+rail → editor → diagram | Task 2 + Task 3 |
| Full-width `ResizeObserver` | Task 3 |
| Parity / no API changes | Implicit (JSX move only); Task 5 CRUD |
| Verification (`tsc` + manual) | Tasks 4–5 |

**Placeholder scan:** none intentionally included.

**Type consistency:** Style exports are `CSSProperties`; `ChainsPage` continues passing the same props into `ChainTrafficDiagram`.

---

**Plan complete and saved to `docs/superpowers/plans/2026-04-14-chains-page-layout.md`. Two execution options:**

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration. **Required sub-skill:** `superpowers:subagent-driven-development`.

2. **Inline execution** — run tasks in this session with checkpoints. **Required sub-skill:** `superpowers:executing-plans`.

**Which approach do you want?**
