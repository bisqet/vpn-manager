# VPNs page — panel URL column and panel-login copy — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After Setup marks a profile `working`, signed-in users see a **Panel** HTTPS link in the VPNs table, and can **copy 3x-ui admin username/password** via authenticated API; anonymous list responses never include `panelUrl`.

**Architecture:** Add **`buildPanelHttpsUrl`** in `apps/server/src/net/panelAddress.ts` (shared with **`setupPhases` verify** curl). Extend **`GET /api/profiles`** to select `xui_web_base_path`, compute **`panelUrl`** only when a session exists and the profile is `working`. Add **`GET /api/profiles/:id/panel-login`** (session required) that decrypts **`xui_secrets_*`**. Update **`VpnsPage.tsx`** with three columns and clipboard flow.

**Tech stack:** Bun, Hono, `bun:sqlite`, React + TanStack Query (existing), TypeScript.

**Deployment note (2026-04-16):** **Panel** links are generic HTTPS URLs to 3x-ui; they **do not** assume **reverse proxy (historical)** as the TLS front-end (see root `AGENTS.md`).

---

## File map

| File | Role |
|------|------|
| `apps/server/src/net/panelAddress.ts` | Add **`buildPanelHttpsUrl`** (uses **`httpsUrlHost`**). |
| `apps/server/src/net/panelAddress.test.ts` | Unit tests for URL builder (FQDN + IPv4 + IPv6 path). |
| `apps/server/src/vpn/setupPhases.ts` | **Verify** phase: build curl URL via **`buildPanelHttpsUrl`** (remove duplicate `webPathForUrl` / host concat). |
| `apps/server/src/vpn/setupPhases.test.ts` | Update expectations if verify script string changes (should match same URL). |
| `apps/server/src/routes/profiles.ts` | List query + **`toProfileDto`** + new **`GET /:id/panel-login`** (register **above** **`/:id/ssh`**). |
| `apps/server/src/routes/profiles.test.ts` | Tests: list `panelUrl` null anon / set authed; **`panel-login`** 401/404/409/200. |
| `apps/web/src/pages/VpnsPage.tsx` | Types, columns, fetch+copy, loading state. |

---

### Task 1: Shared HTTPS panel URL builder

**Files:**

- Modify: `apps/server/src/net/panelAddress.ts`
- Modify: `apps/server/src/net/panelAddress.test.ts`
- Modify: `apps/server/src/vpn/setupPhases.ts`
- Modify: `apps/server/src/vpn/setupPhases.test.ts`

- [ ] **Step 1: Write the failing test**

In `apps/server/src/net/panelAddress.test.ts`, add **`buildPanelHttpsUrl`** to the existing import from **`./panelAddress`**, then append:

```ts
describe("buildPanelHttpsUrl", () => {
  test("returns null when webBasePath missing", () => {
    expect(buildPanelHttpsUrl("panel.example.com", null)).toBeNull();
    expect(buildPanelHttpsUrl("panel.example.com", "")).toBeNull();
  });
  test("returns null when panel hostname empty", () => {
    expect(buildPanelHttpsUrl("", "abc")).toBeNull();
  });
  test("FQDN with path without leading slash", () => {
    expect(buildPanelHttpsUrl("panel.example.com", "myPath")).toBe("https://panel.example.com/myPath/");
  });
  test("FQDN with path with leading slash", () => {
    expect(buildPanelHttpsUrl("panel.example.com", "/myPath")).toBe("https://panel.example.com/myPath/");
  });
  test("public IPv4 panel", () => {
    expect(buildPanelHttpsUrl("203.0.113.5", "xyz")).toBe("https://203.0.113.5/xyz/");
  });
  test("public IPv6 panel brackets host", () => {
    expect(buildPanelHttpsUrl("2001:4860:4860::8888", "p")).toBe("https://[2001:4860:4860::8888]/p/");
  });
});
```

Adjust the import line at the top to include `buildPanelHttpsUrl`.

Run: `bun test apps/server/src/net/panelAddress.test.ts`  
Expected: **FAIL** (export missing).

- [ ] **Step 2: Implement `buildPanelHttpsUrl`**

In `apps/server/src/net/panelAddress.ts`, add:

```ts
/**
 * HTTPS URL for the 3x-ui panel behind reverse proxy (historical), matching verify curl in setupPhases.
 * Returns null if hostname or path is missing/blank.
 */
export function buildPanelHttpsUrl(panelHostname: string, webBasePath: string | null): string | null {
  const hostKey = panelHostname.trim();
  if (!hostKey) return null;
  if (webBasePath === null) return null;
  const base = webBasePath.trim();
  if (base === "") return null;
  const webPathForUrl = base.startsWith("/") ? base : `/${base}`;
  const httpsHost = httpsUrlHost(hostKey);
  return `https://${httpsHost}${webPathForUrl}/`;
}
```

Run: `bun test apps/server/src/net/panelAddress.test.ts`  
Expected: **PASS**

- [ ] **Step 3: Refactor `setupPhases` verify script to use the helper**

In `apps/server/src/vpn/setupPhases.ts`:

1. Add: `import { buildPanelHttpsUrl } from "../net/panelAddress";`
2. Inside `buildSetupPhases`, after `webPathForUrl` / `httpsHost` are used elsewhere, for **verify** only: replace the inline `https://${httpsHost}${webPathForUrl}/` string with a variable:

```ts
const panelHttpsUrl = buildPanelHttpsUrl(panelHostname, webBasePath);
if (!panelHttpsUrl) {
  throw new Error("buildSetupPhases: panelHttpsUrl unexpectedly empty");
}
```

In the **verify** phase script template, use `"${panelHttpsUrl}"` inside the `curl` argument (keep `-g` if still needed for IPv6 URL).

Remove now-unused `httpsHost` / `webPathForUrl` **only if** nothing else in the function uses them. If **configureCaddy** still uses `caddySiteKey` / `httpsHost` — grep the file: `httpsHost` is used in verify only today; `caddySiteKey` uses `panelHostname` directly. After change, delete unused `const httpsHost = ...` and `webPathForUrl` **if** truly unused.

Run: `bun test apps/server/src/vpn/setupPhases.test.ts`  
Expected: **PASS** (update test expected substring if the test asserted the raw URL string and it still matches).

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/net/panelAddress.ts apps/server/src/net/panelAddress.test.ts apps/server/src/vpn/setupPhases.ts apps/server/src/vpn/setupPhases.test.ts
git commit -m "feat(server): shared buildPanelHttpsUrl for panel HTTPS links"
```

---

### Task 2: List profiles — `panelUrl` when authenticated

**Files:**

- Modify: `apps/server/src/routes/profiles.ts`
- Modify: `apps/server/src/routes/profiles.test.ts`

- [ ] **Step 1: Write failing tests**

In `apps/server/src/routes/profiles.test.ts`:

1. Import `buildPanelHttpsUrl` is **not** required if you assert literal expected URL.
2. Add a test **"GET /api/profiles returns panelUrl null without session when profile working"**: create profile (with cookie), run live setup fake path so profile is `working` (reuse pattern from `"POST /api/profiles/:id/setup live path succeeds with fake ssh"`), then **`GET /api/profiles` without Cookie**, expect first element **`panelUrl`** **`null`** (or key absent if you omit null fields — spec prefers **`null`**; use **`null`** in JSON).
3. Add **"GET /api/profiles returns panelUrl when session and working"**: same DB setup, `GET /api/profiles` with **`Cookie: SESSION_COOKIE=session-token`**, expect **`panelUrl`** equals **`https://...`** built from that profile’s `panel_hostname` and `xui_web_base_path` (compute expected with **`buildPanelHttpsUrl`** imported from `../net/panelAddress` in the test file, or hardcode string matching the inserted row after setup).

Run: `bun test apps/server/src/routes/profiles.test.ts -t "panelUrl"`  
Expected: **FAIL** until implementation exists.

- [ ] **Step 2: Implement list changes**

In `apps/server/src/routes/profiles.ts`:

1. Import `getCookie` if not already (already have `getCookie` from hono/cookie).
2. Extend **`VpnProfileRow`** with **`xui_web_base_path: string | null`** (nullable).
3. **`GET /`** SQL: add **`xui_web_base_path`** to the **`SELECT`** list.
4. Import **`buildPanelHttpsUrl`** from **`../net/panelAddress`**.
5. At start of **`GET /`** handler:

```ts
const token = getCookie(c, SESSION_COOKIE);
const userId = getSessionUserId(db, token);
```

6. Change **`toProfileDto`** to accept **`userId: number | null`** and compute:

```ts
const panelUrl =
  userId !== null &&
  row.operational_status === "working"
    ? buildPanelHttpsUrl(row.panel_hostname, row.xui_web_base_path)
    : null;
```

Return **`{ ...existingFields, panelUrl }`**. Ensure **`getProfileById`** / other callers of **`toProfileDto`** pass **`userId`**: for **create/patch/setup responses**, use the same **`getSessionUserId`** from the request when available; for **unauthenticated** create (there is none — create uses cookie in tests), check call sites:

- **POST /** after create: has no session in some flows — use **`getSessionUserId(db, getCookie(c, SESSION_COOKIE))`**.
- **PATCH** return: same.
- **POST setup** return: same.

If **`userId`** is null on create response, **`panelUrl`** should be **`null`** even for working (edge case: impossible on first create). **PATCH** may clear working — placeholder health check — still fine.

7. **`GET /`**: `return c.json(rows.map((row) => toProfileDto(row, userId)));`

**Important:** **`getProfileById`** still selects without **`xui_web_base_path`** — **`toProfileDto(updated!)`** for patch/create must include **`xui_web_base_path`** on the row or **`panelUrl`** will be wrong. Extend **`getProfileById`** **`SELECT`** to include **`xui_web_base_path`** (and keep secrets columns as today).

Run: `bun test apps/server/src/routes/profiles.test.ts`  
Expected: **PASS**

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/routes/profiles.ts apps/server/src/routes/profiles.test.ts
git commit -m "feat(server): panelUrl on profile list for authenticated users"
```

---

### Task 3: `GET /api/profiles/:id/panel-login`

**Files:**

- Modify: `apps/server/src/routes/profiles.ts`
- Modify: `apps/server/src/routes/profiles.test.ts`

- [ ] **Step 1: Write failing tests**

Add tests in **`profiles.test.ts`**:

```ts
test("GET /api/profiles/:id/panel-login returns 401 without session", async () => {
  const app = createApp(db, env);
  const res = await app.request("/api/profiles/1/panel-login");
  expect(res.status).toBe(401);
});
```

For **200**: reuse **`liveEnv`**, **`fakeSsh`**, session cookie, create profile, **`POST .../setup`**, then **`GET /api/profiles/1/panel-login`** with cookie; parse JSON; expect **`adminUsername`**, **`adminPassword`**, **`panelUrl`** strings non-empty; **`panelUrl`** matches **`buildPanelHttpsUrl(panel_hostname, xui_web_base_path)`** from DB or from response consistency.

For **404**: **`GET /api/profiles/99/panel-login`** with cookie → **404**.

For **409**: insert a **`pending`** profile with cookie → **409** (or **400** — spec says **409**; stick to **409**).

Run filtered tests → **FAIL** until route exists.

- [ ] **Step 2: Implement route**

In **`profiles.ts`**, register **`app.get("/:id/panel-login", async (c) => { ... })` immediately before** the **`app.get("/:id/ssh", ...`** block so Hono matches the static suffix first.

Handler logic:

```ts
app.get("/:id/panel-login", async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) return c.json({ error: "Invalid VPN profile id" }, 400);

  const token = getCookie(c, SESSION_COOKIE);
  const userId = getSessionUserId(db, token);
  if (userId === null) return c.json({ error: "Unauthorized" }, 401);

  const row =
    db
      .query<{
        operational_status: string;
        panel_hostname: string;
        xui_web_base_path: string | null;
        xui_secrets_ciphertext: Uint8Array | null;
        xui_secrets_nonce: Uint8Array | null;
      }, [number]>(
        `SELECT operational_status, panel_hostname, xui_web_base_path,
                xui_secrets_ciphertext, xui_secrets_nonce
         FROM vpn_profiles WHERE id = ?`,
      )
      .get(id) ?? null;

  if (!row) return c.json({ error: "Profile not found" }, 404);

  if (row.operational_status !== "working") {
    return c.json({ error: "Panel login is only available after successful setup" }, 409);
  }
  if (!row.xui_secrets_ciphertext || !row.xui_secrets_nonce || !row.xui_web_base_path) {
    return c.json({ error: "Panel credentials are not available for this profile" }, 409);
  }

  let secrets;
  try {
    secrets = await decryptXuiSecretsJson(env.masterKey, row.xui_secrets_ciphertext, row.xui_secrets_nonce);
  } catch {
    return c.json({ error: "Panel credentials are not available for this profile" }, 409);
  }
  if (secrets.v !== 1) {
    return c.json({ error: "Panel credentials are not available for this profile" }, 409);
  }

  const panelUrl = buildPanelHttpsUrl(row.panel_hostname, row.xui_web_base_path);
  if (!panelUrl) {
    return c.json({ error: "Panel credentials are not available for this profile" }, 409);
  }

  return c.json({
    panelUrl,
    adminUsername: secrets.adminUsername,
    adminPassword: secrets.adminPassword,
  });
});
```

Add top import: **`import { decryptXuiSecretsJson } from "../crypto/xuiSecrets";`**

Run: `bun test apps/server/src/routes/profiles.test.ts`  
Expected: **PASS**

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/routes/profiles.ts apps/server/src/routes/profiles.test.ts
git commit -m "feat(server): GET panel-login for 3x-ui admin credentials"
```

---

### Task 4: Web — VPNs table columns and copy

**Files:**

- Modify: `apps/web/src/pages/VpnsPage.tsx`

- [ ] **Step 1: Extend types and fetch helper**

1. On **`VpnProfile`**, add **`panelUrl: string | null`** (API always sends key with **`null`** or string).

2. Add function near other **`apiFetch`** helpers:

```ts
type PanelLoginResponse = {
  panelUrl: string;
  adminUsername: string;
  adminPassword: string;
};

function fetchPanelLogin(profileId: number) {
  return apiFetch<PanelLoginResponse>(`/api/profiles/${profileId}/panel-login`);
}
```

- [ ] **Step 2: Row state for fetch + copy handlers**

Use **`useState`** map or **`useRef`** + **`useState`** for:

- **`panelLoginLoadingId: number | null`** (or **`Set`** if paranoid about concurrency — YAGNI: one **`number | null`**).
- **`panelLoginCache: Map<number, PanelLoginResponse>`** or store **`Record<number, PanelLoginResponse>`** — simplest: **`useRef(new Map<number, PanelLoginResponse>())`** updated after successful fetch so both copy buttons reuse data without double fetch.

Handler **`async function copyPanelField(profileId: number, field: "adminUsername" | "adminPassword")`**:

1. If cache has profileId, use it; else **`await fetchPanelLogin(profileId)`**, store in map, then **`navigator.clipboard.writeText(data[field])`**.
2. **`catch`**: set a page-level error string (reuse **`setupActionError`** or add **`panelCopyError`**) with a safe message.
3. Finally clear **`panelLoginLoadingId`**.

Use **`try/finally`** for loading id.

- [ ] **Step 3: Table markup**

In **`<thead>`**, after **User**, add:

- **`Panel`** — table head cell
- **`User`** (short label; **`title`**: Panel admin username) — icon column
- **`Pass`** — icon column (**`title`**: Panel admin password)

In row body:

- **Panel cell:** if **`profile.panelUrl`**, render **`<a>`** as in spec; else if **`!authUser && profile.operationalStatus === "working"`**, small muted hint; else **`—`**.
- **Copy cells:** **`authUser && profile.operationalStatus === "working"`** → **`<button type="button"`** with **`aria-label`**, **`disabled={panelLoginLoadingId === profile.id}`**, **`onClick`** → **`void copyPanelField(profile.id, ...)`**. Use a minimal **clipboard** icon (inline **SVG** 16×16 or Unicode **“📋”** — prefer **SVG** for consistency). Two buttons.

Keep styles aligned with existing **`tableHeadCellStyle`** / **`secondaryButtonStyle`** (may add **`iconButtonStyle`** inline object next to other **`CSSProperties`**).

- [ ] **Step 4: Typecheck**

Run: `cd apps/web && bunx tsc -b`  
Expected: **no errors**

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/VpnsPage.tsx
git commit -m "feat(web): VPNs table panel link and panel admin copy buttons"
```

---

## Spec coverage (self-review)

| Spec requirement | Task |
|------------------|------|
| `panelUrl` matches verify URL semantics | Task 1 + 2 |
| `panelUrl` only when signed in | Task 2 tests + `userId` check |
| `panelUrl` null when not `working` | Task 2 |
| `GET .../panel-login` 401 / 404 / 409 / 200 | Task 3 |
| Response body shape camelCase | Task 3 |
| No secrets on list | Task 2 (only `panelUrl`) |
| Web columns + guest behavior + copy | Task 4 |
| Testing / `tsc` | All tasks |

**Placeholder scan:** None intentional. **Naming:** **`adminUsername`** / **`adminPassword`** in JSON match **`XuiSecretsPayloadV1`** field names for clarity.

---

**Plan complete and saved to `docs/superpowers/plans/2026-04-14-vpns-page-panel-column.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — Dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
