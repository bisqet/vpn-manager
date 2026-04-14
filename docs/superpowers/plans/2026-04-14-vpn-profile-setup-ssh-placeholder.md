# VPN profile Setup + SSH placeholder — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist **`operationalStatus`** (`pending` | `working`) on VPN profiles, add **`POST /api/profiles/:id/setup`** (fake delay + placeholder health always OK), re-verify after **`PATCH`**, and extend the **VPNs** page with **Setup**, **Status**, **SSH** (bottom sheet fake terminal).

**Architecture:** SQLite column + idempotent migration for existing DBs; shared **`verifyProfileHealthPlaceholder()`** (returns **`working`**) used by setup and patch; **Zod** profile schemas unchanged (no client-writable status — extra JSON keys are stripped). Web: TanStack Query **mutation** for setup + **local state** for SSH sheet and terminal scrollback.

**Tech Stack:** Bun, `bun:sqlite`, Hono, Zod, Bun test runner, React 18+, TanStack Query, inline styles (existing `VpnsPage` pattern).

**Spec:** `docs/superpowers/specs/2026-04-14-vpn-profile-setup-ssh-placeholder-design.md`

---

## File structure (create / modify)

| Path | Responsibility |
|------|----------------|
| `apps/server/src/db/schema.sql` | Add `operational_status TEXT NOT NULL DEFAULT 'pending'` to `vpn_profiles` with optional `CHECK (operational_status IN ('pending','working'))`. |
| `apps/server/src/db/migrateVpnProfileOperationalStatus.ts` | **New.** If `vpn_profiles` lacks `operational_status`, `ALTER TABLE` add column + `UPDATE vpn_profiles SET operational_status = 'pending' WHERE operational_status IS NULL` (belt-and-suspenders). |
| `apps/server/src/db/migrate.ts` | Call `migrateVpnProfileOperationalStatusIfNeeded(db)` after existing migrations. |
| `apps/server/src/db/migrateVpnProfileOperationalStatus.test.ts` | **New.** Legacy table without column → after migration, column exists and rows are `pending`. |
| `apps/server/src/db/migrate.test.ts` | Assert `PRAGMA table_info(vpn_profiles)` includes `operational_status` after `migrate()`. |
| `apps/server/src/routes/profiles.ts` | Extend row type + `toProfileDto`; import placeholder helpers; **`POST /:id/setup`**; after successful PATCH, set status from placeholder; all SELECTs include `operational_status`. |
| `apps/server/src/vpn/profileOperationalPlaceholder.ts` | **New.** `verifyProfileHealthPlaceholder()`, `simulateSetupWork()` — tiny delays, always returns **`working`**. |
| `apps/server/src/routes/profiles.test.ts` | Expect `operationalStatus: "pending"` on create/list/patch; new tests for `POST .../setup` and DB persistence; extend `ProfileRow` + raw SQL selects. |
| `apps/web/src/pages/VpnsPage.tsx` | Status column, Setup button + mutation, SSH sheet + fake terminal, body scroll lock, setup error state. |
| `apps/web/src/pages/ChainsPage.tsx` | Add **`operationalStatus`** to local `VpnProfile` type so `tsc` stays satisfied when listing profiles. |

---

### Task 1: DB migration module (TDD)

**Files:**
- Create: `apps/server/src/db/migrateVpnProfileOperationalStatus.ts`
- Create: `apps/server/src/db/migrateVpnProfileOperationalStatus.test.ts`

- [ ] **Step 1: Write failing test** in `migrateVpnProfileOperationalStatus.test.ts`

```ts
import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrateVpnProfileOperationalStatusIfNeeded } from "./migrateVpnProfileOperationalStatus";

describe("migrateVpnProfileOperationalStatusIfNeeded", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec(`
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
    `);
    db.query(
      `INSERT INTO vpn_profiles (label, host, ssh_port, ssh_user, ssh_password_ciphertext, ssh_password_nonce)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("A", "h", 22, "u", new Uint8Array([1]), new Uint8Array([2]));
  });

  test("adds operational_status defaulting existing rows to pending", () => {
    migrateVpnProfileOperationalStatusIfNeeded(db);

    const cols = db.query<{ name: string }, []>("PRAGMA table_info(vpn_profiles)").all();
    expect(cols.map((c) => c.name)).toContain("operational_status");

    const status = db
      .query<{ operational_status: string }, []>("SELECT operational_status FROM vpn_profiles WHERE id = 1")
      .get();
    expect(status?.operational_status).toBe("pending");
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

Run: `bun test apps/server/src/db/migrateVpnProfileOperationalStatus.test.ts`  
Expected: **FAIL** (import or function missing).

- [ ] **Step 3: Implement** `migrateVpnProfileOperationalStatus.ts`

```ts
import type { Database } from "bun:sqlite";

type TableInfoRow = { name: string };

function vpnProfilesColumns(db: Database): Set<string> {
  const rows = db.query<TableInfoRow, []>("PRAGMA table_info(vpn_profiles)").all();
  return new Set(rows.map((r) => r.name));
}

export function migrateVpnProfileOperationalStatusIfNeeded(db: Database): void {
  if (vpnProfilesColumns(db).has("operational_status")) {
    return;
  }

  db.exec(
    `ALTER TABLE vpn_profiles ADD COLUMN operational_status TEXT NOT NULL DEFAULT 'pending'
     CHECK (operational_status IN ('pending','working'));`,
  );
  db.exec(`UPDATE vpn_profiles SET operational_status = 'pending' WHERE operational_status IS NULL`);
}
```

- [ ] **Step 4: Run test — expect PASS**

Run: `bun test apps/server/src/db/migrateVpnProfileOperationalStatus.test.ts`  
Expected: **PASS**

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/db/migrateVpnProfileOperationalStatus.ts apps/server/src/db/migrateVpnProfileOperationalStatus.test.ts
git commit -m "feat(db): migrate vpn_profiles operational_status"
```

---

### Task 2: Wire migration + greenfield schema

**Files:**
- Modify: `apps/server/src/db/migrate.ts`
- Modify: `apps/server/src/db/schema.sql`
- Modify: `apps/server/src/db/migrate.test.ts`

- [ ] **Step 1: Update** `schema.sql` — inside `CREATE TABLE vpn_profiles`, add:

```sql
operational_status TEXT NOT NULL DEFAULT 'pending' CHECK (operational_status IN ('pending','working')),
```

(Place before `created_at` or after `ssh_password_nonce` — match column order used elsewhere.)

- [ ] **Step 2: Update** `migrate.ts`

```ts
import { migrateVpnProfileOperationalStatusIfNeeded } from "./migrateVpnProfileOperationalStatus";
```

At end of `migrate()` after other migrations:

```ts
  migrateVpnProfileOperationalStatusIfNeeded(db);
```

- [ ] **Step 3: Extend** `migrate.test.ts` with:

```ts
  test("vpn_profiles has operational_status", () => {
    migrate(db);
    const cols = db.query<{ name: string }, []>("PRAGMA table_info(vpn_profiles)").all();
    expect(cols.map((c) => c.name)).toContain("operational_status");
  });
```

- [ ] **Step 4: Run tests**

Run: `bun test apps/server/src/db/migrate.test.ts apps/server/src/db/migrateVpnProfileOperationalStatus.test.ts`  
Expected: **PASS**

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/db/schema.sql apps/server/src/db/migrate.ts apps/server/src/db/migrate.test.ts
git commit -m "feat(db): schema and migrate hook for operational_status"
```

---

### Task 3: Placeholder helpers (server)

**Files:**
- Create: `apps/server/src/vpn/profileOperationalPlaceholder.ts`

- [ ] **Step 1: Add file**

```ts
/** Placeholder until real SSH / health checks exist. Always succeeds. */
export async function verifyProfileHealthPlaceholder(): Promise<"working"> {
  await new Promise((r) => setTimeout(r, 10));
  return "working";
}

/** Simulates remote setup work (SSH, package install, etc.). */
export async function simulateSetupWork(): Promise<void> {
  await new Promise((r) => setTimeout(r, 50));
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/server/src/vpn/profileOperationalPlaceholder.ts
git commit -m "feat(server): placeholder VPN profile health and setup delay"
```

---

### Task 4: Profiles API + routes (TDD)

**Files:**
- Modify: `apps/server/src/routes/profiles.ts`
- Modify: `apps/server/src/routes/profiles.test.ts`

- [ ] **Step 1: Write failing test** — append to `profiles.test.ts` a new `test("POST /api/profiles/:id/setup marks profile working", ...)`:

```ts
  test("POST /api/profiles/:id/setup marks profile working", async () => {
    const app = createApp(db, env);

    const createRes = await app.request("/api/profiles", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${SESSION_COOKIE}=session-token`,
      },
      body: JSON.stringify({
        label: "Edge",
        host: "10.0.0.1",
        sshPort: 22,
        sshUser: "root",
        sshPassword: "pw",
      }),
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json();
    expect(created.operationalStatus).toBe("pending");

    const setupRes = await app.request("/api/profiles/1/setup", {
      method: "POST",
      headers: { Cookie: `${SESSION_COOKIE}=session-token` },
    });
    expect(setupRes.status).toBe(200);
    const afterSetup = await setupRes.json();
    expect(afterSetup.operationalStatus).toBe("working");

    const row = db.query<{ operational_status: string }, []>(
      "SELECT operational_status FROM vpn_profiles WHERE id = 1",
    ).get();
    expect(row?.operational_status).toBe("working");
  });
```

- [ ] **Step 2: Run test — expect FAIL** (404 or route missing)

Run: `bun test apps/server/src/routes/profiles.test.ts`  
Expected: **FAIL** on the new test.

- [ ] **Step 3: Implement profiles route changes**

Conceptual edits to `profiles.ts` (apply as a coherent patch):

1. Import `verifyProfileHealthPlaceholder` and `simulateSetupWork` from `../vpn/profileOperationalPlaceholder`.
2. Extend `VpnProfileRow` with `operational_status: string` (or narrow to `"pending" | "working"` if you map).
3. **`toProfileDto`:** add `operationalStatus: row.operational_status` (map DB snake to camelCase).
4. **All SQL** that selects from `vpn_profiles` for DTOs: add `operational_status` to the column list.
5. **`INSERT`:** omit `operational_status` so DB default **`pending`** applies (or insert `'pending'` explicitly).
6. **After successful `PATCH` `UPDATE`:**  
   `const nextStatus = await verifyProfileHealthPlaceholder();`  
   `db.query("UPDATE vpn_profiles SET operational_status = ?, updated_at = datetime('now') WHERE id = ?").run(nextStatus, id);`  
   Then `getProfileById` and return DTO.
7. **New route** (register **before** or after other `/:id` routes — path is distinct `/:id/setup`):

```ts
  app.post("/:id/setup", async (c) => {
    const id = parseId(c.req.param("id"));
    if (id === null) {
      return c.json({ error: "Invalid profile id" }, 400);
    }

    const existing = getProfileById(db, id);
    if (!existing) {
      return c.json({ error: "Profile not found" }, 404);
    }

    await simulateSetupWork();
    const status = await verifyProfileHealthPlaceholder();

    db.query(
      "UPDATE vpn_profiles SET operational_status = ?, updated_at = datetime('now') WHERE id = ?",
    ).run(status, id);

    const updated = getProfileById(db, id);
    return c.json(toProfileDto(updated!));
  });
```

8. **Do not** add `operationalStatus` to `vpnProfileCreate` / `vpnProfileUpdate` in `types.ts` (Zod will strip unknown keys from PATCH body).

- [ ] **Step 4: Update existing expectations** in `profiles.test.ts` — every `expect(...).toEqual({` for profile JSON must include **`operationalStatus: "pending"`** or **`"working"`** as appropriate after patch/setup. Extend `ProfileRow` type and raw `SELECT` strings to include **`operational_status`** when querying SQLite.

- [ ] **Step 5: Add test** `PATCH` while profile is `pending` results in **`working`** JSON and DB row (placeholder always OK):

```ts
  test("PATCH runs placeholder verify and sets operationalStatus working", async () => {
    const app = createApp(db, env);
    await app.request("/api/profiles", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${SESSION_COOKIE}=session-token`,
      },
      body: JSON.stringify({
        label: "X",
        host: "1.2.3.4",
        sshPort: 22,
        sshUser: "u",
        sshPassword: "p",
      }),
    });

    const patchRes = await app.request("/api/profiles/1", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${SESSION_COOKIE}=session-token`,
      },
      body: JSON.stringify({ label: "Y" }),
    });
    expect(patchRes.status).toBe(200);
    const body = await patchRes.json();
    expect(body.operationalStatus).toBe("working");
  });
```

- [ ] **Step 6: Run full server tests**

Run: `bun test apps/server`  
Expected: **PASS**

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/routes/profiles.ts apps/server/src/routes/profiles.test.ts
git commit -m "feat(api): profile operationalStatus, POST setup placeholder, verify on PATCH"
```

---

### Task 5: Fix other server tests that INSERT into `vpn_profiles`

**Files:**
- Modify: any file under `apps/server` that `INSERT INTO vpn_profiles` without the new column (grep for `INSERT INTO vpn_profiles`).

- [ ] **Step 1: Search**

Run: `rg "INSERT INTO vpn_profiles" apps/server`

- [ ] **Step 2: For each match**, either rely on **DEFAULT** by listing only non-default columns (preferred) or add **`operational_status`** explicitly. After edits, run:

Run: `bun test apps/server`  
Expected: **PASS**

- [ ] **Step 3: Commit** (if any files changed)

```bash
git add -A
git commit -m "test(server): align vpn_profiles seeds with operational_status"
```

---

### Task 6: Web — VPNs page + ChainsPage type

**Files:**
- Modify: `apps/web/src/pages/VpnsPage.tsx`
- Modify: `apps/web/src/pages/ChainsPage.tsx`

- [ ] **Step 1: Extend** `VpnProfile` in both files with:

```ts
  operationalStatus: "pending" | "working";
```

- [ ] **Step 2: Add API helper** in `VpnsPage.tsx`

```ts
function setupProfile(id: number) {
  return apiFetch<VpnProfile>(`/api/profiles/${id}/setup`, { method: "POST" });
}
```

- [ ] **Step 3: Add** `useMutation` for setup — `onSuccess` → `queryClient.invalidateQueries({ queryKey: profilesQueryKey })`; **`onMutate`** or **`onError`** not required beyond clearing errors.

- [ ] **Step 4: Local state**

```ts
const [setupActionError, setSetupActionError] = useState<string | null>(null);
const [sshProfile, setSshProfile] = useState<VpnProfile | null>(null);
```

- [ ] **Step 5: Table UI** — new **Status** column; per row:

  - **Setup:** `profile.operationalStatus === "pending"` only; `disabled={setupMutation.isPending && setupMutation.variables === profile.id}`; label **`Setting up...`** when pending for that id; `onClick` clears `setupActionError`, calls `setupMutation.mutateAsync(profile.id)` with try/catch setting **`setSetupActionError`** from `getErrorMessage`.

  - **SSH:** always; `onClick={() => setSshProfile(profile)}`.

- [ ] **Step 6: Surface** `setupActionError` next to existing `mutationError` (combine with `??` or two blocks).

- [ ] **Step 7: Bottom sheet** — when `sshProfile` non-null, render fixed backdrop + bottom panel (`height: "50vh"`, `maxHeight`, `borderTopLeftRadius`, dark terminal area). **`role="dialog"`**, **`aria-modal="true"`**, **`aria-labelledby`** pointing to a title id = `SSH: ${sshProfile.label}`.

- [ ] **Step 8: Body scroll lock**

```ts
useEffect(() => {
  if (!sshProfile) return;
  const prev = document.body.style.overflow;
  document.body.style.overflow = "hidden";
  return () => {
    document.body.style.overflow = prev;
  };
}, [sshProfile]);
```

- [ ] **Step 9: Escape to close**

```ts
useEffect(() => {
  if (!sshProfile) return;
  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") setSshProfile(null);
  }
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}, [sshProfile]);
```

- [ ] **Step 10: Fake terminal state** (inside `VpnsPage` or tiny inner function component in same file)

```ts
const [lines, setLines] = useState<string[]>([
  "# Not a real SSH session — demo only. Type commands for your own notes.",
  "# Manual server prep — paste commands here (not executed).",
]);
const [currentLine, setCurrentLine] = useState("");
```

Prompt: `` `${sshProfile.sshUser}@${sshProfile.host}:~$ ` ``

On **`keydown`** on a focused `textarea` or `div` `tabIndex={0}`:

- **Enter:** `setLines((l) => [...l, `${prompt}${currentLine}`]);` `setCurrentLine("")`;
- **Backspace:** shrink `currentLine`
- Printable keys: append `e.key` when `e.key.length === 1` and not `e.ctrlKey` / `e.metaKey` (keep YAGNI — basic typing only)

Render: `lines.map` + last line showing prompt + `currentLine` + block cursor (optional).

- [ ] **Step 11: Delete path** — in `handleDelete` **after** successful delete, if `sshProfile?.id === profile.id` then `setSshProfile(null)`.

- [ ] **Step 12: Typecheck web**

Run: `cd apps/web && bunx tsc -b`  
Expected: **exit 0**

- [ ] **Step 13: Commit**

```bash
git add apps/web/src/pages/VpnsPage.tsx apps/web/src/pages/ChainsPage.tsx
git commit -m "feat(web): VPN setup button, status, SSH demo terminal sheet"
```

---

## Plan self-review

| Spec requirement | Task(s) |
|------------------|---------|
| DB column + default `pending`, migrate old DBs | Task 1–2 |
| JSON `operationalStatus`, not client-writable | Task 4 (Zod unchanged) |
| `POST .../setup` fake + placeholder → `working` | Task 3–4 |
| `PATCH` re-runs placeholder | Task 4 |
| Table Status + Setup visibility + loading | Task 6 |
| SSH always + bottom sheet + honesty line + fake typing | Task 6 |
| Body scroll lock, dialog a11y, Escape | Task 6 |
| Setup errors on page strip; clear on retry | Task 6 |
| Close SSH sheet when profile deleted | Task 6 |
| Server tests + `tsc` web | Tasks 1–6 |

**Placeholder scan:** No TBD/TODO lines in this plan.  
**Type consistency:** `operationalStatus` uses the same literal union in web types as DB values `'pending'|'working'`.

---

**Plan complete and saved to `docs/superpowers/plans/2026-04-14-vpn-profile-setup-ssh-placeholder.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — Dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach do you want?**
