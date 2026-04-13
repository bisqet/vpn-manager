# VPN Manager — Web UI (v1) Design

**Date:** 2026-04-13  
**Status:** Approved (conversation) — pending written-spec review  
**Scope:** Web UI and configuration **generation** only. No live SSH, no host routing enforcement, no bundled GeoIP or country blocklists.

## 1. Goals and non-goals

### Goals

- CRUD **VPN profiles** with fields: **IP (host)**, **SSH port**, **login**, **password** (stored **encrypted at rest**).
- Define **chains**: ordered sequences of VPN profiles (Stitch “chains” screen as loose visual reference).
- Define **routing**: send some traffic **direct** to the internet, some **through the chain**, and **block** some traffic (e.g. suffix `.ru` as an example intent). Rules support **per-row** match kind: **domain-style** or **CIDR**.
- **Export** a **versioned JSON** artifact describing chains and routing for a **future executor** — no apply/deploy action in v1.
- **Authenticated Web UI**; encryption master secret from **environment** (independent of UI login password).

### Non-goals (v1)

- Real VPN tunnels, SSH sessions, packet routing, or rule enforcement on any machine.
- Automatic feeds for “Russian” or other geography beyond what the user encodes (suffix lists, CIDR lists).
- Pixel-perfect recreation of Google Stitch mocks; use them as **layout inspiration** only.
- Revealing stored SSH passwords in the UI after save (replace-only editing; no “show password” unless added in a later version).

## 2. Architecture

- **Server:** Bun HTTP server exposing a JSON API; in **production**, serves the built SPA as static assets (same origin). Development may use a Vite dev server with proxy to the API or a single Bun entry — implementation plan will choose; contract is **JSON API + static SPA**.
- **Client:** **React + TypeScript + Vite** (recommended default; aligns with “any UI lib” and rich editors).
- **Persistence:** **SQLite** (Bun built-in driver) for users, profiles, chains, routing profiles, rules.
- **Auth:** Session-based (e.g. **HttpOnly, Secure, SameSite=Lax** cookie) after username/password login. Password hashes use **Argon2id** (preferred) or **bcrypt** with sensible work factors.
- **Secrets at rest:** SSH passwords encrypted with **AES-256-GCM** using a key derived from **`VPN_MANAGER_MASTER_KEY`** (see §6). UI login credentials are stored separately (hashed), not used to unwrap VPN ciphertext.

### Default traffic and rule semantics

- Each **routing profile** has **`default_action`**: `use_chain` | `direct`.
- **`rules`** are an **ordered list**; evaluation is **first match wins** (documented in export schema). Unmatched traffic follows `default_action`.
- **`use_chain`** on a rule means: for matched flows, traffic follows the **associated chain** (same chain as the routing profile’s `chain_id`).

## 3. Data model

### `user`

- `id`, `username` (unique), `password_hash`, `created_at`.

### `vpn_profile`

- `id`, `label`, `host` (IP string), `ssh_port` (integer), `ssh_user`,
- `ssh_password_ciphertext`, `ssh_password_nonce` (or single blob column storing nonce||ciphertext per project convention),
- `created_at`, `updated_at`.

### `chain`

- `id`, `name`,
- **Ordered** list of `vpn_profile_id` references (array table or join table with `position` integer). **No duplicate** profile IDs in one chain (server-enforced).

### `routing_profile`

- `id`, `name`,
- `chain_id` (FK — v1: **one routing profile per chain** is sufficient; enforce uniqueness on `chain_id` if we model 1:1),
- `default_action`: `use_chain` | `direct`.

### `rule`

- `id`, `routing_profile_id`, `position` (integer ordering),
- `match_kind`: `domain` | `cidr`,
- `match_value`: string,
- `action`: `direct` | `use_chain` | `block`.

### Domain match interpretation (v1)

- **`domain`**: treat `match_value` as a **hostname suffix** after normalization:
  - Trim whitespace; lowercase ASCII hostnames for comparison.
  - If the user enters `*.ru`, normalize to **`.ru`** in the UI or server so that hosts like `example.ru` match. A host **matches** if its hostname is **equal** to the suffix without leading dot (e.g. `ru` matching bare `ru` is discouraged — **prefer** values like `.ru`), or ends with the suffix **`.ru`** (i.e. `endsWith(match)` where normalized suffix begins with `.`).
  - **Explicit rule:** normalized suffix **must** start with `.` for public suffix style (e.g. `.ru`, `.co.uk` as stored string). Validation rejects suffixes without a leading dot except documented edge cases in implementation plan.

### CIDR match interpretation (v1)

- **`cidr`**: `match_value` is a single IPv4 or IPv6 CIDR (server validates parseable CIDR). Evaluation compares **destination IP** conceptually — the export schema describes intent; no runtime evaluation in v1.

## 4. UI screens

1. **Login** — username + password; generic error on failure.
2. **VPN profiles** — table; add/edit/delete in a modal; masked password on entry; after save, password is **not** shown (edit = supply new password or keep unchanged — implementation chooses explicit “change password” vs resend; spec: **optional empty password = unchanged** on update).
3. **Chains** — list + editor: ordered rows, each row selects a **saved VPN**; drag handles or up/down; chain name.
4. **Routing** — select chain (or open routing from chain context). Set **default** `use_chain` vs `direct`. Rules table: order, match kind, match value, action; reorder/add/remove.
5. **Export** — “Generate / download” produces JSON per §5; optional in-page **preview** (pretty-print). **No** “apply to system” button.

## 5. Exported configuration

- **Format:** JSON file, e.g. `vpn-manager.routing.v1.json`.
- **`schemaVersion`:** `1` (integer).
- **Contents (minimum):**
  - Metadata: `exportedAt` (ISO-8601), human-readable `name` optional.
  - `chain`: ordered list of hop objects: `profileId`, `host`, `sshPort`, `sshUser` — **omit `sshPassword`** from export **always in v1** (security default). Future versions may add a separate encrypted operator bundle; out of scope.
  - `routing`: `defaultAction`, ordered `rules` with `matchKind`, `matchValue`, `action`.
  - **Identifiers:** stable `profileId` / `chainId` / `routingProfileId` as needed so a future executor can join exported hops to a local secret store.

**Note:** Because passwords are omitted, the export is safe to share as a **routing intent** document; operators map `profileId` to secrets out of band.

## 6. Cryptography and environment

- **`VPN_MANAGER_MASTER_KEY`:** required at server start. Document as **32-byte** key, **base64**-encoded (or hex — pick one in implementation and document; no ambiguity in code). Server **fails fast** if missing or wrong length after decoding.
- **AES-256-GCM** per stored password with random nonce per row; authenticate ciphertext; constant-time compare not required for decryption but use standard libraries.

## 7. API and validation (high level)

- All mutating and sensitive routes require **authenticated session**.
- Validate: SSH port range, non-empty host/user on create, chain non-empty before export, unique chain members, CIDR parseable when `match_kind = cidr`, domain suffix format when `match_kind = domain`, rule `position` contiguous or server normalizes order on save.

## 8. Error handling and UX

- Server returns **400** with structured field errors for validation; **401/403** for auth.
- Client: toasts or inline errors; avoid leaking whether username exists (same message as wrong password on login).

## 9. Testing (v1)

- **Server unit tests:** CIDR parsing/validation, domain suffix normalization, rule ordering serialization, encrypt/decrypt roundtrip with test key, chain validation.
- **Client (optional minimal):** pure helpers for rule form validation if extracted.

## 10. Tech stack (locked for v1)

- **Runtime / server:** Bun.
- **Client:** React + TypeScript + Vite.
- **DB:** SQLite.

## 11. Open items deferred to implementation plan

- Exact HTTP router (Hono vs `Bun.serve` only), session token format, migration tool, dev vs prod static hosting layout, and folder structure for `apps/server` vs `apps/web` or single package.

---

## Spec self-review (2026-04-13)

- **Placeholders:** None intentional; §11 defers structural choices explicitly.
- **Consistency:** Routing profile ↔ chain is 1:1 in prose; enforce in schema (unique `chain_id` on `routing_profile`).
- **Scope:** Matches “Web UI + generate configs only.”
- **Ambiguity resolved:** Domain suffix requires leading `.` after normalization; export never includes SSH passwords in v1.
