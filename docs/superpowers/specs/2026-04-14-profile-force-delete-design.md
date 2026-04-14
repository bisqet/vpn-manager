# VPN profile force delete (chain hop cleanup) — design

**Date:** 2026-04-14  
**Status:** Approved for implementation planning  
**Scope:** `DELETE /api/profiles/:id` and VPNs page delete UX (`apps/server/src/routes/profiles.ts`, `apps/web/src/pages/VpnsPage.tsx`).

## Goal

When a user deletes a VPN profile that is still referenced by one or more **chain hops**, the server today returns **409** with **"Profile is in use by one or more chain hops"** (SQLite `FOREIGN KEY` on `chain_hops.vpn_profile_id` → `vpn_profiles`, `ON DELETE RESTRICT`).

The product should:

1. Keep that **safe default** for a normal delete (no silent data loss).
2. Offer **“Delete anyway”** in the UI when that conflict occurs, backed by a **force** delete that removes the profile **and** cleans up references so the database stays consistent.

## Confirmed behavior (multi-hop chains)

When **force** delete runs:

1. **Remove only** `chain_hops` rows whose `vpn_profile_id` equals the profile being deleted. Deleting a hop **cascades** to its `routing_profiles` and `rules` (existing schema).
2. For each affected **chain**, **renumber** remaining hops to contiguous positions **`0 .. n-1`** ordered by current `position` (use `id` as a stable tiebreaker if two rows ever share the same position, which must not happen in normal data).
3. If a chain has **no hops left** after step 1, **delete the `chains` row** for that chain (avoid empty ghost chains).
4. Then **delete the `vpn_profiles` row**.

The product does **not** delete entire multi-profile chains when the profile appears on only some hops; other hops and their routing data remain.

## Non-goals

- Admin-only or elevated permission for force delete (same authenticated session as normal delete unless a future spec adds roles).
- Returning a detailed “impact preview” payload before delete (optional follow-up).
- Changing `ON DELETE RESTRICT` in the schema to silent cascade without an explicit API flag (explicit `force` keeps intent clear in logs and clients).

## API

- **`DELETE /api/profiles/:id`** — unchanged: attempt direct `DELETE FROM vpn_profiles`; on FK failure, respond **409** with `{ "error": "Profile is in use by one or more chain hops" }` (exact string preserved for existing tests and simple client matching).
- **`DELETE /api/profiles/:id?force=true`** (accept `force=1` as equivalent if convenient) — run the **transaction** described in “Confirmed behavior”, then `DELETE FROM vpn_profiles WHERE id = ?`. Success body: **`{ "ok": true }`** (same as normal delete).
- **404** if the profile id is valid but no row exists. **400** for invalid id or malformed `force` (e.g. not boolean-like).

Implementation must use **`BEGIN` / `COMMIT` / `ROLLBACK`** so partial hop cleanup never leaves the DB inconsistent.

## UI (`VpnsPage`)

- On delete failure, detect **409** with the known error message (or a shared constant on web matching the server string).
- Show the existing error surface **plus** a **“Delete anyway”** control.
- **Second confirmation** (`window.confirm` is acceptable to match the existing delete confirm pattern): warn that hops using this profile will be removed, **routing rules on those hops will be lost**, chains with no hops left will be **removed**, and the profile will be permanently deleted.
- Successful force delete uses the **same** post-delete behavior as today (invalidate profiles query, close SSH/setup UI if that profile was open).

## Testing

- **`apps/server/src/routes/profiles.test.ts`**
  - **Without** `force`: profile referenced by a hop still returns **409** and the same error JSON.
  - **With** `force=true`: profile deleted; hops referencing it gone; routing for removed hops gone; remaining hops on a multi-hop chain have **renumbered** positions; chain with only that hop **deleted**; chains with other hops **retained**.
- **Web:** extend or add coverage only if the project already tests this page; at minimum **`bunx tsc -b`** (or repo-standard check) after API client/type changes.

## Files likely touched (implementation hint only)

- `apps/server/src/routes/profiles.ts` — parse `force` query; transactional cleanup helper.
- `apps/server/src/routes/profiles.test.ts` — scenarios above.
- `apps/web/src/pages/VpnsPage.tsx` — `deleteProfile` helper with optional force; error UI + second confirm.
