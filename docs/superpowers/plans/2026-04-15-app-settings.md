# App Settings (SQLite) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add SQLite-backed global settings (`acme_email`, `vpn_ssh_enabled`, `ssh_known_hosts_file`), authenticated `GET`/`PATCH /api/settings`, and a **Settings** page in the SPA; migrate setup/teardown/SSH terminal paths off `process.env` for those keys after the singleton row exists (bootstrap from env once).

**Architecture:** Single-row table `app_settings`; module `apps/server/src/db/appSettings.ts` owns bootstrap (`INSERT` from `process.env` when row missing), read, patch validation, and ISO `updated_at`. `createApp` receives only `Pick<Env, "masterKey" | "staticDir">` (narrow `Env` in `env.ts` accordingly). Runners and `profilesRoutes` call `getAppSettings(db)` per operation.

**Tech stack:** Bun, Hono, `bun:sqlite`, TanStack React Query, React Router, existing inline-style UI patterns.

**Spec:** `docs/superpowers/specs/2026-04-15-app-settings-design.md`

---

## File map (create / modify)

| Path | Responsibility |
|------|----------------|
| `apps/server/src/db/schema.sql` | `CREATE TABLE IF NOT EXISTS app_settings` (singleton `id = 1`, columns per spec). |
| `apps/server/src/env.ts` | Export `parseProcessAppSettingsSeed()`; narrow `Env` (remove three runtime keys from type + `loadEnv` return). |
| `apps/server/src/db/appSettings.ts` | Types, `ensureAppSettingsRow`, `getAppSettings`, `patchAppSettings`, validation. |
| `apps/server/src/db/appSettings.test.ts` | Unit tests: bootstrap insert, get, patch validation. |
| `apps/server/src/routes/settings.ts` | Hono `GET` / `PATCH` handlers. |
| `apps/server/src/routes/settings.test.ts` | HTTP tests: 401, 400, 200. |
| `apps/server/src/index.ts` | Mount `settingsRoutes`; narrow `createApp` env param. |
| `apps/server/src/routes/profiles.ts` | `ProfilesEnv` → `Pick<Env, "masterKey">`; replace `env.vpnSshEnabled` / `acme` / `sshKnownHosts` with `getAppSettings(db)`. |
| `apps/server/src/vpn/setupRunner.ts` | `SetupEnv` → `Pick<Env, "masterKey">`; read settings via `getAppSettings(db)`. |
| `apps/server/src/vpn/teardownRunner.ts` | Same pattern as setup. |
| `apps/server/src/routes/profiles.test.ts` | Seed `app_settings` where tests varied `vpnSshEnabled` / `acmeEmail`; fix `createApp(db, env)` calls. |
| `apps/server/src/routes/chains.test.ts` | Remove obsolete env keys from `Env` literal; add `seedAppSettings` if any test hits code that reads settings (chains may not — only if `createApp` type forces). |
| `apps/server/src/routes/routing.test.ts` | Same as chains. |
| `apps/server/src/routes/import.test.ts` | Same. |
| `apps/web/src/api/client.ts` | `fetchSettings`, `patchSettings`, types. |
| `apps/web/src/pages/SettingsPage.tsx` | Form + React Query. |
| `apps/web/src/App.tsx` | Route `/settings`, nav item in `ProtectedLayout`. |
| `apps/server/.env.example` | Document that `ACME_EMAIL` / `VPN_SSH_ENABLED` / `SSH_KNOWN_HOSTS_FILE` seed the DB **until** Settings row exists (optional one-line). |

Helper used in tests (define in `appSettings.ts` or bottom of `appSettings.test.ts` first, then re-export from `appSettings.ts` if needed):

```ts
/** Seeds row id=1 for tests (skips env bootstrap). */
export function putTestAppSettings(
  db: Database,
  row: { acmeEmail: string; vpnSshEnabled: boolean; sshKnownHostsFile: string | null },
) {
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO app_settings (id, acme_email, vpn_ssh_enabled, ssh_known_hosts_file, updated_at)
     VALUES (1, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       acme_email = excluded.acme_email,
       vpn_ssh_enabled = excluded.vpn_ssh_enabled,
       ssh_known_hosts_file = excluded.ssh_known_hosts_file,
       updated_at = excluded.updated_at`,
    [row.acmeEmail, row.vpnSshEnabled ? 1 : 0, row.sshKnownHostsFile, now],
  );
}
```

---

### Task 1: Schema — `app_settings` table

**Files:**
- Modify: `apps/server/src/db/schema.sql`

- [ ] **Step 1: Append table DDL**

Append (before EOF, after `rules` table is fine):

```sql
CREATE TABLE IF NOT EXISTS app_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  acme_email TEXT NOT NULL DEFAULT '',
  vpn_ssh_enabled INTEGER NOT NULL DEFAULT 0 CHECK (vpn_ssh_enabled IN (0, 1)),
  ssh_known_hosts_file TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

- [ ] **Step 2: Verify migration runs**

After Task 3 adds `appSettings.test.ts`, run: `bun test apps/server` (schema is exercised via `migrate()` in tests).

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/db/schema.sql
git commit -m "feat(db): add app_settings singleton table"
```

---

### Task 2: `parseProcessAppSettingsSeed` + narrow `Env`

**Files:**
- Modify: `apps/server/src/env.ts`
- Modify: every file importing `Env` that referenced `vpnSshEnabled` | `acmeEmail` | `sshKnownHostsFile` on the **type** (compiler will list them)

- [ ] **Step 1: Add parser and slim `Env`**

Replace the body of `loadEnv` to use a shared parser; **remove** the three fields from `Env` type and return value.

```ts
export type ProcessAppSettingsSeed = {
  vpnSshEnabled: boolean;
  acmeEmail: string | undefined;
  sshKnownHostsFile: string | undefined;
};

export function parseProcessAppSettingsSeed(): ProcessAppSettingsSeed {
  const vpnSshEnabled =
    process.env.VPN_SSH_ENABLED === "1" ||
    process.env.VPN_SSH_ENABLED === "true" ||
    process.env.VPN_SSH_ENABLED === "yes";
  const acmeEmail = process.env.ACME_EMAIL?.trim() || undefined;
  const sshKnownHostsFile = process.env.SSH_KNOWN_HOSTS_FILE?.trim() || undefined;
  return { vpnSshEnabled, acmeEmail, sshKnownHostsFile };
}

export type Env = {
  port: number;
  databasePath: string;
  masterKey: Uint8Array;
  staticDir?: string;
};

export function loadEnv(): Env {
  const master = process.env.VPN_MANAGER_MASTER_KEY;
  if (!master) throw new Error("VPN_MANAGER_MASTER_KEY is required");
  const port = Number(process.env.PORT ?? "3000");
  const databasePath = process.env.DATABASE_PATH ?? "data/vpn-manager.sqlite";
  const staticDir = process.env.STATIC_DIR;
  return {
    port,
    databasePath,
    masterKey: decodeMasterKey(master),
    staticDir,
  };
}
```

- [ ] **Step 2: Run TypeScript / tests to list breakages**

Run: `bun test apps/server 2>&1 | head -80`  
Expected: compile/test failures pointing at `createApp`, tests, runners — fixed in later tasks.

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/env.ts
git commit -m "refactor(env): extract ACME/SSH seed parser; drop runtime fields from Env"
```

---

### Task 3: `appSettings` module + unit tests

**Files:**
- Create: `apps/server/src/db/appSettings.ts`
- Create: `apps/server/src/db/appSettings.test.ts`

- [ ] **Step 1: Write failing test file**

`apps/server/src/db/appSettings.test.ts`:

```ts
import { describe, expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "./migrate";
import { getAppSettings, patchAppSettings, putTestAppSettings } from "./appSettings";

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
});

test("getAppSettings bootstraps from env when row missing", () => {
  process.env.ACME_EMAIL = "  seed@example.com  ";
  process.env.VPN_SSH_ENABLED = "true";
  process.env.SSH_KNOWN_HOSTS_FILE = "/tmp/kh";
  const s = getAppSettings(db);
  expect(s.acmeEmail).toBe("seed@example.com");
  expect(s.vpnSshEnabled).toBe(true);
  expect(s.sshKnownHostsFile).toBe("/tmp/kh");
  delete process.env.ACME_EMAIL;
  delete process.env.VPN_SSH_ENABLED;
  delete process.env.SSH_KNOWN_HOSTS_FILE;
});

test("patchAppSettings rejects live SSH without ACME email", () => {
  putTestAppSettings(db, { acmeEmail: "", vpnSshEnabled: false, sshKnownHostsFile: null });
  expect(() => patchAppSettings(db, { vpnSshEnabled: true })).toThrow();
});
```

Run: `bun test apps/server/src/db/appSettings.test.ts`  
Expected: FAIL (imports unresolved).

- [ ] **Step 2: Implement `appSettings.ts`**

`apps/server/src/db/appSettings.ts` (full v1):

```ts
import type { Database } from "bun:sqlite";
import { parseProcessAppSettingsSeed } from "../env";

export type AppSettingsDto = {
  acmeEmail: string;
  vpnSshEnabled: boolean;
  sshKnownHostsFile: string | null;
  updatedAt: string;
};

type AppSettingsRow = {
  acme_email: string;
  vpn_ssh_enabled: number;
  ssh_known_hosts_file: string | null;
  updated_at: string;
};

function rowToDto(row: AppSettingsRow): AppSettingsDto {
  return {
    acmeEmail: row.acme_email,
    vpnSshEnabled: row.vpn_ssh_enabled === 1,
    sshKnownHostsFile: row.ssh_known_hosts_file,
    updatedAt: row.updated_at,
  };
}

function bootstrapFromEnv(db: Database): void {
  const seed = parseProcessAppSettingsSeed();
  const acme = seed.acmeEmail ?? "";
  const kh = seed.sshKnownHostsFile ?? null;
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO app_settings (id, acme_email, vpn_ssh_enabled, ssh_known_hosts_file, updated_at)
     VALUES (1, ?, ?, ?, ?)`,
    [acme, seed.vpnSshEnabled ? 1 : 0, kh, now],
  );
}

/** Ensures row id=1 exists (bootstrap from process.env if missing), then returns it. */
export function getAppSettings(db: Database): AppSettingsDto {
  const row = db
    .query<AppSettingsRow, []>(`SELECT acme_email, vpn_ssh_enabled, ssh_known_hosts_file, updated_at FROM app_settings WHERE id = 1`)
    .get();
  if (!row) {
    bootstrapFromEnv(db);
    return getAppSettings(db);
  }
  return rowToDto(row);
}

export function putTestAppSettings(
  db: Database,
  row: { acmeEmail: string; vpnSshEnabled: boolean; sshKnownHostsFile: string | null },
): void {
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO app_settings (id, acme_email, vpn_ssh_enabled, ssh_known_hosts_file, updated_at)
     VALUES (1, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       acme_email = excluded.acme_email,
       vpn_ssh_enabled = excluded.vpn_ssh_enabled,
       ssh_known_hosts_file = excluded.ssh_known_hosts_file,
       updated_at = excluded.updated_at`,
    [row.acmeEmail, row.vpnSshEnabled ? 1 : 0, row.sshKnownHostsFile, now],
  );
}

export type AppSettingsPatch = {
  acmeEmail?: string;
  vpnSshEnabled?: boolean;
  sshKnownHostsFile?: string | null;
};

export function patchAppSettings(db: Database, patch: AppSettingsPatch): AppSettingsDto {
  const current = getAppSettings(db);
  const next = {
    acmeEmail: patch.acmeEmail !== undefined ? patch.acmeEmail.trim() : current.acmeEmail,
    vpnSshEnabled: patch.vpnSshEnabled !== undefined ? patch.vpnSshEnabled : current.vpnSshEnabled,
    sshKnownHostsFile:
      patch.sshKnownHostsFile !== undefined
        ? patch.sshKnownHostsFile === null || patch.sshKnownHostsFile.trim() === ""
          ? null
          : patch.sshKnownHostsFile.trim()
        : current.sshKnownHostsFile,
  };
  if (next.vpnSshEnabled && next.acmeEmail === "") {
    const err = new Error("acme_email_required_when_ssh_enabled");
    (err as Error & { status?: number }).status = 400;
    throw err;
  }
  const now = new Date().toISOString();
  db.run(
    `UPDATE app_settings SET acme_email = ?, vpn_ssh_enabled = ?, ssh_known_hosts_file = ?, updated_at = ? WHERE id = 1`,
    [next.acmeEmail, next.vpnSshEnabled ? 1 : 0, next.sshKnownHostsFile, now],
  );
  return getAppSettings(db);
}
```

Add a third test: `patchAppSettings` happy path updates `updated_at`.

- [ ] **Step 3: Run tests**

Run: `bun test apps/server/src/db/appSettings.test.ts`  
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/db/appSettings.ts apps/server/src/db/appSettings.test.ts
git commit -m "feat(db): app settings CRUD with bootstrap and validation"
```

---

### Task 4: HTTP `/api/settings` routes + tests

**Files:**
- Create: `apps/server/src/routes/settings.ts`
- Create: `apps/server/src/routes/settings.test.ts`
- Modify: `apps/server/src/index.ts`

- [ ] **Step 1: Write failing route test**

`apps/server/src/routes/settings.test.ts`:

```ts
import { describe, expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../db/migrate";
import { createApp } from "../index";
import type { Env } from "../env";
import { SESSION_COOKIE } from "../auth/cookie";
import { putTestAppSettings } from "../db/appSettings";

const baseEnv: Env = {
  port: 3000,
  databasePath: ":memory:",
  masterKey: new Uint8Array(32).fill(9),
};

describe("settingsRoutes", () => {
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
    putTestAppSettings(db, {
      acmeEmail: "a@b.co",
      vpnSshEnabled: false,
      sshKnownHostsFile: null,
    });
  });

  test("GET /api/settings 401 without cookie", async () => {
    const app = createApp(db, baseEnv);
    const res = await app.request("/api/settings");
    expect(res.status).toBe(401);
  });

  test("GET /api/settings 200 with session", async () => {
    const app = createApp(db, baseEnv);
    const res = await app.request("/api/settings", {
      headers: { Cookie: `${SESSION_COOKIE}=session-token` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { acmeEmail: string; vpnSshEnabled: boolean };
    expect(body.acmeEmail).toBe("a@b.co");
    expect(body.vpnSshEnabled).toBe(false);
  });

  test("PATCH rejects live SSH without email", async () => {
    putTestAppSettings(db, { acmeEmail: "", vpnSshEnabled: false, sshKnownHostsFile: null });
    const app = createApp(db, baseEnv);
    const res = await app.request("/api/settings", {
      method: "PATCH",
      headers: {
        Cookie: `${SESSION_COOKIE}=session-token`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ vpnSshEnabled: true }),
    });
    expect(res.status).toBe(400);
  });
});
```

Run: `bun test apps/server/src/routes/settings.test.ts`  
Expected: FAIL (route missing or wrong `createApp` signature).

- [ ] **Step 2: Implement routes**

`apps/server/src/routes/settings.ts`:

```ts
import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { getAppSettings, patchAppSettings } from "../db/appSettings";

export function settingsRoutes(db: Database) {
  const app = new Hono();

  app.get("/", (c) => {
    const dto = getAppSettings(db);
    return c.json(dto);
  });

  app.patch("/", async (c) => {
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const patch: {
      acmeEmail?: string;
      vpnSshEnabled?: boolean;
      sshKnownHostsFile?: string | null;
    } = {};
    if (typeof body.acmeEmail === "string") patch.acmeEmail = body.acmeEmail;
    if (typeof body.vpnSshEnabled === "boolean") patch.vpnSshEnabled = body.vpnSshEnabled;
    if (body.sshKnownHostsFile === null || typeof body.sshKnownHostsFile === "string") {
      patch.sshKnownHostsFile = body.sshKnownHostsFile as string | null;
    }
    try {
      const dto = patchAppSettings(db, patch);
      return c.json(dto);
    } catch (e) {
      if (e instanceof Error && e.message === "acme_email_required_when_ssh_enabled") {
        return c.json(
          { error: "ACME email is required when live SSH is enabled" },
          400,
        );
      }
      throw e;
    }
  });

  return app;
}
```

- [ ] **Step 3: Wire `index.ts`**

Change `createApp` signature to:

```ts
env: Pick<Env, "masterKey" | "staticDir">,
```

Add import and mount:

```ts
import { settingsRoutes } from "./routes/settings";
// ...
authed.route("/settings", settingsRoutes(db));
```

Update `importRoutes(db, env)` to pass only `{ masterKey: env.masterKey }` if you narrow the import route signature in the same commit.

- [ ] **Step 4: Run tests**

Run: `bun test apps/server/src/routes/settings.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/routes/settings.ts apps/server/src/routes/settings.test.ts apps/server/src/index.ts
git commit -m "feat(api): authenticated GET/PATCH /api/settings"
```

---

### Task 5: Wire runners + `profiles` to `getAppSettings`

**Files:**
- Modify: `apps/server/src/vpn/setupRunner.ts`
- Modify: `apps/server/src/vpn/teardownRunner.ts`
- Modify: `apps/server/src/routes/profiles.ts`

- [ ] **Step 1: `setupRunner`**

Change `SetupEnv` to `Pick<Env, "masterKey">`. Inside `executeProfileSetup`, after loading the profile row:

```ts
import { getAppSettings } from "../db/appSettings";

const settings = getAppSettings(db);
if (!settings.vpnSshEnabled) {
  // dry-run branch: use acmeEmail: settings.acmeEmail || "ops@example.com"
  // ...
}
if (!settings.acmeEmail) {
  throw Object.assign(new Error("acme_email_required"), { status: 400 as const });
}
// live: acmeEmail: settings.acmeEmail
// knownHostsFile: settings.sshKnownHostsFile ?? undefined
```

- [ ] **Step 2: `teardownRunner`**

Same: read `getAppSettings(db)` for `vpnSshEnabled` and `sshKnownHostsFile`.

- [ ] **Step 3: `profilesRoutes`**

- `ProfilesEnv` → `Pick<Env, "masterKey">`.
- Replace `env.vpnSshEnabled` with `getAppSettings(db).vpnSshEnabled` (cache in handler locals if called multiple times per request).
- `executeProfileSetup({ db, env: { masterKey: env.masterKey }, ... })` — adjust callee signature.
- WS handler `env: { sshKnownHostsFile: getAppSettings(db).sshKnownHostsFile ?? undefined }`.

- [ ] **Step 4: Run full server tests**

Run: `bun test apps/server`  
Expected: PASS after test file updates in Task 6.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/vpn/setupRunner.ts apps/server/src/vpn/teardownRunner.ts apps/server/src/routes/profiles.ts
git commit -m "feat(server): read ACME/SSH flags from app_settings in setup/teardown/profiles"
```

---

### Task 6: Fix all server tests and `createApp` callers

**Files:**
- Modify: `apps/server/src/routes/profiles.test.ts` (primary)
- Modify: `apps/server/src/routes/chains.test.ts`, `routing.test.ts`, `import.test.ts`
- Modify: any other `createApp(db, { ... })` or `Env` literals under `apps/server`

- [ ] **Step 1: Normalize test `Env` literals**

Remove `vpnSshEnabled`, `acmeEmail`, `sshKnownHostsFile` from every `const env: Env = { ... }`.

- [ ] **Step 2: Seed settings in profiles tests**

Where tests previously passed `vpnSshEnabled: true` and `acmeEmail: "ops@example.com"`, add in that `beforeEach` (after `migrate(db)`):

```ts
import { putTestAppSettings } from "../db/appSettings";

putTestAppSettings(db, {
  acmeEmail: "ops@example.com",
  vpnSshEnabled: true,
  sshKnownHostsFile: null,
});
```

For tests that expected `vpnSshEnabled: false`, either omit `putTestAppSettings` (bootstrap may run — isolate by `putTestAppSettings` with `vpnSshEnabled: false` explicitly after migrate for determinism).

- [ ] **Step 3: Run**

Run: `bun test apps/server`  
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/routes/profiles.test.ts apps/server/src/routes/chains.test.ts apps/server/src/routes/routing.test.ts apps/server/src/routes/import.test.ts
git commit -m "test(server): seed app_settings for profile and route tests"
```

---

### Task 7: Web — Settings page + API client

**Files:**
- Modify: `apps/web/src/api/client.ts`
- Create: `apps/web/src/pages/SettingsPage.tsx`
- Modify: `apps/web/src/App.tsx`

- [ ] **Step 1: API client**

Add to `apps/web/src/api/client.ts`:

```ts
export type AppSettingsDto = {
  acmeEmail: string;
  vpnSshEnabled: boolean;
  sshKnownHostsFile: string | null;
  updatedAt: string;
};

export const settingsQueryKey = ["settings"] as const;

export function fetchSettings() {
  return apiFetch<AppSettingsDto>("/api/settings");
}

export function patchSettings(patch: Partial<Pick<AppSettingsDto, "acmeEmail" | "vpnSshEnabled" | "sshKnownHostsFile">>) {
  return apiFetch<AppSettingsDto>("/api/settings", { method: "PATCH", body: patch });
}
```

- [ ] **Step 2: `SettingsPage`**

Match existing patterns: `useQuery` for `fetchSettings`, `useMutation` for `patchSettings`, `queryClient.invalidateQueries({ queryKey: settingsQueryKey })` on success. Inline styles similar to `ExportPage` / card sections. Fields:

- Email input bound to `acmeEmail`
- Checkbox for `vpnSshEnabled` (label: “Enable live SSH (setup opens real SSH connections)”)
- Text input for `sshKnownHostsFile` (empty string → send `null` on save)

Show short copy: “Values are stored in the server database and apply to future setup and teardown.”

- [ ] **Step 3: Router + nav**

In `App.tsx`:

- Add `{ path: "/settings", label: "Settings" }` to `navItems`.
- Add `<Route path="/settings" element={<SettingsPage />} />` inside `ProtectedLayout`.

- [ ] **Step 4: Verify**

Run: `bunx tsc -b` in `apps/web`  
Run: `bun test apps/server`  
Manual: log in, open `/settings`, change email, refresh.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/api/client.ts apps/web/src/pages/SettingsPage.tsx apps/web/src/App.tsx
git commit -m "feat(web): Settings page for global ACME and SSH options"
```

---

### Task 8: Docs touch-up

**Files:**
- Modify: `apps/server/.env.example`

- [ ] **Step 1: Comment block**

Add 2–3 lines explaining `ACME_EMAIL`, `VPN_SSH_ENABLED`, `SSH_KNOWN_HOSTS_FILE` seed the **initial** `app_settings` row when the DB has none; after that, use the Settings UI.

- [ ] **Step 2: Commit**

```bash
git add apps/server/.env.example
git commit -m "docs(env): document app_settings bootstrap from env"
```

---

## Plan self-review (spec coverage)

| Spec section | Task |
|-------------|------|
| Goals 1–2 (SQLite + bootstrap) | Tasks 1–3 |
| Goal 3 (Settings UI auth shell) | Task 7 |
| Goal 4 (GET/PATCH authed) | Tasks 4–6 |
| Non-goals (no master key in DB) | Not planned — do not add columns |
| Data model columns | Task 1 + `appSettings.ts` |
| Validation (ACME when SSH on) | Tasks 3–4 |
| Runners read DB | Task 5 |
| Security (settings authed) | Task 4 |
| `/profiles` unchanged auth model | Task 5 (no auth change) |
| Testing | Tasks 3, 4, 6 |

**Placeholder scan:** None intentional; all file paths concrete.

**Type consistency:** DTO shape `AppSettingsDto` shared naming between `appSettings.ts` route JSON and web `client.ts` — keep field names identical (`acmeEmail`, `vpnSshEnabled`, `sshKnownHostsFile`, `updatedAt`).

---

**Plan complete and saved to** `docs/superpowers/plans/2026-04-15-app-settings.md`.

**Two execution options:**

1. **Subagent-driven (recommended)** — Fresh subagent per task, review between tasks, fast iteration. **Required sub-skill:** subagent-driven-development.

2. **Inline execution** — Run tasks in this session using executing-plans with checkpoints.

**Which approach do you want?**
