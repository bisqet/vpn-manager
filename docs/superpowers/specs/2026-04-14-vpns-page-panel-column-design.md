# VPNs table — panel URL and panel admin copy actions — design

**Date:** 2026-04-14  
**Status:** Approved for implementation pending reader review of this document  
**Scope:** After **Setup** succeeds (`operationalStatus === "working"`), the **VPNs** profile table shows a **Panel** column (HTTPS URL to the 3x-ui admin UI) and two **copy** actions for **3x-ui panel admin** username and password (generated during Setup, stored encrypted). Does **not** change which credentials SSH uses (still SSH user + stored SSH password).

## Goals

1. **Panel column:** For **working** profiles, show a **clickable HTTPS URL** that matches how setup verifies the panel (`https` + canonical host from `panelHostname` + path derived from `xui_web_base_path`, consistent with `buildSetupPhases` / verify in `apps/server/src/vpn/setupPhases.ts`).
2. **Copy panel admin username** and **copy panel admin password:** Icon-only controls in the table; values come from decrypted **`xui_secrets_*`** (same payload shape as today’s `encryptXuiSecretsJson` / `v: 1`).
3. **Security:** Never return decrypted panel secrets on **`GET /api/profiles`** (list). Never return **`panelUrl`** to **unauthenticated** callers (even when the profile is `working`), so anonymous clients do not learn the obscured path or TLS name from the list API.

## Non-goals

- Exposing **SSH** password or SSH user in new columns (existing “User” column remains SSH user only).
- **Reset / rotate** panel credentials or re-run setup for `working` profiles.
- **Rate limiting** the credentials endpoint (optional later).
- **Playwright** or other E2E tests unless the repo already adopts them for this area.

## Table behavior (web — `VpnsPage`)

- **Column order (default):** Insert **Panel**, **Panel user** (copy), **Panel password** (copy) **before** the **Status** column (between **User** and **Status**). Headers may be short (“Panel”, “User”, “Pass”) with full meaning in `aria-label` / `title`.
- **Pending profiles:** Panel link absent; copy buttons **disabled** or not shown; cell shows `—`.
- **Working + signed in:** Show link when `panelUrl` is non-null; copy buttons **enabled**.
- **Working + guest (no session):** No link; no copy; short hint consistent with existing **Sign in to SSH** pattern (e.g. “Sign in to open panel” / “Sign in to copy panel login”).
- **Panel cell:** `<a href={panelUrl} target="_blank" rel="noopener noreferrer">` — link text may be “Open” or a truncated display of host + path.
- **Copy interaction:** On click, call the credentials endpoint (see below), then `navigator.clipboard.writeText` for the chosen field. Show brief success feedback; on failure show a safe message (**no** secret in logs or UI). If clipboard API rejects after async work, show a generic “Copy failed” message.
- **Loading:** Disable copy buttons (and optionally set `aria-busy`) while a **per-profile** credential fetch is in flight; a **single** in-flight fetch per row is enough (first click loads; second click reuses cached response for that profile until navigation/refresh, optional optimization).

## API — list

### `GET /api/profiles`

- Extend each profile DTO with **`panelUrl: string | null`**.
- **Rules:**
  - **`null`** if `operationalStatus !== "working"` or required fields are missing.
  - **`null`** if the request has **no** valid session (same session mechanism as other authenticated routes — e.g. `getSessionUserId` + `SESSION_COOKIE`).
  - When session is valid and the profile is `working`, compute **`panelUrl`** on the server using a **shared helper** (same semantics as verify URL construction) so setup scripts and API never drift.

**Note:** Existing tests allow unauthenticated list; they remain valid if anonymous responses always have **`panelUrl: null`**.

## API — panel login material

### `GET /api/profiles/:id/panel-login` (exact path may be adjusted in implementation if routing prefers a different suffix; behavior is normative)

- **Auth:** Valid session **required** → **401** without session (align with **`GET /api/profiles/:id/ssh`** style gates).
- **404** if profile id invalid or row missing.
- **409** if profile is not **`working`**, or encrypted secrets / base path are missing or cannot be decrypted.
- **200** JSON body, e.g. `{ "panelUrl": string, "adminUsername": string, "adminPassword": string }` — **all three** so one round-trip supports both copy buttons and keeps URL consistent with list logic.
- **Server:** Decrypt with **`decryptXuiSecretsJson`** and **`masterKey`**; validate decrypted payload shape (`v: 1`).
- **Observability:** Do **not** log decrypted values or response bodies for this route.

## Testing

- **Server (`profiles.test.ts` or adjacent):**
  - **`panel-login`:** 401 without cookie; 404 unknown id; 200 returns expected username/password (and `panelUrl`) for a **`working`** row with known encrypted fixtures or post-setup DB state; error when not `working` or secrets missing.
  - **List:** Anonymous **`GET /api/profiles`** → **`panelUrl`** is **`null`** for a `working` profile; with valid session → **`panelUrl`** matches the shared URL builder for known `panel_hostname` + `xui_web_base_path`.
- **Web:** Typecheck **`bunx tsc -b`** in `apps/web` after type updates. Optional unit test only if a **pure** `buildPanelUrl` is extracted to a shared module.

## Implementation notes

- **Shared URL builder:** Lives in **`apps/server`** (e.g. next to `net/panelAddress.ts` or imported by `setupPhases` and routes) so **verify** and **API** share one implementation.
- **Types:** Extend the web client’s **`VpnProfile`** type with optional **`panelUrl`**; add a small fetch helper for **`panel-login`**.
