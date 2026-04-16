# 3x-ui subscription URI path hardening — design

**Date:** 2026-04-16  
**Status:** Approved for implementation planning (design approved in chat)  
**Scope:** Automated setup must set **non-default** 3x-ui subscription paths so the panel **Settings** page does not show insecure-path alerts for **`/sub/`** or **`/json/`**. Covers **phased tarball setup** (`buildSetupPhases` in `apps/server/src/vpn/setupPhases.ts`) and **browser install.sh setup** (`runInstallShSetupSession` in `apps/server/src/vpn/runInstallShSetupSession.ts` + `profileSetupTerminalBridge` persistence unchanged except outcomes).

## Background

3x-ui warns when subscription features use well-known defaults: if subscription is enabled and the effective classic path equals **`/sub/`**, it shows an alert; if JSON subscription is enabled and the path equals **`/json/`**, it shows a similar alert (see `web/html/settings.html` `confAlerts` logic in upstream). Defaults are seeded in the panel DB (`subPath`, `subJsonPath` keys). The public **`x-ui setting`** CLI does **not** expose flags for these keys, so automation must use another mechanism.

## Goals

1. After **successful** automated setup, **`subPath`** is **not** the default **`/sub/`** (use a random, URL-path-safe segment with leading and trailing `/`, matching upstream shape e.g. `/<segment>/`).
2. After successful setup, **`subJsonPath`** is **not** the default **`/json/`**, with the same formatting rules, **even if** JSON subscription is currently disabled (proactive hardening).
3. Generated **classic** and **JSON** path segments are **independent** and **distinct from each other** and from **`webBasePath`** (avoid operator confusion).
4. If hardening fails, setup must **not** complete as success with defaults still in place (fail the run with a clear error).

## Non-goals

- Persisting subscription path segments in **VPN Manager** SQLite (`vpn_profiles`) unless a later feature needs them (YAGNI).
- Changing 3x-ui **subscription port**, **TLS**, **subURI** full-URL overrides, or inbound/client subscription IDs.
- Supporting **non-Linux** DB paths (Windows targets are out of scope for this product flow).
- Verifying subscription HTTP responses on port **2096** in v1 (optional follow-up).

## Recommended approach

**Direct SQLite update while `x-ui` is stopped:** `systemctl stop x-ui`, run `sqlite3` against **`/etc/x-ui/x-ui.db`** (upstream `config.GetDBPath()` on Linux), `UPDATE` the `settings` table rows where **`key`** is **`subPath`** and **`subJsonPath`**, then `systemctl start x-ui` and confirm service active.

**Rejected alternatives:** panel HTTP API (session and payload fragility); forking upstream solely for CLI flags (maintenance cost).

## Path generation

- Reuse the **same character set and length rules** already used for **`webBasePath`** and admin secrets where applicable: **shell-safe** (e.g. **`[a-zA-Z0-9]+`** with documented minimum length consistent with existing generators).
- Normalize stored values to **`/<segment>/`** (leading and trailing slash), avoiding **`/sub/`** and **`/json/`** exactly.

## Phased setup (`buildSetupPhases`)

- Extend **`configure_xui`** or add a **small following phase** that:
  1. Stops **`x-ui`**.
  2. Ensures **`sqlite3`** is available (install via `apt-get` if missing, consistent with **`ufw`** phase style).
  3. Runs **`UPDATE`** statements; require each update to affect exactly **one** row (e.g. `sqlite3` with `changes()` / `SELECT changes()` pattern or equivalent guard); on mismatch, exit non-zero with stderr explaining subscription path hardening failure.
  4. Starts **`x-ui`**, waits for active state, preserves existing **panel loopback** `curl` verification.
- **Dry-run** script text must mention subscription path hardening and show **placeholders** or the same interpolation pattern as other generated secrets (`<GENERATED_…>`) for the two segments.

## Install.sh setup (`runInstallShSetupSession`)

- After credentials are obtained and **before** returning success, send a **bash block** on the **same PTY** that performs the same **stop → sqlite → start** sequence using **server-generated** segments.
- Wait for completion using an **explicit marker line** in PTY output (same pattern as existing recover / install automation markers).
- On hardening failure, return **`outcome: "failed"`** with a reason string that mentions subscription paths so **`persistInstallSessionResult`** does not mark the profile **`working`**.

## Runtime assumptions

- Panel database path **`/etc/x-ui/x-ui.db`** and table shape compatible with upstream **`model.Setting`**. GORM’s default table name for that model is **`settings`** with columns **`key`** and **`value`**; implementation should confirm once against a live 3x-ui DB (`sqlite_master` / `.schema`) and fail loudly if the file or expected rows are missing.
- **Root** (or equivalent) on the target host, consistent with existing setup scripts.

## Error handling

- Missing DB file, **`sqlite3`** errors, or **`UPDATE`** affecting zero or multiple rows → **non-zero** exit / failed install outcome; message should name **subscription URI hardening** so operators can search logs.

## Testing

- **`setupPhases.test.ts`:** assert generated scripts contain non-default paths, correct DB path, **`systemctl stop`/`start`**, and **`UPDATE`** for both keys; placeholder behavior for dry-run strings.
- **`runInstallShSetupSession.test.ts` (and driver tests as needed):** success path includes post-install hardening script + marker; failure path when marker missing or sqlite errors.
- Avoid brittle full-script snapshots; prefer **targeted substring** or structured assertions.

## Files likely touched (implementation hint)

- `apps/server/src/vpn/setupPhases.ts` — context fields / placeholders / remote script.
- `apps/server/src/vpn/setupPhases.test.ts`
- `apps/server/src/vpn/runInstallShSetupSession.ts` — post-success PTY hardening.
- `apps/server/src/vpn/runInstallShSetupSession.test.ts`
- Possible small shared module for **path segment generation** if duplication would otherwise diverge.
