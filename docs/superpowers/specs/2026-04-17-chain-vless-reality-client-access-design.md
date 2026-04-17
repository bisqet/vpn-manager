# Chain client access — VLESS + REALITY (single hop) — design

**Date:** 2026-04-17  
**Status:** Approved for implementation planning  
**Depends on:** Existing VPN profiles with successful 3x-ui setup (`operational_status = working`, encrypted panel credentials, `panel_hostname` and optional `xui_web_base_path` / `xui_panel_port` as today).

## Summary

Chains today describe ordered VPN servers and optional **split routing** export (`vpn-manager.routing.v2.json`). This feature adds **client access** for the simplest topology: **user → one VPN hop → internet**, with **no routing rules** in scope for v1.

Operators use **Generate profile** on a chain. Each invocation **provisions new resources on the hop’s 3x-ui panel** (VLESS + REALITY, fixed template below) and opens a **modal** showing:

1. **VLESS share link** (`vless://…`) — copy for clients that accept share links.  
2. **Subscription URL** — copy for clients that import subscriptions.

The user picks whichever fits their client. **Each successful generation creates new panel-side objects**; nothing is persisted in VPN Manager SQLite for these inbounds in v1. **Future work:** profile management (reuse, revoke, list, cleanup).

## Goals (v1)

1. **Single-hop chains only:** If a chain has zero or more than one hop, the API returns a clear **4xx** error; the UI disables or hides **Generate profile** where practical.  
2. **Server-side config:** Create the required **VLESS + REALITY** inbound (and client material) on the **first hop’s** 3x-ui instance via the **panel HTTP API**, using stored admin credentials (same trust model as the rest of the app).  
3. **Fixed protocol template:**  
   - **VLESS** with **REALITY**  
   - **REALITY dest / server name:** `yahoo.com` (v1 constant; not operator-configurable)  
   - **Flow:** `xtls-rprx-vision`  
4. **Response to UI:** Return **both** `vlessShareLink` and `subscriptionUrl` strings for display and copy.  
5. **Modal UX:** Popup with two labeled fields and **Copy** actions; loading and error states consistent with the rest of the SPA.

## Non-goals (v1)

- Multi-hop aggregation (nested configs, per-hop client chains).  
- Routing rules, `routing_profiles`, or changes to `buildExportV2`.  
- Operator-configurable SNI, port, shortId, or Reality public key rotation from the UI.  
- Persisting inbound IDs, client IDs, or subscription tokens in the database.  
- Automatic deletion of previously generated inbounds (left to **future profile management**).  
- Opening firewall ports on the remote host beyond what the operator already configured for 3x-ui / Xray.  
- Browser-side calls to the VPN host or panel; **only the VPN Manager API** talks to the panel.

**Optional extension (implemented separately):** When **`app_settings.vpn_ssh_enabled`** is true and the operator has installed the **`vpnmgr-xui-ufw-sync`** script plus **`sudoers`** on the 3x-ui host (see `docs/superpowers/specs/2026-04-17-vpn-manager-3x-ui-ufw-sync-design.md`), **`POST …/generate-profile`** may open an **SSH** session only to run that fixed reconcile command after a successful panel **inbound** mutation. **Cloud security groups** remain operator-owned; client material is still obtained via the **panel HTTP API**, not by scraping Xray over SSH.

## Architecture

| Layer | Responsibility |
|--------|----------------|
| **`apps/server`** | New authenticated route under chains (exact path in implementation plan). Validates chain is single-hop and hop profile is **working**. Decrypts x-ui secrets. Calls a **small 3x-ui HTTP adapter** (login/session, create inbound + client, read share link and subscription URL). Returns JSON to the web app. |
| **`apps/web`** | **Generate profile** control on chain UI → `POST` → modal with two copy targets; handles errors. |
| **3x-ui (remote)** | Source of truth for inbound/client and subscription URL format. |

**Recommended approach:** **Panel HTTP API** for login, inbound creation, and client material (share link / subscription URL). **Optional SSH** is reserved for **UFW reconcile** when enabled in settings; it does not replace the panel API for Xray JSON.

## Data flow

1. User clicks **Generate profile** on a chain.  
2. Web calls VPN Manager API with session cookie (same auth as `GET /api/chains`).  
3. Server loads chain + hop + `vpn_profiles` row; validates **exactly one hop** and **working** profile with decryptable x-ui secrets.  
4. Server builds panel base URL from `panel_hostname`, port, and web base path (reuse existing URL-building helpers if present).  
5. Adapter performs panel login (or token flow per upstream), creates inbound + client matching the fixed template, retrieves **VLESS URI** and **subscription URL** as the panel exposes them.  
6. Server returns both strings; **does not** log full URLs or tokens.  
7. Web shows modal; user copies either value.

## Protocol template (v1 constants)

Implementation must encode these choices when calling the panel API / constructing inbound settings:

- **Protocol:** VLESS  
- **Security:** REALITY  
- **REALITY dest / sni (or equivalent):** `yahoo.com`  
- **Flow:** `xtls-rprx-vision`  
- **Listen port:** Use a single convention chosen at implementation time (e.g. **443** if compatible with existing install defaults and panel API); document in the plan if the codebase introduces a constant. Operators are responsible for ensuring the port is reachable and not conflicting on that host.

Exact JSON field names follow **MHSanaei/3x-ui** (or pinned version) API; the adapter isolates upstream churn.

## API contract (logical)

- **Method:** `POST`  
- **Path:** Under `/api/chains/:id/…` (final segment name to be chosen in implementation; e.g. `client-access` or `generate-profile`).  
- **Success (200):** `{ "vlessShareLink": string, "subscriptionUrl": string }`  
- **Errors:**  
  - Invalid id → **400**  
  - Chain not found → **404**  
  - Hop count ≠ 1 → **400** with explicit message  
  - Profile not `working`, missing secrets, or panel error → **409** or **502** / **503** with safe, non-leaky message body  

**Security:** Treat both returned strings as **secrets** in the UI (no logging in client devtools beyond what React already does); server logs must not contain full links.

## UI

- **Placement:** Inside the Chains experience, per chain (same row or detail panel as other chain actions).  
- **Control label:** `Generate profile`  
- **Behavior:** Disable while request in flight; on success open **modal** (existing modal overlay patterns preferred per project conventions).  
- **Modal contents:**  
  - Title e.g. “Client access”  
  - **VLESS share link** — read-only field + **Copy**  
  - **Subscription URL** — read-only field + **Copy**  
  - Dismiss control  

No requirement for QR codes or “open app” deep links in v1.

## Testing

- **Route / validation:** Unit or integration tests for hop count, missing chain, non-working profile (no outbound panel call in those cases if mocked at boundary).  
- **Adapter:** Tests against **HTTP mocks** (fixed responses) for happy path and typical panel error responses.  
- **E2E with live 3x-ui:** Optional manual checklist only; not required in CI.

## Operational notes

- Each generation may **accumulate** inbounds/clients on the panel until future cleanup features exist.  
- Operators must ensure **Xray listens** on the chosen port and network path allows clients to connect; VPN Manager does not configure `ufw` for this feature in v1.

## Future extensions (not in this spec)

- **Profile management:** list, reuse, revoke, delete panel objects; optional DB table linking `chain_id` to inbound/client ids.  
- Configurable Reality parameters and per-chain protocol templates.  
- Multi-hop: composite client config or separate doc for each hop.

## Self-review (2026-04-17)

- No `TBD` left; port choice is explicitly deferred to implementation with documentation.  
- Single-hop and “new each time” align with user approval.  
- Modal contents match user request (VLESS link + subscription URL).
