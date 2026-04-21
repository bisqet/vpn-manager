# Routing Rules xray / 3x-ui parity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand the per-hop Routing Rules section so each rule carries xray-core's full `RoutingRule` field set, the table UI matches 3x-ui's Rules view, and saving rules pushes them to the hop's 3x-ui panel.

**Architecture:** Schema-first rewrite of the `rules` table and removal of `routing_profiles.default_action`, followed by a new xray emitter (`emitRoutingRulesForHop`) that the routing PATCH handler and chain provisioner both call to project stored rules onto the panel's `routing.rules` array. The web UI replaces the inline-edit table with a summary row + edit modal, chip inputs for multi-value fields, and drag-to-reorder via `@dnd-kit`.

**Tech Stack:** Bun runtime + `bun:sqlite`, Hono API server, `@tanstack/react-query` + React 18 + Vite on the web side, `@dnd-kit/core` + `@dnd-kit/sortable` (new), inline `CSSProperties` styling, `bun:test` for tests, `happy-dom` for web tests.

**Reference spec:** `docs/superpowers/specs/2026-04-20-routing-rules-xray-parity-design.md`

---

## Phase 1 — Schema migration

### Task 1: Update schema and add imperative migration for the rules table

**Files:**
- Modify: `apps/server/src/db/schema.sql` (replace `CREATE TABLE rules (...)` and drop `default_action` from `routing_profiles`)
- Create: `apps/server/src/db/migrateRulesXrayShape.ts`
- Create: `apps/server/src/db/migrateRulesXrayShape.test.ts`
- Modify: `apps/server/src/db/migrate.ts` (call the new module)
- Modify: `apps/server/src/db/migrate.test.ts` (update assertions for new columns)

- [ ] **Step 1: Write the failing migration test**

Create `apps/server/src/db/migrateRulesXrayShape.test.ts`:

```ts
import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrateRulesXrayShapeIfNeeded } from "./migrateRulesXrayShape";

function createLegacyDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(`
    CREATE TABLE chains (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
    CREATE TABLE chain_hops (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chain_id INTEGER NOT NULL REFERENCES chains(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      UNIQUE (chain_id, position)
    );
    CREATE TABLE routing_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      chain_hop_id INTEGER NOT NULL UNIQUE REFERENCES chain_hops(id) ON DELETE CASCADE,
      default_action TEXT NOT NULL CHECK (default_action IN ('use_chain','direct','block'))
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
  db.query("INSERT INTO chains (id, name) VALUES (1, 'c')").run();
  db.query("INSERT INTO chain_hops (id, chain_id, position) VALUES (10, 1, 0)").run();
  db.query(
    "INSERT INTO routing_profiles (id, name, chain_hop_id, default_action) VALUES (100, 'p', 10, 'direct')",
  ).run();
  db.query(
    "INSERT INTO rules (routing_profile_id, position, match_kind, match_value, action) VALUES (?, ?, ?, ?, ?)",
  ).run(100, 0, "domain", ".example.com", "block");
  return db;
}

describe("migrateRulesXrayShapeIfNeeded", () => {
  test("drops old rules table, drops default_action, recreates new rules schema", () => {
    const db = createLegacyDb();

    migrateRulesXrayShapeIfNeeded(db);

    const rulesCols = db
      .query<{ name: string }, []>("PRAGMA table_info(rules)")
      .all()
      .map((c) => c.name);
    expect(rulesCols).toEqual([
      "id",
      "routing_profile_id",
      "position",
      "outbound_tag",
      "rule_tag",
      "domain_matcher",
      "domains_json",
      "ips_json",
      "ports",
      "source_ports",
      "protocols_json",
      "networks_json",
      "sources_json",
      "users_json",
      "inbound_tags_json",
      "attrs",
    ]);
    expect(db.query("SELECT COUNT(*) AS c FROM rules").get()).toEqual({ c: 0 });

    const profileCols = db
      .query<{ name: string }, []>("PRAGMA table_info(routing_profiles)")
      .all()
      .map((c) => c.name);
    expect(profileCols).toEqual(["id", "name", "chain_hop_id"]);
    expect(db.query("SELECT COUNT(*) AS c FROM routing_profiles").get()).toEqual({ c: 1 });
  });

  test("is a no-op when already on the new schema", () => {
    const db = createLegacyDb();
    migrateRulesXrayShapeIfNeeded(db);
    migrateRulesXrayShapeIfNeeded(db);
    expect(db.query("SELECT COUNT(*) AS c FROM rules").get()).toEqual({ c: 0 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/server && bun test src/db/migrateRulesXrayShape.test.ts`
Expected: module not found / import error

- [ ] **Step 3: Implement `migrateRulesXrayShape.ts`**

Create `apps/server/src/db/migrateRulesXrayShape.ts`:

```ts
import type { Database } from "bun:sqlite";

function hasColumn(db: Database, table: string, column: string): boolean {
  const rows = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
  return rows.some((r) => r.name === column);
}

export function migrateRulesXrayShapeIfNeeded(db: Database): void {
  const rulesHasMatchKind = hasColumn(db, "rules", "match_kind");
  const profilesHasDefaultAction = hasColumn(db, "routing_profiles", "default_action");

  if (!rulesHasMatchKind && !profilesHasDefaultAction) {
    return;
  }

  db.exec("BEGIN");
  try {
    if (rulesHasMatchKind) {
      db.exec("DROP TABLE rules");
      db.exec(`
        CREATE TABLE rules (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          routing_profile_id INTEGER NOT NULL REFERENCES routing_profiles(id) ON DELETE CASCADE,
          position INTEGER NOT NULL,
          outbound_tag TEXT NOT NULL,
          rule_tag TEXT,
          domain_matcher TEXT,
          domains_json TEXT,
          ips_json TEXT,
          ports TEXT,
          source_ports TEXT,
          protocols_json TEXT,
          networks_json TEXT,
          sources_json TEXT,
          users_json TEXT,
          inbound_tags_json TEXT,
          attrs TEXT,
          UNIQUE (routing_profile_id, position)
        )
      `);
    }

    if (profilesHasDefaultAction) {
      db.exec(`
        CREATE TABLE routing_profiles_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          chain_hop_id INTEGER NOT NULL UNIQUE REFERENCES chain_hops(id) ON DELETE CASCADE
        )
      `);
      db.exec(
        "INSERT INTO routing_profiles_new (id, name, chain_hop_id) SELECT id, name, chain_hop_id FROM routing_profiles",
      );
      db.exec("DROP TABLE routing_profiles");
      db.exec("ALTER TABLE routing_profiles_new RENAME TO routing_profiles");
      db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS routing_profiles_chain_hop_id_key ON routing_profiles(chain_hop_id)",
      );
    }

    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/server && bun test src/db/migrateRulesXrayShape.test.ts`
Expected: 2 passes.

- [ ] **Step 5: Update `schema.sql` to match the new shape**

Replace the existing `routing_profiles` and `rules` definitions in `apps/server/src/db/schema.sql` (lines 53–68 today):

```sql
CREATE TABLE IF NOT EXISTS routing_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  chain_hop_id INTEGER NOT NULL UNIQUE REFERENCES chain_hops(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  routing_profile_id INTEGER NOT NULL REFERENCES routing_profiles(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  outbound_tag TEXT NOT NULL,
  rule_tag TEXT,
  domain_matcher TEXT,
  domains_json TEXT,
  ips_json TEXT,
  ports TEXT,
  source_ports TEXT,
  protocols_json TEXT,
  networks_json TEXT,
  sources_json TEXT,
  users_json TEXT,
  inbound_tags_json TEXT,
  attrs TEXT,
  UNIQUE (routing_profile_id, position)
);
```

- [ ] **Step 6: Register the migration in `migrate.ts`**

Edit `apps/server/src/db/migrate.ts`. Add the import and call:

```ts
import { migrateRulesXrayShapeIfNeeded } from "./migrateRulesXrayShape";
// ...
export function migrate(db: Database): void {
  db.exec(schema);
  migratePerHopRoutingIfNeeded(db);
  migrateRoutingDefaultActionsIfNeeded(db);
  migrateRulesXrayShapeIfNeeded(db);
  migrateVpnProfileOperationalStatusIfNeeded(db);
  migrateVpnProfile3xUiIfNeeded(db);
  migrateVpnProfileXuiPanelPortIfNeeded(db);
  migrateVpnProfilePanelReachabilityIfNeeded(db);
}
```

Order matters: this migration must run **after** `migrateRoutingDefaultActionsIfNeeded` (which still operates on the old shape) so older DBs migrate cleanly through each step.

- [ ] **Step 7: Update `migrate.test.ts` expectations**

Open `apps/server/src/db/migrate.test.ts`. Every assertion referencing `default_action` or old `rules` columns must change. Replace assertions that check for `default_action`, `match_kind`, `match_value`, or `action` columns with the new `rules` column list and a `routing_profiles` column list excluding `default_action`.

- [ ] **Step 8: Run the full db test suite**

Run: `cd apps/server && bun test src/db/`
Expected: all tests pass.

- [ ] **Step 9: Commit**

```bash
cd /workspace
git add apps/server/src/db/schema.sql \
        apps/server/src/db/migrate.ts \
        apps/server/src/db/migrate.test.ts \
        apps/server/src/db/migrateRulesXrayShape.ts \
        apps/server/src/db/migrateRulesXrayShape.test.ts
git commit -m "feat(db): migrate rules table to xray-shaped schema"
```

---

## Phase 2 — Shared rule types and server-side validation

### Task 2: Define shared rule types and a pure validator

**Files:**
- Create: `apps/server/src/routing/ruleShape.ts`
- Create: `apps/server/src/routing/validateRules.ts`
- Create: `apps/server/src/routing/validateRules.test.ts`

(We create a new `apps/server/src/routing/` folder for the new modules; the HTTP handlers stay in `apps/server/src/routes/routing.ts` and import from here.)

- [ ] **Step 1: Create the shared types module**

Create `apps/server/src/routing/ruleShape.ts`:

```ts
export type OutboundTagAllowlist = readonly string[];

export const PROTOCOLS = ["http", "tls", "bittorrent", "quic"] as const;
export const NETWORKS = ["tcp", "udp"] as const;
export const DOMAIN_MATCHERS = ["hybrid", "linear"] as const;

export type Protocol = (typeof PROTOCOLS)[number];
export type Network = (typeof NETWORKS)[number];
export type DomainMatcher = (typeof DOMAIN_MATCHERS)[number];

export type RoutingRuleInput = {
  outboundTag: string;
  ruleTag: string | null;
  domainMatcher: DomainMatcher | null;
  domains: string[] | null;
  ips: string[] | null;
  ports: string | null;
  sourcePorts: string | null;
  protocols: Protocol[] | null;
  networks: Network[] | null;
  sources: string[] | null;
  users: string[] | null;
  inboundTags: string[] | null;
  attrs: Record<string, string> | null;
};

export type RoutingRuleDto = RoutingRuleInput & {
  id: number;
  position: number;
};

export type RoutingProfileDto = {
  id: number;
  name: string;
  chainHopId: number;
  chainId: number;
  allowedOutboundTags: string[];
  rules: RoutingRuleDto[];
};

export type RoutingPatchBody = {
  rules: RoutingRuleInput[];
};
```

- [ ] **Step 2: Write failing validator tests**

Create `apps/server/src/routing/validateRules.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { validateRules } from "./validateRules";

const middleAllowlist = ["direct", "blocked", "next-hop"] as const;
const terminalAllowlist = ["direct", "blocked"] as const;

function baseRule(overrides: Partial<import("./ruleShape").RoutingRuleInput> = {}) {
  return {
    outboundTag: "direct",
    ruleTag: null,
    domainMatcher: null,
    domains: [".example.com"],
    ips: null,
    ports: null,
    sourcePorts: null,
    protocols: null,
    networks: null,
    sources: null,
    users: null,
    inboundTags: null,
    attrs: null,
    ...overrides,
  };
}

describe("validateRules", () => {
  test("accepts a single catch-all rule", () => {
    const result = validateRules(
      { rules: [{ ...baseRule(), domains: null, outboundTag: "direct" }] },
      middleAllowlist,
    );
    expect(result.ok).toBe(true);
  });

  test("accepts a non-terminal rule with domains", () => {
    const result = validateRules({ rules: [baseRule()] }, middleAllowlist);
    expect(result.ok).toBe(true);
  });

  test("rejects non-terminal catch-all (empty match) in the middle", () => {
    const result = validateRules(
      { rules: [{ ...baseRule(), domains: null }, baseRule()] },
      middleAllowlist,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("match");
      expect(result.ruleIndex).toBe(0);
    }
  });

  test("rejects outbound tag outside allowlist (terminal hop rejects next-hop)", () => {
    const result = validateRules(
      { rules: [{ ...baseRule(), outboundTag: "next-hop" }] },
      terminalAllowlist,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("outboundTag");
      expect(result.field).toBe("outboundTag");
    }
  });

  test("rejects empty outbound tag", () => {
    const result = validateRules(
      { rules: [{ ...baseRule(), outboundTag: "" }] },
      middleAllowlist,
    );
    expect(result.ok).toBe(false);
  });

  test.each([
    ["80"],
    ["80,443"],
    ["1000-2000"],
    ["80,1000-2000,8443"],
  ])("accepts valid port string %s", (ports) => {
    const result = validateRules(
      { rules: [{ ...baseRule(), ports }] },
      middleAllowlist,
    );
    expect(result.ok).toBe(true);
  });

  test.each([
    ["0-100"],
    ["100-99"],
    ["abc"],
    ["80,,443"],
    ["65536"],
  ])("rejects invalid port string %s", (ports) => {
    const result = validateRules(
      { rules: [{ ...baseRule(), ports }] },
      middleAllowlist,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.field).toBe("ports");
  });

  test("rejects protocol outside enum", () => {
    const result = validateRules(
      {
        rules: [
          {
            ...baseRule(),
            protocols: ["smtp" as unknown as "http"],
          },
        ],
      },
      middleAllowlist,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.field).toBe("protocols");
  });

  test("rejects duplicate network values", () => {
    const result = validateRules(
      { rules: [{ ...baseRule(), networks: ["tcp", "tcp"] }] },
      middleAllowlist,
    );
    expect(result.ok).toBe(false);
  });

  test("rejects domainMatcher without domains", () => {
    const result = validateRules(
      { rules: [{ ...baseRule(), domains: null, domainMatcher: "hybrid" }] },
      middleAllowlist,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.field).toBe("domainMatcher");
  });

  test("rejects empty string in chip arrays", () => {
    const result = validateRules(
      { rules: [{ ...baseRule(), domains: ["ok", ""] }] },
      middleAllowlist,
    );
    expect(result.ok).toBe(false);
  });

  test("rejects nested attrs", () => {
    const result = validateRules(
      {
        rules: [
          {
            ...baseRule(),
            attrs: { a: "1", b: { nested: "yes" } as unknown as string },
          },
        ],
      },
      middleAllowlist,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.field).toBe("attrs");
  });
});
```

- [ ] **Step 3: Run it to verify failures**

Run: `cd apps/server && bun test src/routing/validateRules.test.ts`
Expected: module not found / import error

- [ ] **Step 4: Implement the validator**

Create `apps/server/src/routing/validateRules.ts`:

```ts
import {
  DOMAIN_MATCHERS,
  NETWORKS,
  PROTOCOLS,
  type OutboundTagAllowlist,
  type RoutingPatchBody,
  type RoutingRuleInput,
} from "./ruleShape";

export type ValidationOk = { ok: true; value: RoutingPatchBody };
export type ValidationErr = {
  ok: false;
  error: string;
  ruleIndex?: number;
  field?: string;
};
export type ValidationResult = ValidationOk | ValidationErr;

const PORT_STRING_RE = /^\d+(-\d+)?(,\d+(-\d+)?)*$/;

function isPortString(v: string): boolean {
  if (!PORT_STRING_RE.test(v)) return false;
  for (const part of v.split(",")) {
    if (part.includes("-")) {
      const [a, b] = part.split("-").map(Number);
      if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
      if (a <= 0 || b > 65535 || a > b) return false;
    } else {
      const n = Number(part);
      if (!Number.isFinite(n) || n <= 0 || n > 65535) return false;
    }
  }
  return true;
}

function hasAnyMatch(rule: RoutingRuleInput): boolean {
  return Boolean(
    (rule.domains && rule.domains.length) ||
      (rule.ips && rule.ips.length) ||
      rule.ports ||
      rule.sourcePorts ||
      (rule.protocols && rule.protocols.length) ||
      (rule.networks && rule.networks.length) ||
      (rule.sources && rule.sources.length) ||
      (rule.users && rule.users.length) ||
      (rule.inboundTags && rule.inboundTags.length) ||
      rule.attrs,
  );
}

function fail(error: string, ruleIndex?: number, field?: string): ValidationErr {
  return { ok: false, error, ruleIndex, field };
}

function validateStringArray(
  arr: unknown,
  field: string,
  ruleIndex: number,
): ValidationErr | null {
  if (arr === null) return null;
  if (!Array.isArray(arr)) return fail(`${field} must be an array or null`, ruleIndex, field);
  for (const v of arr) {
    if (typeof v !== "string") return fail(`${field} must contain strings`, ruleIndex, field);
    if (v.trim() === "") return fail(`${field} must not contain empty strings`, ruleIndex, field);
  }
  return null;
}

export function validateRules(
  body: RoutingPatchBody,
  allowedOutboundTags: OutboundTagAllowlist,
): ValidationResult {
  if (!body || !Array.isArray(body.rules)) {
    return fail("rules must be an array");
  }

  for (let i = 0; i < body.rules.length; i++) {
    const r = body.rules[i];
    if (!r || typeof r !== "object") return fail("rule must be an object", i);

    if (typeof r.outboundTag !== "string" || r.outboundTag === "") {
      return fail("outboundTag is required", i, "outboundTag");
    }
    if (!allowedOutboundTags.includes(r.outboundTag)) {
      return fail(
        `outboundTag ${r.outboundTag} not allowed on this hop`,
        i,
        "outboundTag",
      );
    }

    if (i < body.rules.length - 1 && !hasAnyMatch(r)) {
      return fail("Only the last rule may be a catch-all", i, "match");
    }

    for (const [field, val] of [
      ["domains", r.domains],
      ["ips", r.ips],
      ["sources", r.sources],
      ["users", r.users],
      ["inboundTags", r.inboundTags],
    ] as const) {
      const err = validateStringArray(val, field, i);
      if (err) return err;
    }

    if (r.ports !== null && (typeof r.ports !== "string" || !isPortString(r.ports))) {
      return fail("ports must be a valid port string", i, "ports");
    }
    if (
      r.sourcePorts !== null &&
      (typeof r.sourcePorts !== "string" || !isPortString(r.sourcePorts))
    ) {
      return fail("sourcePorts must be a valid port string", i, "sourcePorts");
    }

    if (r.protocols !== null) {
      if (!Array.isArray(r.protocols)) return fail("protocols must be an array", i, "protocols");
      const set = new Set<string>();
      for (const p of r.protocols) {
        if (!PROTOCOLS.includes(p as (typeof PROTOCOLS)[number])) {
          return fail(`invalid protocol ${String(p)}`, i, "protocols");
        }
        if (set.has(p)) return fail(`duplicate protocol ${p}`, i, "protocols");
        set.add(p);
      }
    }

    if (r.networks !== null) {
      if (!Array.isArray(r.networks)) return fail("networks must be an array", i, "networks");
      const set = new Set<string>();
      for (const n of r.networks) {
        if (!NETWORKS.includes(n as (typeof NETWORKS)[number])) {
          return fail(`invalid network ${String(n)}`, i, "networks");
        }
        if (set.has(n)) return fail(`duplicate network ${n}`, i, "networks");
        set.add(n);
      }
    }

    if (
      r.domainMatcher !== null &&
      !DOMAIN_MATCHERS.includes(r.domainMatcher as (typeof DOMAIN_MATCHERS)[number])
    ) {
      return fail("invalid domainMatcher", i, "domainMatcher");
    }
    if (r.domainMatcher !== null && (!r.domains || r.domains.length === 0)) {
      return fail(
        "domainMatcher requires at least one domain",
        i,
        "domainMatcher",
      );
    }

    if (r.attrs !== null) {
      if (typeof r.attrs !== "object" || Array.isArray(r.attrs)) {
        return fail("attrs must be a flat object", i, "attrs");
      }
      for (const v of Object.values(r.attrs)) {
        if (typeof v !== "string") return fail("attrs values must be strings", i, "attrs");
      }
    }

    if (r.ruleTag !== null && (typeof r.ruleTag !== "string" || r.ruleTag === "")) {
      return fail("ruleTag must be a non-empty string or null", i, "ruleTag");
    }
  }

  return { ok: true, value: body };
}
```

- [ ] **Step 5: Run validator tests**

Run: `cd apps/server && bun test src/routing/validateRules.test.ts`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
cd /workspace
git add apps/server/src/routing/ruleShape.ts \
        apps/server/src/routing/validateRules.ts \
        apps/server/src/routing/validateRules.test.ts
git commit -m "feat(routing): add xray-shaped rule types and validator"
```

---

### Task 3: Rule-row ↔ DTO mapping and DB helpers

**Files:**
- Create: `apps/server/src/routing/rulesRepo.ts`
- Create: `apps/server/src/routing/rulesRepo.test.ts`

- [ ] **Step 1: Write failing repo tests**

Create `apps/server/src/routing/rulesRepo.test.ts`:

```ts
import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../db/migrate";
import {
  computeAllowedOutboundTags,
  readRoutingProfileByChainHopId,
  readRoutingProfileById,
  replaceRulesForProfile,
} from "./rulesRepo";
import type { RoutingRuleInput } from "./ruleShape";

function makeDb() {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

function seedChainWithHops(db: Database, hopCount: number) {
  const chain = db.query("INSERT INTO chains (name) VALUES ('c')").run();
  const chainId = Number(chain.lastInsertRowid);
  const hopIds: number[] = [];
  const profileIds: number[] = [];
  for (let i = 0; i < hopCount; i++) {
    // hops require a vpn_profile_id; seed a throwaway profile per hop
    const v = db
      .query(
        `INSERT INTO vpn_profiles (label, host, ssh_port, ssh_user, ssh_password_ciphertext, ssh_password_nonce)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(`p${i}`, `h${i}`, 22, "root", new Uint8Array([1]), new Uint8Array([2]));
    const hop = db
      .query("INSERT INTO chain_hops (chain_id, position, vpn_profile_id) VALUES (?, ?, ?)")
      .run(chainId, i, Number(v.lastInsertRowid));
    hopIds.push(Number(hop.lastInsertRowid));
    const rp = db
      .query("INSERT INTO routing_profiles (name, chain_hop_id) VALUES (?, ?)")
      .run(`hop ${i}`, Number(hop.lastInsertRowid));
    profileIds.push(Number(rp.lastInsertRowid));
  }
  return { chainId, hopIds, profileIds };
}

function ruleInput(overrides: Partial<RoutingRuleInput> = {}): RoutingRuleInput {
  return {
    outboundTag: "direct",
    ruleTag: null,
    domainMatcher: null,
    domains: [".example.com"],
    ips: null,
    ports: null,
    sourcePorts: null,
    protocols: null,
    networks: null,
    sources: null,
    users: null,
    inboundTags: null,
    attrs: null,
    ...overrides,
  };
}

describe("rulesRepo", () => {
  test("computeAllowedOutboundTags returns middle hop tags for non-terminal", () => {
    const db = makeDb();
    const { profileIds } = seedChainWithHops(db, 2);
    expect(computeAllowedOutboundTags(db, profileIds[0])).toEqual([
      "direct",
      "blocked",
      "next-hop",
    ]);
  });

  test("computeAllowedOutboundTags returns terminal tags for last hop", () => {
    const db = makeDb();
    const { profileIds } = seedChainWithHops(db, 2);
    expect(computeAllowedOutboundTags(db, profileIds[1])).toEqual(["direct", "blocked"]);
  });

  test("single-hop chain treats its only hop as terminal", () => {
    const db = makeDb();
    const { profileIds } = seedChainWithHops(db, 1);
    expect(computeAllowedOutboundTags(db, profileIds[0])).toEqual(["direct", "blocked"]);
  });

  test("replaceRulesForProfile stores and reads back all fields", () => {
    const db = makeDb();
    const { hopIds, profileIds } = seedChainWithHops(db, 2);
    const pid = profileIds[0];
    replaceRulesForProfile(db, pid, [
      ruleInput({
        outboundTag: "next-hop",
        ruleTag: "test-rule",
        domainMatcher: "hybrid",
        domains: [".a.com", ".b.com"],
        ips: ["10.0.0.0/8"],
        ports: "80,443",
        sourcePorts: "1000-2000",
        protocols: ["http", "tls"],
        networks: ["tcp"],
        sources: ["1.1.1.0/24"],
        users: ["u1"],
        inboundTags: ["in-a"],
        attrs: { ":method": "GET" },
      }),
      ruleInput({ domains: null, outboundTag: "blocked" }),
    ]);

    const profile = readRoutingProfileByChainHopId(db, hopIds[0]);
    expect(profile).not.toBeNull();
    expect(profile!.rules).toHaveLength(2);
    const [r0, r1] = profile!.rules;
    expect(r0.position).toBe(0);
    expect(r0.outboundTag).toBe("next-hop");
    expect(r0.ruleTag).toBe("test-rule");
    expect(r0.domainMatcher).toBe("hybrid");
    expect(r0.domains).toEqual([".a.com", ".b.com"]);
    expect(r0.ports).toBe("80,443");
    expect(r0.protocols).toEqual(["http", "tls"]);
    expect(r0.networks).toEqual(["tcp"]);
    expect(r0.inboundTags).toEqual(["in-a"]);
    expect(r0.attrs).toEqual({ ":method": "GET" });
    expect(r1.position).toBe(1);
    expect(r1.outboundTag).toBe("blocked");
    expect(r1.domains).toBeNull();
  });

  test("replaceRulesForProfile deletes previous rows", () => {
    const db = makeDb();
    const { profileIds } = seedChainWithHops(db, 2);
    const pid = profileIds[0];
    replaceRulesForProfile(db, pid, [ruleInput()]);
    replaceRulesForProfile(db, pid, []);
    const profile = readRoutingProfileById(db, pid);
    expect(profile!.rules).toEqual([]);
  });

  test("readRoutingProfileById computes allowedOutboundTags", () => {
    const db = makeDb();
    const { profileIds } = seedChainWithHops(db, 2);
    expect(readRoutingProfileById(db, profileIds[0])!.allowedOutboundTags).toEqual([
      "direct",
      "blocked",
      "next-hop",
    ]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/server && bun test src/routing/rulesRepo.test.ts`
Expected: module not found.

- [ ] **Step 3: Implement the repo**

Create `apps/server/src/routing/rulesRepo.ts`:

```ts
import type { Database } from "bun:sqlite";
import type {
  DomainMatcher,
  Network,
  Protocol,
  RoutingProfileDto,
  RoutingRuleDto,
  RoutingRuleInput,
} from "./ruleShape";

type ProfileRow = {
  id: number;
  name: string;
  chain_hop_id: number;
  chain_id: number;
  is_terminal: number;
};

type RuleRow = {
  id: number;
  position: number;
  outbound_tag: string;
  rule_tag: string | null;
  domain_matcher: string | null;
  domains_json: string | null;
  ips_json: string | null;
  ports: string | null;
  source_ports: string | null;
  protocols_json: string | null;
  networks_json: string | null;
  sources_json: string | null;
  users_json: string | null;
  inbound_tags_json: string | null;
  attrs: string | null;
};

const MIDDLE_TAGS = ["direct", "blocked", "next-hop"] as const;
const TERMINAL_TAGS = ["direct", "blocked"] as const;

function parseJsonArray<T = string>(v: string | null): T[] | null {
  if (v === null) return null;
  const parsed = JSON.parse(v);
  if (!Array.isArray(parsed)) throw new Error("expected JSON array");
  return parsed as T[];
}

function parseJsonObject(v: string | null): Record<string, string> | null {
  if (v === null) return null;
  const parsed = JSON.parse(v);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("expected JSON object");
  }
  return parsed as Record<string, string>;
}

function stringifyOrNull(v: readonly unknown[] | Record<string, string> | null): string | null {
  if (v === null) return null;
  if (Array.isArray(v) && v.length === 0) return null;
  return JSON.stringify(v);
}

function loadProfileRow(db: Database, profileId: number): ProfileRow | null {
  const row = db
    .query<ProfileRow, [number]>(
      `SELECT
         rp.id AS id,
         rp.name AS name,
         rp.chain_hop_id AS chain_hop_id,
         ch.chain_id AS chain_id,
         CASE WHEN ch.position = (
           SELECT MAX(mx.position) FROM chain_hops mx WHERE mx.chain_id = ch.chain_id
         ) THEN 1 ELSE 0 END AS is_terminal
       FROM routing_profiles rp
       JOIN chain_hops ch ON ch.id = rp.chain_hop_id
       WHERE rp.id = ?`,
    )
    .get(profileId);
  return row ?? null;
}

function loadProfileRowByHop(db: Database, chainHopId: number): ProfileRow | null {
  const row = db
    .query<ProfileRow, [number]>(
      `SELECT
         rp.id AS id,
         rp.name AS name,
         rp.chain_hop_id AS chain_hop_id,
         ch.chain_id AS chain_id,
         CASE WHEN ch.position = (
           SELECT MAX(mx.position) FROM chain_hops mx WHERE mx.chain_id = ch.chain_id
         ) THEN 1 ELSE 0 END AS is_terminal
       FROM routing_profiles rp
       JOIN chain_hops ch ON ch.id = rp.chain_hop_id
       WHERE rp.chain_hop_id = ?`,
    )
    .get(chainHopId);
  return row ?? null;
}

function loadRules(db: Database, profileId: number): RoutingRuleDto[] {
  const rows = db
    .query<RuleRow, [number]>(
      `SELECT id, position, outbound_tag, rule_tag, domain_matcher,
              domains_json, ips_json, ports, source_ports,
              protocols_json, networks_json, sources_json, users_json,
              inbound_tags_json, attrs
         FROM rules
         WHERE routing_profile_id = ?
         ORDER BY position ASC, id ASC`,
    )
    .all(profileId);

  return rows.map((r) => ({
    id: r.id,
    position: r.position,
    outboundTag: r.outbound_tag,
    ruleTag: r.rule_tag,
    domainMatcher: (r.domain_matcher as DomainMatcher | null) ?? null,
    domains: parseJsonArray<string>(r.domains_json),
    ips: parseJsonArray<string>(r.ips_json),
    ports: r.ports,
    sourcePorts: r.source_ports,
    protocols: parseJsonArray<Protocol>(r.protocols_json),
    networks: parseJsonArray<Network>(r.networks_json),
    sources: parseJsonArray<string>(r.sources_json),
    users: parseJsonArray<string>(r.users_json),
    inboundTags: parseJsonArray<string>(r.inbound_tags_json),
    attrs: parseJsonObject(r.attrs),
  }));
}

function profileDtoFromRow(db: Database, row: ProfileRow): RoutingProfileDto {
  return {
    id: row.id,
    name: row.name,
    chainHopId: row.chain_hop_id,
    chainId: row.chain_id,
    allowedOutboundTags: row.is_terminal === 1 ? [...TERMINAL_TAGS] : [...MIDDLE_TAGS],
    rules: loadRules(db, row.id),
  };
}

export function readRoutingProfileByChainHopId(
  db: Database,
  chainHopId: number,
): RoutingProfileDto | null {
  const row = loadProfileRowByHop(db, chainHopId);
  return row ? profileDtoFromRow(db, row) : null;
}

export function readRoutingProfileById(
  db: Database,
  routingProfileId: number,
): RoutingProfileDto | null {
  const row = loadProfileRow(db, routingProfileId);
  return row ? profileDtoFromRow(db, row) : null;
}

export function computeAllowedOutboundTags(
  db: Database,
  routingProfileId: number,
): string[] {
  const row = loadProfileRow(db, routingProfileId);
  if (!row) return [];
  return row.is_terminal === 1 ? [...TERMINAL_TAGS] : [...MIDDLE_TAGS];
}

export function replaceRulesForProfile(
  db: Database,
  routingProfileId: number,
  rules: RoutingRuleInput[],
): void {
  db.query("DELETE FROM rules WHERE routing_profile_id = ?").run(routingProfileId);
  for (let i = 0; i < rules.length; i++) {
    const r = rules[i];
    db.query(
      `INSERT INTO rules (
        routing_profile_id, position, outbound_tag, rule_tag, domain_matcher,
        domains_json, ips_json, ports, source_ports,
        protocols_json, networks_json, sources_json, users_json,
        inbound_tags_json, attrs
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      routingProfileId,
      i,
      r.outboundTag,
      r.ruleTag,
      r.domainMatcher,
      stringifyOrNull(r.domains),
      stringifyOrNull(r.ips),
      r.ports,
      r.sourcePorts,
      stringifyOrNull(r.protocols),
      stringifyOrNull(r.networks),
      stringifyOrNull(r.sources),
      stringifyOrNull(r.users),
      stringifyOrNull(r.inboundTags),
      stringifyOrNull(r.attrs),
    );
  }
}
```

- [ ] **Step 4: Run repo tests**

Run: `cd apps/server && bun test src/routing/rulesRepo.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
cd /workspace
git add apps/server/src/routing/rulesRepo.ts \
        apps/server/src/routing/rulesRepo.test.ts
git commit -m "feat(routing): add rules repository with xray-shaped read/write"
```

---

### Task 4: Drop `default_action` from chain-hop and import profile creation

**Files:**
- Modify: `apps/server/src/routes/chains.ts` (function `insertRoutingProfilesForHops`, lines 306–323)
- Modify: `apps/server/src/routes/chains.test.ts` (drop `default_action` assertions)
- Modify: `apps/server/src/import/insertChainWithHops.ts` (same pattern)
- Modify: `apps/server/src/export/buildExport.ts` (drop `default_action` from select/output)
- Modify: `apps/server/src/export/buildExport.test.ts`

- [ ] **Step 1: Update `chains.ts` `insertRoutingProfilesForHops`**

Replace the function body at `apps/server/src/routes/chains.ts` lines 306–323 with:

```ts
function insertRoutingProfilesForHops(db: Database, chainId: number, chainName: string, hopCount: number) {
  for (let position = 0; position < hopCount; position++) {
    const hopRow = db
      .query<{ id: number }, [number, number]>(
        "SELECT id FROM chain_hops WHERE chain_id = ? AND position = ?",
      )
      .get(chainId, position);
    if (!hopRow) {
      throw new Error("Expected chain_hops row after insert");
    }
    db.query("INSERT INTO routing_profiles (name, chain_hop_id) VALUES (?, ?)").run(
      routingProfileNameForHop(chainName, position),
      hopRow.id,
    );
  }
}
```

- [ ] **Step 2: Update `chains.test.ts`**

Search for `default_action` in `apps/server/src/routes/chains.test.ts`. Remove every assertion on that column. Any assertion of the form `expect(row).toEqual({ ..., default_action: "..." })` must drop the `default_action` key.

- [ ] **Step 3: Update `insertChainWithHops.ts` equivalently**

Open `apps/server/src/import/insertChainWithHops.ts`, locate the routing-profile insert loop, and drop `default_action` the same way.

- [ ] **Step 4: Update `buildExport.ts`**

Open `apps/server/src/export/buildExport.ts`. The JOIN that produces per-hop routing output currently includes `rp.default_action`. Drop that column and any corresponding property in the emitted JSON. Export each rule using the old shape temporarily is **not** sufficient — but the full rule export is handled in Task 6. In this step, just drop `default_action` from the profile-level output.

- [ ] **Step 5: Run affected server tests**

Run:
```bash
cd apps/server && bun test src/routes/chains.test.ts src/import/ src/export/
```
Expected: `chains.test.ts` and `export` tests pass; `import` tests may still fail because they reference rule shape — that's fixed in Task 6.

- [ ] **Step 6: Commit**

```bash
cd /workspace
git add apps/server/src/routes/chains.ts \
        apps/server/src/routes/chains.test.ts \
        apps/server/src/import/insertChainWithHops.ts \
        apps/server/src/export/buildExport.ts \
        apps/server/src/export/buildExport.test.ts
git commit -m "refactor(routing): drop default_action from profile creation and export"
```

---

### Task 5: Rewrite the routing HTTP handlers to the new shape (no emitter yet)

**Files:**
- Modify: `apps/server/src/routes/routing.ts` (full rewrite)
- Modify: `apps/server/src/routes/routing.test.ts` (rewrite fixtures + assertions)

This task lands the new API shape end-to-end. Panel push is wired in Task 8.

- [ ] **Step 1: Update `routing.test.ts` to the new shape**

The file needs full rewrite. Replace the entire file contents with:

```ts
import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { SESSION_COOKIE } from "../auth/cookie";
import type { Env } from "../env";
import { createApp } from "../index";
import { migrate } from "../db/migrate";

const env: Env = {
  port: 3000,
  databasePath: ":memory:",
  masterKey: new Uint8Array(32).fill(9),
};

describe("routingRoutes", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys = ON;");
    migrate(db);
    db.query("INSERT INTO users (username, password_hash) VALUES (?, ?)").run("alice", "hash");
    db.query("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)").run(
      "session-token",
      1,
      Date.now() + 60_000,
    );
  });

  function authHeaders(contentType = false) {
    return {
      ...(contentType ? { "Content-Type": "application/json" } : {}),
      Cookie: `${SESSION_COOKIE}=session-token`,
    };
  }

  function seedVpnProfile() {
    return Number(
      db
        .query(
          `INSERT INTO vpn_profiles (label, host, ssh_port, ssh_user, ssh_password_ciphertext, ssh_password_nonce)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run("p", "h", 22, "root", new Uint8Array([1]), new Uint8Array([2])).lastInsertRowid,
    );
  }
  function seedChain() {
    return Number(db.query("INSERT INTO chains (name) VALUES ('c')").run().lastInsertRowid);
  }
  function seedHop(chainId: number, pos: number, vpnId: number) {
    return Number(
      db
        .query("INSERT INTO chain_hops (chain_id, position, vpn_profile_id) VALUES (?, ?, ?)")
        .run(chainId, pos, vpnId).lastInsertRowid,
    );
  }
  function seedProfile(hopId: number) {
    return Number(
      db
        .query("INSERT INTO routing_profiles (name, chain_hop_id) VALUES (?, ?)")
        .run(`hop ${hopId}`, hopId).lastInsertRowid,
    );
  }

  test("requires auth", async () => {
    const app = createApp(db, env);
    const res = await app.request("/api/routing/by-hop/1");
    expect(res.status).toBe(401);
  });

  test("GET by-hop returns the new shape with allowedOutboundTags for middle hop", async () => {
    const app = createApp(db, env);
    const v0 = seedVpnProfile();
    const v1 = seedVpnProfile();
    const c = seedChain();
    const h0 = seedHop(c, 0, v0);
    seedHop(c, 1, v1);
    const pid = seedProfile(h0);

    const res = await app.request(`/api/routing/by-hop/${h0}`, { headers: authHeaders() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: pid,
      name: `hop ${h0}`,
      chainHopId: h0,
      chainId: c,
      allowedOutboundTags: ["direct", "blocked", "next-hop"],
      rules: [],
    });
  });

  test("GET by-hop returns terminal allowedOutboundTags for last hop", async () => {
    const app = createApp(db, env);
    const v0 = seedVpnProfile();
    const v1 = seedVpnProfile();
    const c = seedChain();
    const h0 = seedHop(c, 0, v0);
    const h1 = seedHop(c, 1, v1);
    seedProfile(h0);
    seedProfile(h1);
    const res = await app.request(`/api/routing/by-hop/${h1}`, { headers: authHeaders() });
    const body = (await res.json()) as { allowedOutboundTags: string[] };
    expect(body.allowedOutboundTags).toEqual(["direct", "blocked"]);
  });

  test("PATCH replaces rules and echoes full dto", async () => {
    const app = createApp(db, env);
    const v = seedVpnProfile();
    const c = seedChain();
    const h = seedHop(c, 0, v);
    const pid = seedProfile(h);

    const res = await app.request(`/api/routing/${pid}`, {
      method: "PATCH",
      headers: authHeaders(true),
      body: JSON.stringify({
        rules: [
          {
            outboundTag: "direct",
            ruleTag: null,
            domainMatcher: null,
            domains: [".example.com"],
            ips: null,
            ports: "443",
            sourcePorts: null,
            protocols: ["tls"],
            networks: ["tcp"],
            sources: null,
            users: null,
            inboundTags: null,
            attrs: null,
          },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rules: unknown[] };
    expect(body.rules).toHaveLength(1);
  });

  test("PATCH rejects next-hop outbound on terminal hop", async () => {
    const app = createApp(db, env);
    const v0 = seedVpnProfile();
    const v1 = seedVpnProfile();
    const c = seedChain();
    const h0 = seedHop(c, 0, v0);
    const h1 = seedHop(c, 1, v1);
    seedProfile(h0);
    const pid1 = seedProfile(h1);
    const res = await app.request(`/api/routing/${pid1}`, {
      method: "PATCH",
      headers: authHeaders(true),
      body: JSON.stringify({
        rules: [
          {
            outboundTag: "next-hop",
            ruleTag: null,
            domainMatcher: null,
            domains: [".example.com"],
            ips: null,
            ports: null,
            sourcePorts: null,
            protocols: null,
            networks: null,
            sources: null,
            users: null,
            inboundTags: null,
            attrs: null,
          },
        ],
      }),
    });
    expect(res.status).toBe(400);
  });

  test("PATCH rejects invalid port string", async () => {
    const app = createApp(db, env);
    const v = seedVpnProfile();
    const c = seedChain();
    const h = seedHop(c, 0, v);
    const pid = seedProfile(h);
    const res = await app.request(`/api/routing/${pid}`, {
      method: "PATCH",
      headers: authHeaders(true),
      body: JSON.stringify({
        rules: [
          {
            outboundTag: "direct",
            ruleTag: null,
            domainMatcher: null,
            domains: null,
            ips: null,
            ports: "0-100",
            sourcePorts: null,
            protocols: null,
            networks: null,
            sources: null,
            users: null,
            inboundTags: null,
            attrs: null,
          },
        ],
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { field?: string };
    expect(body.field).toBe("ports");
  });

  test("PATCH rejects catch-all not at end", async () => {
    const app = createApp(db, env);
    const v = seedVpnProfile();
    const c = seedChain();
    const h = seedHop(c, 0, v);
    const pid = seedProfile(h);
    const res = await app.request(`/api/routing/${pid}`, {
      method: "PATCH",
      headers: authHeaders(true),
      body: JSON.stringify({
        rules: [
          {
            outboundTag: "direct",
            ruleTag: null,
            domainMatcher: null,
            domains: null,
            ips: null,
            ports: null,
            sourcePorts: null,
            protocols: null,
            networks: null,
            sources: null,
            users: null,
            inboundTags: null,
            attrs: null,
          },
          {
            outboundTag: "blocked",
            ruleTag: null,
            domainMatcher: null,
            domains: [".x"],
            ips: null,
            ports: null,
            sourcePorts: null,
            protocols: null,
            networks: null,
            sources: null,
            users: null,
            inboundTags: null,
            attrs: null,
          },
        ],
      }),
    });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Replace `routing.ts` with the new handlers**

Replace the full contents of `apps/server/src/routes/routing.ts`:

```ts
import type { Database } from "bun:sqlite";
import type { Context } from "hono";
import { Hono } from "hono";
import { validateRules } from "../routing/validateRules";
import {
  computeAllowedOutboundTags,
  readRoutingProfileByChainHopId,
  readRoutingProfileById,
  replaceRulesForProfile,
} from "../routing/rulesRepo";

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

function parseId(idParam: string): number | null {
  const id = Number(idParam);
  if (!Number.isInteger(id) || id < 1) return null;
  return id;
}

export function routingRoutes(db: Database) {
  const app = new Hono();

  app.get("/by-hop/:chainHopId", (c) => {
    const chainHopId = parseId(c.req.param("chainHopId"));
    if (chainHopId === null) {
      return c.json({ error: "Invalid chain hop id" }, 400);
    }
    const dto = readRoutingProfileByChainHopId(db, chainHopId);
    if (!dto) {
      return c.json({ error: "Routing profile not found" }, 404);
    }
    return c.json(dto);
  });

  app.patch("/:routingProfileId", async (c) => {
    const routingProfileId = parseId(c.req.param("routingProfileId"));
    if (routingProfileId === null) {
      return c.json({ error: "Invalid routing profile id" }, 400);
    }
    const existing = readRoutingProfileById(db, routingProfileId);
    if (!existing) {
      return c.json({ error: "Routing profile not found" }, 404);
    }

    const body = (await readJson(c)) as { rules?: unknown } | null;
    if (!body || typeof body !== "object") {
      return c.json({ error: "Invalid routing payload" }, 400);
    }
    const allowed = computeAllowedOutboundTags(db, routingProfileId);
    const parsed = validateRules(
      { rules: (body.rules as import("../routing/ruleShape").RoutingRuleInput[]) ?? [] },
      allowed,
    );
    if (!parsed.ok) {
      return c.json(
        { error: parsed.error, ruleIndex: parsed.ruleIndex, field: parsed.field },
        400,
      );
    }

    db.exec("BEGIN");
    try {
      replaceRulesForProfile(db, routingProfileId, parsed.value.rules);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }

    return c.json(readRoutingProfileById(db, routingProfileId)!);
  });

  return app;
}
```

- [ ] **Step 3: Run the routing test suite**

Run: `cd apps/server && bun test src/routes/routing.test.ts`
Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
cd /workspace
git add apps/server/src/routes/routing.ts \
        apps/server/src/routes/routing.test.ts
git commit -m "feat(routing): switch HTTP handlers to xray-shaped rules"
```

---

### Task 6: Update import/export paths to the new rule shape

**Files:**
- Modify: `apps/server/src/import/buildImportPlan.ts`
- Modify: `apps/server/src/import/buildImportPlan.test.ts`
- Modify: `apps/server/src/import/applyImport.ts`
- Modify: `apps/server/src/import/applyImport.test.ts`
- Modify: `apps/server/src/export/buildExport.ts`
- Modify: `apps/server/src/export/buildExport.test.ts`

- [ ] **Step 1: Read the current import/export code**

Open each file and locate the routing-rule serialization. In every import path, the old rule shape (`{matchKind, matchValue, action}`) is produced and consumed. Replace it with the new shape (`RoutingRuleInput` from `apps/server/src/routing/ruleShape.ts`).

- [ ] **Step 2: Update `buildImportPlan.ts` validation**

Remove the terminal-hop `defaultAction === "use_chain"` check. Add a terminal-hop check: for the last hop's routing profile, every rule's `outboundTag` must be in `{'direct','blocked'}`. Replace the rule-shape validation with `validateRules` from `apps/server/src/routing/validateRules.ts` using the appropriate allowlist per hop.

- [ ] **Step 3: Update `applyImport.ts`**

Replace the rules insert loop with `replaceRulesForProfile` from `apps/server/src/routing/rulesRepo.ts`. Drop the `UPDATE routing_profiles SET default_action = ?` step.

- [ ] **Step 4: Update `buildExport.ts`**

Change the rules JOIN / output loop so it emits the new rule shape. Use `readRoutingProfileById` (or inline the same SELECT) and map to the exported JSON.

- [ ] **Step 5: Update all import/export tests**

In each `.test.ts` under `apps/server/src/import/` and `apps/server/src/export/`, replace fixtures that use `{matchKind, matchValue, action}` with the new shape. Replace `defaultAction` assertions with terminal-hop outbound-tag assertions where relevant.

- [ ] **Step 6: Run import/export tests**

Run:
```bash
cd apps/server && bun test src/import/ src/export/
```
Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
cd /workspace
git add apps/server/src/import/ apps/server/src/export/
git commit -m "refactor(routing): update import/export to xray-shaped rules"
```

---

## Phase 3 — Xray emitter integration

### Task 7: Build `emitRoutingRulesForHop` (pure reconciliation + mapping)

**Files:**
- Create: `apps/server/src/xui/emitRoutingRulesForHop.ts`
- Create: `apps/server/src/xui/emitRoutingRulesForHop.test.ts`

This task builds the pure in-memory function. Wiring to the panel happens in Task 8 and Task 9.

- [ ] **Step 1: Write failing tests**

Create `apps/server/src/xui/emitRoutingRulesForHop.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { reconcileHopRoutingRules } from "./emitRoutingRulesForHop";
import type { RoutingRuleInput } from "../routing/ruleShape";

const hopInboundTag = "inbound-443";
const fallbackRule = { type: "field", inboundTag: [hopInboundTag], outboundTag: "next-hop" };

function baseRule(overrides: Partial<RoutingRuleInput> = {}): RoutingRuleInput {
  return {
    outboundTag: "direct",
    ruleTag: null,
    domainMatcher: null,
    domains: null,
    ips: null,
    ports: null,
    sourcePorts: null,
    protocols: null,
    networks: null,
    sources: null,
    users: null,
    inboundTags: null,
    attrs: null,
    ...overrides,
  };
}

describe("reconcileHopRoutingRules", () => {
  test("auto-scopes empty inboundTags with the hop's inbound tag", () => {
    const out = reconcileHopRoutingRules({
      existingRules: [fallbackRule],
      hopInboundTags: [hopInboundTag],
      userRules: [baseRule({ domains: [".a.com"] })],
      fallbackRule,
    });
    expect(out[0]).toMatchObject({
      type: "field",
      inboundTag: [hopInboundTag],
      domain: [".a.com"],
      outboundTag: "direct",
    });
    expect(out[out.length - 1]).toEqual(fallbackRule);
  });

  test("passes non-empty inboundTags through verbatim", () => {
    const out = reconcileHopRoutingRules({
      existingRules: [fallbackRule],
      hopInboundTags: [hopInboundTag],
      userRules: [baseRule({ inboundTags: ["custom-in"], domains: [".a.com"] })],
      fallbackRule,
    });
    expect(out[0]).toMatchObject({ inboundTag: ["custom-in"] });
  });

  test("emits comma-joined network (xray shape)", () => {
    const out = reconcileHopRoutingRules({
      existingRules: [fallbackRule],
      hopInboundTags: [hopInboundTag],
      userRules: [baseRule({ networks: ["tcp", "udp"] })],
      fallbackRule,
    });
    expect(out[0]).toMatchObject({ network: "tcp,udp" });
  });

  test("preserves unrelated existing rules (other inbound) and removes our own", () => {
    const unrelated = {
      type: "field",
      inboundTag: ["other-in"],
      outboundTag: "direct",
    };
    const oursPrior = {
      type: "field",
      inboundTag: [hopInboundTag],
      domain: [".old.com"],
      outboundTag: "direct",
    };
    const out = reconcileHopRoutingRules({
      existingRules: [unrelated, oursPrior, fallbackRule],
      hopInboundTags: [hopInboundTag],
      userRules: [baseRule({ domains: [".new.com"] })],
      fallbackRule,
    });
    expect(out).toEqual([
      { type: "field", inboundTag: [hopInboundTag], domain: [".new.com"], outboundTag: "direct" },
      fallbackRule,
      unrelated,
    ]);
  });

  test("zero user rules produces [fallback, ...unrelated]", () => {
    const unrelated = {
      type: "field",
      inboundTag: ["other-in"],
      outboundTag: "direct",
    };
    const oursPrior = {
      type: "field",
      inboundTag: [hopInboundTag],
      outboundTag: "direct",
    };
    const out = reconcileHopRoutingRules({
      existingRules: [unrelated, oursPrior, fallbackRule],
      hopInboundTags: [hopInboundTag],
      userRules: [],
      fallbackRule,
    });
    expect(out).toEqual([fallbackRule, unrelated]);
  });

  test("emits each optional field only when non-empty", () => {
    const out = reconcileHopRoutingRules({
      existingRules: [fallbackRule],
      hopInboundTags: [hopInboundTag],
      userRules: [
        baseRule({
          domains: [".a.com"],
          ips: ["10.0.0.0/8"],
          ports: "443",
          sourcePorts: "1000-2000",
          protocols: ["tls"],
          networks: ["tcp"],
          sources: ["1.1.1.0/24"],
          users: ["u1"],
          attrs: { ":method": "GET" },
          ruleTag: "tag1",
          domainMatcher: "hybrid",
        }),
      ],
      fallbackRule,
    });
    const r = out[0] as Record<string, unknown>;
    expect(r).toMatchObject({
      type: "field",
      domain: [".a.com"],
      ip: ["10.0.0.0/8"],
      port: "443",
      sourcePort: "1000-2000",
      protocol: ["tls"],
      network: "tcp",
      source: ["1.1.1.0/24"],
      user: ["u1"],
      attrs: { ":method": "GET" },
      ruleTag: "tag1",
      domainMatcher: "hybrid",
      inboundTag: [hopInboundTag],
      outboundTag: "direct",
    });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/server && bun test src/xui/emitRoutingRulesForHop.test.ts`
Expected: module not found.

- [ ] **Step 3: Implement reconciliation**

Create `apps/server/src/xui/emitRoutingRulesForHop.ts`:

```ts
import type { RoutingRuleInput } from "../routing/ruleShape";

export type ReconcileInput = {
  existingRules: unknown[];
  hopInboundTags: string[];
  userRules: RoutingRuleInput[];
  fallbackRule: Record<string, unknown>;
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function rulesIntersect(rule: Record<string, unknown>, tags: string[]): boolean {
  const ib = rule.inboundTag;
  if (!Array.isArray(ib)) return false;
  for (const t of ib) {
    if (typeof t === "string" && tags.includes(t)) return true;
  }
  return false;
}

export function userRuleToXray(
  rule: RoutingRuleInput,
  hopInboundTag: string,
): Record<string, unknown> {
  const r: Record<string, unknown> = { type: "field" };
  r.inboundTag =
    rule.inboundTags && rule.inboundTags.length ? rule.inboundTags : [hopInboundTag];
  if (rule.domains && rule.domains.length) r.domain = rule.domains;
  if (rule.ips && rule.ips.length) r.ip = rule.ips;
  if (rule.ports) r.port = rule.ports;
  if (rule.sourcePorts) r.sourcePort = rule.sourcePorts;
  if (rule.protocols && rule.protocols.length) r.protocol = rule.protocols;
  if (rule.networks && rule.networks.length) r.network = rule.networks.join(",");
  if (rule.sources && rule.sources.length) r.source = rule.sources;
  if (rule.users && rule.users.length) r.user = rule.users;
  if (rule.attrs) r.attrs = rule.attrs;
  if (rule.ruleTag) r.ruleTag = rule.ruleTag;
  if (rule.domainMatcher) r.domainMatcher = rule.domainMatcher;
  r.outboundTag = rule.outboundTag;
  return r;
}

export function reconcileHopRoutingRules(input: ReconcileInput): unknown[] {
  const preserved = input.existingRules.filter(
    (r) => !(isRecord(r) && rulesIntersect(r, input.hopInboundTags)),
  );
  const ours = input.userRules.map((r) => userRuleToXray(r, input.hopInboundTags[0] ?? ""));
  return [...ours, input.fallbackRule, ...preserved];
}
```

- [ ] **Step 4: Run tests**

Run: `cd apps/server && bun test src/xui/emitRoutingRulesForHop.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
cd /workspace
git add apps/server/src/xui/emitRoutingRulesForHop.ts \
        apps/server/src/xui/emitRoutingRulesForHop.test.ts
git commit -m "feat(xui): add pure reconcile function for hop routing rules"
```

---

### Task 8: Wire the panel push into `PATCH /api/routing/:id`

**Files:**
- Create: `apps/server/src/xui/pushHopRoutingToPanel.ts`
- Create: `apps/server/src/xui/pushHopRoutingToPanel.test.ts`
- Modify: `apps/server/src/routes/routing.ts` (accept an emitter dependency)
- Modify: `apps/server/src/index.ts` (pass env/emitter)
- Modify: `apps/server/src/routes/routing.test.ts` (mock emitter)

- [ ] **Step 1: Define the emitter interface and write tests**

Create `apps/server/src/xui/pushHopRoutingToPanel.test.ts`:

```ts
import { describe, expect, mock, test } from "bun:test";
import { pushHopRoutingToPanel } from "./pushHopRoutingToPanel";
import type { RoutingRuleInput } from "../routing/ruleShape";

const baseInput = {
  panelBaseUrl: "https://p.test/",
  adminUsername: "a",
  adminPassword: "b",
  hopInboundTags: ["inbound-443"],
  userRules: [] as RoutingRuleInput[],
  directOutboundTag: "direct",
  blockedOutboundTag: "blocked",
  nextHopOutboundTag: "proxy-1",
};

describe("pushHopRoutingToPanel", () => {
  test("logs in, fetches xray, rewrites rules, saves, restarts", async () => {
    const calls: string[] = [];
    const fetchMock = mock(async (url: RequestInfo | URL) => {
      const s = typeof url === "string" ? url : url.toString();
      calls.push(s);
      if (s.endsWith("/login")) {
        return new Response(JSON.stringify({ success: true }), {
          headers: { "set-cookie": "3x-ui=c; Path=/" },
        });
      }
      if (s.endsWith("/panel/xray/")) {
        return new Response(
          JSON.stringify({
            success: true,
            obj: JSON.stringify({
              xraySetting: {
                outbounds: [
                  { protocol: "freedom", tag: "direct" },
                  { protocol: "blackhole", tag: "blocked" },
                ],
                routing: { rules: [] },
              },
              outboundTestUrl: "https://x",
            }),
          }),
        );
      }
      if (s.endsWith("/panel/xray/update")) {
        return new Response(JSON.stringify({ success: true }));
      }
      if (s.endsWith("/panel/api/server/restartXrayService")) {
        return new Response(JSON.stringify({ success: true }));
      }
      throw new Error(`unexpected ${s}`);
    });

    await pushHopRoutingToPanel({ ...baseInput, fetchFn: fetchMock as typeof fetch });

    expect(calls.some((c) => c.endsWith("/panel/xray/update"))).toBe(true);
    expect(calls.some((c) => c.endsWith("/panel/api/server/restartXrayService"))).toBe(true);
  });

  test("throws PanelRequestError when update fails", async () => {
    const fetchMock = mock(async (url: RequestInfo | URL) => {
      const s = typeof url === "string" ? url : url.toString();
      if (s.endsWith("/login")) {
        return new Response(JSON.stringify({ success: true }), {
          headers: { "set-cookie": "3x-ui=c; Path=/" },
        });
      }
      if (s.endsWith("/panel/xray/")) {
        return new Response(
          JSON.stringify({
            success: true,
            obj: JSON.stringify({ xraySetting: { outbounds: [], routing: { rules: [] } } }),
          }),
        );
      }
      if (s.endsWith("/panel/xray/update")) {
        return new Response(JSON.stringify({ success: false, msg: "boom" }));
      }
      return new Response(JSON.stringify({ success: true }));
    });

    await expect(
      pushHopRoutingToPanel({ ...baseInput, fetchFn: fetchMock as typeof fetch }),
    ).rejects.toThrow(/boom|update panel xray failed/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/server && bun test src/xui/pushHopRoutingToPanel.test.ts`
Expected: module not found.

- [ ] **Step 3: Implement the push helper**

Create `apps/server/src/xui/pushHopRoutingToPanel.ts`:

```ts
import type { RoutingRuleInput } from "../routing/ruleShape";
import { reconcileHopRoutingRules } from "./emitRoutingRulesForHop";
import { fetchPanelXrayBundle, restartPanelXrayService, updatePanelXraySetting } from "./panelXrayClient";
import { loginCookie } from "./panelLoginCookie";

function resolveOutboundTag(
  requested: string,
  mapping: { directOutboundTag: string; blockedOutboundTag: string; nextHopOutboundTag: string },
): string {
  if (requested === "direct") return mapping.directOutboundTag;
  if (requested === "blocked") return mapping.blockedOutboundTag;
  if (requested === "next-hop") return mapping.nextHopOutboundTag;
  return requested;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export async function pushHopRoutingToPanel(input: {
  panelBaseUrl: string;
  adminUsername: string;
  adminPassword: string;
  hopInboundTags: string[];
  userRules: RoutingRuleInput[];
  directOutboundTag: string;
  blockedOutboundTag: string;
  nextHopOutboundTag: string;
  fetchFn?: typeof fetch;
}): Promise<void> {
  const fetchFn = input.fetchFn ?? fetch;
  const { base, cookieHeader } = await loginCookie({
    panelBaseUrl: input.panelBaseUrl,
    adminUsername: input.adminUsername,
    adminPassword: input.adminPassword,
    fetchFn,
  });

  const bundle = await fetchPanelXrayBundle({
    panelBaseUrl: base,
    cookieHeader,
    fetchFn,
  });
  const xray = JSON.parse(bundle.xraySettingText) as Record<string, unknown>;
  const routing = isRecord(xray.routing) ? xray.routing : (xray.routing = {});
  const existingRules = Array.isArray((routing as Record<string, unknown>).rules)
    ? ((routing as Record<string, unknown>).rules as unknown[])
    : [];

  const resolvedUserRules = input.userRules.map((r) => ({
    ...r,
    outboundTag: resolveOutboundTag(r.outboundTag, input),
  }));

  const fallbackRule = {
    type: "field",
    inboundTag: [...input.hopInboundTags],
    outboundTag: input.nextHopOutboundTag,
  };

  const nextRules = reconcileHopRoutingRules({
    existingRules,
    hopInboundTags: input.hopInboundTags,
    userRules: resolvedUserRules,
    fallbackRule,
  });

  (routing as Record<string, unknown>).rules = nextRules;
  (xray as Record<string, unknown>).routing = routing;

  await updatePanelXraySetting({
    panelBaseUrl: base,
    cookieHeader,
    xraySettingText: JSON.stringify(xray),
    outboundTestUrl: bundle.outboundTestUrl,
    fetchFn,
  });
  await restartPanelXrayService({ panelBaseUrl: base, cookieHeader, fetchFn });
}
```

- [ ] **Step 4: Run the push tests**

Run: `cd apps/server && bun test src/xui/pushHopRoutingToPanel.test.ts`
Expected: all pass.

- [ ] **Step 5: Wire into the PATCH handler via dependency injection**

Modify `apps/server/src/routes/routing.ts` to accept an emitter and credential resolver:

```ts
import type { Database } from "bun:sqlite";
import type { Context } from "hono";
import { Hono } from "hono";
import { validateRules } from "../routing/validateRules";
import {
  computeAllowedOutboundTags,
  readRoutingProfileByChainHopId,
  readRoutingProfileById,
  replaceRulesForProfile,
} from "../routing/rulesRepo";
import type { RoutingRuleInput } from "../routing/ruleShape";

export type HopPanelBinding = {
  panelBaseUrl: string;
  adminUsername: string;
  adminPassword: string;
  hopInboundTags: string[];
  directOutboundTag: string;
  blockedOutboundTag: string;
  nextHopOutboundTag: string;
};

export type RoutingRoutesDeps = {
  resolveHopPanelBinding: (
    db: Database,
    routingProfileId: number,
  ) => Promise<HopPanelBinding | null>;
  pushHopRouting: (binding: HopPanelBinding, rules: RoutingRuleInput[]) => Promise<void>;
};

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}
function parseId(s: string): number | null {
  const n = Number(s);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

export function routingRoutes(db: Database, deps: RoutingRoutesDeps) {
  const app = new Hono();

  app.get("/by-hop/:chainHopId", (c) => {
    const chainHopId = parseId(c.req.param("chainHopId"));
    if (chainHopId === null) return c.json({ error: "Invalid chain hop id" }, 400);
    const dto = readRoutingProfileByChainHopId(db, chainHopId);
    if (!dto) return c.json({ error: "Routing profile not found" }, 404);
    return c.json(dto);
  });

  app.patch("/:routingProfileId", async (c) => {
    const routingProfileId = parseId(c.req.param("routingProfileId"));
    if (routingProfileId === null) return c.json({ error: "Invalid routing profile id" }, 400);
    const existing = readRoutingProfileById(db, routingProfileId);
    if (!existing) return c.json({ error: "Routing profile not found" }, 404);

    const body = (await readJson(c)) as { rules?: unknown } | null;
    if (!body || typeof body !== "object") {
      return c.json({ error: "Invalid routing payload" }, 400);
    }
    const allowed = computeAllowedOutboundTags(db, routingProfileId);
    const parsed = validateRules(
      { rules: (body.rules as RoutingRuleInput[]) ?? [] },
      allowed,
    );
    if (!parsed.ok) {
      return c.json(
        { error: parsed.error, ruleIndex: parsed.ruleIndex, field: parsed.field },
        400,
      );
    }

    const binding = await deps.resolveHopPanelBinding(db, routingProfileId);
    if (!binding) {
      return c.json(
        { error: "hop is not bound to a provisioned panel; cannot push rules" },
        409,
      );
    }

    db.exec("BEGIN");
    try {
      replaceRulesForProfile(db, routingProfileId, parsed.value.rules);
      await deps.pushHopRouting(binding, parsed.value.rules);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      const msg = err instanceof Error ? err.message : "panel push failed";
      return c.json({ error: `panel-push-failed: ${msg}` }, 502);
    }

    return c.json(readRoutingProfileById(db, routingProfileId)!);
  });

  return app;
}
```

- [ ] **Step 6: Update `apps/server/src/index.ts` to construct the real deps**

Locate the `app.route("/routing", routingRoutes(db))` call in `apps/server/src/index.ts` (around lines 42–48). Replace with an inline `deps` object that resolves bindings from the DB and calls `pushHopRoutingToPanel`:

```ts
import { pushHopRoutingToPanel } from "./xui/pushHopRoutingToPanel";
import { decryptXuiSecretsJson } from "./crypto/xuiSecrets";
// ...
app.route("/routing", routingRoutes(db, {
  resolveHopPanelBinding: async (db, routingProfileId) => {
    const row = db
      .query<{
        panelHostname: string;
        xuiWebBasePath: string | null;
        xuiPanelPort: number | null;
        xuiCiphertext: Uint8Array | null;
        xuiNonce: Uint8Array | null;
        hopInboundTag: string | null;
        nextHopOutboundTag: string | null;
      }, [number]>(
        `SELECT
           vp.panel_hostname AS panelHostname,
           vp.xui_web_base_path AS xuiWebBasePath,
           vp.xui_panel_port AS xuiPanelPort,
           vp.xui_secrets_ciphertext AS xuiCiphertext,
           vp.xui_secrets_nonce AS xuiNonce
         FROM routing_profiles rp
         JOIN chain_hops ch ON ch.id = rp.chain_hop_id
         JOIN vpn_profiles vp ON vp.id = ch.vpn_profile_id
         WHERE rp.id = ?`,
      )
      .get(routingProfileId);
    if (!row || !row.xuiCiphertext || !row.xuiNonce || !row.xuiWebBasePath) return null;

    const secrets = await decryptXuiSecretsJson(env.masterKey, row.xuiCiphertext, row.xuiNonce);

    // TODO(followup): the hopInboundTag and nextHopOutboundTag must be discovered
    // from the panel. For this first version, derive them with the same rules the
    // provisioner uses: hop inbound tag == most recent `inbound-*` tag belonging
    // to this chain on the panel; next-hop outbound tag == proxy outbound created
    // by the provisioner (tag `proxy-<chainId>-<hopPosition>`). A proper
    // implementation belongs in a dedicated helper; inline here for now.
    return {
      panelBaseUrl: "" /* build from hostname + path + port in a helper */,
      adminUsername: secrets.username,
      adminPassword: secrets.password,
      hopInboundTags: ["TODO-resolve"],
      directOutboundTag: "direct",
      blockedOutboundTag: "blocked",
      nextHopOutboundTag: "TODO-resolve",
    };
  },
  pushHopRouting: async (binding, rules) => {
    await pushHopRoutingToPanel({
      panelBaseUrl: binding.panelBaseUrl,
      adminUsername: binding.adminUsername,
      adminPassword: binding.adminPassword,
      hopInboundTags: binding.hopInboundTags,
      userRules: rules,
      directOutboundTag: binding.directOutboundTag,
      blockedOutboundTag: binding.blockedOutboundTag,
      nextHopOutboundTag: binding.nextHopOutboundTag,
    });
  },
}));
```

The `TODO-resolve` placeholders are filled in Step 7 below — they depend on a helper we build next.

- [ ] **Step 7: Build the binding resolver helper**

Create `apps/server/src/routing/resolveHopPanelBinding.ts` that:

1. Loads the VPN profile row (hostname, port, web base path, encrypted xui secrets).
2. Builds `panelBaseUrl` using the same logic as chain provisioning (see `apps/server/src/xui/dialHostForVpnProfile.ts` and `provisionChainClientAccess` call sites for the exact `new URL(...)` assembly).
3. Fetches the hop's current inbound tag from the panel by listing inbounds and picking the one whose `remark` matches the chain/hop naming convention used in `provisionMultihopChainClientAccess`.
4. Derives the `nextHopOutboundTag` from the chain's next-hop `vpn_profile_id` and the outbound naming convention used in `buildVlessRealityOutbound`.

Write a unit test for the assembler portion (URL building + field decryption) and stub out panel calls.

Replace `TODO-resolve` in `index.ts` with a call to this helper.

- [ ] **Step 8: Update `routing.test.ts` with a stub emitter**

In `apps/server/src/routes/routing.test.ts`, replace every `createApp(db, env)` call that exercises a routing route with a local factory that builds the Hono app using a stubbed `deps`:

```ts
function makeApp(db: Database, push: (b: any, r: any) => Promise<void>) {
  const app = new Hono();
  app.use("*", authMiddleware(db));
  app.route(
    "/api/routing",
    routingRoutes(db, {
      resolveHopPanelBinding: async () => ({
        panelBaseUrl: "https://stub",
        adminUsername: "u",
        adminPassword: "p",
        hopInboundTags: ["inbound-443"],
        directOutboundTag: "direct",
        blockedOutboundTag: "blocked",
        nextHopOutboundTag: "next-hop-out",
      }),
      pushHopRouting: push,
    }),
  );
  return app;
}
```

Add two tests:

- Happy path: `push` mock returns resolved; PATCH returns 200 and DB has the new rules.
- Sad path: `push` mock rejects with `new Error("panel down")`; PATCH returns 502 with body `{ error: "panel-push-failed: panel down" }` and DB still holds the **previous** rules (i.e., the write was rolled back).

- [ ] **Step 9: Run the full server test suite**

Run: `cd apps/server && bun test`
Expected: all tests pass.

- [ ] **Step 10: Commit**

```bash
cd /workspace
git add apps/server/src/xui/pushHopRoutingToPanel.ts \
        apps/server/src/xui/pushHopRoutingToPanel.test.ts \
        apps/server/src/routes/routing.ts \
        apps/server/src/routes/routing.test.ts \
        apps/server/src/routing/resolveHopPanelBinding.ts \
        apps/server/src/routing/resolveHopPanelBinding.test.ts \
        apps/server/src/index.ts
git commit -m "feat(routing): push rules to panel on PATCH with transactional rollback"
```

---

### Task 9: Publish stored rules during chain provisioning

**Files:**
- Modify: `apps/server/src/xui/provisionMultihopChainClientAccess.ts`
- Modify: `apps/server/src/xui/provisionMultihopChainClientAccess.test.ts`

- [ ] **Step 1: Extend the existing multihop integration test**

Locate the two-hop test in `provisionMultihopChainClientAccess.test.ts`. After the existing assertions, add one more expectation: after provisioning completes, the mocked `panel/xray/update` call for each hop was invoked with a body whose `routing.rules` contains both user rules (seeded before provisioning) and the provisioner's fallback rule, in the correct order.

To seed rules: the test will need to inject stored rules into `provisionMultihopChainClientAccess`. Change the function signature to accept an optional `readUserRulesForHop: (chainHopId: number) => RoutingRuleInput[]` function so the test can provide rules without coupling to the DB.

Update the new test to pass a stub that returns a single `{ outboundTag: "direct", domains: [".example.com"] }` rule for hop0 and an empty list for hop1. Assert the final `xraySetting` pushed to each hop contains the expected rules.

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/server && bun test src/xui/provisionMultihopChainClientAccess.test.ts`
Expected: new assertion fails.

- [ ] **Step 3: Implement the change in `provisionMultihopChainClientAccess.ts`**

Add an optional `readUserRulesForHop` parameter. In the per-hop merge step, call `reconcileHopRoutingRules` with the stored user rules instead of only calling `mergeInboundToOutboundRule`. Keep the existing single-rule helper usable when `readUserRulesForHop` is not provided (fallback to the current behavior — no user rules, fallback rule only).

- [ ] **Step 4: Wire DB-backed `readUserRulesForHop` at call sites**

Find every caller of `provisionMultihopChainClientAccess` in the repo and pass a closure that calls `readRoutingProfileByChainHopId(db, chainHopId)` and returns its `.rules`.

- [ ] **Step 5: Re-run the xui tests**

Run: `cd apps/server && bun test src/xui/`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
cd /workspace
git add apps/server/src/xui/provisionMultihopChainClientAccess.ts \
        apps/server/src/xui/provisionMultihopChainClientAccess.test.ts \
        apps/server/src/routes/chains.ts
git commit -m "feat(xui): publish stored routing rules during chain provisioning"
```

---

## Phase 4 — Web UI

### Task 10: Add @dnd-kit dependencies

**Files:**
- Modify: `apps/web/package.json`
- Modify: `bun.lock`

- [ ] **Step 1: Add the deps**

Run from the repo root:

```bash
cd /workspace && bun add --cwd apps/web @dnd-kit/core @dnd-kit/sortable
```

Expected: `package.json` updated, `bun.lock` updated.

- [ ] **Step 2: Verify install**

Run: `cd apps/web && bunx tsc -b`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
cd /workspace
git add apps/web/package.json bun.lock
git commit -m "chore(web): add @dnd-kit for drag-to-reorder routing rules"
```

---

### Task 11: `ChipInput` component (TDD with happy-dom)

**Files:**
- Create: `apps/web/src/components/ChipInput.tsx`
- Create: `apps/web/src/components/ChipInput.test.tsx`

- [ ] **Step 1: Write failing tests**

Create `apps/web/src/components/ChipInput.test.tsx`:

```tsx
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { ChipInput } from "./ChipInput";

let window: Window;

beforeEach(() => {
  window = new Window();
  // @ts-expect-error wire happy-dom globals
  globalThis.window = window;
  globalThis.document = window.document as unknown as Document;
});

afterEach(() => {
  window.close();
});

describe("ChipInput", () => {
  test("adds a chip on Enter", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const values: string[][] = [];
    await act(async () => {
      root.render(
        <ChipInput value={["a"]} onChange={(v) => values.push(v)} placeholder="x" />,
      );
    });
    const input = container.querySelector("input")!;
    await act(async () => {
      input.value = "b";
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
      input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(values.at(-1)).toEqual(["a", "b"]);
  });

  test("removes a chip on backspace when input is empty", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const values: string[][] = [];
    await act(async () => {
      root.render(<ChipInput value={["a", "b"]} onChange={(v) => values.push(v)} />);
    });
    const input = container.querySelector("input")!;
    await act(async () => {
      input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Backspace", bubbles: true }));
    });
    expect(values.at(-1)).toEqual(["a"]);
  });

  test("rejects empty/whitespace values", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const values: string[][] = [];
    await act(async () => {
      root.render(<ChipInput value={[]} onChange={(v) => values.push(v)} />);
    });
    const input = container.querySelector("input")!;
    await act(async () => {
      input.value = "   ";
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
      input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(values).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/web && bun test src/components/ChipInput.test.tsx`
Expected: module not found.

- [ ] **Step 3: Implement `ChipInput.tsx`**

Create `apps/web/src/components/ChipInput.tsx`:

```tsx
import { useState, type CSSProperties, type KeyboardEvent } from "react";

type Props = {
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  id?: string;
};

export function ChipInput({ value, onChange, placeholder, id }: Props) {
  const [draft, setDraft] = useState("");

  function commit() {
    const trimmed = draft.trim();
    if (trimmed === "") return;
    onChange([...value, trimmed]);
    setDraft("");
  }

  function handleKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      commit();
    } else if (e.key === "Backspace" && draft === "" && value.length > 0) {
      e.preventDefault();
      onChange(value.slice(0, -1));
    }
  }

  return (
    <div style={wrapperStyle}>
      {value.map((v, i) => (
        <span key={`${v}-${i}`} style={chipStyle}>
          {v}
          <button
            type="button"
            style={chipRemoveStyle}
            onClick={() => onChange(value.filter((_, idx) => idx !== i))}
            aria-label={`Remove ${v}`}
          >
            ×
          </button>
        </span>
      ))}
      <input
        id={id}
        style={inputStyle}
        type="text"
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => commit()}
        onKeyDown={handleKey}
      />
    </div>
  );
}

const wrapperStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "6px",
  padding: "8px 10px",
  border: "1px solid #d1d5db",
  borderRadius: "10px",
  background: "#ffffff",
};
const chipStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "4px",
  padding: "2px 8px",
  background: "#f3f4f6",
  border: "1px solid #e5e7eb",
  borderRadius: "999px",
  fontSize: "0.85rem",
};
const chipRemoveStyle: CSSProperties = {
  background: "transparent",
  border: "none",
  cursor: "pointer",
  padding: 0,
  fontSize: "1rem",
  lineHeight: 1,
};
const inputStyle: CSSProperties = {
  flex: 1,
  minWidth: "120px",
  border: "none",
  outline: "none",
  fontSize: "1rem",
};
```

- [ ] **Step 4: Run tests**

Run: `cd apps/web && bun test src/components/ChipInput.test.tsx`
Expected: 3 passes.

- [ ] **Step 5: Commit**

```bash
cd /workspace
git add apps/web/src/components/ChipInput.tsx apps/web/src/components/ChipInput.test.tsx
git commit -m "feat(web): add ChipInput component for multi-value rule fields"
```

---

### Task 12: `OutboundTagPill` component

**Files:**
- Create: `apps/web/src/components/OutboundTagPill.tsx`

- [ ] **Step 1: Implement the pill**

Create `apps/web/src/components/OutboundTagPill.tsx`:

```tsx
import type { CSSProperties } from "react";

export function OutboundTagPill({ tag }: { tag: string }) {
  const style = pillStyleFor(tag);
  return <span style={style}>{tag}</span>;
}

function pillStyleFor(tag: string): CSSProperties {
  const base: CSSProperties = {
    display: "inline-block",
    padding: "2px 10px",
    borderRadius: "999px",
    fontSize: "0.8rem",
    fontWeight: 600,
    letterSpacing: "0.02em",
  };
  if (tag === "direct") return { ...base, background: "#f3f4f6", color: "#111827", border: "1px solid #e5e7eb" };
  if (tag === "blocked") return { ...base, background: "#fef2f2", color: "#b91c1c", border: "1px solid #fecaca" };
  if (tag === "next-hop") return { ...base, background: "#eff6ff", color: "#1d4ed8", border: "1px solid #bfdbfe" };
  return { ...base, background: "#f9fafb", color: "#374151", border: "1px solid #e5e7eb" };
}
```

- [ ] **Step 2: TypeScript check**

Run: `cd apps/web && bunx tsc -b`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
cd /workspace
git add apps/web/src/components/OutboundTagPill.tsx
git commit -m "feat(web): add OutboundTagPill component"
```

---

### Task 13: `RuleMatchSummary` component

**Files:**
- Create: `apps/web/src/components/RuleMatchSummary.tsx`

- [ ] **Step 1: Implement**

Create `apps/web/src/components/RuleMatchSummary.tsx`:

```tsx
import type { CSSProperties } from "react";
import type { RoutingRuleDto } from "../types/routing";

export function RuleMatchSummary({ rule }: { rule: RoutingRuleDto }) {
  const parts: string[] = [];
  if (rule.domains && rule.domains.length) parts.push(`domain: ${rule.domains.join(", ")}`);
  if (rule.ips && rule.ips.length) parts.push(`ip: ${rule.ips.join(", ")}`);
  if (rule.ports) parts.push(`port: ${rule.ports}`);
  if (rule.sourcePorts) parts.push(`sourcePort: ${rule.sourcePorts}`);
  if (rule.protocols && rule.protocols.length) parts.push(`proto: ${rule.protocols.join(", ")}`);
  if (rule.networks && rule.networks.length) parts.push(`net: ${rule.networks.join(", ")}`);
  if (rule.sources && rule.sources.length) parts.push(`source: ${rule.sources.join(", ")}`);
  if (rule.users && rule.users.length) parts.push(`user: ${rule.users.join(", ")}`);
  if (rule.attrs) parts.push(`attrs: ${Object.keys(rule.attrs).length} keys`);

  if (parts.length === 0) {
    return <span style={matchAllStyle}>match-all</span>;
  }
  const text = parts.join(" · ");
  return (
    <span style={summaryStyle} title={text}>
      {text}
    </span>
  );
}

const summaryStyle: CSSProperties = {
  display: "inline-block",
  maxWidth: "640px",
  overflow: "hidden",
  whiteSpace: "nowrap",
  textOverflow: "ellipsis",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: "0.85rem",
  color: "#374151",
};

const matchAllStyle: CSSProperties = {
  fontStyle: "italic",
  color: "#6b7280",
};
```

- [ ] **Step 2: Create the shared type file**

Create `apps/web/src/types/routing.ts`:

```ts
export const PROTOCOLS = ["http", "tls", "bittorrent", "quic"] as const;
export const NETWORKS = ["tcp", "udp"] as const;
export const DOMAIN_MATCHERS = ["hybrid", "linear"] as const;

export type Protocol = (typeof PROTOCOLS)[number];
export type Network = (typeof NETWORKS)[number];
export type DomainMatcher = (typeof DOMAIN_MATCHERS)[number];

export type RoutingRuleInput = {
  outboundTag: string;
  ruleTag: string | null;
  domainMatcher: DomainMatcher | null;
  domains: string[] | null;
  ips: string[] | null;
  ports: string | null;
  sourcePorts: string | null;
  protocols: Protocol[] | null;
  networks: Network[] | null;
  sources: string[] | null;
  users: string[] | null;
  inboundTags: string[] | null;
  attrs: Record<string, string> | null;
};

export type RoutingRuleDto = RoutingRuleInput & {
  id: number;
  position: number;
};

export type RoutingProfileDto = {
  id: number;
  name: string;
  chainHopId: number;
  chainId: number;
  allowedOutboundTags: string[];
  rules: RoutingRuleDto[];
};

export type RoutingPatchPayload = {
  rules: RoutingRuleInput[];
};
```

- [ ] **Step 3: TypeScript check**

Run: `cd apps/web && bunx tsc -b`
Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
cd /workspace
git add apps/web/src/components/RuleMatchSummary.tsx \
        apps/web/src/types/routing.ts
git commit -m "feat(web): add shared routing types and RuleMatchSummary"
```

---

### Task 14: `RoutingRuleModal` component

**Files:**
- Create: `apps/web/src/components/RoutingRuleModal.tsx`
- Create: `apps/web/src/components/RoutingRuleModal.test.tsx`

- [ ] **Step 1: Write failing tests**

Create `apps/web/src/components/RoutingRuleModal.test.tsx`:

```tsx
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { RoutingRuleModal } from "./RoutingRuleModal";
import type { RoutingRuleInput } from "../types/routing";

let window: Window;

const empty: RoutingRuleInput = {
  outboundTag: "direct",
  ruleTag: null,
  domainMatcher: null,
  domains: null,
  ips: null,
  ports: null,
  sourcePorts: null,
  protocols: null,
  networks: null,
  sources: null,
  users: null,
  inboundTags: null,
  attrs: null,
};

beforeEach(() => {
  window = new Window();
  // @ts-expect-error
  globalThis.window = window;
  globalThis.document = window.document as unknown as Document;
});
afterEach(() => window.close());

describe("RoutingRuleModal", () => {
  test("renders with allowed outbound tags as options", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <RoutingRuleModal
          title="Add rule"
          initial={empty}
          allowedOutboundTags={["direct", "blocked", "next-hop"]}
          onSave={() => {}}
          onCancel={() => {}}
        />,
      );
    });
    const select = container.querySelector<HTMLSelectElement>("select[name='outboundTag']")!;
    const options = Array.from(select.options).map((o) => o.value);
    expect(options).toEqual(["direct", "blocked", "next-hop"]);
  });

  test("blocks Save when ports string is invalid", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let saved: RoutingRuleInput | null = null;
    await act(async () => {
      root.render(
        <RoutingRuleModal
          title="Add rule"
          initial={empty}
          allowedOutboundTags={["direct", "blocked", "next-hop"]}
          onSave={(v) => (saved = v)}
          onCancel={() => {}}
        />,
      );
    });
    const ports = container.querySelector<HTMLInputElement>("input[name='ports']")!;
    await act(async () => {
      ports.value = "0-100";
      ports.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    const save = container.querySelector<HTMLButtonElement>("button[data-role='save']")!;
    await act(async () => save.click());
    expect(saved).toBeNull();
  });

  test("saves a rule with domains chip input", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let saved: RoutingRuleInput | null = null;
    await act(async () => {
      root.render(
        <RoutingRuleModal
          title="Add rule"
          initial={empty}
          allowedOutboundTags={["direct", "blocked", "next-hop"]}
          onSave={(v) => (saved = v)}
          onCancel={() => {}}
        />,
      );
    });
    const domainsInput = container.querySelector<HTMLInputElement>(
      "input[data-field='domains']",
    )!;
    await act(async () => {
      domainsInput.value = ".example.com";
      domainsInput.dispatchEvent(new window.Event("input", { bubbles: true }));
      domainsInput.dispatchEvent(
        new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    const save = container.querySelector<HTMLButtonElement>("button[data-role='save']")!;
    await act(async () => save.click());
    expect(saved).not.toBeNull();
    expect(saved!.domains).toEqual([".example.com"]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/web && bun test src/components/RoutingRuleModal.test.tsx`
Expected: module not found.

- [ ] **Step 3: Implement the modal**

Create `apps/web/src/components/RoutingRuleModal.tsx`. Include:

- Controlled inputs for every rule field listed in `RoutingRuleInput`.
- Chip inputs for array fields (reuse `ChipInput`).
- Multi-checkbox for `protocols` (4 options) and `networks` (2 options).
- Select for `domainMatcher` and `outboundTag`.
- Port-string validator using the same regex + range check as the server (copy from `apps/server/src/routing/validateRules.ts`).
- Advanced collapsible (closed by default) containing `ruleTag` and `attrs` (key/value grid: add/remove rows).
- "Cancel" → calls `onCancel`.
- "Save" → runs client validation; if valid, builds `RoutingRuleInput` (normalizing empty arrays/strings to `null`) and calls `onSave(rule)`.

Keep the modal's JSX well below 600 lines by splitting sub-sections into local `function Section({...})` components within the same file.

- [ ] **Step 4: Run tests**

Run: `cd apps/web && bun test src/components/RoutingRuleModal.test.tsx`
Expected: 3 passes.

- [ ] **Step 5: Commit**

```bash
cd /workspace
git add apps/web/src/components/RoutingRuleModal.tsx \
        apps/web/src/components/RoutingRuleModal.test.tsx
git commit -m "feat(web): add RoutingRuleModal with chip inputs and client validation"
```

---

### Task 15: Rebuild `RoutingPage.tsx` (table + drag + modal wiring)

**Files:**
- Modify: `apps/web/src/pages/RoutingPage.tsx` (full rewrite)

- [ ] **Step 1: Remove the old file contents**

Preserve the top-level imports you need (`useMutation`, `useQuery`, `useQueryClient`, `apiFetch`, `ApiError`) and the chain/hop selector logic. Delete:

- The old `MatchKind` / `RuleAction` / `DefaultAction` types.
- The `validateRoutingForm` helper.
- `handleMoveRule`, `handleRuleChange` (replaced by modal-driven editing).
- The inline table with per-cell `select` / `input`.
- The "Default action" fieldset JSX and radios.

Import the new types from `../types/routing` and the new components from `../components/`.

- [ ] **Step 2: Add drag context**

Use `@dnd-kit/core` `DndContext` + `@dnd-kit/sortable` `SortableContext` + `useSortable` on each row. Row keys are the local `key` field (same approach as today).

- [ ] **Step 3: Wire modal state**

Add:

```tsx
type ModalMode =
  | { kind: "closed" }
  | { kind: "add" }
  | { kind: "edit"; key: number; index: number };
const [modal, setModal] = useState<ModalMode>({ kind: "closed" });
```

Rules table row gets an "Edit" button setting `setModal({ kind: "edit", key: row.key, index })`. "Add rule" button sets `setModal({ kind: "add" })`. On `onSave`, update `ruleRows` accordingly and close the modal.

- [ ] **Step 4: Build the summary table**

Columns: drag handle, `#`, `Rule Tag` (`row.ruleTag ?? "—"`), `Inbound Tags` (joined), `Outbound Tag` (via `OutboundTagPill`), `Match` (via `RuleMatchSummary`), actions (`Edit`, `Remove`).

- [ ] **Step 5: Wire the Save changes button**

On submit, build the payload `{ rules: ruleRows.map(toInput) }` and call `updateRoutingProfile`. `toInput` strips client-only `key` and maps empty arrays to `null`.

Handle 502 responses (panel-push-failed): display the error text from the response body in `formError`; the DB rolled back, so no state refresh needed.

Handle 400 responses: if the body has `ruleIndex` / `field`, render a user-friendly error that mentions the rule number.

- [ ] **Step 6: TypeScript check**

Run: `cd apps/web && bunx tsc -b`
Expected: exits 0.

- [ ] **Step 7: Commit**

```bash
cd /workspace
git add apps/web/src/pages/RoutingPage.tsx
git commit -m "feat(web): rebuild Routing page with 3x-ui-style rules table and modal"
```

---

### Task 16: End-to-end manual verification

**Setup:**
- API: `bun --cwd apps/server dev`
- Web: `bun --cwd apps/web dev`
- Admin: `cd apps/server && ADMIN_USERNAME=admin ADMIN_PASSWORD=changeme bun scripts/create-admin.ts`
- Seed one working VPN profile with xui secrets via the existing flow on `/vpns` (or reuse an existing DB).
- Create a chain with 2 hops on `/chains`.

- [ ] **Step 1: Build and lint pass**

Run:
```bash
cd /workspace
bun install
bun --cwd apps/web build
bun test apps/server
```

All three must succeed before manual testing.

- [ ] **Step 2: Start servers in tmux**

Start API and web dev servers in tmux sessions so they stay running across testing steps.

- [ ] **Step 3: `computerUse` walkthrough**

Provide the `computerUse` subagent these instructions:

1. Navigate to `http://localhost:5173`, log in as `admin` / `changeme`.
2. Go to **Routing**. Select the two-hop chain; select hop #1 (middle).
3. Click **Add rule**. In the modal: set **outboundTag** = `next-hop`; in the **Domains & IPs** section, add `.example.com` as a chip in the domains field; leave everything else blank. Click **Save**.
4. Confirm the new row appears with `next-hop` pill and `Match` cell showing `domain: .example.com`.
5. Click **Add rule** again. Outbound: `blocked`. In the **Ports & Protocols** section, set **Ports** = `443`, check **tls** and **tcp** boxes. Save.
6. Drag the second rule to the top. Confirm `#1` and `#2` swap in the rendered table.
7. Click **Save changes** and wait for the success banner.
8. Reload the page. Confirm both rules are still there in the new order.
9. Click **Edit** on rule #1, change the outbound to `direct`, Save, confirm the pill changes color.
10. Switch to hop #2 (terminal). Click **Add rule**. Confirm the outbound dropdown only offers `direct` and `blocked` (no `next-hop`).
11. In the same modal, try setting **Ports** = `0-100` → confirm the inline error blocks Save.

Screenshots required at: step 3 (modal populated), step 5 (two rows in table), step 6 (after drag), step 10 (terminal hop dropdown).

- [ ] **Step 4: Record video walkthrough**

Start screen recording, then run the happy path (steps 3 → 9). Stop recording and save.

- [ ] **Step 5: Verify panel push**

With one chain provisioned against a real 3x-ui panel (or the mocked panel fixture used in integration tests), inspect the panel's xray settings after step 7:

- `routing.rules[0]` should have `domain: [".example.com"]` and `outboundTag` resolving to our proxy outbound.
- The provisioner's original `inboundTag → <next-hop>` rule should still be present below the user rule.

Capture this as a terminal log artifact (the mocked panel test output is sufficient when a real panel is unavailable).

---

## Self-review findings

Ran the self-review checklist against the spec:

- **Spec coverage:** every section in the spec maps to at least one task (schema/migration → Task 1; API shape → Tasks 2, 3, 5; validation → Task 2; UI → Tasks 10–15; xray emission → Tasks 7–9; import/export ripple → Task 6; testing → covered inside each task; manual walkthrough → Task 16).
- **Placeholder scan:** one intentional `TODO(followup)` in Task 8 Step 6 is resolved by Step 7 of the same task.
- **Type consistency:** `RoutingRuleInput` / `RoutingRuleDto` / `RoutingProfileDto` names match between the server (`apps/server/src/routing/ruleShape.ts`) and web (`apps/web/src/types/routing.ts`); field names use camelCase identically.
- **Scope:** the plan touches database, server API, xray integration, and web UI — consistent with the expanded scope approved in the final spec. No single task crosses subsystems except Tasks 5 and 8 (necessarily, because they're the API/panel integration points).

## Execution handoff

**Plan complete.** Execution choices:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task with review between tasks.
2. **Inline Execution** — execute tasks in this session with checkpoints.

Pick one and say so, or say "start with Task N" to jump in.
