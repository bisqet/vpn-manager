# Per-hop routing rules — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move routing from one profile per chain to **one profile per `chain_hops` row**, expose **`GET /api/routing/by-hop/:chainHopId`**, ship **export `schemaVersion: 2`**, and update the **Routing** UI to **chain → hop → rules**.

**Architecture:** Keep `rules` rows keyed by `routing_profile_id`. Replace `routing_profiles.chain_id` with **`routing_profiles.chain_hop_id`** (UNIQUE, FK `ON DELETE CASCADE` to `chain_hops`). Extend **`migrate()`** so existing databases that still have `chain_id` on `routing_profiles` are upgraded in place (copy legacy rules to **every** hop’s new profile). **`POST/PATCH /api/chains`** inserts or rebuilds **one routing profile per hop** after hop rows exist. **`buildExportV2`** joins hops to profiles and emits **`routingByHop`** plus **`chainHopId`** on each chain hop object.

**Tech Stack:** Bun, `bun:sqlite`, Hono, Bun test runner, React + TanStack Query (existing `apps/web` patterns).

**Spec:** `docs/superpowers/specs/2026-04-14-per-hop-routing-design.md`

---

## File structure (create / modify)

| Path | Responsibility |
|------|----------------|
| `apps/server/src/db/schema.sql` | New greenfield DDL: `routing_profiles` uses `chain_hop_id` only (no `chain_id`). |
| `apps/server/src/db/migratePerHopRouting.ts` | **New.** Detect legacy `routing_profiles.chain_id` via `PRAGMA table_info`, run ALTER/backfill/DROP COLUMN, idempotent. |
| `apps/server/src/db/migrate.ts` | After `db.exec(schema)`, call `migratePerHopRoutingIfNeeded(db)`. |
| `apps/server/src/db/migratePerHopRouting.test.ts` | **New.** Legacy-schema fixture + assert N profiles and copied rules. |
| `apps/server/src/db/migrate.test.ts` | Assert `routing_profiles` has `chain_hop_id` column after `migrate()` on fresh DB. |
| `apps/server/src/routes/chains.ts` | POST: insert profile **per hop** (capture `lastInsertRowid` from each `chain_hops` insert or query hop ids). PATCH: on `vpnProfileIds` change, `DELETE chain_hops` then insert hops then **insert N new routing_profiles** (defaults, empty rules). PATCH name-only: `UPDATE routing_profiles SET name = ?` for all profiles joined to hops of that chain. Remove `routingProfileName` single-row insert; add `routingProfileNameForHop(chainName, position)`. Remove `UPDATE routing_profiles ... WHERE chain_id`. |
| `apps/server/src/routes/chains.test.ts` | Expect **two** routing profiles after create with two hops; export v2; update SQL assertions off `chain_id`. |
| `apps/server/src/routes/routing.ts` | DTO: `chainHopId`, `chainId` (from join for clients), remove `chainId` as DB column reference. Add `getRoutingProfileByChainHopId`, route `GET /by-hop/:chainHopId`. Remove `GET /by-chain/:chainId`. Adjust `RoutingProfileRow` SQL selects. |
| `apps/server/src/routes/routing.test.ts` | Seed **hops + profiles** linked by `chain_hop_id`; test `GET /by-hop/:id` and PATCH unchanged behavior. |
| `apps/server/src/export/buildExport.ts` | Add `ExportV2`, `buildExportV2`; include `chainHopId` on each `chain[]` element and `routingByHop` array. Keep or remove `buildExportV1` — **remove** once callers updated. |
| `apps/server/src/export/buildExport.test.ts` | Assert `schemaVersion === 2`, two hops → two `routingByHop` entries, rule copies per profile. |
| `apps/web/src/pages/RoutingPage.tsx` | Chain select → hop select (`selectedChainHopId`) → `fetchRoutingProfileByHop(chainHopId)`; query keys `["routing","by-hop", chainHopId]`; save invalidates that key. |
| `apps/web/src/pages/ExportPage.tsx` | Download filename `vpn-manager.routing.v2.json` (and any preview text expectations if tied to v1). |
| `apps/web/src/pages/ChainsPage.tsx` | Extend `Chain` type with optional `hops` if needed for display; **no change** if server keeps returning `vpnProfileIds` as ordered copy of hops. |

---

### Task 1: Legacy migration module (TDD)

**Files:**
- Create: `apps/server/src/db/migratePerHopRouting.ts`
- Create: `apps/server/src/db/migratePerHopRouting.test.ts`

- [ ] **Step 1: Write failing test** in `migratePerHopRouting.test.ts`

```ts
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migratePerHopRoutingIfNeeded } from "./migratePerHopRouting";

function createLegacyRoutingDb() {
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
      chain_id INTEGER NOT NULL UNIQUE REFERENCES chains(id) ON DELETE CASCADE,
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
  const hop1 = Number(
    db.query("INSERT INTO chain_hops (chain_id, position, vpn_profile_id) VALUES (?, ?, ?)").run(chainId, 0, vp)
      .lastInsertRowid,
  );
  const hop2 = Number(
    db.query("INSERT INTO chain_hops (chain_id, position, vpn_profile_id) VALUES (?, ?, ?)").run(chainId, 1, vp)
      .lastInsertRowid,
  );
  const rp = Number(
    db
      .query("INSERT INTO routing_profiles (name, chain_id, default_action) VALUES (?, ?, ?)")
      .run("C routing", chainId, "direct").lastInsertRowid,
  );
  db.query(
    "INSERT INTO rules (routing_profile_id, position, match_kind, match_value, action) VALUES (?, ?, ?, ?, ?)",
  ).run(rp, 0, "domain", ".x", "block");

  return { db, chainId, hop1, hop2, legacyProfileId: rp };
}

describe("migratePerHopRoutingIfNeeded", () => {
  test("splits legacy chain-level profile into per-hop profiles and copies rules", () => {
    const { db, hop1, hop2, legacyProfileId } = createLegacyRoutingDb();

    migratePerHopRoutingIfNeeded(db);

    expect(db.query("SELECT COUNT(*) AS c FROM routing_profiles").get() as { c: number }).toEqual({ c: 2 });

    const profiles = db
      .query<{ id: number; chain_hop_id: number }, []>(
        "SELECT id, chain_hop_id FROM routing_profiles ORDER BY chain_hop_id ASC",
      )
      .all();
    expect(profiles.map((p) => p.chain_hop_id).sort()).toEqual([hop1, hop2].sort());

    for (const p of profiles) {
      const rules = db
        .query<{ match_value: string }, [number]>(
          "SELECT match_value FROM rules WHERE routing_profile_id = ? ORDER BY position",
        )
        .all(p.id);
      expect(rules).toEqual([{ match_value: ".x" }]);
    }

    const pragma = db.query<{ name: string }, []>("PRAGMA table_info(routing_profiles)").all();
    expect(pragma.some((c) => c.name === "chain_id")).toBe(false);
    expect(legacyProfileId).toBe(profiles[0].id);
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

Run: `bun test apps/server/src/db/migratePerHopRouting.test.ts`

Expected: import or function fails / migration not implemented.

- [ ] **Step 3: Implement `migratePerHopRoutingIfNeeded`** in `migratePerHopRouting.ts`

Behavior:

1. Read `PRAGMA table_info(routing_profiles)`. If there is **no** column named `chain_id`, return immediately (already migrated or greenfield table never had `chain_id`).
2. `ALTER TABLE routing_profiles ADD COLUMN chain_hop_id INTEGER REFERENCES chain_hops(id);` — use `try/catch` or pragma check: if `chain_hop_id` already exists, skip the `ALTER`.
3. In a transaction: for each row in `routing_profiles` where `chain_id IS NOT NULL`:
   - Load ordered hops: `SELECT id, position FROM chain_hops WHERE chain_id = ? ORDER BY position ASC, id ASC`.
   - Load ordered rules for `routing_profiles.id`.
   - If hops empty: delete rules for that profile, delete profile, continue.
   - Bind **first** hop: `UPDATE routing_profiles SET chain_hop_id = ? WHERE id = ?` (first hop id).
   - For **remaining** hops: `INSERT INTO routing_profiles (name, default_action, chain_hop_id) VALUES (?, ?, ?)` with name `"{originalName} hop {position}"`, same `default_action`, then for each rule `INSERT INTO rules (...)` copies (same `position`, `match_kind`, `match_value`, `action`).
4. After all rows processed: `ALTER TABLE routing_profiles DROP COLUMN chain_id;` (SQLite 3.35+). If any profile still has `NULL chain_hop_id`, abort with throw before DROP.
5. Recreate uniqueness: if SQLite dropped UNIQUE with column, add `CREATE UNIQUE INDEX IF NOT EXISTS routing_profiles_chain_hop_id_key ON routing_profiles(chain_hop_id);`

Export the function:

```ts
import type { Database } from "bun:sqlite";

export function migratePerHopRoutingIfNeeded(db: Database): void {
  // implementation as above
}
```

- [ ] **Step 4: Run tests — expect PASS**

Run: `bun test apps/server/src/db/migratePerHopRouting.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/db/migratePerHopRouting.ts apps/server/src/db/migratePerHopRouting.test.ts
git commit -m "feat(db): migrate legacy chain-level routing to per-hop profiles"
```

---

### Task 2: Greenfield schema + wire migrate

**Files:**
- Modify: `apps/server/src/db/schema.sql` — replace `routing_profiles` definition:

```sql
CREATE TABLE IF NOT EXISTS routing_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  chain_hop_id INTEGER NOT NULL UNIQUE REFERENCES chain_hops(id) ON DELETE CASCADE,
  default_action TEXT NOT NULL CHECK (default_action IN ('use_chain','direct'))
);
```

- Modify: `apps/server/src/db/migrate.ts`:

```ts
import type { Database } from "bun:sqlite";
import schema from "./schema.sql" with { type: "text" };
import { migratePerHopRoutingIfNeeded } from "./migratePerHopRouting";

export function migrate(db: Database): void {
  db.exec(schema);
  migratePerHopRoutingIfNeeded(db);
}
```

- Modify: `apps/server/src/db/migrate.test.ts` — append test:

```ts
  test("routing_profiles uses chain_hop_id", () => {
    migrate(db);
    const cols = db.query<{ name: string }, []>("PRAGMA table_info(routing_profiles)").all();
    expect(cols.some((c) => c.name === "chain_hop_id")).toBe(true);
    expect(cols.some((c) => c.name === "chain_id")).toBe(false);
  });
```

- [ ] **Step 1: Apply file edits** (schema.sql, migrate.ts, migrate.test.ts).

- [ ] **Step 2: Run full server tests** (many will fail until later tasks — expect failures).

Run: `bun test apps/server`

Expected: failures in `routing.test.ts`, `chains.test.ts`, `buildExport.test.ts` until those tasks are done.

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/db/schema.sql apps/server/src/db/migrate.ts apps/server/src/db/migrate.test.ts
git commit -m "feat(db): schema routing_profiles keyed by chain_hop_id"
```

---

### Task 3: Chains API — profiles per hop

**Files:**
- Modify: `apps/server/src/routes/chains.ts`

- [ ] **Step 1: Replace helpers**

Remove `routingProfileName(chainName)` single-chain naming. Add:

```ts
function routingProfileNameForHop(chainName: string, position: number) {
  return `${chainName} hop ${position}`;
}
```

- [ ] **Step 2: Extend `ChainRow` / `ChainDto`**

```ts
type ChainHopDto = {
  id: number;
  position: number;
  vpnProfileId: number;
  label: string;
};

type ChainDto = {
  id: number;
  name: string;
  vpnProfileIds: number[];
  hops: ChainHopDto[];
};
```

- [ ] **Step 3: Rewrite `listChains` and `getChainById` SQL** to join `vpn_profiles` for `label`, select `chain_hops.id`, build `hops` array and `vpnProfileIds` from ordered hops.

- [ ] **Step 4: POST `/api/chains`** — inside the transaction after hop inserts:

```ts
for (const [position] of vpnProfileIds.entries()) {
  const hopRow = db
    .query<{ id: number }, [number, number]>("SELECT id FROM chain_hops WHERE chain_id = ? AND position = ?")
    .get(chainId, position);
  if (!hopRow) {
    throw new Error("Expected chain_hops row after insert");
  }
  db.query("INSERT INTO routing_profiles (name, chain_hop_id, default_action) VALUES (?, ?, ?)").run(
    routingProfileNameForHop(name, position),
    hopRow.id,
    "use_chain",
  );
}
```

Remove the single `INSERT INTO routing_profiles (name, chain_id, ...)`.

- [ ] **Step 5: PATCH `/api/chains/:id`** — when `parsed.value.name` set:

```ts
const profiles = db
  .query<{ id: number; position: number }, [number]>(
    `SELECT rp.id, ch.position
     FROM routing_profiles rp
     JOIN chain_hops ch ON ch.id = rp.chain_hop_id
     WHERE ch.chain_id = ?
     ORDER BY ch.position ASC`,
  )
  .all(id);
for (const row of profiles) {
  db.query("UPDATE routing_profiles SET name = ? WHERE id = ?").run(
    routingProfileNameForHop(nextName, row.position),
    row.id,
  );
}
```

Remove `UPDATE routing_profiles SET name = ? WHERE chain_id = ?`.

- [ ] **Step 6: PATCH when `nextVpnProfileIds` set** — after `DELETE FROM chain_hops` and re-insert hops, **insert one routing profile per new hop** (same loop as POST). Old profiles were CASCADE-deleted with old hops.

- [ ] **Step 7: Update `chains.test.ts`** expectations

After POST with two profiles, assert:

```ts
const count = db.query("SELECT COUNT(*) AS c FROM routing_profiles").get() as { c: number };
expect(count.c).toBe(2);
```

Replace queries using `chain_id` with joins on `chain_hops`.

- [ ] **Step 8: Run tests**

Run: `bun test apps/server/src/routes/chains.test.ts`

Expected: PASS (export test may still expect v1 — fix in Task 5 or temporarily skip).

- [ ] **Step 9: Commit**

```bash
git add apps/server/src/routes/chains.ts apps/server/src/routes/chains.test.ts
git commit -m "feat(api): one routing profile per chain hop; chain DTO includes hops"
```

---

### Task 4: Routing API — GET by hop, DTO update

**Files:**
- Modify: `apps/server/src/routes/routing.ts`
- Modify: `apps/server/src/routes/routing.test.ts`

- [ ] **Step 1: Update types**

```ts
type RoutingProfileDto = {
  id: number;
  name: string;
  chainHopId: number;
  chainId: number;
  defaultAction: DefaultAction;
  rules: RoutingRuleDto[];
};
```

`RoutingProfileRow` should select `ch.chain_id AS chain_id`, `rp.chain_hop_id AS chain_hop_id`, remove dependence on `rp.chain_id`.

- [ ] **Step 2: Replace `getRoutingProfileByChainId` with `getRoutingProfileByChainHopId`**

SQL `WHERE rp.chain_hop_id = ?` and join `chain_hops ch ON ch.id = rp.chain_hop_id` for `chain_id`.

- [ ] **Step 3: Routes**

Remove `app.get("/by-chain/:chainId", ...)`.

Add:

```ts
app.get("/by-hop/:chainHopId", (c) => {
  const chainHopId = parseId(c.req.param("chainHopId"));
  if (chainHopId === null) {
    return c.json({ error: "Invalid chain hop id" }, 400);
  }
  const routingProfile = getRoutingProfileByChainHopId(db, chainHopId);
  if (!routingProfile) {
    return c.json({ error: "Routing profile not found" }, 404);
  }
  return c.json(routingProfile);
});
```

`mapRoutingProfile` must set `chainHopId` and `chainId` from row.

- [ ] **Step 4: Rewrite `routing.test.ts` seed helpers**

```ts
function seedHop(chainId: number, position: number, vpnProfileId: number) {
  const result = db
    .query("INSERT INTO chain_hops (chain_id, position, vpn_profile_id) VALUES (?, ?, ?)")
    .run(chainId, position, vpnProfileId);
  return Number(result.lastInsertRowid);
}

function seedRoutingProfileForHop(chainHopId: number, defaultAction: "use_chain" | "direct" = "use_chain") {
  const result = db
    .query("INSERT INTO routing_profiles (name, chain_hop_id, default_action) VALUES (?, ?, ?)")
    .run(`hop ${chainHopId} routing`, chainHopId, defaultAction);
  return Number(result.lastInsertRowid);
}
```

Each test must insert `vpn_profiles` row before hops (FK). Minimal insert same as existing tests’ pattern.

- [ ] **Step 5: Replace GET URL** in test from `/api/routing/by-chain/${chainId}` to `/api/routing/by-hop/${hopId}` and expect JSON:

```ts
expect(await getRes.json()).toEqual({
  id: routingProfileId,
  name: "hop 1 routing",
  chainHopId: hopId,
  chainId,
  defaultAction: "use_chain",
  rules: [ /* ... */ ],
});
```

Update PATCH response expectations to include `chainHopId` / `chainId` instead of only `chainId`.

- [ ] **Step 6: Run tests**

Run: `bun test apps/server/src/routes/routing.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/routes/routing.ts apps/server/src/routes/routing.test.ts
git commit -m "feat(api): GET routing profile by chain hop id"
```

---

### Task 5: Export v2 + chain download

**Files:**
- Modify: `apps/server/src/export/buildExport.ts`
- Modify: `apps/server/src/export/buildExport.test.ts`
- Modify: `apps/server/src/routes/chains.ts` (`/:id/export` handler: call `buildExportV2`, filename `vpn-manager.routing.v2.json`)

- [ ] **Step 1: Define `ExportV2` and `buildExportV2`**

```ts
export type ExportV2 = {
  schemaVersion: 2;
  exportedAt: string;
  name?: string;
  chainId: number;
  chain: Array<{
    chainHopId: number;
    profileId: number;
    host: string;
    sshPort: number;
    sshUser: string;
  }>;
  routingByHop: Array<{
    hopIndex: number;
    chainHopId: number;
    routingProfileId: number;
    defaultAction: "use_chain" | "direct";
    rules: Array<{
      matchKind: "domain" | "cidr";
      matchValue: string;
      action: "direct" | "use_chain" | "block";
    }>;
  }>;
};

export function buildExportV2(db: Database, chainId: number): ExportV2 {
  // Query hops with ch.id AS chain_hop_id, join vpn_profiles, join routing_profiles ON routing_profiles.chain_hop_id = ch.id
  // Build chain[] with chainHopId; routingByHop with hopIndex 0..n-1 matching ORDER BY ch.position ASC, ch.id ASC
}
```

Remove `ExportV1` / `buildExportV1` **or** keep `buildExportV1` unused — **delete** to avoid dead code once `chains.ts` imports `buildExportV2`.

- [ ] **Step 2: Update `buildExport.test.ts`** to use `buildExportV2`, two hops, two profiles with possibly different rules, assert `routingByHop.length === 2` and `schemaVersion === 2`.

- [ ] **Step 3: Update `chains.test.ts` export** section: Content-Disposition `vpn-manager.routing.v2.json`, `schemaVersion: 2`, expect `routingByHop` array with duplicated rules if seed only profile 1 — after Task 3, two profiles exist; insert rules on both or only first and assert accordingly.

- [ ] **Step 4: Run tests**

Run: `bun test apps/server/src/export/buildExport.test.ts apps/server/src/routes/chains.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/export/buildExport.ts apps/server/src/export/buildExport.test.ts apps/server/src/routes/chains.ts apps/server/src/routes/chains.test.ts
git commit -m "feat(export): schema v2 with routingByHop and chainHopId"
```

---

### Task 6: Web — Routing page flow

**Files:**
- Modify: `apps/web/src/pages/RoutingPage.tsx`

- [ ] **Step 1: Extend `Chain` type**

```ts
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

- [ ] **Step 2: Replace `fetchRoutingProfile` / query key**

```ts
function routingProfileQueryKey(chainHopId: number) {
  return ["routing", "by-hop", chainHopId] as const;
}

function fetchRoutingProfileByHop(chainHopId: number) {
  return apiFetch<RoutingProfile>(`/api/routing/by-hop/${chainHopId}`);
}
```

`RoutingProfile` type: add `chainHopId`, keep `chainId` for cache invalidation if returned by API.

- [ ] **Step 3: State** — `selectedChainHopId: number | null` instead of loading by chain only. When chain changes, set `selectedChainHopId` to `chain.hops[0]?.id ?? null`.

- [ ] **Step 4: `useQuery`** — `enabled: selectedChainHopId !== null`, `queryKey: routingProfileQueryKey(selectedChainHopId!)`, `queryFn`.

- [ ] **Step 5: UI** — add `<select>` for hop (options from `selectedChain.hops`, value = `chainHopId`, label = `#${position + 1} — ${label}`).

- [ ] **Step 6: `saveMutation` onSuccess** — `setQueryData(routingProfileQueryKey(profile.chainHopId), profile)` and `invalidateQueries` for same key (remove `routingProfileQueryKey(profile.chainId)`).

- [ ] **Step 7: Manual smoke** — `bun --cwd apps/server dev` and `bun --cwd apps/web dev`, log in, Routing: pick chain, second hop, edit rules, save, reload.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/pages/RoutingPage.tsx
git commit -m "feat(web): routing editor selects hop then loads per-hop rules"
```

---

### Task 7: Web — Export download filename

**Files:**
- Modify: `apps/web/src/pages/ExportPage.tsx`

- [ ] **Step 1: Change** `anchor.download = "vpn-manager.routing.v2.json";` in `downloadExport`.

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/pages/ExportPage.tsx
git commit -m "fix(web): export download uses v2 filename"
```

---

### Task 8: Full verification

- [ ] **Step 1: Run all server tests**

Run: `bun test apps/server`

Expected: all PASS.

- [ ] **Step 2: Run web typecheck/build**

Run: `bun --cwd apps/web build`

Expected: PASS.

- [ ] **Step 3: Commit** (only if fixes needed)

```bash
git add -A
git commit -m "chore: per-hop routing follow-up fixes"
```

---

## Self-review (spec coverage)

| Spec section | Task |
|--------------|------|
| `routing_profiles.chain_hop_id` UNIQUE FK CASCADE | Task 2 schema; Task 3 CASCADE via hop delete |
| Remove `chain_id` | Task 1 migrator; Task 2 greenfield |
| Migration copies rules to every hop | Task 1 |
| Chain create → profile per hop | Task 3 |
| `GET /api/routing/by-hop/:chainHopId` | Task 4 |
| `PATCH` unchanged body | Task 4 (existing handler) |
| Remove `by-chain` GET | Task 4 |
| Export `schemaVersion: 2`, `routingByHop` | Task 5 |
| UI chain → hop → rules | Task 6 |
| CASCADE / reorder | Task 3 (ids follow hops); schema CASCADE |

**Placeholder scan:** None intentional.

**Type consistency:** `chainHopId` used in API DTO, export `routingByHop`, and web types consistently.

---

## Execution handoff

**Plan complete and saved to `docs/superpowers/plans/2026-04-14-per-hop-routing.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — Dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
