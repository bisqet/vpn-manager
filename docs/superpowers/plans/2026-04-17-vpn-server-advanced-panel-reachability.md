# VPN server Advanced panel + async reachability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a collapsed Advanced section on the VPN server modal (panel address, optional web path/port, optional panel admin credentials), persist credentials and path/port on the server, run an async HTTPS reachability probe after relevant writes, and show probe status in the VPNs table with list polling while any profile is `checking`.

**Architecture:** SQLite gains three `panel_reachability_*` columns (default `unknown`). `POST`/`PATCH` extend `vpn_profile` rows with optional `xui_secrets_*`, `xui_web_base_path`, and `xui_panel_port` from the client. A dedicated `panelReachabilityProbe` module builds the probe URL, classifies `fetch` results, and updates the row. Routes call `void schedulePanelReachabilityProbe(...)` after commit when the spec says to (create, panel-touching patch, setup success). The React app extends `VpnProfile` and uses `refetchInterval` on the profiles query when any row is `checking`.

**Tech Stack:** Bun, Hono, `bun:sqlite`, Zod, TanStack Query, React (`VpnsPage.tsx`), existing `encryptXuiSecretsJson` / `buildPanelHttpsUrl` / `httpsUrlHost` from `apps/server/src/net/panelAddress.ts`.

---

## File map

| File | Responsibility |
|------|------------------|
| `apps/server/src/db/schema.sql` | Canonical `vpn_profiles` columns for new DBs |
| `apps/server/src/db/migrateVpnProfilePanelReachability.ts` | `ALTER TABLE` for reachability columns if missing |
| `apps/server/src/db/migrate.ts` | Call `migrateVpnProfilePanelReachabilityIfNeeded` |
| `apps/server/src/db/migrate.test.ts` | Assert new columns exist after migrate |
| `apps/server/src/types.ts` | Extend `vpnProfileCreate` / `vpnProfileUpdate` Zod schemas |
| `apps/server/src/net/panelReachabilityProbe.ts` | URL build, `fetch` probe, DB update |
| `apps/server/src/net/panelReachabilityProbe.test.ts` | Unit tests with mocked `fetch` |
| `apps/server/src/routes/profiles.ts` | DTO row shape, SELECT lists, POST/PATCH persistence, schedule probe |
| `apps/server/src/routes/profiles.test.ts` | API + DB expectations; await probe in tests via delay or injected runner |
| `apps/server/src/vpn/setupLivePhaseLoop.ts` | After successful live setup, set `checking` + schedule probe |
| `apps/server/src/vpn/profileSetupTerminalBridge.ts` | Same after install terminal success |
| `apps/web/src/pages/VpnsPage.tsx` | Advanced UI, form state, validation, polling, status column |

---

### Task 1: Database migration and schema

**Files:**
- Create: `apps/server/src/db/migrateVpnProfilePanelReachability.ts`
- Modify: `apps/server/src/db/migrate.ts`
- Modify: `apps/server/src/db/schema.sql`
- Modify: `apps/server/src/db/migrate.test.ts`

- [ ] **Step 1: Add migration module**

Create `apps/server/src/db/migrateVpnProfilePanelReachability.ts`:

```typescript
import type { Database } from "bun:sqlite";

type TableInfoRow = { name: string };

function vpnProfilesColumns(db: Database): Set<string> {
  const rows = db.query<TableInfoRow, []>("PRAGMA table_info(vpn_profiles)").all();
  return new Set(rows.map((r) => r.name));
}

export function migrateVpnProfilePanelReachabilityIfNeeded(db: Database): void {
  const cols = vpnProfilesColumns(db);
  if (!cols.has("panel_reachability")) {
    db.exec(`
      ALTER TABLE vpn_profiles ADD COLUMN panel_reachability TEXT NOT NULL DEFAULT 'unknown'
        CHECK(panel_reachability IN ('unknown','checking','reachable','unreachable'));
    `);
  }
  if (!cols.has("panel_reachability_detail")) {
    db.exec(`ALTER TABLE vpn_profiles ADD COLUMN panel_reachability_detail TEXT;`);
  }
  if (!cols.has("panel_reachability_checked_at")) {
    db.exec(`ALTER TABLE vpn_profiles ADD COLUMN panel_reachability_checked_at TEXT;`);
  }
}
```

- [ ] **Step 2: Wire migrate**

In `apps/server/src/db/migrate.ts`, import and call `migrateVpnProfilePanelReachabilityIfNeeded(db)` after `migrateVpnProfileXuiPanelPortIfNeeded(db)`.

- [ ] **Step 3: Update base schema**

In `apps/server/src/db/schema.sql`, inside `vpn_profiles`, add the same three columns so fresh databases match migrated ones (place after `xui_panel_port` or before `last_setup_error`):

```sql
  panel_reachability TEXT NOT NULL DEFAULT 'unknown' CHECK(panel_reachability IN ('unknown','checking','reachable','unreachable')),
  panel_reachability_detail TEXT,
  panel_reachability_checked_at TEXT,
```

- [ ] **Step 4: Extend migrate test**

In `apps/server/src/db/migrate.test.ts`, after migration, assert `PRAGMA table_info(vpn_profiles)` includes `panel_reachability`, `panel_reachability_detail`, `panel_reachability_checked_at`.

- [ ] **Step 5: Run server DB tests**

Run: `bun test apps/server/src/db/migrate.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/db/migrateVpnProfilePanelReachability.ts apps/server/src/db/migrate.ts apps/server/src/db/schema.sql apps/server/src/db/migrate.test.ts
git commit -m "feat(db): add vpn_profiles panel reachability columns and migration."
```

---

### Task 2: Zod types for create/patch payloads

**Files:**
- Modify: `apps/server/src/types.ts`

- [ ] **Step 1: Extend `vpnProfileCreate`**

Replace the existing `vpnProfileCreate` export with:

```typescript
export const vpnProfileCreate = z
  .object({
    label: z.string().min(1),
    host: z.string().min(1),
    sshPort: z.number().int().min(1).max(65535),
    sshUser: z.string().min(1),
    sshPassword: z.string().min(1),
    /** Omitted or empty allowed when `host` is a public IP (server derives panel). */
    panelHostname: z.string().optional(),
    panelAdminUsername: z.string().optional(),
    panelAdminPassword: z.string().optional(),
    panelWebBasePath: z.string().optional(),
    panelHttpsPort: z.number().int().min(1).max(65535).optional(),
  })
  .superRefine((val, ctx) => {
    const u = val.panelAdminUsername?.trim() ?? "";
    const p = val.panelAdminPassword?.trim() ?? "";
    if ((u === "") !== (p === "")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "panelAdminUsername and panelAdminPassword must both be set or both omitted.",
        path: ["panelAdminPassword"],
      });
    }
  });
```

- [ ] **Step 2: Extend `vpnProfileUpdate`**

Add optional `panelAdminUsername`, `panelAdminPassword`, `panelWebBasePath`, `panelHttpsPort` with the same pair rule in `superRefine` (trim both before comparing). Keep existing optional fields.

- [ ] **Step 3: Strip empty panel password on patch (routes layer)**

Re-use the pattern for `sshPassword`: if `panelAdminPassword === ""`, delete it from the body object before `safeParse` in `PATCH` (so "omit" means keep existing secrets).

- [ ] **Step 4: Run a quick typecheck**

Run: `cd apps/server && bunx tsc -b --pretty false 2>&1 | head -40`
Expected: no errors in `types.ts` (full project may have unrelated errors; if clean, better).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/types.ts
git commit -m "feat(types): optional panel admin and path fields on profile create/update."
```

---

### Task 3: Panel reachability probe module

**Files:**
- Create: `apps/server/src/net/panelReachabilityProbe.ts`
- Create: `apps/server/src/net/panelReachabilityProbe.test.ts`

- [ ] **Step 1: Implement URL builder and classification**

Create `apps/server/src/net/panelReachabilityProbe.ts`:

```typescript
import type { Database } from "bun:sqlite";
import { buildPanelHttpsUrl, httpsUrlHost } from "./panelAddress";

export type PanelReachability = "unknown" | "checking" | "reachable" | "unreachable";

export type PanelReachabilityRow = {
  panel_hostname: string;
  xui_web_base_path: string | null;
  xui_panel_port: number | null;
};

/** HTTP status codes that count as "panel speaks HTTPS" for v1 (see spec). */
export function httpStatusMeansReachable(status: number): boolean {
  if (status >= 200 && status < 400) return true;
  if (status === 401 || status === 403) return true;
  return false;
}

export function buildPanelProbeUrl(row: PanelReachabilityRow): string | null {
  const host = row.panel_hostname.trim();
  if (!host) return null;
  const port =
    row.xui_panel_port != null && Number.isFinite(row.xui_panel_port)
      ? Math.trunc(Number(row.xui_panel_port))
      : null;
  const portSuffix = port !== null && port > 0 && port !== 443 && port <= 65535 ? `:${port}` : "";
  const httpsHost = httpsUrlHost(host);
  const path = row.xui_web_base_path?.trim() ?? "";
  if (path !== "") {
    return buildPanelHttpsUrl(host, path, port);
  }
  return `https://${httpsHost}${portSuffix}/`;
}

export function summarizeProbeError(err: unknown): string {
  if (err instanceof Error && err.name === "AbortError") return "Probe timed out.";
  if (err instanceof Error) return err.message.slice(0, 200);
  return String(err).slice(0, 200);
}

export type ProbeDeps = {
  fetchFn?: typeof fetch;
  timeoutMs?: number;
};

export async function runPanelReachabilityProbe(options: {
  db: Database;
  profileId: number;
} & ProbeDeps): Promise<void> {
  const { db, profileId } = options;
  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? 4000;

  const row =
    db
      .query<PanelReachabilityRow, [number]>(
        `SELECT panel_hostname, xui_web_base_path, xui_panel_port FROM vpn_profiles WHERE id = ?`,
      )
      .get(profileId) ?? null;

  if (!row) return;

  const url = buildPanelProbeUrl(row);
  if (!url) {
    db.query(
      `UPDATE vpn_profiles SET panel_reachability = 'unreachable', panel_reachability_detail = ?, panel_reachability_checked_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
    ).run("Panel hostname is missing.", profileId);
    return;
  }

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, { method: "GET", redirect: "follow", signal: controller.signal });
    if (httpStatusMeansReachable(res.status)) {
      db.query(
        `UPDATE vpn_profiles SET panel_reachability = 'reachable', panel_reachability_detail = NULL, panel_reachability_checked_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
      ).run(profileId);
    } else {
      db.query(
        `UPDATE vpn_profiles SET panel_reachability = 'unreachable', panel_reachability_detail = ?, panel_reachability_checked_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
      ).run(`HTTP ${res.status}`, profileId);
    }
  } catch (e) {
    db.query(
      `UPDATE vpn_profiles SET panel_reachability = 'unreachable', panel_reachability_detail = ?, panel_reachability_checked_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
    ).run(summarizeProbeError(e), profileId);
  } finally {
    clearTimeout(t);
  }
}

export function schedulePanelReachabilityProbe(options: {
  db: Database;
  profileId: number;
  fetchFn?: typeof fetch;
}): void {
  void runPanelReachabilityProbe(options);
}
```

Remove unused imports if any (`isPublicIpLiteral`, `Env` — trim before commit).

- [ ] **Step 2: Unit tests**

Create `apps/server/src/net/panelReachabilityProbe.test.ts` with tests that:

1. `httpStatusMeansReachable(200)` true; `httpStatusMeansReachable(404)` false.
2. `buildPanelProbeUrl` with `xui_web_base_path` null returns `https://.../` using `httpsUrlHost` (pick host `203.0.113.1` and assert string contains `https://203.0.113.1/`).
3. `runPanelReachabilityProbe` with mocked `fetchFn` returning `Response` status 401 updates row to `reachable` (use in-memory SQLite: open `:memory:`, run `schema.sql` + migrations or minimal `CREATE TABLE vpn_profiles` with required columns for the probe UPDATE).

Minimal in-memory table for test 3:

```sql
CREATE TABLE vpn_profiles (
  id INTEGER PRIMARY KEY,
  panel_hostname TEXT NOT NULL,
  xui_web_base_path TEXT,
  xui_panel_port INTEGER,
  panel_reachability TEXT NOT NULL DEFAULT 'unknown',
  panel_reachability_detail TEXT,
  panel_reachability_checked_at TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);
INSERT INTO vpn_profiles (id, panel_hostname) VALUES (1, '203.0.113.1');
```

- [ ] **Step 3: Run tests**

Run: `bun test apps/server/src/net/panelReachabilityProbe.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/net/panelReachabilityProbe.ts apps/server/src/net/panelReachabilityProbe.test.ts
git commit -m "feat(server): panel HTTPS reachability probe and scheduler."
```

---

### Task 4: Profiles routes — persistence, DTO, scheduling

**Files:**
- Modify: `apps/server/src/routes/profiles.ts`
- Modify: `apps/server/src/routes/profiles.test.ts`

- [ ] **Step 1: Extend `VpnProfileRow` and `getProfileById` / list SELECT**

Add columns: `panel_reachability`, `panel_reachability_detail`, `panel_reachability_checked_at`, and ensure `xui_web_base_path`, `xui_panel_port`, `xui_secrets_ciphertext`, `xui_secrets_nonce` are selected wherever `getProfileById` and the `GET /` list query read from `vpn_profiles`.

- [ ] **Step 2: Extend `toProfileDto`**

Return:

```typescript
panelReachability: row.panel_reachability as PanelReachability,
panelReachabilityDetail: row.panel_reachability_detail ?? null,
panelReachabilityCheckedAt: row.panel_reachability_checked_at ?? null,
```

Import `PanelReachability` type from `panelReachabilityProbe.ts` or define a shared string union in `types.ts` if you prefer no net→routes cycle (if circular, define the union in `panelReachabilityProbe.ts` only and use string assertion in DTO).

- [ ] **Step 3: Normalize `panelWebBasePath` helper**

Add a small function in `profiles.ts` (or `net/panelAddress.ts` if reusable):

```typescript
function normalizeWebBasePath(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const t = raw.trim();
  if (t === "") return null;
  return t.startsWith("/") ? t : `/${t}`;
}
```

- [ ] **Step 4: POST `/` implementation**

After parsing, compute:

- `resolved.panel` as today.
- `xuiSecrets` from `encryptXuiSecretsJson` when both `panelAdminUsername` and `panelAdminPassword` are non-empty after trim; otherwise `null` ciphertext/nonce for INSERT (bind `NULL` in SQLite).
- `webPath = normalizeWebBasePath(parsed.data.panelWebBasePath)`
- `panelPort = parsed.data.panelHttpsPort ?? null`

Extend `INSERT` to set: `panel_hostname`, `xui_secrets_ciphertext`, `xui_secrets_nonce`, `xui_web_base_path`, `xui_panel_port`, `panel_reachability` = `'checking'`, `panel_reachability_detail` = NULL, `panel_reachability_checked_at` = NULL.

After `run`, call `schedulePanelReachabilityProbe({ db, profileId: Number(result.lastInsertRowid) })`.

- [ ] **Step 5: PATCH `/:id` implementation**

Merge `panelHostname` as today. Add merge logic for `panelWebBasePath` and `panelHttpsPort` (only update columns when fields present in parsed body). For panel admin secrets: if both username and password provided and non-empty, encrypt and set `xui_secrets_*`; if omitted entirely, keep existing; if clearing is not required by spec, do not add clear semantics.

Detect **panel-related change** when any of: merged `panel_hostname` differs from pre-update value, `xui_web_base_path` or `xui_panel_port` change, or panel secrets blob changed.

If changed: before return, `UPDATE ... SET panel_reachability = 'checking', panel_reachability_detail = NULL, panel_reachability_checked_at = NULL` (or fold into main UPDATE), then `schedulePanelReachabilityProbe(...)`.

If not changed: leave reachability columns untouched.

- [ ] **Step 6: Tests in `profiles.test.ts`**

Add tests that:

1. `POST` with optional `panelAdminUsername` / `panelAdminPassword` stores non-null `xui_secrets_ciphertext` and response JSON has `panelReachability: "checking"`.
2. After `await new Promise((r) => setTimeout(r, 100))` (tune for CI), row has `reachable` or `unreachable` when using `fetch` mock — inject by exporting `profilesRoutes(..., { fetchForReachability: ... })` **or** mock global `fetch` in that test file only.

If injecting fetch is too invasive, assert only `checking` on response and that `schedulePanelReachabilityProbe` runs by querying DB after delay without mock (may be flaky on slow CI — prefer optional `reachabilityProbeRunner` in `ProfilesRoutesOptions` defaulting to `schedulePanelReachabilityProbe`, overridden in test to `async (opts) => runPanelReachabilityProbe(opts)`).

Extend `ProfilesRoutesOptions` in `profiles.ts`:

```typescript
export type ProfilesRoutesOptions = {
  sshExec?: SshExecFn;
  upgradeWebSocket?: UpgradeWebSocket;
  /** Test hook: await probe instead of fire-and-forget. */
  reachabilityProbeRunner?: (opts: { db: Database; profileId: number; fetchFn?: typeof fetch }) => void | Promise<void>;
};
```

Default: `void runPanelReachabilityProbe(...)`. In tests, pass `reachabilityProbeRunner: async (o) => { await runPanelReachabilityProbe({ ...o, fetchFn: mockFetch }); }`.

- [ ] **Step 7: Run profiles tests**

Run: `bun test apps/server/src/routes/profiles.test.ts`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/routes/profiles.ts apps/server/src/routes/profiles.test.ts
git commit -m "feat(api): persist optional panel fields and schedule async reachability probe."
```

---

### Task 5: Setup success paths trigger re-probe

**Files:**
- Modify: `apps/server/src/vpn/setupLivePhaseLoop.ts`
- Modify: `apps/server/src/vpn/profileSetupTerminalBridge.ts`
- Possibly modify: `apps/server/src/vpn/setupRunner.ts` or callers to pass `masterKey` — follow existing `executeProfileSetup` / `runLiveSetupPhases` options

- [ ] **Step 1: `setupLivePhaseLoop.ts`**

After the successful `UPDATE` that sets `operational_status = 'working'` and `xui_secrets_*`, add an `UPDATE` setting `panel_reachability = 'checking'`, clear detail and checked_at, then call `schedulePanelReachabilityProbe({ db, profileId })`. Import from `../net/panelReachabilityProbe`.

- [ ] **Step 2: `profileSetupTerminalBridge.ts`**

In `persistInstallSessionResult` success branch, same `UPDATE` + `schedulePanelReachabilityProbe`.

- [ ] **Step 3: Adjust tests**

Update `setupLivePhaseLoop.test.ts` / `profileSetupTerminalBridge.test.ts` if they assert exact SQL row shape or column counts.

Run: `bun test apps/server/src/vpn/setupLivePhaseLoop.test.ts apps/server/src/vpn/profileSetupTerminalBridge.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/vpn/setupLivePhaseLoop.ts apps/server/src/vpn/profileSetupTerminalBridge.ts
git commit -m "feat(vpn): re-queue panel reachability probe after successful setup."
```

---

### Task 6: Web app — Advanced UI, validation, polling, status

**Files:**
- Modify: `apps/web/src/pages/VpnsPage.tsx`

- [ ] **Step 1: Extend `VpnProfile` and `ProfileFormValues`**

Add to `VpnProfile`:

```typescript
panelReachability: "unknown" | "checking" | "reachable" | "unreachable";
panelReachabilityDetail: string | null;
panelReachabilityCheckedAt: string | null;
```

Add to `ProfileFormValues` / `emptyFormValues` / `getInitialValues`:

- `panelAdminUsername`, `panelAdminPassword`, `panelWebBasePath`, `panelHttpsPort` (use string for port input like `"443"` or `""` for default — match `sshPort` pattern with string + parse at submit).

- [ ] **Step 2: Extend `createProfile` / `updateProfile` request bodies**

Pass through optional fields only when relevant (omit empty optional strings).

- [ ] **Step 3: Client validation in `validateFormValues`**

- Panel admin pair: both empty or both non-empty after trim; otherwise return `{ error: "..." }`.
- `panelHttpsPort`: if non-empty string, parse integer 1–65535.
- `panelWebBasePath`: optional; trim only.

Keep existing panel hostname vs public IP rules.

- [ ] **Step 4: Advanced UI**

Use `<details style={...}><summary>Advanced</summary> ... </details>` or a styled button + conditional region. Inside: moved panel address field + helper, panel login, panel password, web base path, HTTPS port fields.

- [ ] **Step 5: `useQuery` polling**

On the profiles query, add:

```typescript
refetchInterval: (q) => {
  const rows = q.state.data;
  if (!rows) return false;
  return rows.some((p) => p.panelReachability === "checking") ? 2000 : false;
},
```

- [ ] **Step 6: Status column**

Next to Pending/Working, render panel line:

- `checking` → "Panel: …" with subtle pending styling
- `reachable` → "Panel: OK"
- `unreachable` → "Panel: unreachable" with `title={profile.panelReachabilityDetail ?? undefined}`
- `unknown` → "Panel: not checked"

- [ ] **Step 7: Typecheck web**

Run: `cd apps/web && bunx tsc -b --pretty false 2>&1 | head -50`
Expected: no errors in `VpnsPage.tsx`.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/pages/VpnsPage.tsx
git commit -m "feat(web): Advanced panel fields and async reachability status on VPNs page."
```

---

### Task 7: Chains page / shared types (if needed)

**Files:**
- Modify: `apps/web/src/pages/ChainsPage.tsx` only if it duplicates `VpnProfile` shape

- [ ] **Step 1: Search for `VpnProfile` / `panelHostname` types**

Run: `rg "VpnProfile|panelReachability" apps/web/src`

- [ ] **Step 2: Align types**

If `ChainsPage.tsx` defines its own profile shape, add the three new optional fields or import a shared type from a small `apps/web/src/types/vpnProfile.ts` if you introduce one (YAGNI: inline extend only if required by `tsc`).

- [ ] **Step 3: Commit** (skip commit if no file changed)

---

## Plan self-review

**1. Spec coverage**

| Spec section | Task |
|--------------|------|
| Advanced disclosure + fields | Task 6 |
| Persist encrypted panel admin | Tasks 2, 4 |
| Optional web base path + HTTPS port | Tasks 2, 4, 6 |
| Edit: empty panel password means no change | Task 4 PATCH + Task 6 omit empty |
| DTO fields on list/create/patch | Task 4 `toProfileDto` |
| Async probe + checking state | Tasks 3, 4 |
| POST/PATCH schedule rules | Task 4 |
| Setup success → checking + probe | Task 5 |
| Unit + route tests | Tasks 1–4 |
| Web polling + status | Task 6 |
| Security (no secrets in GET) | Task 4 (no new fields for passwords) |

**2. Placeholder scan:** None intentional.

**3. Type consistency:** DTO uses `panelReachability` camelCase matching existing `operationalStatus` style; DB snake_case in SQL.

---

## Execution handoff

**Plan complete and saved to `docs/superpowers/plans/2026-04-17-vpn-server-advanced-panel-reachability.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — Dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**

If **Subagent-Driven** is chosen: use **subagent-driven-development**; one subagent per task above plus two-stage review.

If **Inline** is chosen: use **executing-plans** and work through the checkbox steps in order.
