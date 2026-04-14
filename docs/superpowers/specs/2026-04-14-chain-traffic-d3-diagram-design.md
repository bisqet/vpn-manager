# Chain screen — D3 traffic diagram (hops + per-hop routing)

**Date:** 2026-04-14  
**Status:** Approved (design sign-off in session)  
**Scope:** **Web UI only** — `ChainsPage` (or adjacent components). Visualize the **full VPN hop chain** and **per-hop routing** (default + rules) so operators see **where traffic can go** at each hop. **Does not** add routing editing on the Chains screen; routing continues to be edited on the **Routing** page.

## 1. Problem and intent

Operators building chains need a **single glance** at:

1. **Chain topology:** ordered VPN profiles (hops) from entry through the chain.
2. **Policy topology at each hop:** default action and each rule (domain / CIDR → `direct` | `use_chain` | `block`) so traffic paths are visible alongside the hop list.

The diagram is **policy / structure**, not live traffic or metrics.

## 2. Data sources (approved approach)

**Primary approach:** reuse existing APIs; **no new backend** in the first version unless performance requires it later.

1. **`GET /api/chains`** — align the web client with the **full** server payload: each chain includes **`hops`** with stable **`id`** (`chainHopId`), **`position`**, **`vpnProfileId`**, **`label`** (same shape as `RoutingPage` today). The list endpoint already returns this; **narrow typings on `ChainsPage` are updated** to match.
2. For the chain currently shown in the editor (only when the chain **exists in the DB** — i.e. after at least one successful save), fetch routing **in parallel** for each hop: **`GET /api/routing/by-hop/:chainHopId`**.

**Unsaved / create mode:** hops exist only as **draft rows** (profile ids) without `chainHopId`. The diagram shows the **backbone** (Entry → selected profiles in order) **without** routing branches, plus copy that **routing appears after the chain is saved** (routing profiles are created per hop on the server).

**Optional future optimization:** a single bundled endpoint (e.g. chain + all hop routing) if chains routinely have many hops or latency becomes an issue — **out of scope** for v1 unless measured need.

## 3. Visual design (D3)

**Layout**

- **Left → right** = traffic flow.
- **Backbone:** **Entry → hop 1 → hop 2 → … → last hop** on one clear horizontal band.
- **Per-hop routing:** from **each hop node**, branches to **outcomes**:
  - **`use_chain`:** continue to the **next hop** on the backbone (or end of chain if last hop; server/UI already restrict invalid `use_chain` on terminal hop — diagram **reflects** returned data, does not invent paths).
  - **`direct`:** edge to a **Direct** sink node (or shared sink per diagram).
  - **`block`:** edge to a **Blocked** sink.
- **Rules:** each rule is an edge (or grouped label) showing **match kind** (domain / CIDR), **match value** (truncated if very long), and **action**. Stack branches **vertically** per hop to reduce crossing into the next hop’s column.
- **Many rules:** show the **first N** (e.g. 8) with text **“+N more rules — edit on Routing page”**; no expand/collapse unless added in a later iteration.

**Encoding**

- Hop nodes: **profile label** and **#id** if helpful; styling consistent with existing Chains cards (neutral background, dark text).
- **Continue chain** edges: same visual weight as backbone; **Direct** / **Block** distinguishable (e.g. stroke style or muted palette). **Legend** above or below: Continue, Direct, Block, Domain, CIDR.

**Technology**

- **`d3`** in the web app: measure container, bind data, draw SVG (paths + text). Prefer **redraw from props** on data/size change over long-lived global selections. **ResizeObserver** (or equivalent) for responsive width.

## 4. React integration

- **`ChainTrafficDiagram`** (name indicative): props = ordered hops with ids + labels + **map or array of routing profiles keyed by `chainHopId`**, plus loading/error flags per hop if needed.
- **Parent (`ChainsPage`)** owns: which chain is in the editor, **parallel queries** (`useQueries`) for `by-hop` when `editorState.mode === 'edit'` and hop ids exist; merge results into props.
- **Lifecycle:** `useRef` for SVG root; on update, **clear and redraw** (or single root `g`) to stay Strict Mode–safe. No routing **mutations** from this component.

## 5. Loading, errors, empty states

- **Loading routing:** placeholder or skeleton in the diagram area; optional: show **backbone** immediately when hop list is known, then **attach branches** as responses arrive.
- **Per-hop failure:** render backbone; for failed hop show **“Routing unavailable”** and skip branches for that hop only.
- **Missing VPN profile** (deleted profile): node shows **unavailable** state, aligned with hop list behavior.
- **Zero hops:** omit diagram or one-line hint (“Add hops to see traffic flow”).

## 6. Testing

- **Pure module:** `buildChainRoutingGraph(chainHops, routingByHopId)` → `{ nodes, links }` (or equivalent) with stable, serializable shapes. Unit tests cover: default actions, multiple rules, `direct` / `use_chain` / `block`, domain vs cidr labels, terminal hop data as returned by API.
- **Optional:** shallow mount test that the diagram component renders with minimal props without throwing.

## 7. Explicit non-goals

- Editing routing from the Chains page.
- Live traffic, bandwidth, or health metrics on the diagram.
- New export schema or server-side graph DTO for v1.

## 8. Dependencies

- Add **`d3`** (and TypeScript types **`@types/d3`** if required by the toolchain) to **`apps/web`** only.
