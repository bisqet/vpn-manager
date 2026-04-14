# Chain traffic D3 diagram — implementation plan

**Where to find this file:** It lives at `docs/superpowers/plans/2026-04-14-chain-traffic-d3-diagram.md` in the repo. If you only browse the default branch (`master`), merge the branch that added this file; earlier drafts were only on a feature branch and did not appear on `master`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On the Chains page, show a D3 SVG diagram of the full saved chain (Entry → VPN hops) plus per-hop routing (default + rules) so operators see where traffic can go, matching `docs/superpowers/specs/2026-04-14-chain-traffic-d3-diagram-design.md`.

**Architecture:** A pure function builds a serializable `{ nodes, links }` graph from ordered hops and optional per-hop `RoutingProfile` data. A `ChainTrafficDiagram` React component measures its container, uses D3 to render SVG from that graph, and `ChainsPage` widens chain types to match the API, uses `useQueries` to load `/api/routing/by-hop/:id` in parallel for the edited chain, and passes loading/error state into the diagram.

**Tech stack:** React 18, TanStack Query v5, Vite, TypeScript, `d3`, Bun test runner (`bun test`).

---

## File map

| File | Responsibility |
|------|----------------|
| `apps/web/package.json` | Add `d3`, `@types/d3`; add `"test": "bun test src"` script. |
| `package.json` (repo root) | Add script `test:web` → `bun --cwd apps/web test` so CI/agents can run web tests from root (optional but recommended). |
| `apps/web/src/chainTrafficGraph.ts` | Types for graph I/O + `buildChainRoutingGraph` (pure). |
| `apps/web/src/chainTrafficGraph.test.ts` | Bun unit tests for the builder. |
| `apps/web/src/components/ChainTrafficDiagram.tsx` | ResizeObserver, SVG ref, D3 draw, legend, empty/loading/error UI. |
| `apps/web/src/pages/ChainsPage.tsx` | Align `Chain` type with API (`hops`), shared routing types, `useQueries` for routing by hop, render diagram + hint for create mode / unsaved. |

---

### Task 1: Dependencies and web test script

**Files:**

- Modify: `apps/web/package.json`
- Modify: `package.json` (optional)

- [ ] **Step 1: Add dependencies**

From repo root:

```bash
cd apps/web && bun add d3 && bun add -d @types/d3
```

Edit `apps/web/package.json` so `dependencies` includes `"d3": "^7.9.0"` (or whatever version `bun add` resolved) and `devDependencies` includes `"@types/d3": "^7.4.3"` (resolved versions are fine). Add a script:

```json
"scripts": {
  "dev": "vite",
  "build": "tsc -b && vite build",
  "preview": "vite preview",
  "test": "bun test src"
}
```

- [ ] **Step 2: Verify install**

Run:

```bash
bun --cwd apps/web install
```

Expected: completes with no errors.

- [ ] **Step 3: (Optional) Root script for web tests**

In `/workspace/package.json`, under `scripts`, add:

```json
"test:web": "bun --cwd apps/web test"
```

- [ ] **Step 4: Commit**

```bash
git add apps/web/package.json package.json bun.lock
git commit -m "chore(web): add d3 and web test script"
```

---

### Task 2: Pure graph builder (TDD)

**Files:**

- Create: `apps/web/src/chainTrafficGraph.ts`
- Create: `apps/web/src/chainTrafficGraph.test.ts`

**Graph contract (stable ids for tests and D3):**

- **Nodes:** `id`, `kind` (`"entry"` | `"hop"` | `"sink_direct"` | `"sink_block"`), `label`, optional `sublabel`, optional `chainHopId` for hops.
- **Links:** `id`, `sourceId`, `targetId`, optional `label`, `variant` (`"backbone"` | `"continue"` | `"direct"` | `"block"`).

**Id conventions:**

- `entry`, `sink:direct`, `sink:block`
- Hops: `hop:{chainHopId}`
- Rule edges: `link:{chainHopId}:rule:{position}` (rule `position` from API)
- Default action edge: `link:{chainHopId}:default`

**Builder behavior:**

1. Sort hops by `position` ascending.
2. Always emit `entry`, all `hop:*` nodes, and **one each** of `sink:direct` and `sink:block` (shared sinks).
3. **Backbone links:** `entry` → first hop → second hop → … (variant `backbone`).
4. For each hop that has a **`RoutingProfile`** in the input map:
   - Emit **default** edge from that hop:
     - `use_chain`: if there is a **next** hop, add link `hop → hop:next` with variant `continue` and label `default → chain`; if **terminal** hop, **omit** this edge (nothing to draw; server forbids useless default—if API still returns `use_chain`, omit edge to avoid inventing a target).
     - `direct`: link to `sink:direct`, variant `direct`, label `default`.
     - `block`: link to `sink:block`, variant `block`, label `default`.
5. For each **rule** (sorted by `position`), cap at **first 8** rules per hop. For each included rule, add a link from that hop to the target implied by `action` (`use_chain` → next hop if exists; else omit), (`direct` → `sink:direct`), (`block` → `sink:block`). Variant matches action family (`continue` / `direct` / `block`). Label: `` `${matchKind}: ${matchValue}` `` truncated to **40** chars with `…` if longer.
6. If a hop has **more than 8** rules, the builder does **not** emit extra rule links; instead expose **`truncatedRuleCountByHopId: Record<number, number>`** from the builder return value (count of omitted rules only), e.g. `return { nodes, links, truncatedRuleCountByHopId }`.

Export types:

```typescript
export type DefaultAction = "use_chain" | "direct" | "block";
export type RuleAction = "direct" | "use_chain" | "block";
export type MatchKind = "domain" | "cidr";

export type ChainHopInput = {
  id: number;
  position: number;
  vpnProfileId: number;
  label: string;
};

export type RoutingRuleInput = {
  position: number;
  matchKind: MatchKind;
  matchValue: string;
  action: RuleAction;
};

export type RoutingProfileInput = {
  chainHopId: number;
  defaultAction: DefaultAction;
  rules: RoutingRuleInput[];
};

export type GraphNodeKind = "entry" | "hop" | "sink_direct" | "sink_block";

export type GraphNode = {
  id: string;
  kind: GraphNodeKind;
  label: string;
  sublabel?: string;
  chainHopId?: number;
};

export type GraphLinkVariant = "backbone" | "continue" | "direct" | "block";

export type GraphLink = {
  id: string;
  sourceId: string;
  targetId: string;
  label?: string;
  variant: GraphLinkVariant;
};

export type ChainTrafficGraph = {
  nodes: GraphNode[];
  links: GraphLink[];
  truncatedRuleCountByHopId: Record<number, number>;
};

export function buildChainRoutingGraph(
  hops: ChainHopInput[],
  routingByChainHopId: Map<number, RoutingProfileInput>,
): ChainTrafficGraph {
  // implementation
}
```

- [ ] **Step 1: Write failing tests**

Create `apps/web/src/chainTrafficGraph.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { buildChainRoutingGraph } from "./chainTrafficGraph";

const hop = (
  id: number,
  position: number,
  label: string,
  vpnProfileId: number = id,
): import("./chainTrafficGraph").ChainHopInput => ({
  id,
  position,
  vpnProfileId,
  label,
});

describe("buildChainRoutingGraph", () => {
  test("backbone only when routing map is empty", () => {
    const hops = [hop(10, 0, "A"), hop(11, 1, "B")];
    const graph = buildChainRoutingGraph(hops, new Map());
    expect(graph.links.filter((l) => l.variant === "backbone")).toEqual([
      expect.objectContaining({ sourceId: "entry", targetId: "hop:10" }),
      expect.objectContaining({ sourceId: "hop:10", targetId: "hop:11" }),
    ]);
    expect(graph.nodes.some((n) => n.id === "sink:direct")).toBe(true);
    expect(graph.nodes.some((n) => n.id === "sink:block")).toBe(true);
    expect(graph.truncatedRuleCountByHopId).toEqual({});
  });

  test("default direct and rule use_chain to next hop", () => {
    const hops = [hop(1, 0, "First"), hop(2, 1, "Second")];
    const routing = new Map<number, import("./chainTrafficGraph").RoutingProfileInput>();
    routing.set(1, {
      chainHopId: 1,
      defaultAction: "direct",
      rules: [{ position: 0, matchKind: "domain", matchValue: "x.test", action: "use_chain" }],
    });
    const graph = buildChainRoutingGraph(hops, routing);
    expect(graph.links).toContainEqual(
      expect.objectContaining({
        id: "link:1:default",
        sourceId: "hop:1",
        targetId: "sink:direct",
        variant: "direct",
      }),
    );
    expect(graph.links).toContainEqual(
      expect.objectContaining({
        id: "link:1:rule:0",
        sourceId: "hop:1",
        targetId: "hop:2",
        variant: "continue",
      }),
    );
  });

  test("terminal hop default use_chain emits no default continue edge", () => {
    const hops = [hop(5, 0, "Only")];
    const routing = new Map<number, import("./chainTrafficGraph").RoutingProfileInput>();
    routing.set(5, { chainHopId: 5, defaultAction: "use_chain", rules: [] });
    const graph = buildChainRoutingGraph(hops, routing);
    expect(graph.links.find((l) => l.id === "link:5:default")).toBeUndefined();
  });

  test("truncates rules after 8 and reports count", () => {
    const hops = [hop(9, 0, "H")];
    const rules = Array.from({ length: 10 }, (_, i) => ({
      position: i,
      matchKind: "cidr" as const,
      matchValue: `10.0.${i}.0/24`,
      action: "block" as const,
    }));
    const routing = new Map<number, import("./chainTrafficGraph").RoutingProfileInput>();
    routing.set(9, { chainHopId: 9, defaultAction: "direct", rules });
    const graph = buildChainRoutingGraph(hops, routing);
    expect(graph.links.filter((l) => l.id.startsWith("link:9:rule:")).length).toBe(8);
    expect(graph.truncatedRuleCountByHopId[9]).toBe(2);
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

Run:

```bash
bun --cwd apps/web test src/chainTrafficGraph.test.ts
```

Expected: FAIL (module not found or function missing).

- [ ] **Step 3: Implement `chainTrafficGraph.ts`**

Implement `buildChainRoutingGraph` to satisfy all tests: sort hops, create nodes, backbone links, sinks, default links, rule links with truncation.

- [ ] **Step 4: Run tests — expect PASS**

Run:

```bash
bun --cwd apps/web test src/chainTrafficGraph.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Typecheck web**

Run:

```bash
cd apps/web && bunx tsc -b
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/chainTrafficGraph.ts apps/web/src/chainTrafficGraph.test.ts
git commit -m "feat(web): add chain routing graph builder"
```

---

### Task 3: `ChainTrafficDiagram` component + D3 render

**Files:**

- Create: `apps/web/src/components/ChainTrafficDiagram.tsx`

**Props (explicit):**

```typescript
export type ChainTrafficDiagramProps = {
  width: number;
  hops: import("../chainTrafficGraph").ChainHopInput[];
  /** Profiles for hops that finished loading; omit key if still loading */
  routingByChainHopId: Map<number, import("../chainTrafficGraph").RoutingProfileInput>;
  /** Hops where routing fetch failed or 404 */
  routingFailedChainHopIds: Set<number>;
  /** True while any in-flight routing query for displayed hop ids */
  routingLoading: boolean;
  /** Draft hops (create mode): profile labels for backbone only */
  draftProfileLabels?: string[];
  /** When true, show hint that routing appears after save */
  showSaveForRoutingHint?: boolean;
};
```

**Layout algorithm (simple, no extra libraries):**

- Constants: `columnWidth = 140`, `rowHeight = 28`, `padding = 24`, `sinkSpread = 70`.
- Place **entry** at `(padding, padding)`.
- Place **hops** at `(padding + (i + 1) * columnWidth, padding)` for sorted order `i`.
- Place **sinks** at `(padding + (hops.length + 1) * columnWidth, padding + sinkSpread)` for `sink:direct` and `(same x, padding + sinkSpread + 50)` for `sink:block` (adjust so labels do not overlap).
- For **links** that are not backbone, offset control points vertically by rule index (use `linkIndex` per source hop).

**D3 usage:**

- `import * as d3 from "d3";`
- Inside `useLayoutEffect` depending on `[width, hops, routingByChainHopId, routingFailedChainHopIds, routingLoading, ...]`:
  - Call `buildChainRoutingGraph` with hops sorted by `position` and the routing map (only complete profiles; do not put partial data in map).
  - Select SVG, `selectAll("*").remove()` or clear one root `<g>`.
  - Draw circles or rounded rects for nodes, paths for links (use `d3.curveBumpX` or straight lines), text for labels.
- If `width < 320`, still render but scale `viewBox` or reduce font size to 11px.

**UI layers:**

1. If `hops.length === 0` and `!draftProfileLabels?.length`: return `null` or a single line: “Add hops to see traffic flow.”
2. If `draftProfileLabels?.length` and `hops.length === 0`: build synthetic `ChainHopInput[]` with **placeholder ids** `0,1,2…` only for layout — **better:** pass real draft as fake hops with `id: -rowKey` — **avoid negative ids in API calls**; for diagram-only draft backbone, add optional prop `draftHopDisplay: { key: string; label: string }[]` and map to temporary hop ids `-1, -2` internally **only** in diagram for positions, **without** routing. Simpler approach approved: **Create mode:** pass `hops=[]`, `draftProfileLabels={labels}` — component renders **Entry → labels as boxes** with sequential pseudo ids `draft:0`, no routing, plus hint text “Save the chain to load per-hop routing.” **Edit mode:** always pass real `hops` from API with positive ids.

Refine props:

```typescript
export type ChainTrafficDiagramProps = {
  width: number;
  /** Saved chain hops (edit mode). Empty in create mode if only drafts. */
  hops: import("../chainTrafficGraph").ChainHopInput[];
  routingByChainHopId: Map<number, import("../chainTrafficGraph").RoutingProfileInput>;
  routingFailedChainHopIds: Set<number>;
  routingLoading: boolean;
  /** Create mode backbone: ordered profile labels */
  draftLabels?: string[];
};
```

When `draftLabels?.length` and `hops.length === 0`, render draft backbone only + hint. When `hops.length > 0`, ignore `draftLabels` for graph (editor is showing saved hops).

- [ ] **Step 1: Create component skeleton** with props above, call `buildChainRoutingGraph`, render legend (`Continue`, `Direct`, `Block`) using colors: backbone `#111827`, continue `#2563eb`, direct `#059669`, block `#b91c1c` (match app severity colors loosely).

- [ ] **Step 2: Wire ResizeObserver** in parent — actually diagram receives `width` from parent to avoid double observer; **parent** `ChainsPage` holds `const [diagramWidth, setDiagramWidth] = useState(600)` and `ref` + `ResizeObserver` on wrapper `div` around diagram. **Document in Task 4**; diagram is presentational with `width` prop only.

- [ ] **Step 3: Run `bunx tsc -b` in apps/web**

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/ChainTrafficDiagram.tsx
git commit -m "feat(web): add chain traffic D3 diagram component"
```

---

### Task 4: Integrate into `ChainsPage`

**Files:**

- Modify: `apps/web/src/pages/ChainsPage.tsx`

- [ ] **Step 1: Align types with API**

Replace local `Chain` type with:

```typescript
type ChainHop = {
  id: number;
  position: number;
  vpnProfileId: number;
  label: string;
};

type Chain = {
  id: number;
  name: string;
  vpnProfileIds: number[];
  hops: ChainHop[];
};
```

Keep using `vpnProfileIds` from API for anything that still needs it, or derive from `hops.map(h => h.vpnProfileId)` when loading editor — **prefer** `chain.hops` order for editor to preserve `chainHopId` alignment: when entering edit mode, set `hopRows` from `chain.hops` sorted by `position` using `vpnProfileId` and stable row keys.

- [ ] **Step 2: Add fetch helper** (or inline) for routing:

```typescript
function fetchRoutingByHop(chainHopId: number) {
  return apiFetch<RoutingProfile>(`/api/routing/by-hop/${chainHopId}`);
}
```

Define `RoutingProfile` interface matching `RoutingPage` (same fields used).

- [ ] **Step 3: `useQueries` for routing**

When `editorState.mode === "edit"` and `selectedChain` is non-null and `selectedChain.hops.length > 0`:

```typescript
const routingQueries = useQueries({
  queries: selectedChain.hops.map((h) => ({
    queryKey: ["routing", "by-hop", h.id] as const,
    queryFn: () => fetchRoutingByHop(h.id),
    enabled: editorState.mode === "edit" && !!selectedChain,
  })),
});
```

Build `routingByChainHopId` Map: for each successful query, `map.set(hop.id, { chainHopId: profile.chainHopId, defaultAction: profile.defaultAction, rules: profile.rules.map(...) })`.

Build `routingFailedChainHopIds`: query is error and not pending.

`routingLoading`: any query `isPending` or `isFetching` for those hops.

- [ ] **Step 4: Width observer**

Below the hop list (inside the editor card), add:

```tsx
const diagramContainerRef = useRef<HTMLDivElement>(null);
const [diagramWidth, setDiagramWidth] = useState(0);

useLayoutEffect(() => {
  const el = diagramContainerRef.current;
  if (!el) return;
  const ro = new ResizeObserver(() => {
    setDiagramWidth(el.getBoundingClientRect().width);
  });
  ro.observe(el);
  setDiagramWidth(el.getBoundingClientRect().width);
  return () => ro.disconnect();
}, []);
```

- [ ] **Step 5: Render `ChainTrafficDiagram`**

```tsx
<div ref={diagramContainerRef} style={{ width: "100%", minHeight: 200 }}>
  {diagramWidth > 0 ? (
    <ChainTrafficDiagram
      width={diagramWidth}
      hops={isCreateMode ? [] : selectedChain?.hops ?? []}
      draftLabels={
        isCreateMode
          ? hopRows
              .map((row) => profiles.find((p) => String(p.id) === row.vpnProfileId)?.label)
              .filter((x): x is string => !!x)
          : undefined
      }
      routingByChainHopId={routingMap}
      routingFailedChainHopIds={failedSet}
      routingLoading={routingLoading}
    />
  ) : null}
</div>
```

Use sorted hops: `[...(selectedChain?.hops ?? [])].sort((a, b) => a.position - b.position)`.

- [ ] **Step 6: `bunx tsc -b` in apps/web**

Expected: PASS.

- [ ] **Step 7: Manual smoke**

Run `bun --cwd apps/server dev` and `bun --cwd apps/web dev`, open `/chains`, edit a chain with 2+ hops, confirm diagram shows backbone + branches after routing loads.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/pages/ChainsPage.tsx
git commit -m "feat(web): show chain traffic diagram on Chains page"
```

---

### Task 5: Verification and root test script

- [ ] **Step 1: Run unit tests**

```bash
bun --cwd apps/web test src/chainTrafficGraph.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run web typecheck**

```bash
cd apps/web && bunx tsc -b
```

Expected: PASS.

- [ ] **Step 3: Run server tests** (ensure no regressions)

```bash
bun test apps/server
```

Expected: PASS.

- [ ] **Step 4: Final commit** if any fixes were needed; otherwise document “no changes”.

---

## Spec coverage (self-review)

| Spec section | Tasks |
|--------------|--------|
| Data: `GET /api/chains` with `hops` | Task 4 types + editor hydration from `hops` |
| Parallel `GET /api/routing/by-hop/:id` | Task 4 `useQueries` |
| Unsaved / create: backbone + hint | Task 3 `draftLabels`, Task 4 wiring |
| Layout, sinks, rule cap 8, legend | Task 2 truncation + Task 3 rendering |
| Loading / per-hop failure | Task 3 props + Task 4 query state |
| Missing profile | Existing hop row UI; diagram uses `label` from API — if label shows unavailable, pass through; optional: sublabel in builder from hop label string |
| D3 + ResizeObserver | Tasks 3–4 |
| Tests: pure builder | Task 2 |
| `d3` in apps/web | Task 1 |

**Gap closed:** “Missing VPN profile” — server `chain_hops` join already exposes label; if product uses “(unavailable)” in list only when profile missing from list, mirror same string in hop `label` from API when applicable (no extra task if API already returns a sentinel label).

---

## Execution handoff

**Plan complete and saved to `docs/superpowers/plans/2026-04-14-chain-traffic-d3-diagram.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — Dispatch a fresh subagent per task, review between tasks, fast iteration. **REQUIRED SUB-SKILL:** `subagent-driven-development`.

**2. Inline Execution** — Execute tasks in this session using `executing-plans`, batch execution with checkpoints. **REQUIRED SUB-SKILL:** `executing-plans`.

**Which approach?**
