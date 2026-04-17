# VPN server modal: Advanced panel fields, persisted credentials, async reachability

## Goals

- Simplify the default **Add VPN server** / **Edit VPN server** flow by moving **Panel address (FQDN or public IP)** and its helper text into a collapsed **Advanced** section.
- In **Advanced**, allow optional **Panel login** and **Panel password**, persisted **encrypted** on the server (same `xui_secrets_*` payload shape as today: `{ v: 1, adminUsername, adminPassword }`).
- After create or when panel-related fields change on update, run a **non-blocking** reachability check from the server and expose the outcome in the **VPNs** table status area (alongside Pending / Working).

## Non-goals (v1)

- Proving that stored admin credentials are valid (no 3x-ui login/API probe in v1).
- Changing **`GET /api/profiles/:id/panel-login`** eligibility rules (`operational_status === "working"` remains as today).
- Replacing or duplicating full **Setup** / install flows.

## UI

### Advanced disclosure

- Add an **Advanced** control (e.g. `details`/`summary` or a button that toggles a region) on the server modal in `VpnsPage.tsx`.
- **Collapsed by default** for both create and edit.

### Fields inside Advanced

1. **Panel address (FQDN or public IP)** — moved from the main form; same validation rules as today (required unless **IP or Host** is a public IP literal).
2. **Panel login** and **Panel password** — optional as a pair: either both empty or both non-empty after trim.
3. **Panel web base path** (optional) — when the operator knows it (e.g. `/abc123/`). Trim; if non-empty, normalize to include a leading `/` where appropriate to match how `xui_web_base_path` is stored after setup. Used to build the HTTPS URL for probing (and aligns with future URL building).
4. **Panel HTTPS port** (optional) — integer 1–65535. Persist in `xui_panel_port` when provided; when omitted, store **NULL** and use default port **443** for the async probe and for `buildPanelHttpsUrl` when a web base path exists (consistent with existing `NULL` port semantics).

### Edit mode

- Pre-fill panel address and optional path/port from the profile DTO as available.
- **Do not** pre-fill panel password from the API (secrets are not returned). Empty panel password on submit means **do not change** stored panel secrets; non-empty replaces the encrypted blob (same pattern as SSH password on PATCH).

### VPNs table status

- Show panel reachability alongside existing **Pending** / **Working** labels, e.g. **Panel: checking…**, **Panel: OK**, **Panel: unreachable**, **Panel: not checked** (exact strings are implementation details; keep concise).
- Use a short **tooltip** (e.g. `title`) with `panel_reachability_detail` when state is unreachable or when useful for debugging timeouts.

## API

### Request bodies

- **`POST /api/profiles`** (`vpnProfileCreate`): add optional `panelAdminUsername`, `panelAdminPassword` (pair rule). Add optional `panelWebBasePath` (string) and `panelHttpsPort` (number) as above.
- **`PATCH /api/profiles/:id`** (`vpnProfileUpdate`): same optional fields; empty strings for passwords mean “omit from update” per existing conventions.

### Responses

- Extend the profile DTO returned by list and create/patch with:

  - `panelReachability`: `"unknown" | "checking" | "reachable" | "unreachable"`.
  - `panelReachabilityDetail`: `string | null` (short human-readable reason; safe to show to authenticated admins).
  - `panelReachabilityCheckedAt`: ISO string or `null`.

- Never return panel admin password (or SSH password) in JSON.

### Scheduling rule

- After **successful** create, or **successful** patch that changes any of: `panel_hostname`, `xui_web_base_path`, `xui_panel_port`, or panel admin secrets — set `panel_reachability` to **`checking`**, commit, return response, then **schedule** the async probe for that profile id.
- If a patch does not touch panel-related fields, do not reset reachability (unless product later wants “re-check” button; out of scope).

## Async reachability probe (server)

### Execution model

- **Asynchronous** relative to the HTTP handler: respond to the client without waiting for the probe to finish.
- Use an in-process fire-and-forget task (e.g. `void runPanelReachabilityProbe({ db, env, profileId })`) started **after** the transaction that persists the profile succeeds.
- The probe loads the current row by `profileId`. If `panel_hostname` is missing or blank after trim, set **`unreachable`** with detail and stop.
- Otherwise build a probe URL: when `xui_web_base_path` is non-null and non-empty, prefer the same semantics as **`buildPanelHttpsUrl`** (hostname, path, port). When `xui_web_base_path` is null or empty, probe **`https://{host}{portSuffix}/`** (default port **443** when `xui_panel_port` is null) so reachability can still run before a base path is known; this may false-negative for panels that only respond under a secret path until the operator fills **Panel web base path**.
- Use **`fetch`** with **AbortSignal** timeout (recommended **3–5 seconds**), bounded behavior, normal TLS verification. Classify outcomes:
  - **reachable:** TLS succeeds and HTTP status is “up” in the v1 sense (e.g. 2xx, 3xx, 401, 403 — not connection errors).
  - **unreachable:** DNS failure, connection refused, timeout, TLS failure, or other network errors; store a short detail string.
- On completion, `UPDATE` `panel_reachability`, `panel_reachability_detail`, `panel_reachability_checked_at`, and `updated_at`.
- If the probe is **superseded** (e.g. second patch schedules another run), last-writer-wins is acceptable for v1; optional in-memory guard against duplicate concurrent probes for the same id may be added if easy.

### Initial and legacy rows

- Migration backfills existing profiles to **`unknown`** with `null` detail and `null` checked_at (or checked_at unchanged).
- Optionally trigger a one-time probe for existing rows is **out of scope**; only new writes and relevant patches set **`checking`**.

## Persistence and schema

- Reuse **`xui_secrets_ciphertext` / `xui_secrets_nonce`** when both panel admin fields are provided; leave them **NULL** when the pair is omitted (unchanged on PATCH when omitting).
- Allow setting **`xui_web_base_path`** and **`xui_panel_port`** on create/patch when the client sends optional advanced values (still overwritten by successful setup when the installer produces new values).
- Add columns to **`vpn_profiles`** (via existing migration mechanism alongside `schema.sql`):

  - `panel_reachability` TEXT NOT NULL DEFAULT `'unknown'` with CHECK constraint allowing `unknown`, `checking`, `reachable`, `unreachable`.
  - `panel_reachability_detail` TEXT NULL.
  - `panel_reachability_checked_at` TEXT NULL (ISO datetime string consistent with other columns).

## Interaction with setup

- When live setup completes successfully, today’s logic continues to set **`operational_status`**, **`xui_secrets_*`**, **`xui_web_base_path`**, **`xui_panel_port`**, etc. Implementation should either:
  - set `panel_reachability` to **`checking`** and schedule a new probe after setup success, or
  - set **`reachable`** optimistically and still schedule a probe — **recommended:** set **`checking`** and schedule one probe so the UI reflects post-install connectivity without extra spec.

## Testing

- **Unit tests:** URL construction inputs for the probe; outcome classification with mocked `fetch`.
- **Route tests:** POST with optional panel secrets sets ciphertext; response includes `panelReachability: "checking"` before probe completes; after awaiting probe helper in test (inject mock or flush microtasks as appropriate for Bun), row shows `reachable` or `unreachable`.
- **Web:** Manual or light automated check that Advanced toggles, create returns quickly while UI shows **checking** then updates on refetch (TanStack Query `refetchInterval` while any profile is `checking` is an acceptable approach; document in plan).

## Security

- Panel admin password only in transit to **`POST`/`PATCH`** over the app’s existing authenticated HTTPS and stored encrypted at rest.
- Probe runs **server-side** only; no new endpoint exposes secrets.
- Keep detail strings free of response bodies that might contain secrets.

## Deferred follow-ups

- Authenticated / 3x-ui–specific probe using stored admin credentials.
- Explicit **“Re-check panel”** control outside create/patch.
