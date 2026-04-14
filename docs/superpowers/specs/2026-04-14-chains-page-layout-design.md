# Chains page layout — design

**Date:** 2026-04-14  
**Status:** Approved (design sign-off in session)  
**Scope:** **Web UI only** — rearrange `ChainsPage` so useful content fills the main area better and the **traffic diagram uses maximum horizontal width**. No API, routing, or `ChainTrafficDiagram` graph-semantics changes unless a layout bug is discovered during implementation.

## 1. Problem and intent

The Chains page today uses a **two-column grid** (`minmax(280px, 360px)` + `1fr`). The **chain list** occupies a fixed-width left column with **unused vertical space**, while the **editor and traffic diagram** share the right column. The diagram sits **below** a long form, feels **bottom-heavy**, and its width is limited to the **right column** because `ResizeObserver` measures that inner container.

**Product goals (approved in session):**

1. **Prioritize a bigger diagram** — maximize width first; the chain list and editor may become more compact or move.
2. **Full-width diagram band** — diagram spans nearly the **full main content width**, not the former narrow right column; chain controls + editor sit **above** it.

## 2. Approaches considered

| # | Approach | Pros | Cons |
|---|----------|------|------|
| 1 | **Stacked page:** compact **chain rail** + editor card + **full-width** diagram card | Largest `diagramWidth`; simple model; aligns with `width`-driven D3 layout | More vertical scrolling than split layouts |
| 2 | **Editor \| diagram** split under a slim top bar | Hops + diagram visible together on tall screens | Diagram narrower than (1); responsive rules more complex |
| 3 | **Collapsible sidebar** for chains | Familiar list; reclaim width when collapsed | Extra interaction; default state still constrains width |

**Recommendation (approved):** **Approach 1** — stacked layout with a **full-width diagram** band.

## 3. Page structure and layout

**Root layout**

- Replace the current **two-column** `pageGridStyle` on the page root with a **single-column stack** (or equivalent one primary column), full width of the existing `main` content area.

**Section order (top → bottom)**

1. **Page header + chain rail** — title, short helper copy, **New chain**, and **horizontal chain switcher** (same actions as today: Edit / Editing, Delete, hop count). Use **flex with wrap** or **horizontal scroll** when there are many chains so actions stay reachable.
2. **Editor card** — eyebrow/title, chain name, hops list, validation/mutation errors, **Reset editor** / **Save changes** (or create). Behavior and validation unchanged.
3. **Diagram card** — “Traffic diagram” heading, helper text, `ChainTrafficDiagram`. **No** sibling column consuming horizontal space beside the diagram.

**Diagram measurement**

- Move the `ResizeObserver` **ref** to an inner wrapper that spans the **diagram card’s content width** (i.e. full content column width minus card padding), so `width` passed to `ChainTrafficDiagram` reflects the **widest practical** value for the page.

## 4. Diagram sizing, states, and polish

**Width and height**

- **Width** is the primary lever for perceived “bigger diagram”; implementation must ensure the observer’s element uses the **new** full-width track.
- **Height** remains driven by **`ChainTrafficDiagram`** / D3 intrinsic layout. Optionally apply a **modest `min-height`** on the diagram area if the implementation pass shows an overly flat block for few hops; must not break empty/create states or clipping.

**Parity**

- **Create vs edit**, **draft labels**, **empty hops**, **routing loading/errors**, and links to the Routing page behave as today — only **placement** in the stacked layout changes.
- Keep the diagram section **present** across modes where it already renders (including empty/draft cases) to avoid **layout jump** when switching modes.

## 5. Non-goals and risks

**Out of scope**

- Routing APIs, SQLite, export formats, Routing page UI.
- Changing **graph semantics** or hop/routing data models inside `ChainTrafficDiagram` (layout math stays unless a defect appears).
- New features: sticky diagram, persisted collapse state, tabs, print layout — defer to future specs if desired.

**Accepted trade-off**

- **More vertical scrolling** than a side-by-side layout, in exchange for **maximum diagram width**.

## 6. Verification

- `bunx tsc -b` from `apps/web` after the layout refactor.
- **Manual:** window resize → diagram rescales; many chains → rail scrolls/wraps without hiding primary actions; create / edit / save / delete unchanged.

## 7. Implementation notes (non-binding)

- Prefer **small extractions** (e.g. chain rail vs editor vs diagram sections) only if it keeps `ChainsPage.tsx` readable; avoid unrelated refactors.
- Reuse existing styles where possible; adjust spacing for the **rail** and **single-column** cards consistently with the rest of the web app.
