# Import screen — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an **Import** page (files + drag-and-drop, clipboard, large textarea) with client-side merge, plus **`POST /api/import/preview`** and **`POST /api/import/apply`** that parse v3 bundles, export v2, and bare VPN objects, return a preview plan (including **`passwordKeys`** and **`panelHostnameKeys`** where needed), and apply changes in **one SQLite transaction** per request.

**Architecture:** Add a focused **`apps/server/src/import/`** module: **`parseImportDocument`** (Zod + detection order from spec), **`buildImportPlan`** (read-only DB for existing-profile match by `host` + `ssh_port` + `ssh_user`, build `plan` + `warnings` + `errors` + credential keys), **`applyImport`** (pre-validate all routing rules, then `BEGIN` → create VPN rows as needed → create each chain with hops + default routing profiles → `UPDATE`/`DELETE`/`INSERT` rules per hop to match export). Wire **`importRoutes`** under **`/api/import`** in **`createApp`**. Web: **`mergeImportSources`** helper + **`ImportPage`** mirroring **`ExportPage`** styles; **`App.tsx`** nav + route.

**Tech Stack:** Bun, `bun:sqlite`, Hono, Zod (existing `types.ts` patterns), Bun test, React + TanStack Query, `apiFetch` / `fetch` with credentials.

**Spec:** `docs/superpowers/specs/2026-04-14-import-screen-design.md`

**Spec gap (plan decision):** Export v2 hop rows do **not** include `panelHostname`, but **`vpnProfileCreate`** requires a valid FQDN **`panelHostname`**. Preview/apply therefore expose **`panelHostnameKeys`** parallel to **`passwordKeys`** (same string keys) for any **new** profile created from a v2 hop or from a VPN entry missing `panelHostname`. Apply body shape:

```json
{
  "import": {},
  "passwords": { "newProfile:0:0": "ssh-secret" },
  "panelHostnames": { "newProfile:0:0": "panel.example.com" }
}
```

Omit `panelHostnames` key when empty; require every listed **`panelHostnameKey`** in the preview response to be present on apply.

---

## File structure (create / modify)

| Path | Responsibility |
|------|----------------|
| `apps/server/src/import/parseImportDocument.ts` | Strip BOM, `JSON.parse`, Zod for v3 / v2 / bare VPN; export **`parseImportDocument`** returning normalized `{ schemaVersion: 3, chains: ExportV2[], vpns: ImportVpnInput[] }` or `{ errors: string[] }`. |
| `apps/server/src/import/parseImportDocument.test.ts` | Unit tests: v3 only chains, only vpns, mixed; v2 root; bare root; BOM; empty v3; duplicate `chainId`+`exportedAt`; unknown `schemaVersion`; ambiguous `chain` array. |
| `apps/server/src/import/buildImportPlan.ts` | **`buildImportPlan(db, normalized)`** → `{ canApply, plan, warnings, errors, passwordKeys, panelHostnameKeys }` per spec §5.1 + gap above. |
| `apps/server/src/import/applyImport.ts` | **`applyImport({ db, env, normalized, passwords, panelHostnames })`** → summary counts; single transaction; uses **`encryptVpnPassword`**, **`assertValidCidr`**, **`assertValidDomainRule`**, terminal-hop default rules. |
| `apps/server/src/import/applyImport.test.ts` | Transaction rollback: FK violation or invalid rule after `BEGIN` (see Task 6). |
| `apps/server/src/routes/import.ts` | Hono: **`POST /preview`**, **`POST /apply`**; read body size **≤ 10 MiB**; `requireAuth` applied by parent mount. |
| `apps/server/src/routes/import.test.ts` | HTTP tests with `createApp`, session cookie (mirror **`chains.test.ts`**). |
| `apps/server/src/index.ts` | `authed.route("/import", importRoutes(db, env))`. |
| `apps/server/src/types.ts` | Optional: export **`importVpnEntrySchema`** if shared; else keep import-only Zod in `import/` to avoid churn. |
| `apps/web/src/import/mergeImportSources.ts` | Pure functions: merge textarea → clipboard → files per spec §2.1; enforce 50 files / 10 MB. |
| `apps/web/src/import/mergeImportSources.test.ts` | Unit tests for merge order and duplicate fingerprint error. |
| `apps/web/src/pages/ImportPage.tsx` | UI: dropzone, file list, textarea, clipboard button, preview/apply, credential table. |
| `apps/web/src/App.tsx` | Nav item **`/import`**, route element **`ImportPage`**. |

---

### Task 1: `parseImportDocument` (TDD)

**Files:**
- Create: `apps/server/src/import/parseImportDocument.ts`
- Create: `apps/server/src/import/parseImportDocument.test.ts`

**Constants:** `MAX_IMPORT_BYTES = 10 * 1024 * 1024`

- [ ] **Step 1: Write failing test** — empty v3 bundle should error

```ts
import { describe, expect, test } from "bun:test";
import { parseImportDocument } from "./parseImportDocument";

test("v3 with empty chains and vpns yields errors", () => {
  const text = JSON.stringify({ schemaVersion: 3, chains: [], vpns: [] });
  const r = parseImportDocument(text);
  expect(r.ok).toBe(false);
});
```

- [ ] **Step 2: Run test — expect FAIL**

Run: `bun test apps/server/src/import/parseImportDocument.test.ts`
Expected: FAIL (module or `parseImportDocument` missing / wrong return shape).

- [ ] **Step 3: Minimal implementation** — implement **`parseImportDocument(text: string): { ok: true, normalized: NormalizedImport } | { ok: false, errors: string[] }`** where **`NormalizedImport`** is `{ schemaVersion: 3; chains: unknown[]; vpns: unknown[] }` after internal normalization (v2 root → one chain; bare → one vpn). Reject when UTF-8 byte length > **`MAX_IMPORT_BYTES`** (use `TextEncoder` on `text`). Strip BOM if `text.startsWith("\uFEFF")`. Use Zod **`strict()`** on objects so unknown keys on VPN entries fail.

Define **`exportV2ObjectSchema`** mirroring **`ExportV2`** from `buildExport.ts` (inline zod, do not import runtime from `buildExport` to avoid cycles): `schemaVersion` literal `2`, `exportedAt` string, `chainId` number, `name` optional string, `chain` array of `{ chainHopId, profileId, host, sshPort, sshUser }`, `routingByHop` array with `hopIndex`, `chainHopId`, `routingProfileId`, `defaultAction` enum, `rules` with `matchKind`, `matchValue`, `action`.

**Bare VPN:** after v3/v2 fail, if record has `routingByHop` → error; if `chain` is non-empty array and `schemaVersion !== 2` → error; if `schemaVersion` is number not 2 or 3 → error; else if `host`, `sshUser`, `sshPort` valid → normalize to `{ schemaVersion: 3, chains: [], vpns: [{ ...defaults, label: host or provided }] }` with **`label`** defaulting to **`host`** when missing.

- [ ] **Step 4: Expand tests** — add cases listed in `parseImportDocument.test.ts` from spec §6.2 (copy minimal valid v2 JSON from **`buildExport.test.ts`** fixture pattern).

- [ ] **Step 5: Run full file tests** — `bun test apps/server/src/import/parseImportDocument.test.ts` → PASS

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/import/parseImportDocument.ts apps/server/src/import/parseImportDocument.test.ts
git commit -m "feat(import): add parseImportDocument with Zod and tests"
```

---

### Task 2: `mergeImportSources` (web, TDD)

**Files:**
- Create: `apps/web/src/import/mergeImportSources.ts`
- Create: `apps/web/src/import/mergeImportSources.test.ts`

- [ ] **Step 1: Failing test** — two v2 roots merge to v3 with `chains.length === 2`

```ts
import { describe, expect, test } from "bun:test";
import { mergeParsedRootsToImportJson } from "./mergeImportSources";

// Use one-hop valid v2 objects (non-empty chain + routingByHop); see buildExport.test / export schema in Task 1.
const v2a = {
  schemaVersion: 2,
  exportedAt: "2026-01-01T00:00:00.000Z",
  chainId: 1,
  name: "A",
  chain: [{ chainHopId: 1, profileId: 10, host: "h1.example.com", sshPort: 22, sshUser: "root" }],
  routingByHop: [
    {
      hopIndex: 0,
      chainHopId: 1,
      routingProfileId: 100,
      defaultAction: "direct",
      rules: [],
    },
  ],
};
const v2b = { ...v2a, exportedAt: "2026-01-02T00:00:00.000Z", chainId: 2, name: "B", chain: [{ ...v2a.chain[0]!, chainHopId: 2, profileId: 11, host: "h2.example.com" }], routingByHop: [{ ...v2a.routingByHop[0]!, chainHopId: 2, routingProfileId: 101 }] };

test("merges two v2 into synthetic v3", () => {
  const out = mergeParsedRootsToImportJson([v2a, v2b]);
  expect(out.ok).toBe(true);
  if (out.ok) {
    expect(out.json.schemaVersion).toBe(3);
    expect(out.json.chains).toHaveLength(2);
  }
});
```

Tests must use **`exportV2ObjectSchema`**-valid payloads (at least one hop; **`routingByHop`** aligned with **`hopIndex`** / **`chain`** length).

- [ ] **Step 2: Run test** — expect FAIL

Run: `bun test apps/web/src/import/mergeImportSources.test.ts`

- [ ] **Step 3: Implement** **`mergeParsedRootsToImportJson(roots: unknown[]): { ok: true; json: object } | { ok: false; errors: string[] }`**  
  - Order: roots array = **textarea**, then **clipboard**, then **files** (caller passes ordered array).  
  - v3 root: concatenate `chains` and `vpns`.  
  - v2 root: push onto `chains`.  
  - Bare: push onto `vpns` (caller should have parsed JSON; bare detection can call shared `classifyRoot` exported from same file or duplicate minimal check).  
  - **Duplicate fingerprint:** two v2 with same `chainId` and `exportedAt` both present → `{ ok: false, errors: [...] }`.  
  - **Max 50 roots** from files+clipboard+textarea (textarea+clipboard = 2 max + files).  
  - **Size:** total `JSON.stringify` length of merged object ≤ 10 MiB (approximate; spec says decoded UTF-8 — sum UTF-8 lengths of source strings used to build roots).

- [ ] **Step 4: Run tests** — PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/import/mergeImportSources.ts apps/web/src/import/mergeImportSources.test.ts
git commit -m "feat(web): add mergeImportSources for multi-file v3 bundle"
```

---

### Task 3: `buildImportPlan`

**Files:**
- Create: `apps/server/src/import/buildImportPlan.ts`
- Create: `apps/server/src/import/buildImportPlan.test.ts` (use `:memory:` DB + **`migrate`** from **`../db/migrate`**)

- [ ] **Step 1: Failing test** — seed one existing **`vpn_profiles`** row `(host, ssh_port, ssh_user)`; plan for v2 chain whose first hop matches → **`plan.chains[0].hops[0].mode === "link"`** and **`passwordKeys`** empty for that hop.

- [ ] **Step 2: Implement** **`buildImportPlan(db, normalized)`**  
  - For each v2 in `normalized.chains`, compute stable keys **`newProfile:${chainIndex}:${hopIndex}`** for hops needing new profiles.  
  - For each vpn in `normalized.vpns`, key **`vpn:${vpnIndex}`** when password or panelHostname missing.  
  - **`findExistingProfileId(db, host, sshPort, sshUser)`** — `SELECT id FROM vpn_profiles WHERE host = ? AND ssh_port = ? AND ssh_user = ?` (trim host only if UI also trims; match **`profiles`** route storage).  
  - **`panelHostnameKeys`** includes keys where **`panelHostname`** missing from JSON for that create.  
  - Validate **`routingByHop`** length equals **`chain.length`** and each **`hopIndex`** 0..n-1 once; **`defaultAction`** on terminal hop not **`use_chain`** (mirror **`routing.ts`** rules); domain/CIDR rules validate with **`normalizeDomainSuffix`** + **`assertValidDomainRule`**, **`assertValidCidr`**. Collect failures into **`errors`**.  
  - **`warnings`:** name collision with existing **`chains.name`** (query `SELECT name FROM chains`).  
  - **`canApply`:** `errors.length === 0` and plan non-null.

- [ ] **Step 3: Run** `bun test apps/server/src/import/buildImportPlan.test.ts` — PASS

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/import/buildImportPlan.ts apps/server/src/import/buildImportPlan.test.ts
git commit -m "feat(import): add buildImportPlan for preview metadata"
```

---

### Task 4: `applyImport`

**Files:**
- Create: `apps/server/src/import/applyImport.ts`
- Modify: `apps/server/src/import/applyImport.test.ts` (or same file as Task 3 if preferred — keep **focused** file for apply)

- [ ] **Step 1: Failing test** — happy path: empty DB, one single-hop v2 export (minimal valid), supply **`passwords`** and **`panelHostnames`**, call **`applyImport`**, expect **`chains`** row count 1, **`vpn_profiles`** 1, **`rules`** count matches export.

- [ ] **Step 2: Implement** **`applyImport`**  
  - Reuse logic parallel to **`chains.ts`** **`insertRoutingProfilesForHops`** (copy small private helper into **`applyImport.ts`** or extract shared **`insertRoutingProfilesForHops`** to **`import/chainInsert.ts`** — **prefer extract to `apps/server/src/import/insertChainWithHops.ts`** to avoid drift).  
  - **Chain name:** `export.name ?? \`imported-chain-${export.chainId}\``; if **`UNIQUE`** collision on `chains.name`, append **` (imported 2)`** etc. (query loop).  
  - **Order inside transaction:** resolve/create all profiles for all chains first (collect new ids), then for each export chain insert chain + hops in order with resolved profile ids, insert default routing profiles, then for each hop apply **`defaultAction`** and rules from **`routingByHop[hopIndex]`** targeting **new** `routing_profile_id` (query by `chain_hop_id`).  
  - **Vpn-only import:** only **`INSERT` into `vpn_profiles`** for each standalone vpn entry (no chain).

- [ ] **Step 3: Rollback test** — In **`applyImport.test.ts`**, pass a second hop with invalid CIDR in rules so **`assertValidCidr`** throws during **pre-validation** before `BEGIN` — expect **no** new rows. Separately, use DB with **`PRAGMA foreign_keys=ON`** and temporarily corrupt insert order is fragile; **prefer** asserting **pre-validation** catches bad rules. Document that **all validation runs before `BEGIN`**.

- [ ] **Step 4: Run** `bun test apps/server/src/import/` — PASS

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/import/applyImport.ts apps/server/src/import/applyImport.test.ts apps/server/src/import/insertChainWithHops.ts
git commit -m "feat(import): add applyImport transactional writer"
```

---

### Task 5: HTTP routes `import.ts`

**Files:**
- Create: `apps/server/src/routes/import.ts`
- Modify: `apps/server/src/index.ts`

- [ ] **Step 1: Wire routes**

```ts
import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import type { Env } from "../env";
import { parseImportDocument } from "../import/parseImportDocument";
import { buildImportPlan } from "../import/buildImportPlan";
import { applyImport } from "../import/applyImport";

export function importRoutes(db: Database, env: Pick<Env, "masterKey">) {
  const app = new Hono();

  app.post("/preview", async (c) => {
    const raw = await c.req.text();
    const parsed = parseImportDocument(raw);
    if (!parsed.ok) {
      return c.json({ error: "Invalid import JSON", details: parsed.errors }, 400);
    }
    const planResult = buildImportPlan(db, parsed.normalized);
    // Spec §5.1: 200 + canApply / errors for semantic validation; 400 only for syntax/size/BOM parse from parseImportDocument
    return c.json({
      canApply: planResult.canApply,
      plan: planResult.plan,
      warnings: planResult.warnings,
      errors: planResult.errors,
      passwordKeys: planResult.passwordKeys,
      panelHostnameKeys: planResult.panelHostnameKeys,
    });
  });

  app.post("/apply", async (c) => {
    const body = await c.req.json().catch(() => null);
    // validate shape { import: unknown, passwords?: record, panelHostnames?: record }
    // stringify import back through parseImportDocument + buildImportPlan; verify canApply; verify keys
    // applyImport(...)
    return c.json(summaryFromApplyImport);
  });

  return app;
}
```

**Note:** For **`preview`**, spec allows **200** with semantic errors — align with spec: return **200** + **`errors`** array always; use **`400`** only for **JSON syntax** / **oversize** / **`parseImportDocument`** hard fail. Adjust **`import.test.ts`** accordingly.

- [ ] **Step 2: Mount** in **`index.ts`**: `authed.route("/import", importRoutes(db, env));`

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/routes/import.ts apps/server/src/index.ts
git commit -m "feat(api): add POST /api/import/preview and /apply"
```

---

### Task 6: Route integration tests

**Files:**
- Create: `apps/server/src/routes/import.test.ts`

- [ ] **Step 1: Copy session pattern** from **`apps/server/src/routes/chains.test.ts`** (admin user, **`SESSION_COOKIE`**, **`createApp`**).

- [ ] **Step 2: Test** `POST /api/import/preview` with minimal valid v2 → **200**, **`canApply`** boolean consistent with **`errors`**.

- [ ] **Step 3: Test** `POST /api/import/apply` with full secrets → **200**, then **`GET /api/chains`** lists new chain.

- [ ] **Step 4: Test** missing **`panelHostnames`** key when required → **400**, DB unchanged.

Run: `bun test apps/server/src/routes/import.test.ts`

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/routes/import.test.ts
git commit -m "test(api): cover import preview and apply routes"
```

---

### Task 7: `ImportPage` + navigation

**Files:**
- Create: `apps/web/src/pages/ImportPage.tsx`
- Modify: `apps/web/src/App.tsx`

- [ ] **Step 1: Implement** **`ImportPage`**  
  - State: `textarea`, `clipboardText`, `fileBlobs` with `{ name, text }[]`, `preview`, `passwords` record, `panelHostnames` record, loading flags.  
  - **Merge:** on Preview, `JSON.parse` each source → **`mergeParsedRootsToImportJson([...])`** → `fetch("/api/import/preview", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(merged) })`.  
  - Render **`passwordKeys`** / **`panelHostnameKeys`** as inputs bound to state maps.  
  - **Apply:** `POST /api/import/apply` with `{ import: merged, passwords, panelHostnames }`.  
  - Reuse **`getErrorMessage`** / styles from **`ExportPage.tsx`** (copy constants acceptable per existing duplication patterns).

- [ ] **Step 2: Add** nav `{ path: "/import", label: "Import" }` next to Export in **`App.tsx`**, lazy or static import **`ImportPage`**, `<Route path="/import" element={<ImportPage />} />`.

- [ ] **Step 3: Manual smoke** — `bun run dev`, login, Import page preview/apply with sample JSON.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/pages/ImportPage.tsx apps/web/src/App.tsx
git commit -m "feat(web): add Import page and nav route"
```

---

### Task 8: Optional web unit test

**Files:**
- Create: `apps/web/src/pages/importPageMerge.test.ts` (or extend **`mergeImportSources.test.ts`** only — **prefer no React test** if heavy; **skip** if time-boxed)

- [ ] **Step 1:** If adding, test **`mergeImportSources`** only (already Task 2). **Skip** dedicated **`ImportPage`** render test unless quick.

---

## Plan self-review

| Spec section | Task coverage |
|--------------|---------------|
| §2 payloads + detection | Task 1 |
| §2.1 client merge | Task 2 |
| §3 UI | Task 7 |
| §4 apply + linking + passwords | Tasks 3–4, **`panelHostnames`** gap documented in header |
| §5 API | Tasks 5–6 |
| §6 tests | Tasks 1–4, 6; optional Task 8 |

**Placeholder scan:** None intentional; numeric limits spelled as **`10 * 1024 * 1024`** and **50 files**.

**Type consistency:** Stable keys **`newProfile:c:i`** and **`vpn:j`** used in plan builder, preview response, UI maps, and apply validation.

---

**Plan complete and saved to `docs/superpowers/plans/2026-04-14-import-screen.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — A fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach do you want?**
