# Bare IP (and FQDN) panel TLS — design

**Date:** 2026-04-14  
**Status:** Approved for implementation planning  
**Scope:** VPN profile `panel_hostname` semantics, API validation (`apps/server/src/types.ts`, `apps/server/src/routes/profiles.ts`), web form (`apps/web/src/pages/VpnsPage.tsx`), remote setup scripts (`apps/server/src/vpn/setupPhases.ts`), setup preconditions (`apps/server/src/vpn/setupRunner.ts`), and tests.

**Deployment note (2026-04-16):** This workspace’s **product intent** is **not** to use **reverse proxy (historical)**. Validation and URL-building in this spec remain relevant; Caddyfile / reverse proxy (historical) ACME language below reflects an **earlier phased-setup** model and must **not** be read as requiring reverse proxy (historical) for TLS going forward.

## Goal

1. Allow the **panel TLS identifier** (stored in `panel_hostname`) to be either a **FQDN** (current behavior) **or** a **public IPv4 / public IPv6** literal, so reverse proxy (historical) can obtain and serve certificates appropriate to that identifier (including **Let’s Encrypt IP certificates** where supported by the installed reverse proxy (historical) and CA policy).
2. When **SSH `host` is a public IP literal**, allow **omitting** `panelHostname` on create/update; the server **sets `panel_hostname` from `host`** (normalization applied). When **`host` is not** a public IP literal, **`panelHostname` is required** and must be a **FQDN or public IP** (never derived from a non-public `host`).
3. **No DNS resolution** of `host` for derivation: only **syntactic** classification of `host` as a public IP. A **hostname** SSH target never auto-fills the panel field, even if it publicly resolves.

## Non-goals

- Supporting **private-IP-only** HTTPS or ACME inside LANs without a public identifier.
- Changing **SSH** connection semantics (`host` may remain hostname, IP, or other forms accepted today).
- **Guaranteeing** ACME success for every IP or network; only **shaping config and validation** so the happy path is possible when reverse proxy (historical) + CA support IP identifiers on the server.
- Renaming the **database column** `panel_hostname` (optional UI copy only).

## Product / UX

- Field label (web): **“Panel address (FQDN or public IP)”** (exact copy may vary slightly in implementation).
- Help text: required **unless** SSH host is entered as a **public IP**, in which case the field may be left empty and the panel address defaults to that IP after save.
- If SSH host is **not** a public IP and panel is empty → **validation error** explaining that a panel FQDN or public IP is required.

## Data model

- **Column:** `vpn_profiles.panel_hostname` `TEXT` — stores **either** a FQDN **or** an IP string in **canonical** form for literals (**IPv6:** normalize to **RFC 5952**; must be **consistent** between DB, Caddyfile site key, and `curl` verify URL).
- **No migration** required for schema shape; existing FQDN values remain valid.

## API and validation rules

### Shared concepts

- **`isPublicIpLiteral(value: string): boolean`** (or equivalent): **true** only for **public** IPv4/IPv6 literals after parse. **False** for hostnames, private ranges (RFC1918, ULA, loopback, link-local, multicast, documentation, CGNAT / `100.64.0.0/10`, etc.), and malformed strings.
- **FQDN:** reuse existing rules (regex / Zod) for values that are **not** accepted as IP literals first (order: if parse as IP, use IP branch; else FQDN branch).

### Create (`POST` profile)

- **`panelHostname`:** optional (empty string or omit treated as “missing” after trim).
- If **missing:** require **`host`** (trimmed) to satisfy **`isPublicIpLiteral(host)`**; then **`panel_hostname := normalizeIp(host)`**. Otherwise **400** with a clear message (panel required).
- If **present:** must satisfy **FQDN schema OR `isPublicIpLiteral`**; store normalized IP if IP.

### Update (`PATCH` profile)

- Compute **merged** `host` and `panel_hostname` (patch fields override existing; omitted patch fields keep existing).
- Let **`p`** = trimmed merged panel value, **`h`** = trimmed merged host.
- If **`p` is non-empty:** validate as FQDN **or** `isPublicIpLiteral(p)`; persist normalized IP if applicable.
- If **`p` is empty:** require **`isPublicIpLiteral(h)`**; persist **`panel_hostname := normalizeIp(h)`**. Otherwise **400** (panel required).

### Setup runner

- Reuse **non-empty** `panel_hostname` check; after this change, “empty” remains invalid; “filled with IP” is valid.
- No change to **dry-run vs live** split beyond accepting IP-shaped panel values.

## Remote setup (`setupPhases`)

- **reverse proxy (historical) site block:** emit the site address reverse proxy (historical) expects:
  - **FQDN:** `example.com { ... }` (unchanged).
  - **IPv4:** `203.0.113.1 { ... }`.
  - **IPv6:** bracketed form if required by reverse proxy (historical) for site keys (e.g. `[2001:db8::1] { ... }`) — **must be verified against Caddyfile documentation** for the minimum reverse proxy (historical) version we support.
- **Global / `tls` options:** if Let’s Encrypt **IP certificates** require a **short-lived / ACME profile** in reverse proxy (historical), add the minimal global or site-level directives **documented for that reverse proxy (historical) release** during implementation (do not guess unsupported directives in this spec).
- **Verify phase:** `curl` to `https://<panel>/...` with correct URL host formatting (**IPv6 URL host must use `[]`**).

## Runtime assumptions (ops)

- Target VPS **reverse proxy (historical)** package must be **new enough** to cooperate with **Let’s Encrypt IP issuance** (IP certs are **short-lived**; renewal must succeed on a short cadence). Implementation phase should record **minimum tested reverse proxy (historical) version** in code comments or AGENTS.md if needed.
- **Ports 80/443** remain required for the default ACME path unless we later add alternatives.

## Testing

- **Server Zod / route tests:** create and patch matrix: public IP `host` + empty panel → stored panel equals normalized IP; private `host` + empty panel → error; FQDN panel + various `host`; explicit IP panel; invalid literals; IPv6 cases.
- **`setupPhases.test.ts`:** assert generated snippets for **FQDN**, **IPv4**, **IPv6** site blocks and verify `curl` line.
- **`setupRunner`:** ensure `panel_hostname_required` only when truly empty after API layer (API should not persist empty when derivation applies).

## Files likely touched (implementation hint)

- `apps/server/src/types.ts` — optional `panelHostname`, refine with `host`, IP/FQDN union.
- `apps/server/src/routes/profiles.ts` — merge logic on patch, error messages.
- `apps/server/src/vpn/setupPhases.ts` — Caddyfile + verify URL formatting.
- `apps/web/src/pages/VpnsPage.tsx` — validation, labels, optional empty panel when host is public IP (client may **prefill** for convenience; server remains source of truth).
- `apps/server/src/routes/profiles.test.ts`, `apps/server/src/vpn/setupPhases.test.ts`.
- Possible small shared module e.g. `apps/server/src/net/publicIp.ts` for `isPublicIpLiteral` / normalize (single source of truth).

## Relation to prior specs

- Older specs that say “FQDN only” for panel are **superseded** for panel identity by this document where they conflict.
