# Routing default actions (`block` + terminal constraint) — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow **`default_action`** values **`use_chain` | `direct` | `block`**, forbid **`use_chain`** as the default on the **terminal** hop, migrate existing DBs (terminal **`use_chain` → `direct`**), and align **API**, **export v2**, **chain creation**, and **Routing** UI.

**Architecture:** Add **`migrateRoutingDefaultActionsIfNeeded(db)`** after **`migratePerHopRoutingIfNeeded`** in **`migrate()`**: idempotently widen SQLite **`CHECK`** on **`routing_profiles`** (table rebuild if needed, preserving **`id`** for **`rules`** FKs), then run a single **`UPDATE`** that fixes terminal profiles. Enforce the terminal rule in **`PATCH /api/routing`** with a small SQL helper. Set **`direct`** only for the last hop when inserting routing profiles in **`chains.ts`**. Extend **`ExportV2`** unions and **`RoutingPage`** radios.

**Tech Stack:** Bun, `bun:sqlite`, Hono, Bun test runner, React + TanStack Query.

**Spec:** `docs/superpowers/specs/2026-04-14-routing-default-actions-design.md`

---

## File structure (create / modify)

| Path | Responsibility |
|------|----------------|
| `apps/server/src/db/migrateRoutingDefaultActions.ts` | **New.** Idempotent: widen `default_action` CHECK to include `block`; coerce terminal `use_chain` → `direct`. |
| `apps/server/src/db/migrateRoutingDefaultActions.test.ts` | **New.** Legacy two-value CHECK fixture; asserts widen + coercion + `block` insert. |
| `apps/server/src/db/migrate.ts` | Call `migrateRoutingDefaultActionsIfNeeded(db)` after `migratePerHopRoutingIfNeeded(db)`. |
| `apps/server/src/db/schema.sql` | `routing_profiles.default_action` CHECK lists three values. |
| `apps/server/src/db/migratePerHopRouting.ts` | Update **`routing_profiles__migrated`** DDL `CHECK` to include **`block`** so legacy rebuild path matches greenfield. |
| `apps/server/src/db/migrate.test.ts` | Optional: assert `sqlite_master` DDL for `routing_profiles` contains **`block`** after `migrate()` on fresh DB. |
| `apps/server/src/routes/routing.ts` | `DefaultAction` + `isDefaultAction`; terminal check before `UPDATE`; stable 400 message. |
| `apps/server/src/routes/routing.test.ts` | Terminal vs non-terminal PATCH cases; `defaultAction: "block"`; update `seedRoutingProfileForHop` typing. |
| `apps/server/src/routes/chains.ts` | `insertRoutingProfilesForHops`: last position → `direct`, else `use_chain`. |
| `apps/server/src/routes/chains.test.ts` | Expected `default_action` rows for create + patch replace hops (incl. single-hop). |
| `apps/server/src/export/buildExport.ts` | Widen `ExportV2` and `HopRow` `default_action` unions. |
| `apps/server/src/export/buildExport.test.ts` | Fixture with `block`; assert JSON field. |
| `apps/web/src/pages/RoutingPage.tsx` | Third default radio; hide/disable Use chain on terminal; coerce state on hop switch / load. |

---

### Task 1: `migrateRoutingDefaultActionsIfNeeded` (TDD)

**Files:**
- Create: `apps/server/src/db/migrateRoutingDefaultActions.ts`
- Create: `apps/server/src/db/migrateRoutingDefaultActions.test.ts`

**Behavior (lock this in):**

1. If `SELECT sql FROM sqlite_master WHERE type='table' AND name='routing_profiles'` contains the substring **`'block'`** (inside the `CHECK`), the **`CHECK`** is already wide — **skip the rebuild**.
2. Otherwise rebuild `routing_profiles` like **`rebuildRoutingProfilesWithoutChainId`** in `migratePerHopRouting.ts`: `CREATE TABLE routing_profiles__wide (...)`, `INSERT INTO routing_profiles__wide (id, name, default_action, chain_hop_id) SELECT id, name, default_action, chain_hop_id FROM routing_profiles`, `DROP TABLE routing_profiles`, `ALTER TABLE routing_profiles__wide RENAME TO routing_profiles`, then `CREATE UNIQUE INDEX IF NOT EXISTS routing_profiles_chain_hop_id_key ON routing_profiles(chain_hop_id);`  
   - `default_action` column: `TEXT NOT NULL CHECK (default_action IN ('use_chain','direct','block'))`  
   - Use `PRAGMA foreign_keys = OFF` around `DROP`/`RENAME` if required by SQLite (mirror proven pattern from `migratePerHopRoutingIfNeeded` transaction).
3. Always run terminal coercion **`UPDATE`** (idempotent):

```sql
UPDATE routing_profiles
SET default_action = 'direct'
WHERE default_action = 'use_chain'
  AND id IN (
    SELECT rp.id
    FROM routing_profiles rp
    JOIN chain_hops ch ON ch.id = rp.chain_hop_id
    JOIN (
      SELECT chain_id, MAX(position) AS max_pos
      FROM chain_hops
      GROUP BY chain_id
    ) t ON t.chain_id = ch.chain_id AND ch.position = t.max_pos
  );
```

Export **`migrateRoutingDefaultActionsIfNeeded(db: Database): void`**.

- [ ] **Step 1: Write failing test** in `migrateRoutingDefaultActions.test.ts`

```ts
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrateRoutingDefaultActionsIfNeeded } from "./migrateRoutingDefaultActions";

function createDbWithTwoValueCheck() {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(`
    CREATE TABLE chains (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
    CREATE TABLE vpn_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT NOT NULL,
      host TEXT NOT NULL,
      ssh_port INTEGER NOT NULL,
      ssh_user TEXT NOT NULL,
      ssh_password_ciphertext BLOB NOT NULL,
      ssh_password_nonce BLOB NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE chain_hops (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chain_id INTEGER NOT NULL REFERENCES chains(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      vpn_profile_id INTEGER NOT NULL REFERENCES vpn_profiles(id) ON DELETE RESTRICT,
      UNIQUE (chain_id, position),
      UNIQUE (chain_id, vpn_profile_id)
    );
    CREATE TABLE routing_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      chain_hop_id INTEGER NOT NULL UNIQUE REFERENCES chain_hops(id) ON DELETE CASCADE,
      default_action TEXT NOT NULL CHECK (default_action IN ('use_chain','direct'))
    );
    CREATE TABLE rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      routing_profile_id INTEGER NOT NULL REFERENCES routing_profiles(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      match_kind TEXT NOT NULL CHECK (match_kind IN ('domain','cidr')),
      match_value TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('direct','use_chain','block')),
      UNIQUE (routing_profile_id, position)
    );
  `);
  const vp = Number(
    db
      .query(
        `INSERT INTO vpn_profiles (label, host, ssh_port, ssh_user, ssh_password_ciphertext, ssh_password_nonce)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run("A", "a.example.com", 22, "u", new Uint8Array([1]), new Uint8Array([2])).lastInsertRowid,
  );
  const chainId = Number(db.query("INSERT INTO chains (name) VALUES (?)").run("C").lastInsertRowid);
  const hop0 = Number(db.query("INSERT INTO chain_hops (chain_id, position, vpn_profile_id) VALUES (?, ?, ?)").run(chainId, 0, vp).lastInsertRowid);
  const hop1 = Number(db.query("INSERT INTO chain_hops (chain_id, position, vpn_profile_id) VALUES (?, ?, ?)").run(chainId, 1, vp).lastInsertRowid);
  db.query("INSERT INTO routing_profiles (name, chain_hop_id, default_action) VALUES (?, ?, ?)").run("p0", hop0, "use_chain");
  db.query("INSERT INTO routing_profiles (name, chain_hop_id, default_action) VALUES (?, ?, ?)").run("p1", hop1, "use_chain");
  return { db, hop0, hop1 };
}

test("widens CHECK, allows block, coerces terminal use_chain to direct", () => {
  const { db, hop0, hop1 } = createDbWithTwoValueCheck();

  migrateRoutingDefaultActionsIfNeeded(db);

  const rows = db
    .query<{ chain_hop_id: number; default_action: string }, []>(
      "SELECT chain_hop_id, default_action FROM routing_profiles ORDER BY chain_hop_id ASC",
    )
    .all();
  expect(rows).toEqual([
    { chain_hop_id: hop0, default_action: "use_chain" },
    { chain_hop_id: hop1, default_action: "direct" },
  ]);

  db.query("UPDATE routing_profiles SET default_action = ? WHERE chain_hop_id = ?").run("block", hop0);
  expect(
    db.query<{ default_action: string }, [number]>("SELECT default_action FROM routing_profiles WHERE chain_hop_id = ?").get(hop0),
  ).toEqual({ default_action: "block" });
});
```

- [ ] **Step 2: Run test — expect FAIL**

Run: `bun test apps/server/src/db/migrateRoutingDefaultActions.test.ts`

Expected: FAIL (module or function missing / logic not implemented).

- [ ] **Step 3: Implement** `migrateRoutingDefaultActions.ts` per behavior above (detection via `sqlite_master.sql` substring **`'block'`**).

- [ ] **Step 4: Run test — expect PASS**

Run: `bun test apps/server/src/db/migrateRoutingDefaultActions.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/db/migrateRoutingDefaultActions.ts apps/server/src/db/migrateRoutingDefaultActions.test.ts
git commit -m "feat(db): migrate routing default_action block and terminal coerce"
```

---

### Task 2: Wire migration + greenfield schema + legacy rebuild DDL

**Files:**
- Modify: `apps/server/src/db/migrate.ts`
- Modify: `apps/server/src/db/schema.sql`
- Modify: `apps/server/src/db/migratePerHopRouting.ts` (only the `CHECK` inside `routing_profiles__migrated`)

- [ ] **Step 1:** In `migrate.ts`, import and call **`migrateRoutingDefaultActionsIfNeeded(db)`** immediately after **`migratePerHopRoutingIfNeeded(db)`**.

```ts
import { migrateRoutingDefaultActionsIfNeeded } from "./migrateRoutingDefaultActions";

export function migrate(db: Database): void {
  db.exec(schema);
  migratePerHopRoutingIfNeeded(db);
  migrateRoutingDefaultActionsIfNeeded(db);
}
```

- [ ] **Step 2:** In `schema.sql`, change `routing_profiles` line to:

```sql
default_action TEXT NOT NULL CHECK (default_action IN ('use_chain','direct','block'))
```

- [ ] **Step 3:** In `migratePerHopRouting.ts`, update the `CREATE TABLE routing_profiles__migrated` string so its `CHECK` includes **`'block'`** (same three literals as `schema.sql`).

- [ ] **Step 4:** Run full server tests

Run: `bun test apps/server`

Expected: PASS (routing/chains tests pick up new migrate on `:memory:` DBs).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/db/migrate.ts apps/server/src/db/schema.sql apps/server/src/db/migratePerHopRouting.ts
git commit -m "feat(db): wire default_action migration and schema CHECK"
```

---

### Task 3: `PATCH /api/routing` validation + types

**Files:**
- Modify: `apps/server/src/routes/routing.ts`

**Stable error message (use exactly this string in JSON `{ error: ... }` so tests stay deterministic):**

`Terminal hop cannot use defaultAction use_chain; use direct or block.`

- [ ] **Step 1: Extend types**

```ts
type DefaultAction = "use_chain" | "direct" | "block";

function isDefaultAction(value: unknown): value is DefaultAction {
  return value === "use_chain" || value === "direct" || value === "block";
}
```

Update **`RoutingProfileDto`**, **`RoutingProfileRow`**, **`RoutingPatchBody`** to use **`DefaultAction`**.

- [ ] **Step 2: Add helper** (same file, private)

```ts
function isTerminalRoutingProfile(db: Database, routingProfileId: number): boolean {
  const row = db
    .query<{ chain_id: number; position: number }, [number]>(
      `SELECT ch.chain_id AS chain_id, ch.position AS position
       FROM routing_profiles rp
       JOIN chain_hops ch ON ch.id = rp.chain_hop_id
       WHERE rp.id = ?`,
    )
    .get(routingProfileId);
  if (!row) {
    return false;
  }
  const maxRow = db
    .query<{ m: number | null }, [number]>(
      "SELECT MAX(position) AS m FROM chain_hops WHERE chain_id = ?",
    )
    .get(row.chain_id);
  const maxPos = maxRow?.m;
  return maxPos !== null && maxPos !== undefined && row.position === maxPos;
}
```

- [ ] **Step 3: In `PATCH` handler**, after **`validatePatchBody`** succeeds and before **`db.exec("BEGIN")`**:

```ts
if (parsed.value.defaultAction === "use_chain" && isTerminalRoutingProfile(db, routingProfileId)) {
  return c.json(
    { error: "Terminal hop cannot use defaultAction use_chain; use direct or block." },
    400,
  );
}
```

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/routes/routing.ts
git commit -m "feat(api): validate terminal hop defaultAction on routing PATCH"
```

---

### Task 4: Routing HTTP tests

**Files:**
- Modify: `apps/server/src/routes/routing.test.ts`

- [ ] **Step 1:** Change **`seedRoutingProfileForHop`** signature to:

```ts
function seedRoutingProfileForHop(
  chainHopId: number,
  defaultAction: "use_chain" | "direct" | "block" = "use_chain",
) {
```

- [ ] **Step 2: Add tests** (new `test(...)` blocks in the same `describe`):

1. **Two hops**, `routingProfileId` for **hop 1** (position 1, terminal). `PATCH` with **`defaultAction: "use_chain"`** → **400** and body **`{ error: "Terminal hop cannot use defaultAction use_chain; use direct or block." }`**.
2. Same profile, **`PATCH` with `defaultAction: "block"`** and minimal valid rules → **200**, persisted **`block`**.
3. **First hop** (non-terminal): **`PATCH` with `defaultAction: "use_chain"`** → **200** (keep existing normalization tests passing; adjust only where expectations conflict).

- [ ] **Step 3:** Update **`"gets and patches routing profiles with ordered rules"`** if needed: single-hop chain’s default after **`migrate()`**-backed create is **`direct`** from Task 5 — if this test seeds its own profile with `seedRoutingProfileForHop(hopId)` on a **single** hop, that hop is **terminal**, so **GET** may still show **`use_chain`** until PATCH — actually seed still inserts `use_chain` by default; migration coerces DB row to `direct` on migrate… **Wait:** `migrateRoutingDefaultActionsIfNeeded` runs on test `beforeEach` migrate — it will **coerce** terminal `use_chain` to **`direct`** after insert if the test inserts after migrate. Order in test: `migrate(db)` in beforeEach, then seed chain with **one** hop and profile with default use_chain — **migrate** already ran; seed happens after. **Coercion runs only inside `migrate()`**, not after each INSERT. So single-hop + `seedRoutingProfileForHop` with default `use_chain` leaves DB as `use_chain` until user runs migration again.

**Important:** The spec’s terminal coercion runs **inside `migrateRoutingDefaultActionsIfNeeded`**, not continuously. **`PATCH`** rejects terminal + `use_chain`; **GET** can still return `use_chain` for a terminal profile if someone inserted via raw SQL after migrate. The **design** also said UI normalizes. For **`routing.test.ts`** single-hop seed with `use_chain`: either seed with **`direct`** for terminal tests, or add a note: after full implementation, **`seedRoutingProfileForHop` default** for tests could remain **`use_chain`** only when caller knows hop is non-terminal; for single-hop tests use **`seedRoutingProfileForHop(hopId, "direct")`** for GET expectations, or expect **GET** to return `use_chain` until first PATCH — API does not auto-fix on read.

Simplest plan fix: document in this task — **for a single-hop chain, use `seedRoutingProfileForHop(hopId, "direct")`** in the existing large test so GET expectation stays valid **if** we later add a startup validation (we won't). Actually current test expects GET `defaultAction: "use_chain"` for one hop — that's still valid data from API perspective until PATCH. Terminal restriction is **write-time** only in §3 of spec. So **GET can return use_chain** for terminal in edge case; **PATCH** forbids setting it. Coercion migration fixes legacy DB only.

Re-read spec section 3: "If the hop is terminal and defaultAction === use_chain, return 400" — doesn't require GET to coerce. Migration fixes old data. So existing test with single hop + use_chain GET: **still valid**.

Two-hop test: profile on position 1 is terminal; PATCH use_chain → 400. Good.

- [ ] **Step 4:** Run `bun test apps/server/src/routes/routing.test.ts`

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/routes/routing.test.ts
git commit -m "test(api): routing PATCH terminal defaultAction rules"
```

---

### Task 5: Chain create / replace — last hop `direct`

**Files:**
- Modify: `apps/server/src/routes/chains.ts`
- Modify: `apps/server/src/routes/chains.test.ts`

- [ ] **Step 1:** In **`insertRoutingProfilesForHops`**, compute:

```ts
const defaultAction = position === hopCount - 1 ? "direct" : "use_chain";
```

and pass **`defaultAction`** into the `INSERT` instead of the literal **`"use_chain"`**.

- [ ] **Step 2:** Update **`chains.test.ts`** expectations:

- After **POST** with **two** hops: first profile **`use_chain`**, second **`direct`**.
- After **PATCH** replacing VPN ids (two hops): same pattern.
- Add **POST** with **one** hop: single profile **`direct`**.

- [ ] **Step 3:** Run `bun test apps/server/src/routes/chains.test.ts`

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/routes/chains.ts apps/server/src/routes/chains.test.ts
git commit -m "feat(api): terminal hop routing profile defaults to direct on chain writes"
```

---

### Task 6: Export v2 unions + test

**Files:**
- Modify: `apps/server/src/export/buildExport.ts`
- Modify: `apps/server/src/export/buildExport.test.ts`

- [ ] **Step 1:** In **`ExportV2`**, change **`routingByHop` item** `defaultAction` to **`"use_chain" | "direct" | "block"`**. Change **`HopRow.default_action`** union similarly.

- [ ] **Step 2:** In **`buildExport.test.ts`**, set one profile’s **`default_action`** to **`block`** in SQL (or via helper), assert exported JSON includes **`"defaultAction":"block"`** for that hop.

- [ ] **Step 3:** Run `bun test apps/server/src/export/buildExport.test.ts`

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/export/buildExport.ts apps/server/src/export/buildExport.test.ts
git commit -m "feat(export): include block in routing defaultAction union"
```

---

### Task 7: Web UI — `RoutingPage`

**Files:**
- Modify: `apps/web/src/pages/RoutingPage.tsx`

- [ ] **Step 1:** Extend **`DefaultAction`** and **`RoutingProfile.defaultAction`** / **`RoutingPatchPayload`** with **`"block"`**.

- [ ] **Step 2:** Derive **`const selectedHop = selectedChain?.hops.find((h) => h.id === selectedChainHopId) ?? null`** and **`const isTerminalHop = selectedChain !== null && selectedHop !== null && selectedHop.id === selectedChain.hops[selectedChain.hops.length - 1]?.id`**.

- [ ] **Step 3:** In the **`useEffect`** that applies **`routingProfileQuery.data`**, after `setDefaultAction(profile.defaultAction)`, if **`isTerminalHop`** and **`profile.defaultAction === "use_chain"`**, call **`setDefaultAction("direct")`** instead.

- [ ] **Step 4:** Add **`useEffect`** on **`[selectedChainHopId, selectedChain, defaultAction]`** (or fold into hop-selection handler): when **`isTerminalHop`** and **`defaultAction === "use_chain"`**, **`setDefaultAction("direct")`**.

- [ ] **Step 5:** Default action fieldset:

- If **`!isTerminalHop`**: three radios — Use chain, Direct, Block (`value="block"`).
- If **`isTerminalHop`**: only Direct and Block (omit Use chain).

- [ ] **Step 6:** In **`validateRoutingForm`**, if terminal hop is detectable from arguments, guard: either pass **`isTerminalHop`** into **`validateRoutingForm`** or validate in the submit handler before mutation — return **`{ error: "..." }`** if **`isTerminalHop && defaultAction === "use_chain"`** (should be unreachable if effects work).

```ts
function validateRoutingForm(
  defaultAction: DefaultAction,
  ruleRows: RuleRow[],
  options?: { terminalHop?: boolean },
): { payload: RoutingPatchPayload } | { error: string } {
  if (options?.terminalHop && defaultAction === "use_chain") {
    return { error: "The last hop in a chain cannot default to use chain." };
  }
  // ... existing rule validation
}
```

- [ ] **Step 7:** Run web typecheck/build if present

Run: `bun run build:web`

Expected: PASS (no TS errors).

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/pages/RoutingPage.tsx
git commit -m "feat(web): block default action and terminal hop UI rules"
```

---

### Task 8: Verification + final commit hygiene

- [ ] **Step 1:** Full server tests

Run: `bun test apps/server`

Expected: PASS

- [ ] **Step 2:** If any test file still assumes two-hop both `use_chain` defaults, fix expectations (grep **`default_action: "use_chain"`** in `apps/server`).

- [ ] **Step 3:** Optional docs: add one line under **Spec** in `docs/superpowers/specs/2026-04-14-per-hop-routing-design.md` pointing to the new spec — **skip unless** you want cross-links; not required for correctness.

- [ ] **Step 4:** Final commit if anything remains unstaged from Task 8 fixes.

---

## Plan self-review

| Spec section | Plan coverage |
|--------------|---------------|
| Section 1 intent (`block`, terminal default) | Tasks 1–7 |
| Section 2 data model + migration + new rows | Tasks 1–2, 5 |
| Section 3 API PATCH + reads | Tasks 3–4 |
| Section 4 export v2 union + invariant | Task 6 (union); invariant enforced by DB+writes, not export-only |
| Section 5 Web UI | Task 7 |
| Section 6 testing | Woven per task + Task 8 |
| Section 7 rollout | Implicit: ship server before web; Task order does that |

**Placeholder scan:** None.

**Type consistency:** `DefaultAction` is **`use_chain` | `direct` | `block`** everywhere; terminal error string matches between **`routing.ts`** and **`routing.test.ts`**. UI copy error string may differ from API — acceptable; PATCH tests use API string.

**Gap closed (Task 4 note):** Terminal rule is **write-time** on PATCH; GET may still show legacy `use_chain` until user PATCHes — no GET change required.

---

**Plan complete and saved to `docs/superpowers/plans/2026-04-14-routing-default-actions.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration  

**2. Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints  

**Which approach?**
