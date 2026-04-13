# Routing default actions — `block` and terminal-hop constraints

**Date:** 2026-04-14  
**Status:** Approved (design sign-off in session)  
**Scope:** Extend per-hop **`default_action`** with **`block`**, restrict **terminal** hops so **`use_chain` is not allowed as the default**, and align **SQLite**, **HTTP API**, **export v2**, **web UI**, and **tests**.

## 1. Problem and intent

Per-hop routing profiles today allow **`default_action`** of only **`use_chain`** or **`direct`**. Product requirements:

1. **Default actions** (the fallback when no rule matches) must be exactly **`use_chain`**, **`direct`**, or **`block`** — same vocabulary breadth as per-rule actions for defaults.
2. On the **terminal hop** (last node in the chain by `chain_hops.position`), **`use_chain` must not be a valid default**; only **`direct`** or **`block`** apply. Semantically, “continue the chain” after the last hop is meaningless for the default path.

**Rule-level** `action: use_chain` on the terminal hop is **unchanged** by this spec (only **default** is restricted).

## 2. Data model and migration

### Column

- **`routing_profiles.default_action`:** allowed values **`use_chain` | `direct` | `block`** (SQLite `CHECK` updated accordingly).

### Terminal hop

- For a given **`chain_id`**, the hop with the **largest `position`** is **terminal** (consistent with ordering `ORDER BY position ASC, id ASC`).

### New rows

- When creating routing profiles for hops (chain create or hop list replacement), use **`use_chain`** for positions **`0 .. n-2`** and **`direct`** for position **`n-1`** when **`n >= 1`**. A **single-hop** chain creates **one** profile with **`direct`**.

### Existing data

- After widening `CHECK`, for each chain set **`default_action = 'direct'`** on the **terminal** hop’s profile where it is currently **`'use_chain'`** (product choice: coerce to **direct**, not block).
- No other automatic coercion is required ( **`block`** did not exist historically).

## 3. API validation and errors

### `PATCH /api/routing/:routingProfileId`

- Accept **`defaultAction`** in **`use_chain` | `direct` | `block`**.
- Resolve the profile’s **`chain_hop_id`** → **`chain_id`** and **`position`**; compute **max(`position`)** for that **`chain_id`**.
- If the hop is **terminal** and **`defaultAction === "use_chain"`**, return **400** with an explicit, stable error message (e.g. that the last hop’s default must be **`direct`** or **`block`**).
- Non-terminal hops may use any of the three values.

### Reads

- **`GET /api/routing/by-hop/:chainHopId`:** response shape unchanged. No new DTO fields required; clients derive terminal from ordered hops on the chain.

### Writes

- Besides **`PATCH /api/routing`** and **chain hop + routing profile creation** (see section 2), no other endpoints must set **`default_action`** without the same rules.

### Implementation note (SQLite)

- Update **`schema.sql`** for new databases. For existing databases, extend **`migrate()`** with an idempotent step that widens the `CHECK` constraint (including table rebuild if SQLite requires it, mirroring **`migratePerHopRoutingIfNeeded`**), then applies the terminal-hop coercion query.

## 4. Export JSON (schema version 2)

### Shape

- Unchanged: **`schemaVersion: 2`**, **`routingByHop[]`** with **`defaultAction`** and **`rules`**.

### `defaultAction` union

- Widen to **`"use_chain" | "direct" | "block"`** in types and generated JSON.

### Consumer contract

- **`schemaVersion`** remains **2** (additive enum extension; same keys as existing v2). Consumers must handle **`block`** as a default action.
- **Documented invariant:** the **`routingByHop`** entry for the **last hop** in export order (**`hopIndex === length - 1`**, aligned with **`chain`**) **must not** have **`defaultAction: "use_chain"`**. Valid DB + server writes guarantee this; executors may assert or reject invalid hand-edited files.

### Export errors

- **`ExportNotFoundError`** if a hop lacks a profile or **`default_action`** is null — unchanged.

## 5. Web UI (`RoutingPage`)

### Types

- Extend **`DefaultAction`** with **`block`** everywhere it mirrors the API.

### Terminal detection

- Terminal when the selected hop is the **last** entry in **`selectedChain.hops`** (same order as server/export).

### Controls

- Add a **Block** radio for default action on **non-terminal** hops (three options: Use chain, Direct, Block).
- On **terminal** hops, **omit or disable** “Use chain” for the default; only **Direct** and **Block**.

### Client normalization

- If a loaded profile is terminal with **`use_chain`** (legacy), normalize displayed/saved intent to **`direct`**.
- When switching the selected hop from a non-terminal hop with **Use chain** selected to the **terminal** hop, coerce **`defaultAction`** to **`direct`**.

### Save

- **`validateRoutingForm`** (or equivalent) must not emit **`use_chain`** for a terminal hop. Server **400** paths continue to surface via existing error handling.

## 6. Testing

- **Migration:** terminal **`use_chain` → direct`**; **`CHECK`** accepts **`block`**; terminal cannot persist **`use_chain`** as default.
- **`PATCH /api/routing`:** terminal + **`use_chain`** → **400**; terminal **`direct` / `block`** OK; non-terminal all three OK.
- **Chains:** multi-hop insert pattern; single-hop **`direct`** only on the sole profile.
- **Export:** **`block`** appears in JSON; terminal row not **`use_chain`** for valid fixtures.
- **UI smoke:** three radios on non-terminal; two on terminal; hop switch coercion; save succeeds.

## 7. Rollout

- Deploy **server migration + API** together with or before the **web** client so **`block`** is never sent against an old `CHECK`.

## 8. Relation to prior specs

**[2026-04-14-per-hop-routing-design.md](./2026-04-14-per-hop-routing-design.md)** defines per-hop profiles and export v2 layout. This document **extends** default-action values and **adds** terminal-default semantics; it **updates** the prior note that new profiles default to **`use_chain`** for **all** hops — **non-terminal** hops keep **`use_chain`**, **terminal** uses **`direct`** on create. Export **`schemaVersion`** stays **2** with an expanded **`defaultAction`** union as described in section 4.
