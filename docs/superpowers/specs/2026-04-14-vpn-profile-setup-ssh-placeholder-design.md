# VPN profile Setup + SSH terminal (placeholder) — design

**Date:** 2026-04-14  
**Status:** Approved for implementation planning  
**Scope:** VPNs page (`apps/web/src/pages/VpnsPage.tsx`) and VPN profile API/storage (`apps/server`).

## Goal

On the VPN profiles screen:

1. **Setup** — After a profile exists, the user can run “setup” (future: SSH to server, install/configure VPN, health check). **For this milestone:** no real SSH; simulate work with a short delay, run a **placeholder health check that always succeeds**, then persist **`working`** so **Setup** is hidden.
2. **SSH** — **Always available** so the user can work on the server manually. **For this milestone:** open a **bottom sheet** with a **fake terminal** (local typing only, no network).

Operational status **must live in the database** and appear after refresh / other clients.

## Non-goals (this milestone)

- Real SSH, tunnels, or shell sessions.
- Real VPN install scripts or health probes.
- WebSocket or streaming terminal I/O.

## Data model

- Add a column on `vpn_profiles`, e.g. **`operational_status`** `TEXT NOT NULL` with allowed application values **`pending`** and **`working`** (enforce in app layer; optional SQLite `CHECK` in migration).
- **Default:** `pending` for new inserts and for **all existing rows** migrated from older DBs (so legacy profiles show **Setup** until run once).
- **Naming in JSON:** `operationalStatus` (camelCase) on API DTOs to match existing profile shapes.

## API

- **List / get / create / patch profile responses** include `operationalStatus`.
- **Clients must not set `operationalStatus` via request bodies** (no spoofing “working”). Only server flows below update it.
- **`POST /api/profiles/:id/setup`** (authenticated): validate id; perform **fake work** (e.g. short `setTimeout` / delay on server); run shared **`verifyProfileHealthPlaceholder()`** → currently **always returns OK**; set `operational_status = 'working'`; return updated profile DTO.
- **`PATCH /api/profiles/:id`:** after a successful credential/host update, call the **same** `verifyProfileHealthPlaceholder()` and persist the result. With the current placeholder (always OK), profiles move or stay **`working`**. When the placeholder later returns failure, the spec should be revised to define resulting status (e.g. `pending` or a future `error` state).

## UI — VPNs table

- New column **Status**: show **Pending** vs **Working** (consistent with existing inline styles; small badge or plain text).
- **Setup:** visible **only** when `operationalStatus === "pending"`. **Disabled** + loading label while that profile’s setup mutation is in flight; prevent double-submit.
- **SSH:** **always** shown for every row. Opens the bottom sheet for that profile.

## UI — SSH bottom sheet

- **Layout:** Large panel **from the bottom** of the viewport, still on the VPNs route (~**45–55%** height), **dimmed backdrop**, **Close** and **backdrop click** dismiss. Prefer **locking body scroll** while open.
- **Honesty:** One short line stating this is **not** a real SSH connection (demo / manual prep only).
- **Fake terminal:** Dark background, monospace. Prompt derived from profile (`sshUser@host` pattern). User typing builds the current line; **Enter** commits the line to scrollback and shows a new prompt. **No** API calls for keystrokes.
- **Accessibility:** `role="dialog"`, `aria-modal="true"`, label tied to profile (label or host). **Escape** closes if straightforward.

## Errors and edge cases

- **Setup failures:** Reuse the existing **page-level error** pattern on `VpnsPage` (`ApiError` / `getErrorMessage`). Clear that error when starting a new Setup attempt.
- **404 / 401:** Same as existing API behavior.
- **Delete while SSH sheet open:** Close the sheet if the open profile was deleted (or if refetch shows the id gone).
- **New profile:** Stays **`pending`** until user clicks **Setup** (no auto-setup).

## Testing

- **Server:** Extend `apps/server` profile route tests — responses include `operationalStatus`; `POST .../setup` transitions `pending` → `working` and persists; `PATCH` runs placeholder verify path (document always-OK for now). Update any raw SQL seeds that insert into `vpn_profiles` to satisfy the new column (or rely on default).
- **Web:** `bunx tsc -b` in `apps/web` after type updates.
- **Manual smoke:** create → Pending + Setup → Setup → Working + Setup hidden; SSH sheet typing + close; edit profile → still Working with current placeholder.

## Files likely touched (implementation hint only)

- `apps/server/src/db/schema.sql`, migration logic alongside existing migrations.
- `apps/server/src/routes/profiles.ts`, `apps/server/src/types.ts`, `apps/server/src/routes/profiles.test.ts`.
- `apps/web/src/pages/VpnsPage.tsx` (and possibly small shared styles or a tiny terminal subcomponent in the same file unless split is warranted).

## Open follow-ups (post–placeholder)

- Replace `verifyProfileHealthPlaceholder()` with real checks; define behavior when check fails (status enum, UX, whether Setup reappears).
- Replace fake terminal with real SSH (architecture TBD: not in this spec).
