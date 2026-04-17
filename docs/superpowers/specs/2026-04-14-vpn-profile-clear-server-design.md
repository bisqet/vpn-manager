# VPN profile — clear server from VPN services — design

**Date:** 2026-04-14  
**Status:** Awaiting reader review  
**Scope:** `apps/server` (new teardown workflow + API route) and `apps/web` (`VpnsPage` edit modal). Complements `2026-04-14-3x-ui-api-ssh-setup-design.md` and current `setupPhases` / `setupRunner` behavior.

**Deployment note (2026-04-16):** **reverse proxy (historical)** steps below match **legacy** phased setup that this project **does not** target for new deployments; keep them only insofar as they mirror code still present on disk.

## Goal

Add a **“Clear server from VPN services”** control on the **Edit VPN profile** modal that **reverses what live Setup created** on the remote host (per operator choice **B — strong cleanup**) and returns the profile to a **pre-success** state in the database so **Setup** can run again.

## Non-goals

- Changing **UFW** rules or disabling UFW (explicitly out of scope for **B**).
- Removing **3x-ui** or **reverse proxy (historical)** if they were installed by means other than this app’s Setup (no fingerprinting beyond paths and lines this Setup created).
- Interactive SSH from the browser (unchanged; teardown is API-driven like Setup).
- Guaranteed idempotency on arbitrary manually broken servers; phases should be written to be **re-runnable** where practical, with clear errors when assumptions fail.

## Remote teardown (strong cleanup — option B)

Teardown runs as **ordered SSH phases** (same execution model as `executeProfileSetup`: per-phase timeout, capture stdout/stderr/exit code, stop on first failure).

Recommended **phase order** (implementation must preserve safe ordering, e.g. stop services before removing files):

1. **Stop and disable 3x-ui:** `systemctl disable --now` the unit used by Setup (today: **`x-ui`**). Remove **`/etc/systemd/system/x-ui.service`** if present (Setup copies it from the tarball). `systemctl daemon-reload`.
2. **Remove 3x-ui install tree:** `rm -rf /usr/local/x-ui` (matches Setup install location).
3. **Remove our reverse proxy (historical) site file:** **`/etc/caddy/conf.d/vpn-manager-3x-ui.caddy`** (path defined in `setupPhases`; keep in sync).
4. **Caddyfile import line:** If **`/etc/caddy/Caddyfile`** contains the **exact** line Setup appends — `import /etc/caddy/conf.d/*.caddy` — remove **one** occurrence of that line (document in UI/help that hand-edited `Caddyfile`s may need manual cleanup if the line no longer matches).
5. **Purge reverse proxy (historical):** non-interactive **`apt-get purge -y caddy`** (or equivalent supported on Ubuntu 24).
6. **Remove reverse proxy (historical) apt wiring added by Setup:** remove **`/etc/apt/sources.list.d/caddy-stable.list`** and **`/usr/share/keyrings/caddy-stable-archive-keyring.gpg`** (paths from Setup’s install script). Optionally run **`apt-get update`** afterward; not required for correctness if purge already ran.

**UFW:** no changes in any phase.

**Dry-run:** When **`VPN_SSH_ENABLED`** is false, the API returns **ordered teardown phases with script text** only (no SSH, no package changes, **no** database updates), mirroring Setup dry-run behavior. **Eligibility rules below apply only to the live path**; dry-run may return phases for any existing profile so operators can review scripts (same spirit as Setup dry-run).

## Database and eligibility

### When the action is allowed (live path)

- **`operational_status === 'working'`** — normal case: undo successful Setup.
- **`operational_status === 'pending'`** and **`last_setup_error` is non-null** — failed live Setup may have left services or packages on the host; teardown is allowed.

### When the action is rejected (live path)

- **`operational_status === 'pending'`** and **`last_setup_error` is null** — Setup never recorded a live failure; nothing to “clear” in the app’s contract. Respond with **400** and a clear message (e.g. nothing to clear / run Setup first).

### After full success (all phases exit 0)

Reset profile to match **never successfully set up**:

- `operational_status = 'pending'`
- `xui_secrets_ciphertext` / `xui_secrets_nonce` → **NULL**
- `xui_web_base_path` → **NULL**
- `last_setup_error` → **NULL**
- `last_setup_at` → update to teardown completion time (implementation choice: same column as “last remote maintenance” is acceptable)

**If any phase fails:** do **not** change the fields above (leave `working` or failed `pending` as-is); persist a concise **`last_setup_error`** (and timestamp) summarizing the failure, analogous to failed Setup.

## API

### `POST /api/profiles/:id/clear-server`

- **Auth:** same as other profile mutations.
- **Body:** empty JSON object or no body.
- **200:** `{ profile: <ProfileDto>, teardown: { mode: "dry-run" | "live", phases: PhaseResult[] } }` — shape mirrors setup responses (`id`, `title`, `script`, optional `stdout`/`stderr`/`code` per phase).
- **404:** unknown profile id.
- **400:** eligibility failure (`pending` without `last_setup_error`), or validation errors shared with Setup where applicable (e.g. missing **`panel_hostname`** if teardown requires it for script generation — prefer **not** requiring panel hostname for teardown if scripts only need host paths; **implementation:** omit panel from teardown scripts if unused).
- **503:** **`sshpass`** missing when live SSH would be used (same as Setup).
- **500 (optional body):** mid-run failure may include **`profile`** + partial **`teardown`** so the UI can open the same style of output sheet as failed Setup.

**Naming:** `clear-server` is canonical in this spec; minor path bikeshedding allowed in implementation if routes stay consistent.

## UI — Edit VPN profile modal

- **Visibility:** **Edit mode only** (not on “Add profile”).
- **Control:** secondary or **danger** styled button, label **“Clear server from VPN services”** (or shorter **“Clear server”** with subtitle/helper text explaining scope).
- **Confirmation:** mandatory **strong confirmation** before calling the API (browser `confirm` is acceptable if no existing pattern; prefer a short in-modal confirm if the app already uses one for destructive actions). Copy must warn: **HTTPS panel and 3x-ui will be removed** until Setup runs again; **UFW is not reverted**.
- **Disabled when:** request in flight for this action, profile save in flight, or other mutually exclusive mutations that could confuse state; **guest** users: match **SSH** / Setup gating (if Setup requires sign-in, this action does too).
- **After success:** invalidate profiles query, close modal or refresh in-modal fields so **Status** shows **Pending** and **Setup** reappears on the table.
- **Output:** on success or failure with phase payload, reuse the **Setup output sheet** pattern (title adapted for teardown) so operators see logs.

## Testing

- **Server:** route tests for eligibility, dry-run when SSH disabled, success path with mocked `sshExec` (all phases succeed → DB reset), failure path (phase nonzero → DB unchanged, `last_setup_error` set). Tests for **`buildTeardownPhases`** (or equivalent): expected phase ids, presence of key paths, and stable ordering.
- **Web:** `bunx tsc -b` in `apps/web` after types/API client updates.

## Files likely touched (implementation hint only)

- `apps/server/src/vpn/teardownPhases.ts` (new), `apps/server/src/vpn/teardownRunner.ts` (new) or merged runner module if duplication is too high.
- `apps/server/src/routes/profiles.ts`, `apps/server/src/routes/profiles.test.ts`
- `apps/web/src/pages/VpnsPage.tsx`

## Relation to existing Setup error message

Today **`POST .../setup`** may return **409** when **`working`**. Teardown is the supported path to return to **`pending`**; after a successful clear, **Setup** is allowed again.
