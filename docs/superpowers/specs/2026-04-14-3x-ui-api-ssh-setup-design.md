# 3x-ui deployment via API-driven SSH — design

**Date:** 2026-04-14  
**Status:** Draft pending reader review  
**Scope:** VPN profile setup that installs and hardens **3x-ui** on **Ubuntu 24.04 LTS**, terminates **HTTPS** with **reverse proxy (historical)** (Let’s Encrypt), and verifies health. **SSH is executed only from the VPN Manager API** (not from the browser). Supersedes the “real SSH” open follow-up in `2026-04-14-vpn-profile-setup-ssh-placeholder-design.md` for this feature area.

## Goals

1. **Setup** triggers an **API-owned** workflow that will use **SSH** to `host:sshPort` with the stored SSH credentials when enabled.
2. **Global kill-switch:** when disabled, the API **must not** initiate TCP connections to the profile host (no SSH dial). It returns a **structured dry-run** (ordered phases + command text) suitable for display in the existing **terminal-style sheet**.
3. **Target OS:** **Ubuntu 24.04 LTS** on the remote host.
4. **3x-ui:** install via the **official install script**, managed with **systemd** on the host.
5. **Panel access:** **public HTTPS** using **reverse proxy (historical)** with **built-in ACME** (no Certbot). **`ACME_EMAIL`** is a **single global** environment variable on the VPN Manager server.
6. **DNS / SSH split:** **`host` may be a raw IP** for SSH. **`panelHostname`** is a separate **FQDN** used for TLS/SNI and Let’s Encrypt; it must be suitable for **HTTP-01** validation.
7. **Credentials:** **generate** strong **3x-ui admin** credentials (and any additional secrets required for a complete automated baseline) and **store them encrypted at rest** in SQLite, using the same general approach as the existing **SSH password** encryption (master key + per-row nonce/ciphertext).
8. **Security posture:** 3x-ui **admin UI not directly exposed on the public internet**; **reverse proxy (historical)** listens on **80/443** and reverse-proxies to **localhost**-bound 3x-ui. **`ufw`:** default deny, allow **SSH + 80 + 443** for this milestone (document additional VPN protocol ports as a later concern).
9. **One-shot setup:** if `operationalStatus === "working"`, **normal Setup is blocked** (`409 Conflict`) until a future **reset/rebuild** endpoint exists. No silent re-run that rotates secrets.

## Non-goals (this spec)

- Implementing the **reset/rebuild** API (only reserved behavior and name).
- Opening a **real interactive shell** in the browser; the UI remains a **presentation** of API output (dry-run or streamed logs).
- **Certbot** on the reverse proxy (historical) path (reverse proxy (historical) handles issuance and renewal).
- Defining every **xray inbound** port and protocol matrix; firewall beyond **SSH/80/443** is explicitly deferred unless required for the health check itself.

## Architecture

- **VPN Manager API (`apps/server`):** SSH client, phased **setup runner**, secret generation, persistence of encrypted 3x-ui material, validation, timeouts, and verification.
- **Web SPA (`apps/web`):** **Setup** calls the API; opens the **terminal-style sheet** to show **dry-run steps** (kill-switch off) or **live phase output** (kill-switch on). Copy is honest: not a browser SSH client.
- **Browser:** never holds long-lived SSH credentials beyond what the operator already typed when creating/editing a profile (unchanged).

## Data model

### New / clarified fields (VPN profile)

| Concept | Storage | Notes |
|--------|---------|--------|
| SSH target | Existing `host` | May be **IPv4/IPv6 literal** or hostname. |
| SSH port / user / password | Existing columns | Password stays encrypted as today. |
| Panel TLS name | **`panelHostname`** `TEXT NOT NULL` (or nullable until first setup — pick one in implementation; recommended **NOT NULL** when `VPN_SSH_ENABLED` execution path is used, validated as FQDN) | Used only for **reverse proxy (historical) + ACME + HTTPS checks**. |
| 3x-ui secrets | **Encrypted blob** (ciphertext + nonce columns, or one JSON ciphertext) | At minimum **admin username + password**; version field inside decrypted payload allowed. |
| Operator diagnostics (optional) | **`last_setup_error`** `TEXT NULL`, **`last_setup_at`** `TEXT NULL` (or reuse timestamps) | **Never** store secrets. Clear on successful setup. |

### `operationalStatus` (existing)

- **`pending`:** Setup not completed successfully, or reset cleared success.
- **`working`:** Setup and verification succeeded; **Setup** hidden/disabled; **`POST .../setup`** returns **409**.

If distinguishing **“dry-run only”** from **“attempted live and failed”** is needed without overloading `operationalStatus`, add **`setupStatus`** (`never_attempted` | `dry_run_only` | `live_failed` | `live_succeeded`) in implementation — not strictly required if `last_setup_error` + `operationalStatus` suffice.

## Environment variables (VPN Manager server)

| Variable | Purpose |
|----------|---------|
| **`VPN_SSH_ENABLED`** | If not truthy: **no outbound SSH**; `POST .../setup` returns **dry-run only**. |
| **`ACME_EMAIL`** | Required when executing live setup with reverse proxy (historical)/LE (validate before SSH). |

## Remote workflow (phased)

Each phase has a stable **id**, **title**, and **script snippet** (for dry-run display). Live execution runs the same sequence (implementation may batch where safe).

1. **Preflight:** Ubuntu 24.04 check; `sudo`/privilege check; tools present (`curl`, etc.); **`panelHostname`** resolves for HTTP-01; optional check that public DNS targets this server when determinable.
2. **`ufw`:** default deny; allow **22, 80, 443**; enable firewall.
3. **Install 3x-ui:** official non-interactive path; enable **systemd** unit(s) per upstream.
4. **Configure 3x-ui:** set generated admin credentials via **supported non-interactive** mechanism (exact command/API depends on 3x-ui; document chosen method in implementation). Apply **hardening** that can be automated; remaining items become a short **operator checklist** in runbooks if not scriptable.
5. **Bind 3x-ui to localhost** on internal panel port (exact port per upstream default, e.g. common defaults — verify at implementation time).
6. **Install reverse proxy (historical)** (supported method for Ubuntu 24); write **Caddyfile** for **`panelHostname`** → `reverse_proxy` to local 3x-ui; use **`ACME_EMAIL`** for issuer contact.
7. **Reload/restart** services in a safe order; **`systemctl is-active`** checks.
8. **Verification:** HTTPS request to `https://panelHostname/...` (minimal path), plus local upstream check if needed; both must pass before **`working`**.

**Partial failure:** Do not set **`working`**. Persist **`last_setup_error`** summary. Document likely **manual cleanup** scenarios (idempotency is **not** promised across arbitrary partial states; full **reset** is a future concern).

## API behavior

### `POST /api/profiles/:id/setup`

- **409** if profile **`operationalStatus === "working"`** (blocked until reset/rebuild exists).
- **`VPN_SSH_ENABLED` false:** **200** + **dry-run payload** (ordered phases, command blocks with **placeholder secrets**, **no** outbound network, **no** transition to **`working`**, **no** persistence of generated 3x-ui secrets).
- **`VPN_SSH_ENABLED` true:** validate **`panelHostname`**, **`ACME_EMAIL`**, profile SSH fields; **generate** secrets; run phases over SSH; on full success encrypt and store secrets, clear `last_setup_error`, set **`operationalStatus = working`**; return updated DTO **without** decrypted secrets in JSON (list/get behavior unchanged for secrets).

### Future: `POST /api/profiles/:id/reset-deployment`

- Clears success state and encrypted 3x-ui payload (and errors), allowing setup again. Remote uninstall policy **TBD**.

## UI behavior

- **Setup:** opens terminal sheet + calls setup API. Show errors with existing patterns.
- **Working:** **Setup** not offered; explain that reset is not yet available if needed.
- **SSH button:** may remain as **manual notes** terminal or later be repurposed; not required to change in this spec beyond **Setup** driving the same sheet for dry-run/live output.

## Security

- **SSH host keys:** **Strict verification** — no “trust on first use” without an explicit decision. **Default for v1:** document operators supplying **known_hosts entries** or a **future `sshHostKey`** profile field; implementation chooses the minimal shippable behavior and documents it (e.g. fail setup if host key not pinned when a certain flag is set).
- **Secrets:** decrypt **only in memory** during live setup; redact in logs; cap stdout/stderr capture size.
- **TLS:** only on **`panelHostname`** via reverse proxy (historical); 3x-ui reachable from the internet **only** through reverse proxy (historical).

## Reliability

- **Per-phase** and **global** timeouts on SSH operations.
- **No destructive re-setup** after success without **reset** (future).

## Testing

- **Unit:** dry-run assembly; env gate (**no dial** when disabled); **409** when `working`; validation failures (`ACME_EMAIL` missing when live, bad `panelHostname`).
- **Integration:** mock SSH transport; assert phase order and side effects on DB when “success” path is simulated.

## Relationship to prior placeholder spec

`2026-04-14-vpn-profile-setup-ssh-placeholder-design.md` defined **fake** setup and a **non-network** terminal. This spec defines **real** API-driven SSH and production-oriented install steps. Implementation may **replace** placeholder setup logic while preserving **operationalStatus** semantics and UI patterns agreed there.

## Open points for implementation (not blockers for this design)

- Exact **3x-ui** non-interactive admin set commands and **systemd** unit names for the chosen upstream version on Ubuntu 24.
- Whether **`panelHostname`** is required at **profile create** time or only before **live** setup.
- Minimal **SSH host key** strategy shipped in v1 vs. documented manual prerequisite only.
