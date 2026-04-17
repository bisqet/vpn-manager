# Multi-hop chain client access — VLESS + REALITY + vision — design

**Date:** 2026-04-17  
**Status:** Draft pending stakeholder review of this file  
**Related:** `docs/superpowers/specs/2026-04-17-chain-vless-reality-client-access-design.md` (single-hop v1; this document **extends** client access to **n ≥ 1** hops and supersedes that spec’s **non-goal** item “Multi-hop aggregation” for the **Generate profile** feature.)

## Summary

Chains are ordered VPN profiles (`chain_hops`). **Generate profile** shall work for **any chain with at least one hop**, not only single-hop chains.

**User-facing client material** is always anchored on **hop 1** (same response shape as today: **`vlessShareLink`** and **`subscriptionUrl`** for a **new** inbound on hop 1’s 3x-ui). Traffic path: **user → hop 1 → hop 2 → … → hop n → internet**.

**Inter-hop segments** use the **same protocol template** as the user leg: **VLESS + REALITY** with REALITY dest / server name **`yahoo.com`** and client flow **`xtls-rprx-vision`**. Each segment is provisioned as **new** panel-side objects per generation; nothing is persisted in VPN Manager SQLite for these objects in this version (same accumulation model as single-hop v1).

**Outbound dial address** from hop *k* to hop *k*+1: use **`panel_hostname`** trimmed when non-empty; otherwise use **`host`** (the SSH / server host field).

## Goals

1. **Multi-hop Generate profile:** If a chain has **n ≥ 1** hops, the API may succeed when all validation and panel steps succeed; **n = 1** remains the existing behavior in spirit (one inbound on the sole hop, returned links).
2. **All hops must be provisionable:** Every hop’s `vpn_profiles` row must be **`operational_status = working`** with decryptable **x-ui secrets** and a usable **panel HTTPS base URL** (same bar as today’s single-hop route).
3. **End-user entry only on hop 1:** Success response returns **only** hop 1’s **VLESS share link** and **subscription URL** for the newly created user-facing inbound.
4. **Forwarding:** Hops **2…n** each receive a **new** VLESS+REALITY+vision **inbound** intended for traffic from the **previous** hop. Hops **1…n−1** are configured so traffic from the appropriate inbound is forwarded via an **outbound** to the next hop, using parameters matching the inbound created on the next hop. Hop **n** sends onward traffic **direct** to the internet (default forward, not through another VPN Manager–defined hop).
5. **Fixed template:** Same constants as single-hop v1 for REALITY target/SNI (**`yahoo.com`**) and flow (**`xtls-rprx-vision`**), unless a later spec explicitly parameterizes them.

## Non-goals

- Integration with **routing export** (`buildExportV2`, `routing_profiles`, rules) for this client path.
- **SQLite persistence** of inbound IDs, client IDs, subscription tokens, or mapping from `chain_id` to panel objects.
- **Automatic deletion** or reuse of previously generated inbounds (future “profile management”).
- **Operator-configurable** SNI, port template, or flow from the UI.
- **Chains that repeat the same VPN profile** (already prevented by `UNIQUE (chain_id, vpn_profile_id)`).
- **Browser-side** calls to panels or VPN hosts; only **`apps/server`** calls panels.

## Architecture

| Layer | Responsibility |
|--------|----------------|
| **`apps/server`** | Extend **`POST /api/chains/:id/generate-profile`**: validate chain and **every** hop’s profile; orchestrate **sequential** (v1) panel work: create downstream-facing inbounds on hops **2…n**, create **user** inbound on hop **1**, then apply **outbound + routing** on hops **1…n−1** so inbounds chain to the next hop; hop **n** routes inbound traffic **direct**. Return hop **1** URLs. |
| **`apps/web`** | Enable **Generate profile** when **all** hops in the chain are **working** (not only `hops.length === 1`). Modal and copy UX unchanged. |
| **3x-ui (remote)** | Source of truth for inbound/client/subscription formatting; must expose sufficient API (or supported equivalent) to attach **outbounds** and **routing** after **inbounds/add**—see **Risks**. |

**Preferred mechanism:** **Panel HTTP API only**, consistent with existing `provisionChainClientAccess` and inbound builders. **Fallback** (only if spike proves API insufficient): documented **SSH + Xray config** merge is out of scope for this design unless a follow-up explicitly adds it.

## Data flow

1. User clicks **Generate profile** on a chain with hops **1…n**.
2. Web calls VPN Manager API (session auth unchanged).
3. Server loads ordered hops and each hop’s `vpn_profiles` row; rejects if any hop is not **working**, secrets cannot be decrypted, or panel base URL cannot be built.
4. **Phase A — downstream inbounds:** For *i* = **2** to **n**, log into hop *i*’s panel and create a **new** VLESS+REALITY+vision inbound (new key material and client UUID per inbound). Record all parameters needed for the **previous** hop’s outbound (public key, shortId, client id, listen port, etc.).
5. **Phase B — user inbound:** On hop **1**, create the **user-facing** inbound (same template). This inbound’s **`subId`** / share material drives the **JSON response**.
6. **Phase C — forwarding:** For *i* = **1** to **n−1**, on hop *i*’s Xray configuration (via panel API), ensure traffic from the **correct inbound** (user inbound on hop 1; “from previous hop” inbound on hops **2…n−1** when *i* > 1) uses an **outbound** to hop *i*+1 at address **`panel_hostname` if non-empty else `host`**, with port and REALITY client settings matching hop *i*+1’s inbound from Phase A.
7. **Phase D — last hop:** On hop **n**, ensure traffic accepted on the **chain** inbound is routed **direct** (not to another managed hop).
8. Server returns **`{ vlessShareLink, subscriptionUrl }`** for hop **1** only. Server logs must not contain full URLs or secrets.

## Ports

- **Hop 1 user inbound:** Keep the existing convention of **443** when compatible with the host (same as current single-hop implementation unless the plan documents a change).
- **Hops 2…n:** Each inbound requires a **listen port** on its own host; default **443** per host is typical when each hop is a **different machine**. If **443 is unavailable** on a host, behavior must be **deterministic and documented** in the implementation plan (e.g. list inbounds and select a free port from an allowed range, or return **409** with a clear operator-facing message). The design does not mandate a specific algorithm here beyond **no silent arbitrary guess** without documentation.

## API contract (logical)

- **Method:** `POST`  
- **Path:** `/api/chains/:id/generate-profile` (unchanged).  
- **Success (200):** `{ "vlessShareLink": string, "subscriptionUrl": string }` — always from **hop 1**’s newly created user inbound.  
- **Errors:**  
  - Invalid id → **400**  
  - Chain not found → **404**  
  - Empty chain → **400**  
  - Any hop not **working**, missing secrets, missing usable panel URL → **409**  
  - Port conflict or panel constraint that prevents completing the chain → **409** with a clear, non-leaky message  
  - Panel or transport failure → **502** / **503** with safe message  

**Security:** Treat returned strings as secrets; do not log them server-side.

## UI

- **Generate profile** visible when **every** hop’s profile in the chain is **`working`** (and other client-side gating consistent with single-hop patterns).
- **Modal:** Unchanged: **VLESS share link** + **subscription URL** + copy actions.

## Testing

- **Route / validation:** Chains with **n = 1, 2, 3**; failure when any hop is non-working; failure when panel URL missing; stable ordering of hops by `position`.
- **Orchestration:** HTTP-mocked panel responses; assert **call order** and payloads for multi-hop (inbounds on 2…n before outbound wiring from 1…n−1).
- **Dial address rule:** Cases where `panel_hostname` is set vs empty (fallback to `host`).
- **Live 3x-ui:** Optional manual checklist only.

## Operational notes

- Each successful generation may **accumulate** multiple inbounds across involved panels until future cleanup features exist.
- Operators must ensure **network reachability** between consecutive hops (hop *i* must be allowed to open outbound connections to hop *i*+1’s published port) and that **firewall** rules permit those paths.

## Risks

- **3x-ui / Xray outbound and routing configuration** via HTTP API is the **critical dependency**. Implementation must begin with an **upstream source review** (3x-ui routes/controllers) and a minimal **spike** proving we can set **default routing** from a given **inbound** to a **VLESS+REALITY outbound** to the next hop. If this is impossible without unsupported hacks, stop and revise the approach (e.g. explicit SSH-based phase in a separate spec) rather than shipping half-wired inbounds.

## Self-review (2026-04-17)

- No `TBD` placeholders; port conflict handling is explicitly delegated to the implementation plan with constraints (deterministic, documented).  
- Aligns with stakeholder choices: **single user entry (A)**, **same template for inter-hop (A)**, **dial address `panel_hostname` else `host` (C)**.  
- Scope is bounded: no DB persistence, no export integration, no cleanup.  
- **Ambiguity resolved:** Response remains hop **1** only; last hop is **direct** to internet.
