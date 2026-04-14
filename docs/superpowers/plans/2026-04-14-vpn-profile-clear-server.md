# VPN profile clear-server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `POST /api/profiles/:id/clear-server` and an Edit-modal **Clear server from VPN services** button that runs phased SSH teardown (spec `2026-04-14-vpn-profile-clear-server-design.md`), resetting the profile DB row when all phases succeed.

**Architecture:** New `buildTeardownPhases()` returns ordered remote bash scripts (mirror `setupPhases` / `setupRunner`). New `executeProfileTeardown()` runs SSH per phase with the same timeout and error persistence pattern as `executeProfileSetup`. `profiles.ts` registers the route and maps outcomes to HTTP like setup. Web reuses the setup output sheet pattern with a `teardown` payload.

**Tech stack:** Bun, Hono, `bun:sqlite`, React + TanStack Query on `VpnsPage`.

**Spec:** `docs/superpowers/specs/2026-04-14-vpn-profile-clear-server-design.md`

---

## File map

| File | Role |
|------|------|
| `apps/server/src/vpn/setupPhases.ts` | Export shared constant for the exact Caddyfile import line Setup appends (single source of truth). |
| `apps/server/src/vpn/teardownPhases.ts` | **New.** `buildTeardownPhases(): TeardownPhase[]` with stable `id`, `title`, `script`. |
| `apps/server/src/vpn/teardownPhases.test.ts` | **New.** Asserts phase count, ids, and that scripts reference key paths. |
| `apps/server/src/vpn/teardownRunner.ts` | **New.** `executeProfileTeardown` (dry-run / live / DB updates). |
| `apps/server/src/routes/profiles.ts` | Register `POST /:id/clear-server`, import runner, handle errors. |
| `apps/server/src/routes/profiles.test.ts` | HTTP tests: dry-run, eligibility 400, success clears DB, failure leaves DB, 503 sshpass. |
| `apps/web/src/pages/VpnsPage.tsx` | API helper, mutation, edit-only danger button + confirm, sheet title for teardown. |

---

### Task 1: Shared Caddyfile import line constant

**Files:**
- Modify: `apps/server/src/vpn/setupPhases.ts`
- Test: `apps/server/src/vpn/setupPhases.test.ts` (extend with one assertion, or rely on teardown tests — prefer **one** grep-style test here that the constant matches the string in `configure_caddy` script)

- [ ] **Step 1: Add exported constant next to `configureCaddy`**

Add after the `caddyConfPath` line (keep the configure script using the constant for the `if ! grep` append line):

```ts
/** Exact line appended to /etc/caddy/Caddyfile by setup; teardown removes one matching line. */
export const CADDYFILE_CONF_D_IMPORT_LINE = "import /etc/caddy/conf.d/*.caddy";
```

In `configureCaddy.script`, replace the `grep` pattern and `echo` argument so both use the same constant (keep `grep -qF` so the line is matched literally):

```ts
if ! grep -qF '${CADDYFILE_CONF_D_IMPORT_LINE}' /etc/caddy/Caddyfile 2>/dev/null; then
  printf '%s\\n' '${CADDYFILE_CONF_D_IMPORT_LINE}' >> /etc/caddy/Caddyfile
fi
```

(`printf` avoids embedding the line twice with different quoting.)

- [ ] **Step 2: Extend `setupPhases.test.ts`**

Add a test that `buildSetupPhases`’s `configure_caddy` phase `script` contains `CADDYFILE_CONF_D_IMPORT_LINE` exactly once as a substring.

Run:

```bash
cd "E:/work/VPN manager"
bun test apps/server/src/vpn/setupPhases.test.ts
```

Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/vpn/setupPhases.ts apps/server/src/vpn/setupPhases.test.ts
git commit -m "refactor: export Caddyfile import line for setup and teardown parity."
```

---

### Task 2: `teardownPhases.ts` + unit tests

**Files:**
- Create: `apps/server/src/vpn/teardownPhases.ts`
- Create: `apps/server/src/vpn/teardownPhases.test.ts`

- [ ] **Step 1: Create `teardownPhases.ts`**

```ts
import { CADDYFILE_CONF_D_IMPORT_LINE, XUI_SYSTEMD } from "./setupPhases";

export type TeardownPhaseId =
  | "stop_xui"
  | "remove_xui_install"
  | "stop_caddy"
  | "remove_caddy_site"
  | "trim_caddyfile_import"
  | "purge_caddy"
  | "remove_caddy_apt_wiring";

export type TeardownPhase = {
  id: TeardownPhaseId;
  title: string;
  script: string;
};

const CADDY_SITE_FILE = "/etc/caddy/conf.d/vpn-manager-3x-ui.caddy";
const CADDY_APT_LIST = "/etc/apt/sources.list.d/caddy-stable.list";
const CADDY_KEYRING = "/usr/share/keyrings/caddy-stable-archive-keyring.gpg";

export function buildTeardownPhases(): TeardownPhase[] {
  const stopXui: TeardownPhase = {
    id: "stop_xui",
    title: "Stop and disable 3x-ui (systemd)",
    script: `set -euo pipefail
systemctl disable --now ${XUI_SYSTEMD} 2>/dev/null || true
rm -f /etc/systemd/system/x-ui.service
systemctl daemon-reload
`,
  };

  const removeXui: TeardownPhase = {
    id: "remove_xui_install",
    title: "Remove 3x-ui installation directory",
    script: `set -euo pipefail
rm -rf /usr/local/x-ui
`,
  };

  const stopCaddy: TeardownPhase = {
    id: "stop_caddy",
    title: "Stop Caddy before package and config changes",
    script: `set -euo pipefail
systemctl stop caddy 2>/dev/null || true
`,
  };

  const removeSite: TeardownPhase = {
    id: "remove_caddy_site",
    title: "Remove VPN Manager Caddy site fragment",
    script: `set -euo pipefail
rm -f ${CADDY_SITE_FILE}
`,
  };

  const trimCaddyfile: TeardownPhase = {
    id: "trim_caddyfile_import",
    title: "Remove conf.d import line from main Caddyfile if present",
    script: `set -euo pipefail
if test -f /etc/caddy/Caddyfile; then
  LINE=${JSON.stringify(CADDYFILE_CONF_D_IMPORT_LINE)}
  TMP=$(mktemp)
  awk -v line="$LINE" '
    $0 == line && !removed { removed=1; next }
    { print }
  ' /etc/caddy/Caddyfile > "$TMP"
  mv "$TMP" /etc/caddy/Caddyfile
fi
`,
  };

  const purgeCaddy: TeardownPhase = {
    id: "purge_caddy",
    title: "Purge Caddy package",
    script: `set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get purge -y caddy 2>/dev/null || true
`,
  };

  const removeApt: TeardownPhase = {
    id: "remove_caddy_apt_wiring",
    title: "Remove Caddy stable apt source and keyring",
    script: `set -euo pipefail
rm -f ${CADDY_APT_LIST} ${CADDY_KEYRING}
`,
  };

  return [stopXui, removeXui, stopCaddy, removeSite, trimCaddyfile, purgeCaddy, removeApt];
}
```

- [ ] **Step 2: Create `teardownPhases.test.ts`**

```ts
import { describe, expect, test } from "bun:test";
import { buildTeardownPhases } from "./teardownPhases";
import { CADDYFILE_CONF_D_IMPORT_LINE } from "./setupPhases";

describe("buildTeardownPhases", () => {
  test("returns ordered phases with expected ids and paths", () => {
    const phases = buildTeardownPhases();
    expect(phases.map((p) => p.id)).toEqual([
      "stop_xui",
      "remove_xui_install",
      "stop_caddy",
      "remove_caddy_site",
      "trim_caddyfile_import",
      "purge_caddy",
      "remove_caddy_apt_wiring",
    ]);
    const joined = phases.map((p) => p.script).join("\n");
    expect(joined).toContain("/usr/local/x-ui");
    expect(joined).toContain("/etc/caddy/conf.d/vpn-manager-3x-ui.caddy");
    expect(joined).toContain("apt-get purge -y caddy");
    expect(joined).toContain(CADDYFILE_CONF_D_IMPORT_LINE);
    expect(joined).toContain("caddy-stable.list");
  });
});
```

- [ ] **Step 3: Run tests**

```bash
bun test apps/server/src/vpn/teardownPhases.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/vpn/teardownPhases.ts apps/server/src/vpn/teardownPhases.test.ts
git commit -m "feat(vpn): add teardown phase scripts for clear-server."
```

---

### Task 3: `teardownRunner.ts` (executeProfileTeardown)

**Files:**
- Create: `apps/server/src/vpn/teardownRunner.ts`

- [ ] **Step 1: Implement runner (copy structure from `setupRunner.ts`)**

Requirements:

1. Query profile with columns: `id`, `host`, `ssh_port`, `ssh_user`, `operational_status`, `panel_hostname`, `ssh_password_ciphertext`, `ssh_password_nonce`, `xui_secrets_ciphertext`, `xui_secrets_nonce`, `xui_web_base_path`, `last_setup_error`, `last_setup_at`, `created_at`, `updated_at` (same shape as `ProfileSetupRow` plus `last_setup_error`; you may reuse `ProfileSetupRow` from `setupRunner.ts` by exporting it or duplicate a minimal `ProfileTeardownRow`).

2. **Dry-run** (`!env.vpnSshEnabled`): return `{ outcome: "dry-run", profileRow, teardown: { mode: "dry-run", phases: buildTeardownPhases().map(...) } }` — **no** eligibility check (per spec). **No** DB writes.

3. **Live** (`env.vpnSshEnabled`):
   - Eligibility: allow if `operational_status === "working"` OR (`operational_status === "pending"` AND `last_setup_error` is non-null non-empty). Otherwise throw `{ status: 400, message: "clear_server_not_eligible" }`.
   - If `sshExec` not injected and `!sshpassAvailable()`, throw `{ status: 503, message: "sshpass_missing" }` (same as setup).
   - Decrypt SSH password like `setupRunner`.
   - Loop phases with `PHASE_TIMEOUT_MS = 600_000` and same `sshExec` contract.
   - On SSH throw: append failure result, `UPDATE vpn_profiles SET last_setup_error = ?, last_setup_at = datetime('now'), updated_at = datetime('now')` (truncate message like setup ~4000 chars), return `{ outcome: "live-failed", profileRow, teardown }`.
   - On `res.code !== 0`: same persist + return live-failed.
   - On all success:  
     `UPDATE vpn_profiles SET operational_status = 'pending', xui_secrets_ciphertext = NULL, xui_secrets_nonce = NULL, xui_web_base_path = NULL, last_setup_error = NULL, last_setup_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`  
     then return `{ outcome: "live-success", profileRow, teardown }`.

4. Export types: `TeardownPhaseResult`, `TeardownResult`, `ExecuteProfileTeardownOutcome` mirroring setup naming (`teardown` instead of `setup`).

- [ ] **Step 2: Commit**

```bash
git add apps/server/src/vpn/teardownRunner.ts
git commit -m "feat(vpn): add executeProfileTeardown runner for clear-server."
```

---

### Task 4: Route `POST /:id/clear-server` + integration tests

**Files:**
- Modify: `apps/server/src/routes/profiles.ts`
- Modify: `apps/server/src/routes/profiles.test.ts`

- [ ] **Step 1: Write failing route tests first**

Append to `profiles.test.ts`:

```ts
  test("POST /api/profiles/:id/clear-server returns dry-run when VPN_SSH_ENABLED is false", async () => {
    const app = createApp(db, env);
    await app.request("/api/profiles", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${SESSION_COOKIE}=session-token`,
      },
      body: JSON.stringify({
        label: "T",
        host: "10.0.0.1",
        sshPort: 22,
        sshUser: "root",
        sshPassword: "pw",
        panelHostname: "panel.t.example.com",
      }),
    });
    db.query("UPDATE vpn_profiles SET operational_status = 'working', xui_web_base_path = 'abc' WHERE id = 1").run();

    const res = await app.request("/api/profiles/1/clear-server", {
      method: "POST",
      headers: { Cookie: `${SESSION_COOKIE}=session-token` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      profile: { operationalStatus: string };
      teardown: { mode: string; phases: { id: string }[] };
    };
    expect(body.teardown.mode).toBe("dry-run");
    expect(body.teardown.phases[0]?.id).toBe("stop_xui");
    const row = db
      .query<{ operational_status: string; xui_web_base_path: string | null }, []>(
        "SELECT operational_status, xui_web_base_path FROM vpn_profiles WHERE id = 1",
      )
      .get();
    expect(row?.operational_status).toBe("working");
    expect(row?.xui_web_base_path).toBe("abc");
  });

  test("POST /api/profiles/:id/clear-server returns 400 when pending and no setup error", async () => {
    const liveEnv: Env = { ...env, vpnSshEnabled: true, acmeEmail: "ops@example.com" };
    const fakeSsh: SshExecFn = async () => ({ code: 0, stdout: "", stderr: "" });
    const app = createApp(db, liveEnv, { profiles: { sshExec: fakeSsh } });
    await app.request("/api/profiles", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${SESSION_COOKIE}=session-token`,
      },
      body: JSON.stringify({
        label: "P",
        host: "10.0.0.3",
        sshPort: 22,
        sshUser: "root",
        sshPassword: "pw",
        panelHostname: "panel.p.example.com",
      }),
    });

    const res = await app.request("/api/profiles/1/clear-server", {
      method: "POST",
      headers: { Cookie: `${SESSION_COOKIE}=session-token` },
    });
    expect(res.status).toBe(400);
  });

  test("POST /api/profiles/:id/clear-server live success clears DB when working", async () => {
    const liveEnv: Env = { ...env, vpnSshEnabled: true, acmeEmail: "ops@example.com" };
    const fakeSsh: SshExecFn = async () => ({ code: 0, stdout: "ok", stderr: "" });
    const app = createApp(db, liveEnv, { profiles: { sshExec: fakeSsh } });
    await app.request("/api/profiles", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${SESSION_COOKIE}=session-token`,
      },
      body: JSON.stringify({
        label: "L",
        host: "10.0.0.4",
        sshPort: 22,
        sshUser: "root",
        sshPassword: "pw",
        panelHostname: "panel.l.example.com",
      }),
    });
    await app.request("/api/profiles/1/setup", {
      method: "POST",
      headers: { Cookie: `${SESSION_COOKIE}=session-token` },
    });

    const res = await app.request("/api/profiles/1/clear-server", {
      method: "POST",
      headers: { Cookie: `${SESSION_COOKIE}=session-token` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { profile: { operationalStatus: string }; teardown: { mode: string } };
    expect(body.teardown.mode).toBe("live");
    expect(body.profile.operationalStatus).toBe("pending");
    const row = db
      .query<{ operational_status: string; xui_web_base_path: string | null; last_setup_error: string | null }, []>(
        "SELECT operational_status, xui_web_base_path, last_setup_error FROM vpn_profiles WHERE id = 1",
      )
      .get();
    expect(row?.operational_status).toBe("pending");
    expect(row?.xui_web_base_path).toBeNull();
    expect(row?.last_setup_error).toBeNull();
  });

  test("POST /api/profiles/:id/clear-server live failure returns 500 and keeps working", async () => {
    const liveEnv: Env = { ...env, vpnSshEnabled: true, acmeEmail: "ops@example.com" };
    let call = 0;
    const fakeSsh: SshExecFn = async () => {
      call += 1;
      if (call === 1) return { code: 0, stdout: "", stderr: "" };
      return { code: 1, stdout: "", stderr: "boom" };
    };
    const app = createApp(db, liveEnv, { profiles: { sshExec: fakeSsh } });
    await app.request("/api/profiles", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${SESSION_COOKIE}=session-token`,
      },
      body: JSON.stringify({
        label: "F",
        host: "10.0.0.5",
        sshPort: 22,
        sshUser: "root",
        sshPassword: "pw",
        panelHostname: "panel.f.example.com",
      }),
    });
    await app.request("/api/profiles/1/setup", {
      method: "POST",
      headers: { Cookie: `${SESSION_COOKIE}=session-token` },
    });

    const res = await app.request("/api/profiles/1/clear-server", {
      method: "POST",
      headers: { Cookie: `${SESSION_COOKIE}=session-token` },
    });
    expect(res.status).toBe(500);
    const row = db.query<{ operational_status: string }, []>("SELECT operational_status FROM vpn_profiles WHERE id = 1").get();
    expect(row?.operational_status).toBe("working");
  });
```

Run:

```bash
bun test apps/server/src/routes/profiles.test.ts
```

Expected: new tests **fail** (route missing).

- [ ] **Step 2: Register route in `profiles.ts`**

Place **`POST /:id/clear-server`** immediately after the `POST /:id/setup` block (before `PATCH`) so routing stays grouped. Pattern:

```ts
  app.post("/:id/clear-server", async (c) => {
    const id = parseId(c.req.param("id"));
    if (id === null) return c.json({ error: "Invalid profile id" }, 400);
    const existing = getProfileById(db, id);
    if (!existing) return c.json({ error: "Profile not found" }, 404);

    try {
      const result = await executeProfileTeardown({
        db,
        env,
        profileId: id,
        sshExec: options.sshExec,
      });
      if (result.outcome === "dry-run") {
        return c.json({ profile: toProfileDto(result.profileRow as VpnProfileRow), teardown: result.teardown });
      }
      if (result.outcome === "live-failed") {
        return c.json(
          { error: "VPN clear-server failed", profile: toProfileDto(result.profileRow as VpnProfileRow), teardown: result.teardown },
          500,
        );
      }
      return c.json({ profile: toProfileDto(result.profileRow as VpnProfileRow), teardown: result.teardown });
    } catch (e: unknown) {
      const err = e as { status?: number; message?: string };
      if (err.status === 400 && err.message === "clear_server_not_eligible") {
        return c.json({ error: "Nothing to clear: profile is pending and setup did not record a failure." }, 400);
      }
      if (err.status === 503) {
        return c.json(
          {
            error:
              "sshpass is required on the VPN Manager host for SSH password authentication (install the sshpass package)",
          },
          503,
        );
      }
      throw e;
    }
  });
```

Import `executeProfileTeardown` from `../vpn/teardownRunner`.

- [ ] **Step 3: Run full server tests**

```bash
bun test apps/server
```

Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/routes/profiles.ts apps/server/src/routes/profiles.test.ts
git commit -m "feat(api): add POST /api/profiles/:id/clear-server."
```

---

### Task 5: Web — Edit modal button + sheet

**Files:**
- Modify: `apps/web/src/pages/VpnsPage.tsx`

- [ ] **Step 1: Add types and API helper**

Near `SetupResponse`, add:

```ts
type ClearServerResponse = {
  profile: VpnProfile;
  teardown: { mode: "dry-run" | "live"; phases: SetupPhaseDto[] };
};
```

```ts
function clearServerFromProfile(id: number) {
  return apiFetch<ClearServerResponse>(`/api/profiles/${id}/clear-server`, {
    method: "POST",
  });
}
```

- [ ] **Step 2: State and mutation**

- `clearServerActionError: string | null` (or reuse `setupActionError` — prefer **separate** `clearServerActionError` to avoid confusing messages).
- `outputSheet: { kind: "setup" | "clear"; profile: VpnProfile; phases: SetupPhaseDto[]; mode: "dry-run" | "live" } | null` — **or** keep `setupSheet` and add optional `kind` + rename internally to `maintenanceSheet`. Simplest: extend existing `setupSheet` state to `{ profile, setup: ..., kind?: "setup" | "clear" }` where `setup` holds phases for both; sheet title uses `kind`.

Minimal change path: rename conceptually to `phaseOutputSheet: { profile; title; phases; mode } | null` only if needed; otherwise add `sheetKind: "setup" | "clear"` next to `setupSheet`.

- `clearServerMutation` with `mutationFn: (id: number) => clearServerFromProfile(id)`, `onSuccess` invalidate `profilesQueryKey` and open sheet with teardown phases.

- [ ] **Step 3: Edit modal UI**

Inside `modalState.mode === "edit"` block, above the form’s error line or in `modalActionsStyle` row:

- Show button **only** when `modalState.profile.operationalStatus === "working"` OR when you need failed-setup path: the list DTO may not include `lastSetupError`. **Gap fix:** extend `VpnProfile` type and `toProfileDto` / GET responses to include optional `lastSetupError: string | null` **or** derive visibility: show clear when `working` only for MVP. **Spec requires** also `pending` + `last_setup_error`. Add to server `toProfileDto`:

```ts
lastSetupError: row.last_setup_error ?? null,
```

and extend `VpnProfileRow` SELECTs to include `last_setup_error`. Then web shows button when `working || (pending && lastSetupError)`.

- Button label: `Clear server from VPN services` (danger style).
- `disabled={isSaving || clearServerMutation.isPending || !authUser}` — if product wants parity with Setup (no auth), drop `!authUser`; **spec** said match SSH for guests: keep `!authUser` disabled.
- `onClick`: `window.confirm` with text warning panel/3x-ui removal and that UFW is untouched; on OK call `clearServerMutation.mutateAsync(modalState.profile.id)`.
- On catch: set `clearServerActionError` like setup; on 500 with `teardown` in body (mirror setup’s 500 handler), open sheet and clear error.

- [ ] **Step 4: Sheet title**

In `SetupOutputSheet`, add optional prop `titlePrefix` default `"Setup"` → render `titlePrefix — {profile.label} (...)`.

- [ ] **Step 5: Typecheck web**

```bash
bun --cwd apps/web exec tsc -b --pretty false
```

Expected: exit code 0.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/routes/profiles.ts apps/web/src/pages/VpnsPage.tsx
git commit -m "feat(web): clear-server control on edit VPN profile modal."
```

(If `toProfileDto` / row types changed only for `lastSetupError`, include those files in the same commit.)

---

### Task 6: Optional `lastSetupError` on profile DTO (if not done in Task 5)

**Files:**
- Modify: `apps/server/src/routes/profiles.ts` (`VpnProfileRow`, `toProfileDto`, SQL in GET and `getProfileById` if used for responses)
- Modify: `apps/web/src/pages/VpnsPage.tsx` (`VpnProfile` type)

- [ ] **Step 1: Add column to selects and DTO**

SQL: add `last_setup_error` to list + single-profile queries. JSON: `lastSetupError: row.last_setup_error`.

- [ ] **Step 2: Server tests**

Update expectations in tests that compare full profile objects if they now include `lastSetupError` (use `expect.objectContaining` or add `lastSetupError: null`).

Run `bun test apps/server`.

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/routes/profiles.ts apps/server/src/routes/profiles.test.ts apps/web/src/pages/VpnsPage.tsx
git commit -m "feat(api): expose lastSetupError on VPN profile DTO for clear-server UX."
```

---

## Plan self-review

**Spec coverage:**

| Spec item | Task |
|-----------|------|
| Phased SSH teardown (B) | Task 2 scripts, Task 3 runner |
| UFW untouched | Task 2 scripts (no ufw) |
| DB reset on success | Task 3 SQL in runner |
| Eligibility live-only | Task 3 runner + Task 4 tests |
| Dry-run no DB | Task 3 + Task 4 test |
| `POST .../clear-server` | Task 4 |
| Edit modal + confirm + sheet | Task 5 |
| `lastSetupError` for pending+error visibility | Task 5/6 |
| Tests | Tasks 1–4, 6 |

**Placeholder scan:** None intentional; awk/sed behavior is specified inline.

**Type consistency:** `ClearServerResponse.teardown.phases` uses `SetupPhaseDto[]` — same shape as setup phases.

---

**Plan complete and saved to `docs/superpowers/plans/2026-04-14-vpn-profile-clear-server.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — Dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
