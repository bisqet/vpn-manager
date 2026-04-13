# Per-hop routing rules — design

**Date:** 2026-04-14  
**Status:** Approved (design sign-off in session)  
**Scope:** Change routing from **one rule set per chain** to **one rule set per chain hop (node)**. Applies to **SQLite schema**, **HTTP API**, **export JSON**, and **web UI**. Does not define executor behavior beyond documenting how exported data maps to “policy at each hop.”

## 1. Problem and intent

Today, `routing_profiles` is **1:1 with `chains`**, and `rules` attach to that single profile. The desired product flow is:

1. Select a **chain**
2. Select a **node** (hop)
3. **Edit** that node’s **default action** and **ordered rules**

**Semantics (approved):** Each hop has its **own** `default_action` and ordered `rules`. A **consumer** of the export applies **that hop’s** policy when traffic is **at that hop** (same split-tunnel style as today, scoped per hop).

## 2. Data model

### `routing_profiles`

- **Primary association:** `chain_hop_id INTEGER NOT NULL UNIQUE REFERENCES chain_hops(id) ON DELETE CASCADE` — exactly **one routing profile per hop**.
- **Remove** the chain-level 1:1: drop **`chain_id`** from `routing_profiles` after migration (do not keep denormalized `chain_id` unless a future query pattern requires it; prefer a single source of truth via `chain_hops`).

### `rules`

- **Unchanged columns:** `routing_profile_id`, `position`, `match_kind`, `match_value`, `action`.
- Rules now always mean “rules for the hop identified by the profile’s `chain_hop_id`.”

### `chain_hops`

- No new columns required if routing is only on `routing_profiles`; ensure **`chain_hops.id`** is the stable key for API and export alignment.

### Chain creation

- After inserting a chain and its hops, the server **inserts one `routing_profiles` row per hop** (e.g. name `"{chainName} hop {position}"` or equivalent convention matching existing naming style), with `default_action = 'use_chain'` and **zero rules** unless product chooses a different default (documented here: **empty rules**).

## 3. Migration

1. For each existing `routing_profiles` row tied to **`chain_id`** (legacy):
   - Load its `default_action` and ordered `rules`.
   - For **each** `chain_hops` row with that `chain_id`, insert a **new** `routing_profiles` row with `chain_hop_id` set, same `default_action`, and **copy** all rules (new `routing_profile_id`, preserve order via `position`).
2. Delete legacy `routing_profiles` rows (and their rules already moved — use transaction; avoid double-delete).
3. Drop `routing_profiles.chain_id` and any **UNIQUE(chain_id)** constraint; add `chain_hop_id` with **UNIQUE NOT NULL** and FK as above.

**Rationale for copying rules to every hop:** Preserves prior behavior where one chain-level list applied conceptually to the whole chain: after migration, **each hop’s** client sees the **same** rules until the user edits per hop.

## 4. HTTP API

### Read / update by hop

- **`GET /api/routing/by-hop/:chainHopId`** — returns routing profile for that hop: `id`, `name`, `chainHopId`, `defaultAction`, `rules` (ordered).
- **`PATCH /api/routing/:routingProfileId`** — unchanged body shape: `{ defaultAction, rules: [{ matchKind, matchValue, action }] }`, same validation and transactional replace as today.

### Deprecation

- **`GET /api/routing/by-chain/:chainId`:** Remove or replace. If a convenience aggregator is desired: **`GET /api/routing/by-chain/:chainId`** returns `{ hops: [{ chainHopId, position, vpnProfileLabel, routingProfileId, defaultAction, rules }] }` in **one** round-trip (optional; not required for minimal scope).

### Rule actions at a hop

- **`direct` | `use_chain` | `block`** unchanged.
- **`use_chain`** at hop position *k* means: for matched flows, continue on the **chain from this hop** (same meaning as today, scoped to the hop’s position).

## 5. Export JSON

- **Bump `schemaVersion` to `2`** (breaking layout change; do not overload v1).
- Include routing **per hop**, aligned with chain order, for example:

  - `routingByHop: Array<{ hopIndex: number; chainHopId: number; routingProfileId: number; defaultAction: "use_chain" | "direct"; rules: Array<{ matchKind: "domain" | "cidr"; matchValue: string; action: "direct" | "use_chain" | "block" }> }>`

- **`hopIndex`** is **0-based** and matches the ordered `chain` array in the export. **`chainHopId`** is the stable DB identifier for executors that store state by id.

Executors that only understand v1 must migrate to v2 or reject unknown `schemaVersion`.

## 6. Web UI

- **Flow:** Select **chain** → list **hops** (order + VPN profile label) → select **hop** → edit **default action** and **rules** → save (**PATCH** by `routingProfileId` from loaded hop payload, or PATCH by hop if API is shaped that way — implementation plan picks the client contract).
- Placement: **Routing** page (or equivalent) implements this wizard-style flow; exact navigation copy is implementation detail.

## 7. Deletion, reordering, errors

- **Hop delete:** `ON DELETE CASCADE` from `chain_hops` to `routing_profiles` (and rules) so removing a hop removes its routing data.
- **Hop reorder:** Profiles stay bound to **`chain_hops.id`**, not `position`, so rules **move with the hop**.
- **Validation:** Reuse existing domain/CIDR normalization and rule validation; return **400** with clear messages on invalid payloads (unchanged expectations).

## 8. Testing

- **Migration:** Legacy chain with one profile + rules → N hops receive N profiles with copied rules; no orphan profiles.
- **Chains POST:** Creates N hop rows and N routing profiles.
- **Routing PATCH:** Replace rules for one hop does not affect another hop’s rules.
- **Export:** `schemaVersion: 2` includes `routingByHop` length equal to hop count; ordering matches chain.

## 9. Relation to prior specs

The **2026-04-13** web UI design document describes **one routing profile per chain** and `use_chain` tied to that profile’s `chain_id`. **This document supersedes that** for routing scope: profiles are **per hop**, and `use_chain` is interpreted **from the hop’s position** on the chain. Other goals (auth, encryption, non-goals) remain unchanged unless they conflict — they do not.
