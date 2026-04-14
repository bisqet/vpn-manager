# 3x-ui API SSH setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace placeholder VPN profile setup with a real, spec-aligned flow: global `VPN_SSH_ENABLED` gate, dry-run structured steps for the UI terminal sheet, live phased SSH execution to Ubuntu 24 hosts, 3x-ui + Caddy + `ufw`, generated admin credentials stored encrypted, `POST /setup` returns **409** when already `working`, and tests proving gates and dry-run behavior.

**Architecture:** Extend `Env` with `vpnSshEnabled` and `acmeEmail`. Add DB columns on `vpn_profiles` (`panel_hostname`, encrypted x-ui secret blob, optional `last_setup_error` / `last_setup_at`). Centralize **setup phase definitions** in a dedicated module that returns the same ordered steps for dry-run and for live execution; live path uses an **SSH adapter** (Bun child process `ssh` or a small wrapper) injected for tests. **Do not** run the full upstream `install.sh` if it blocks on interactive SSL — use the **tarball + systemd** path mirrored from upstream (`install_x-ui` in [3x-ui `install.sh`](https://raw.githubusercontent.com/mhsanaei/3x-ui/master/install.sh)) so Caddy owns TLS. Apply admin credentials with `/usr/local/x-ui/x-ui setting -username … -password …` (see [3x-ui `x-ui.sh`](https://raw.githubusercontent.com/mhsanaei/3x-ui/main/x-ui.sh)). Bind the panel to loopback using whatever flag `x-ui setting -help` documents (spike task below).

**Tech Stack:** Bun, Hono, `bun:sqlite`, Zod, existing `encryptVpnPassword` / `decryptVpnPassword` (AES-GCM) for new payloads, child-process SSH.

**Spec:** `docs/superpowers/specs/2026-04-14-3x-ui-api-ssh-setup-design.md`

---

## File map (responsibilities)

| File | Responsibility |
|------|------------------|
| `apps/server/src/env.ts` | Parse `VPN_SSH_ENABLED`, `ACME_EMAIL`; extend `Env` type. |
| `apps/server/.env.example` | Document new variables. |
| `apps/server/src/db/schema.sql` | New columns on `vpn_profiles` (baseline for fresh DBs). |
| `apps/server/src/db/migrateVpnProfile3xUi.ts` (new) | `ALTER TABLE` when columns missing (pattern like `migrateVpnProfileOperationalStatus.ts`). |
| `apps/server/src/db/migrate.ts` | Call new migration. |
| `apps/server/src/types.ts` | Zod: `panelHostname` on create/update; response shapes if needed. |
| `apps/server/src/crypto/xuiSecrets.ts` (new) | `encryptXuiSecretsBlob` / `decryptXuiSecretsBlob` wrapping same AES-GCM as `vpnSecret.ts` (reuse `importKey` pattern or call shared helper). |
| `apps/server/src/vpn/setupPhases.ts` (new) | Ordered phase metadata + shell snippet templates (placeholders for dry-run). |
| `apps/server/src/vpn/setupRunner.ts` (new) | `runDryRun`, `runLive` orchestration, timeouts, persist errors. |
| `apps/server/src/vpn/sshExec.ts` (new) | `execRemote(profile, decryptedSshPassword, script): Promise<{stdout, stderr, code}>` using `ssh -p … -o BatchMode=yes …`. |
| `apps/server/src/routes/profiles.ts` | Wire setup route to runner; 409 when `working`; remove placeholder simulate/verify for setup path. |
| `apps/server/src/routes/profiles.test.ts` | Update expectations; add dry-run + 409 tests. |
| `apps/server/src/index.ts` | Pass extended `env` into `createApp` / `profilesRoutes` if needed. |
| `apps/web/src/pages/VpnsPage.tsx` | `panelHostname` in form + table; Setup opens sheet + renders dry-run/live payload. |
| `AGENTS.md` (optional) | One-line mention of `VPN_SSH_ENABLED` / `ACME_EMAIL` — only if you want discoverability; spec is primary. |

---

### Task 1: Env parsing and `.env.example`

**Files:**

- Modify: `apps/server/src/env.ts`
- Modify: `apps/server/.env.example`
- Modify: `apps/server/src/index.ts` (thread `Env` where `createApp` is called — read bottom of file)

- [ ] **Step 1: Extend `Env` and `loadEnv`**

```typescript
// Add to Env type in env.ts:
vpnSshEnabled: boolean;
acmeEmail: string | undefined;
sshKnownHostsFile: string | undefined;

// Inside loadEnv(), after master key decode:
const vpnSshEnabled =
  process.env.VPN_SSH_ENABLED === "1" ||
  process.env.VPN_SSH_ENABLED === "true" ||
  process.env.VPN_SSH_ENABLED === "yes";
const acmeEmail = process.env.ACME_EMAIL?.trim() || undefined;
const sshKnownHostsFile = process.env.SSH_KNOWN_HOSTS_FILE?.trim() || undefined;

return {
  port,
  databasePath,
  masterKey: decodeMasterKey(master),
  staticDir,
  vpnSshEnabled,
  acmeEmail,
  sshKnownHostsFile,
};
```

- [ ] **Step 2: Document in `apps/server/.env.example`**

Append:

```dotenv
# When false/unset, POST /api/profiles/:id/setup never opens SSH (dry-run only).
VPN_SSH_ENABLED=false

# Required for live setup (Caddy Let's Encrypt). Global for all profiles.
# ACME_EMAIL=ops@example.com

# Live SSH with stored passwords requires the `sshpass` binary on the API host.
# Optional: path to a known_hosts file for strict host key checking (omit to use accept-new for v1).
# SSH_KNOWN_HOSTS_FILE=/path/to/known_hosts
```

- [ ] **Step 3: Fix all `Env` test fixtures**

Any object literal typed `Env` in tests must add `vpnSshEnabled: false`, `acmeEmail: undefined`, and `sshKnownHostsFile: undefined` (or strings for targeted tests).

Run: `bun test apps/server`

Expected: PASS (or compile errors listing missing fields — fix those files).

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/env.ts apps/server/.env.example apps/server/src/index.ts apps/server/src/routes/profiles.test.ts
git commit -m "feat(server): add VPN_SSH_ENABLED and ACME_EMAIL to env"
```

---

### Task 2: Database migration for `panel_hostname` and x-ui secret storage

**Files:**

- Modify: `apps/server/src/db/schema.sql`
- Create: `apps/server/src/db/migrateVpnProfile3xUi.ts`
- Modify: `apps/server/src/db/migrate.ts`

- [ ] **Step 1: Add columns to `schema.sql` inside `vpn_profiles`**

Add lines (adjust names to match snake_case in DB):

```sql
panel_hostname TEXT NOT NULL DEFAULT '',
xui_secrets_ciphertext BLOB,
xui_secrets_nonce BLOB,
xui_web_base_path TEXT,
last_setup_error TEXT,
last_setup_at TEXT
```

Use `DEFAULT ''` for `panel_hostname` so existing `INSERT` patterns in tests stay valid until Task 3 requires real values.

- [ ] **Step 2: Idempotent migration file**

Create `migrateVpnProfile3xUi.ts`:

```typescript
import type { Database } from "bun:sqlite";

type TableInfoRow = { name: string };

function vpnProfilesColumns(db: Database): Set<string> {
  const rows = db.query<TableInfoRow, []>("PRAGMA table_info(vpn_profiles)").all();
  return new Set(rows.map((r) => r.name));
}

export function migrateVpnProfile3xUiIfNeeded(db: Database): void {
  const cols = vpnProfilesColumns(db);
  if (!cols.has("panel_hostname")) {
    db.exec(`ALTER TABLE vpn_profiles ADD COLUMN panel_hostname TEXT NOT NULL DEFAULT '';`);
  }
  if (!cols.has("xui_secrets_ciphertext")) {
    db.exec(`ALTER TABLE vpn_profiles ADD COLUMN xui_secrets_ciphertext BLOB;`);
  }
  if (!cols.has("xui_secrets_nonce")) {
    db.exec(`ALTER TABLE vpn_profiles ADD COLUMN xui_secrets_nonce BLOB;`);
  }
  if (!cols.has("xui_web_base_path")) {
    db.exec(`ALTER TABLE vpn_profiles ADD COLUMN xui_web_base_path TEXT;`);
  }
  if (!cols.has("last_setup_error")) {
    db.exec(`ALTER TABLE vpn_profiles ADD COLUMN last_setup_error TEXT;`);
  }
  if (!cols.has("last_setup_at")) {
    db.exec(`ALTER TABLE vpn_profiles ADD COLUMN last_setup_at TEXT;`);
  }
}
```

Call `migrateVpnProfile3xUiIfNeeded(db)` from `migrate.ts` after existing migrations.

- [ ] **Step 3: Run tests**

Run: `bun test apps/server`

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/db/schema.sql apps/server/src/db/migrateVpnProfile3xUi.ts apps/server/src/db/migrate.ts
git commit -m "feat(db): add panel hostname and x-ui secret columns to vpn_profiles"
```

---

### Task 3: Zod + API DTO for `panelHostname`

**Files:**

- Modify: `apps/server/src/types.ts`
- Modify: `apps/server/src/routes/profiles.ts` (INSERT/UPDATE/SELECT + `toProfileDto`)

- [ ] **Step 1: Failing test — create requires `panelHostname`**

In `apps/server/src/routes/profiles.test.ts`, update the `POST` body in `"creates, lists, updates..."` to include:

```json
"panelHostname": "vpn.example.com"
```

Run: `bun test apps/server/src/routes/profiles.test.ts`

Expected: FAIL (validation or SQL error until implementation exists).

- [ ] **Step 2: Implement Zod**

```typescript
// types.ts — add to both schemas:
panelHostname: z
  .string()
  .min(1)
  .regex(
    /^([a-zA-Z0-9](-*[a-zA-Z0-9])*\.)+[a-zA-Z]{2,}$/,
    "panelHostname must be a DNS name (FQDN)",
  ),
```

`vpnProfileUpdate` should include `panelHostname` as optional with the same refinement when present.

- [ ] **Step 3: Wire profiles routes**

- Extend `VpnProfileRow` / DTO with `panelHostname` (camelCase JSON, `panel_hostname` in SQL).
- `INSERT` and `UPDATE` statements must include `panel_hostname`.
- `toProfileDto` returns `panelHostname: row.panel_hostname`.

- [ ] **Step 4: Run full server tests**

Run: `bun test apps/server`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/types.ts apps/server/src/routes/profiles.ts apps/server/src/routes/profiles.test.ts
git commit -m "feat(profiles): add panelHostname to VPN profiles API"
```

---

### Task 4: Encrypted x-ui secrets blob helper

**Files:**

- Create: `apps/server/src/crypto/xuiSecrets.ts`
- Create: `apps/server/src/crypto/xuiSecrets.test.ts`

- [ ] **Step 1: Failing test**

```typescript
// apps/server/src/crypto/xuiSecrets.test.ts
import { describe, expect, test } from "bun:test";
import { decryptXuiSecretsJson, encryptXuiSecretsJson } from "./xuiSecrets";

describe("xuiSecrets", () => {
  test("roundtrips json payload", async () => {
    const masterKey = new Uint8Array(32).fill(7);
    const payload = { v: 1 as const, adminUsername: "u9", adminPassword: "p-secret-!" };
    const enc = await encryptXuiSecretsJson(masterKey, payload);
    const out = await decryptXuiSecretsJson(masterKey, enc.ciphertext, enc.nonce);
    expect(out).toEqual(payload);
  });
});
```

Run: `bun test apps/server/src/crypto/xuiSecrets.test.ts`

Expected: FAIL (module missing).

- [ ] **Step 2: Implement using same AES-GCM parameters as `vpnSecret.ts`**

Copy `ALGO`, `IV_LENGTH`, and `importKey` pattern from `apps/server/src/crypto/vpnSecret.ts`; export:

```typescript
export type XuiSecretsPayloadV1 = {
  v: 1;
  adminUsername: string;
  adminPassword: string;
};
// Note: web base path is stored in vpn_profiles.xui_web_base_path (plaintext) for HTTPS probes and Caddy routing.

export async function encryptXuiSecretsJson(
  masterKey: Uint8Array,
  payload: XuiSecretsPayloadV1,
): Promise<{ ciphertext: Uint8Array; nonce: Uint8Array }> {
  const plaintext = JSON.stringify(payload);
  // same encrypt pattern as encryptVpnPassword
}

export async function decryptXuiSecretsJson(
  masterKey: Uint8Array,
  ciphertext: Uint8Array,
  nonce: Uint8Array,
): Promise<XuiSecretsPayloadV1> {
  const text = await decryptVpnPassword(masterKey, ciphertext, nonce);
  return JSON.parse(text) as XuiSecretsPayloadV1;
}
```

You may implement by reusing `encryptVpnPassword` / `decryptVpnPassword` on the JSON string (simplest).

Run: `bun test apps/server/src/crypto/xuiSecrets.test.ts`

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/crypto/xuiSecrets.ts apps/server/src/crypto/xuiSecrets.test.ts
git commit -m "feat(crypto): add encrypted x-ui secrets payload helper"
```

---

### Task 5: Spike — document real `x-ui setting` flags (blocking subtask)

**Files:**

- Create (temporary notes OK): inline comment in `apps/server/src/vpn/setupPhases.ts` once created, or a short comment in the plan after you run the spike.

- [ ] **Step 1: On any Ubuntu 24 machine (or disposable VPS), after manual 3x-ui install, run**

```bash
/usr/local/x-ui/x-ui setting -help 2>&1 | head -n 80
```

Record the exact flag names for: panel **port**, **webBasePath**, **username**, **password**, and any **listen / bind** option.

- [ ] **Step 2: Encode findings in `setupPhases.ts` constants**

Example (adjust to match real `-help` output):

```typescript
export const XUI_LOCAL_PANEL_PORT = 2053; // change if -help shows different default
export const XUI_BIN = "/usr/local/x-ui/x-ui";
```

If no listen flag exists, document in code comment that loopback binding relies on **Caddy-only exposure** plus `ufw` deny on the panel port from WAN (implement `ufw deny` / no rule for that port except localhost — use `ufw` route or iptables if required).

- [ ] **Step 3: Commit** (if only comments/constants)

```bash
git add apps/server/src/vpn/setupPhases.ts
git commit -m "chore(vpn): document x-ui CLI flags from upstream spike"
```

---

### Task 6: `setupPhases.ts` — ordered dry-run / live steps

**Files:**

- Create: `apps/server/src/vpn/setupPhases.ts`
- Create: `apps/server/src/vpn/setupPhases.test.ts`

- [ ] **Step 1: Export types**

```typescript
export type SetupPhaseId =
  | "preflight"
  | "ufw"
  | "install_xui"
  | "configure_xui"
  | "install_caddy"
  | "configure_caddy"
  | "verify";

export type SetupPhase = {
  id: SetupPhaseId;
  title: string;
  /** Multi-line shell; use PLACEHOLDER_ADMIN_USER etc. for dry-run */
  script: string;
};

export const PLACEHOLDER_ADMIN_USER = "<GENERATED_ADMIN_USERNAME>";
export const PLACEHOLDER_ADMIN_PASS = "<GENERATED_ADMIN_PASSWORD>";
```

- [ ] **Step 2: Implement `buildSetupPhases(ctx)`** where `ctx` includes at least:

`sshHost`, `sshPort`, `sshUser`, `panelHostname`, `acmeEmailForCaddyfile` (string or placeholder).

Return **8** phases matching the approved spec (preflight … verify). Use **real** commands where possible:

- Preflight: `grep VERSION_ID /etc/os-release`, `id`, `curl --version`
- UFW: `ufw status verbose` then allow rules (spec: ssh, 80, 443)
- Install x-ui: `curl -4fL …/x-ui-linux-$(uname -m | sed …).tar.gz` pattern from upstream (use `amd64` mapping function copied from comments in upstream or `dpkg --print-architecture`)
- Configure: `${XUI_BIN} setting -username …` (from Task 5)
- Caddy: install via official deb instructions:

```bash
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update
sudo apt-get install -y caddy
```

(Exact lines from [Caddy install docs](https://caddyserver.com/docs/install) if these change.)

- Caddyfile block:

```caddy
{$PANEL_HOSTNAME} {
  encode gzip
  reverse_proxy 127.0.0.1:{$XUI_PORT}
}
```

Use env vars expanded by a small `bash -c` wrapper in the script.

- Verify: `systemctl is-active x-ui`, `systemctl is-active caddy`, `curl -fsS -o /dev/null -w "%{http_code}" https://${panelHostname}/${xuiWebBasePath}` — persist **`xui_web_base_path`** on the profile row after configure phase (random segment like upstream `gen_random_string 18`, no leading slash).

- [ ] **Step 3: Test snapshot count**

```typescript
// setupPhases.test.ts
import { describe, expect, test } from "bun:test";
import { buildSetupPhases, PLACEHOLDER_ADMIN_USER } from "./setupPhases";

describe("buildSetupPhases", () => {
  test("uses placeholders when dry-run", () => {
    const phases = buildSetupPhases({
      sshHost: "203.0.113.10",
      sshPort: 22,
      sshUser: "root",
      panelHostname: "panel.example.com",
      acmeEmail: "ops@example.com",
      adminUsername: PLACEHOLDER_ADMIN_USER,
      adminPassword: PLACEHOLDER_ADMIN_PASS,
      xuiLocalPort: 2053,
    });
    expect(phases.length).toBeGreaterThanOrEqual(7);
    const joined = phases.map((p) => p.script).join("\n");
    expect(joined).toContain("panel.example.com");
    expect(joined).toContain(PLACEHOLDER_ADMIN_USER);
  });
});
```

Run: `bun test apps/server/src/vpn/setupPhases.test.ts`

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/vpn/setupPhases.ts apps/server/src/vpn/setupPhases.test.ts
git commit -m "feat(vpn): add ordered 3x-ui + Caddy setup phases"
```

---

### Task 7: `sshExec.ts` with injectable executor

**Files:**

- Create: `apps/server/src/vpn/sshExec.ts`
- Create: `apps/server/src/vpn/sshExec.test.ts`

- [ ] **Step 1: Interface**

```typescript
export type SshExecFn = (args: {
  host: string;
  port: number;
  user: string;
  password: string;
  remoteScript: string;
  timeoutMs: number;
}) => Promise<{ code: number; stdout: string; stderr: string }>;

export function buildSshExecUsingBunSpawn(): SshExecFn {
  return async ({ host, port, user, password, remoteScript, timeoutMs }) => {
    // Use ssh with BatchMode=yes, StrictHostKeyChecking=accept-new OR reject based on VPN_SSH_STRICT_KNOWN_HOSTS — pick one and document.
    // Pass script via stdin: ssh ... 'bash -s' <<< script is shell-dependent; prefer:
    // const proc = Bun.spawn(["ssh", ...,"bash","-s"], { stdin: new Blob([remoteScript]), ... })
    throw new Error("not implemented");
  };
}
```

- [ ] **Step 2: Test with fake executor**

```typescript
import { describe, expect, test } from "bun:test";
import type { SshExecFn } from "./sshExec";
import { runRemoteScript } from "./sshExec";

test("uses injected executor", async () => {
  const calls: string[] = [];
  const fake: SshExecFn = async ({ remoteScript }) => {
    calls.push(remoteScript);
    return { code: 0, stdout: "ok", stderr: "" };
  };
  const res = await runRemoteScript(fake, { /* minimal fields */ remoteScript: "echo hi", timeoutMs: 1000 });
  expect(res.stdout).toBe("ok");
  expect(calls[0]).toContain("echo hi");
});
```

Export `runRemoteScript` that only forwards to `SshExecFn`.

Implement `runRemoteScript` + `buildSshExecUsingBunSpawn` until the fake test passes.

**v1 password SSH (locked):** `buildSshExecUsingBunSpawn` runs `sshpass -e ssh …` with password passed via environment variable **`SSHPASS`** (set on the spawned process only, not `process.env` global). If `sshpass` is missing on `PATH`, return exit code mapping to **`503`** from the route with `{ error: "sshpass is required on the VPN Manager host for SSH password authentication" }`. Document in `apps/server/.env.example` that production images must install the `sshpass` package. Use `ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new` for v1 (document upgrade path to known-hosts pinning).

**Host keys:** Add optional follow-up env `SSH_KNOWN_HOSTS_FILE` pointing at a file mounted into the server; pass `-o UserKnownHostsFile=…` when set. When unset, keep `accept-new` and log the fingerprint once (no secret leakage).

Run: `bun test apps/server/src/vpn/sshExec.test.ts`

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/vpn/sshExec.ts apps/server/src/vpn/sshExec.test.ts
git commit -m "feat(vpn): add SSH exec adapter with injectable implementation"
```

---

### Task 8: `setupRunner.ts` + `POST /setup` wiring

**Files:**

- Create: `apps/server/src/vpn/setupRunner.ts`
- Modify: `apps/server/src/routes/profiles.ts`
- Modify: `apps/server/src/routes/profiles.test.ts`

- [ ] **Step 1: Runner API**

```typescript
export type SetupResult =
  | { mode: "dry-run"; phases: Array<{ id: string; title: string; script: string }> }
  | { mode: "live"; phases: Array<{ id: string; title: string; script: string; stdout: string; stderr: string; code: number }> };

export async function executeProfileSetup(options: {
  db: Database;
  env: Env;
  profileId: number;
  sshExec: SshExecFn;
}): Promise<SetupResult> { /* ... */ }
```

Rules:

- If `operational_status === 'working'` → throw / return `409` at route layer.
- If `!env.vpnSshEnabled` → **dry-run** only: `buildSetupPhases` with placeholders; **no** DB writes except optional `last_setup_at` (spec said no transition to working — **do not** update `operational_status`).
- If `env.vpnSshEnabled` → require `env.acmeEmail` else `400` with `{ error: "ACME_EMAIL is required when VPN_SSH_ENABLED is true" }`.
- Live: decrypt SSH password; generate random admin user/pass; `buildSetupPhases` with real secrets; for each phase run `sshExec`; stop on first non-zero exit; set `last_setup_error`, `last_setup_at`; on full success encrypt blob with `encryptXuiSecretsJson`, write `xui_secrets_*`, clear `last_setup_error`, set `operational_status='working'`.

- [ ] **Step 2: Route returns JSON shape**

When dry-run:

```json
{
  "profile": { "...existing dto..." },
  "setup": { "mode": "dry-run", "phases": [ ... ] }
}
```

When live success:

```json
{
  "profile": { "... dto ... operationalStatus: \"working\"" },
  "setup": { "mode": "live", "phases": [ ... ] }
}
```

Keep **secrets out of `profile`** JSON.

- [ ] **Step 3: Tests in `profiles.test.ts`**

```typescript
test("POST setup returns dry-run when VPN_SSH_ENABLED is false", async () => {
  const app = createApp(db, { ...env, vpnSshEnabled: false, acmeEmail: "ops@example.com" });
  // create profile with panelHostname
  const res = await app.request("/api/profiles/1/setup", { method: "POST", headers: { Cookie: ... } });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.setup.mode).toBe("dry-run");
  expect(body.setup.phases[0].id).toBeDefined();
  const row = db.query("SELECT operational_status FROM vpn_profiles WHERE id = 1").get() as { operational_status: string };
  expect(row.operational_status).toBe("pending");
});

test("POST setup returns 409 when already working", async () => {
  // insert profile with operational_status working
  const res = await app.request("/api/profiles/1/setup", { method: "POST", headers: { Cookie: ... } });
  expect(res.status).toBe(409);
});
```

Use **in-memory** `fakeSshExec` passed into `profilesRoutes` via new optional parameter **or** env-based factory — cleanest: `profilesRoutes(db, { masterKey, vpnSshEnabled, acmeEmail, sshExec?: SshExecFn })` defaulting to `buildSshExecUsingBunSpawn()` in production `createApp`.

- [ ] **Step 4: Run tests**

Run: `bun test apps/server`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/vpn/setupRunner.ts apps/server/src/routes/profiles.ts apps/server/src/routes/profiles.test.ts
git commit -m "feat(profiles): wire 3x-ui setup runner and dry-run SSH gate"
```

---

### Task 9: Web UI — `panelHostname` + Setup sheet renders phases

**Files:**

- Modify: `apps/web/src/pages/VpnsPage.tsx`
- Run: `cd apps/web && bunx tsc -b`

- [ ] **Step 1: Extend types and forms**

Add `panelHostname` to `VpnProfile`, `ProfileFormValues`, `emptyFormValues`, validators, create/patch payloads, table column **Panel host**.

- [ ] **Step 2: Change `setupProfile` function**

It currently returns `VpnProfile`. Update to typed union matching API, e.g.:

```typescript
type SetupResponse = {
  profile: VpnProfile;
  setup: { mode: "dry-run" | "live"; phases: Array<{ id: string; title: string; script: string; stdout?: string; stderr?: string; code?: number }> };
};

function setupProfile(id: number) {
  return apiFetch<SetupResponse>(`/api/profiles/${id}/setup`, { method: "POST" });
}
```

- [ ] **Step 3: Setup button opens terminal sheet**

State: `setupSheet: { profile: VpnProfile; setup: SetupResponse["setup"] } | null`.

On successful `setupMutation`, if `data.setup.mode === "dry-run"`, open sheet with phases rendered as:

```tsx
data.setup.phases.map((p) => (
  <pre key={p.id} style={{ marginBottom: "1rem", whiteSpace: "pre-wrap" }}>
    {"# " + p.title + "\n" + p.script}
  </pre>
));
```

If live mode, append stdout/stderr blocks per phase.

- [ ] **Step 4: Typecheck**

Run: `cd apps/web && bunx tsc -b`

Expected: exit code 0.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/VpnsPage.tsx
git commit -m "feat(web): panel hostname field and setup dry-run terminal output"
```

---

## Self-review (plan vs spec)

| Spec requirement | Task coverage |
|------------------|---------------|
| API-driven SSH (B) | Task 7–8 |
| Global `VPN_SSH_ENABLED` dry-run, no dial | Task 1, 8 |
| Ubuntu 24 + 3x-ui script/systemd | Task 5–6 (binary path avoids interactive `install.sh`) |
| Caddy + ACME email global | Task 1, 6 |
| `host` IP + `panelHostname` FQDN | Task 2–3 |
| Encrypted 3x-ui credentials | Task 4, 8 |
| Public HTTPS, 3x-ui behind Caddy, ufw 22/80/443 | Task 6 |
| 409 when `working` | Task 8 |
| UI terminal sheet for setup output | Task 9 |
| SSH host key strict policy | Task 7 (explicit `StrictHostKeyChecking` / known_hosts — fill exact flag when implementing) |

**Placeholder scan:** None intentional; Task 5 explicitly resolves unknown `x-ui` CLI flags.

---

## Plan complete and saved to `docs/superpowers/plans/2026-04-14-3x-ui-api-ssh-setup.md`. Two execution options:

**1. Subagent-Driven (recommended)** — Dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints for review.

Which approach do you want?
