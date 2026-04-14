# App Settings (SQLite) — design

**Date:** 2026-04-15  
**Status:** Draft pending reader review  
**Scope:** Authenticated **Settings** page and **API** to read/update **global VPN Manager settings** stored in SQLite (`ACME` contact email, **live SSH** enablement, optional **SSH known_hosts** path). Supersedes env-only operator flow for those keys **after** the initial settings row exists; see **Bootstrap** below.

## Goals

1. **Single source of truth** for v1 globals: **`acme_email`**, **`vpn_ssh_enabled`**, **`ssh_known_hosts_file`** — stored in SQLite and read by setup/teardown and any other server paths that today use `Env` for these fields.
2. **Bootstrap:** If no settings row exists yet, **insert** one row using the same parsing rules as today’s **`loadEnv()`** / `process.env` for those keys. After the row exists, **only the database** drives these values (changing `.env` alone does not change runtime behavior for them).
3. **Settings UI** under **authenticated** shell only: view and edit the three fields with validation aligned with existing setup rules (e.g. non-empty **ACME email** when **live SSH** is on).
4. **HTTP API:** `GET` and `PATCH` under **`requireAuth`**, consistent with chains/import/routing.

## Non-goals

- Persisting **`VPN_MANAGER_MASTER_KEY`**, **`DATABASE_PATH`**, **`PORT`**, **`STATIC_DIR`**, or **`NODE_ENV`** in SQLite (remain deployment env only).
- **Re-seed from env** button or automatic re-sync from env in v1 (can be a later enhancement).
- **Roles** beyond “any signed-in user”: same authorization model as other authed routes unless the product adds admin roles later.
- **Key–value** or **JSON blob** settings store for arbitrary keys (fixed columns for v1; new keys add migrations).

## Relationship to existing SSH / Caddy work

The feature in `2026-04-14-3x-ui-api-ssh-setup-design.md` describes **Caddy** using a **global ACME contact** and **`VPN_SSH_ENABLED`** as a kill-switch. This spec **does not change** remote phased behavior; it only changes **where** the API reads **`acme_email`**, **`vpn_ssh_enabled`**, and **`ssh_known_hosts_file`** after bootstrap: **from `app_settings`**, not from a long-lived in-memory copy of env alone.

## Data model

### Table: `app_settings`

Single logical row (enforce in application and, if useful, with `CHECK (id = 1)` on a singleton `id`).

| Column | Type | Notes |
|--------|------|--------|
| `id` | `INTEGER PRIMARY KEY` | Fixed value `1` when using singleton pattern. |
| `acme_email` | `TEXT NOT NULL` | May be empty string to mean “unset”; validation at API/setup time when live SSH is on. |
| `vpn_ssh_enabled` | `INTEGER NOT NULL` | `0` or `1` boolean. |
| `ssh_known_hosts_file` | `TEXT NULL` | Empty or absent treated as `NULL` (optional path on VPN Manager host). |
| `updated_at` | `TEXT NOT NULL` | ISO timestamp string, consistent with existing tables. |

**Migrations:** Add table via existing migration pipeline (`schema.sql` / migrate modules as used elsewhere).

## Bootstrap semantics

1. On **first successful read** of app settings for a handler that needs them: if **no row** with `id = 1`, **`INSERT`** defaults from **`process.env`** using the same truthiness/string rules as `loadEnv()` for `ACME_EMAIL`, `VPN_SSH_ENABLED`, `SSH_KNOWN_HOSTS_FILE`.
2. Thereafter, **read always from this row** for those three fields; **do not** re-merge from env on each request for v1.
3. **Edge case:** If the row is manually deleted from the DB, the next read may **re-bootstrap** from current `process.env` (same as first boot). Document as operational detail, not a supported “reset” workflow.

## Server API

Mounted under the existing **authenticated** API prefix (same `requireAuth` as `/chains`, `/import`, `/routing`).

| Method | Path | Behavior |
|--------|------|----------|
| `GET` | `/api/settings` | Returns DTO: `acmeEmail`, `vpnSshEnabled`, `sshKnownHostsFile` (nullable), `updatedAt`. Ensures bootstrap row exists before return. |
| `PATCH` | `/api/settings` | JSON body with optional partial fields; validates; updates row; returns same shape as `GET`. |

**Validation (minimum):**

- If **`vpnSshEnabled`** is **true** after patch, **`acmeEmail`** must be non-empty trimmed string → else **400** with clear error (mirror current `ACME_EMAIL` / live setup messaging intent).
- **`sshKnownHostsFile`**: optional; trim; empty → store as `NULL`.

**Internal API:** A small module (e.g. `getAppSettings(db)`, `updateAppSettings(db, patch)`) used by routes **and** by **setup runner**, **teardown runner**, and **profiles** validation paths so **one** implementation of defaults and bootstrap exists.

**`createApp` / `Env`:** Keep **`loadEnv()`** for deployment-only fields. For the three migrated keys, **resolve at use time from `db`** via the helper (or pass a narrow “runtime slice” built per request where practical). Tests that today inject `Env` for `acmeEmail` / `vpnSshEnabled` / `sshKnownHostsFile` should **seed `app_settings`** (or mock the helper) so behavior stays testable.

## Web application

- **Route:** `/settings` (or equivalent single segment), **only** inside **`ProtectedLayout`** (not on the guest VPN shell).
- **Nav:** New item alongside Import/Export (and other authed items).
- **UI:** Form with ACME email, live SSH toggle, known hosts file path; **Save** issues `PATCH`; use React Query **consistent with existing pages** (invalidate/refetch on success).
- **Copy:** Clarify that these values are **stored on the server** and affect **future** setup/teardown behavior.

## Security

- **Writes** and **reads** of `/api/settings` require a **valid session** (`requireAuth`).
- **`/profiles`** may remain usable without login as today; this spec does **not** require moving profile setup behind auth. Dry-run/live payloads may still **embed** ACME email in generated script text when returned to the client — analogous to env-driven behavior today.

## Testing

- **API:** `GET`/`PATCH` — **401** without session; **400** on validation failure; **200** happy path with persisted values.
- **Migration:** Table exists; singleton row behavior.
- **Regression:** Profile setup / teardown tests that depended on `Env` for the three fields updated to use DB-backed settings or mocks.

## Implementation notes

- **Column vs env naming:** DTOs use **camelCase** in JSON; DB columns **snake_case** as existing schema style.
- **Concurrency:** Last-write-wins on `PATCH` is acceptable for v1; document if multiple admins edit simultaneously.
- **Hono wiring:** Register **`/api/settings`** on the same **`authed`** sub-app as `/chains` and `/import`, not on the unauthenticated `/profiles` mount.
