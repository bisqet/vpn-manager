# Routing Rules — xray / 3x-ui parity

**Date:** 2026-04-20
**Status:** Approved design, ready for implementation plan
**Scope:** Expand the per-hop Routing Rules UI and backend so each rule carries the full set of xray-core `RoutingRule` fields and the table looks like 3x-ui's routing table.

## Summary

The Routing page currently stores rules as `{ matchKind: 'domain' | 'cidr', matchValue, action }` in a table named `rules`, with a separate per-hop `defaultAction` column on `routing_profiles`. This spec replaces that model with xray-compatible rules (`domain`, `ip`, `port`, `protocol`, `network`, `source`, `sourcePort`, `user`, `inboundTag`, `attrs`, `ruleTag`, `domainMatcher`, `outboundTag`) and drops the separate default-action control — users add an explicit catch-all rule at the end when they want a fallback.

Rules stay **per hop** (keyed by `chainHopId`). The **per-hop model is retained**; only the rule schema and the UI around it change.

The outbound-tag field is a free-text string validated at write time against a hop-specific allowlist: middle hops → `{direct, blocked, next-hop}`, terminal hops → `{direct, blocked}`.

No data is migrated from the old schema. The migration drops the `rules` table and the `default_action` column, recreates `rules` with the new schema, and leaves users to re-enter rules on each hop.

Saving routing rules pushes them to the hop's 3x-ui panel as part of the save. The push and the DB write are treated as a single transactional unit; if the panel push fails, the DB write rolls back and the user sees the error.

## Non-goals

- No global (per-panel) rules table — rules remain per hop.
- No migration of existing rules into the new shape.
- No API versioning — existing `/api/routing/by-hop/:id` and `/api/routing/:id` paths evolve in place.
- No live-panel end-to-end test expansion beyond what already exists.

## Naming and file-path corrections from reconnaissance

This spec originally referenced `routing_rules`, `apps/server/src/routing/`, `apps/server/src/http/routes/`, and `compensateChainProvision`. The real codebase uses:

- Table name: `rules` (not `routing_rules`).
- Routing HTTP handlers: `apps/server/src/routes/routing.ts`.
- No dedicated `apps/server/src/routing/` package; validators live alongside the handlers.
- Compensation function: `compensateCreatedInbounds` (in `apps/server/src/xui/compensateChainProvision.ts`).
- Schema is a single `apps/server/src/db/schema.sql` file with `CREATE TABLE IF NOT EXISTS` bootstrap, orchestrated by `apps/server/src/db/migrate.ts` which calls named `migrate*.ts` modules.

The plan uses the real names. Inline code fragments in this spec that say "routing_rules" refer to the `rules` table.

## Data model

### `routing_profiles`

Drop `default_action`. Keep `id`, `name`, `chain_id`, `chain_hop_id`.

### `rules`

Dropped and recreated with the following columns:

| column | type | notes |
|---|---|---|
| `id` | INTEGER PK | |
| `routing_profile_id` | INTEGER FK | cascade-delete with profile |
| `position` | INTEGER | 0-indexed ordering within the profile |
| `outbound_tag` | TEXT NOT NULL | free string; validated against hop-specific allowlist |
| `rule_tag` | TEXT NULL | optional label (xray `ruleTag`) |
| `domain_matcher` | TEXT NULL | enum `'hybrid' \| 'linear'` or NULL |
| `domains_json` | TEXT NULL | JSON array of strings (xray `domain`) |
| `ips_json` | TEXT NULL | JSON array of strings (xray `ip`, CIDR/IP/domain per xray) |
| `ports` | TEXT NULL | xray port-string (`"80,443,1000-2000"`) |
| `source_ports` | TEXT NULL | xray port-string |
| `protocols_json` | TEXT NULL | JSON array from `{'http','tls','bittorrent','quic'}` |
| `networks_json` | TEXT NULL | JSON array from `{'tcp','udp'}` |
| `sources_json` | TEXT NULL | JSON array of CIDR/IP strings |
| `users_json` | TEXT NULL | JSON array of strings |
| `inbound_tags_json` | TEXT NULL | JSON array of strings |
| `attrs` | TEXT NULL | JSON object string (flat `string → string`) |

Rationale for two specific choices:

- **`ports` / `source_ports` stored as a single xray-style string.** Xray's wire format is a string; storing it verbatim avoids re-serializing ranges and lets us pass the value straight into the emitted config.
- **`attrs` stored as a JSON-object string.** Xray's `attrs` is `Record<string, string>`; the modal exposes it as a key/value grid.

### Outbound-tag allowlist (server-side, per hop)

- Middle hop → `{ 'direct', 'blocked', 'next-hop' }`
- Terminal hop → `{ 'direct', 'blocked' }`

Any rule whose `outbound_tag` is outside the allowlist for its hop is rejected with HTTP 400.

### Rule validity

Each rule must supply at least one of: `domains_json`, `ips_json`, `ports`, `source_ports`, `protocols_json`, `networks_json`, `sources_json`, `users_json`, `inbound_tags_json`, `attrs`. Exception: the **last** rule in a profile may be a catch-all (no match fields). Catch-all rules anywhere but the final position are rejected.

## API surface

### `GET /api/routing/by-hop/:chainHopId`

```ts
{
  id: number;
  name: string;
  chainId: number;
  chainHopId: number;
  allowedOutboundTags: string[]; // server-computed from hop position
  rules: RoutingRule[];
}
```

### `PATCH /api/routing/:routingProfileId`

Body:

```ts
{ rules: RoutingRuleInput[] } // defaultAction is removed
```

Replace-all semantics preserved. Returns the full profile.

### `RoutingRule` (response)

```ts
type RoutingRule = {
  id: number;
  position: number;
  outboundTag: string;
  ruleTag: string | null;
  domainMatcher: "hybrid" | "linear" | null;
  domains: string[] | null;
  ips: string[] | null;
  ports: string | null;
  sourcePorts: string | null;
  protocols: Array<"http" | "tls" | "bittorrent" | "quic"> | null;
  networks: Array<"tcp" | "udp"> | null;
  sources: string[] | null;
  users: string[] | null;
  inboundTags: string[] | null;
  attrs: Record<string, string> | null;
};
```

### `RoutingRuleInput` (request)

Same shape without `id` and `position`. Ordering is implied by array order; client-supplied `id` / `position` are ignored.

### Removed from all routing responses and requests

- `defaultAction` on profiles.
- `matchKind`, `matchValue`, `action` on rules.

### Unknown fields

Silently ignored (consistent with the existing Hono validator behavior).

## UI

The Routing page keeps its chain selector, hop selector, and selected-chain summary card. The "Default action" fieldset is removed.

### Rules table

Compact summary rows styled to match 3x-ui:

| column | content |
|---|---|
| drag handle | `⋮⋮` icon; pointer drag reorders rows |
| `#` | 1-indexed row number |
| `Rule Tag` | `rule_tag` or `—` |
| `Inbound Tags` | comma-joined `inboundTags`, truncated with ellipsis; full list in `title` tooltip |
| `Outbound Tag` | colored pill: `direct` (neutral), `blocked` (red), `next-hop` (blue), custom (gray) |
| `Match` | single summary cell concatenating non-empty match fields with labeled prefixes (`domain: ... · ip: ... · port: ... · proto: ... · net: ...`); empty match fields render as `match-all` (only valid on the last row); truncated with full content in `title` |
| actions | **Edit** button (opens modal) and **Remove** button |

Below the table: **Add rule** (opens modal blank), **Save changes** (page-level PATCH), and the existing feedback banners.

### Edit modal

Title: `Add rule` or `Edit rule #N`.

Field groups:

1. **Outbound** — `outboundTag` (select from `allowedOutboundTags`).
2. **Match — Domains & IPs** — `domains` (chip input), `ips` (chip input), `domainMatcher` (select: `hybrid` / `linear` / *(none)*). Helper line under `domains`: "Prefix with `domain:`, `regexp:`, `full:`, or `geosite:` per xray syntax — values are stored as-is."
3. **Match — Ports & Protocols** — `ports` (text input, xray port-string grammar, inline validation), `protocols` (multi-checkbox: http / tls / bittorrent / quic), `networks` (multi-checkbox: tcp / udp).
4. **Match — Source** — `sources` (chip input), `sourcePorts` (text input, xray port-string grammar), `users` (chip input).
5. **Match — Inbound** — `inboundTags` (chip input).
6. **Advanced** (collapsible, collapsed by default) — `ruleTag` (text input), `attrs` (key/value grid).

Modal footer: **Cancel** and **Save**. Save validates client-side against the same rules the server enforces and shows inline errors per field. On success the modal closes and the local `ruleRows` state updates; nothing hits the server until the user clicks the page's **Save changes**.

### Chip input

- Type a value, press Enter or comma, it becomes a removable chip.
- Backspace on an empty input removes the last chip.
- Empty and whitespace-only values are rejected inline.

### Enum-ish fields

- `protocol` → multi-checkbox (`http`, `tls`, `bittorrent`, `quic`).
- `network` → multi-checkbox (`tcp`, `udp`).
- `domainMatcher` → single select (`hybrid` / `linear` / *(none)*).

### Reorder

Drag-to-reorder only (no Up/Down buttons). Uses `@dnd-kit/core` + `@dnd-kit/sortable` for keyboard-accessible drag-and-drop. Visual affordance: grab cursor on the handle; dragged row gets a subtle shadow. (~30 KB gzipped dependency cost accepted.)

### Styling

Stays with the inline `CSSProperties` convention used elsewhere in the page. Adds styles for the pill, chip input, and drag handle in the existing visual language (rounded 10–14 px, `#e5e7eb` borders, `#f9fafb` muted backgrounds).

## Xray config integration

**Context finding from reconnaissance:** the current provisioner (`provisionChainClientAccess`, `provisionMultihopChainClientAccess`) does not consume stored routing rules at all. For multihop chains, it inserts exactly one rule per hop at position 0 of `routing.rules`:

```json
{ "type": "field", "inboundTag": ["<our-inbound-tag>"], "outboundTag": "<next-hop-or-direct>" }
```

This spec adds a new emission path: every save of a routing profile rewrites the panel's rules for that hop's inbound.

### When emission happens

- `PATCH /api/routing/:routingProfileId` pushes the updated rules to the hop's 3x-ui panel as part of the request. The DB write and the panel push are one transactional unit — if the panel push fails, the DB write rolls back and the user sees the error.
- `provisionMultihopChainClientAccess` also re-applies the current stored rules during chain provisioning (so rules survive a full re-provision and fresh panels pick them up).

### Where user rules sit in the panel's xray config

Strict-scoping model (Q C1 from design discussion):

- The server only touches `routing.rules` entries whose `inboundTag` array contains any of the chain's own inbound tags for this hop.
- All other routing rules on the panel (rules added by the operator or by other chains) are left untouched.

Positioning (Q B1):

- User rules are emitted **above** the provisioner's existing `{inboundTag: [ourTag], outboundTag: <next-hop-or-direct>}` rule.
- The provisioner rule stays in place as the implicit fallback; no outbound-list reordering.

Auto-scoping:

- If a user rule's `inboundTags` array is non-empty, it is emitted verbatim (operator is explicitly targeting specific inbounds).
- If a user rule's `inboundTags` array is empty/null, the emitter injects the hop's own inbound tag so the rule only matches traffic on this chain's inbound. This prevents one hop's rules from matching traffic on another chain's inbound.

### Rule-to-xray mapping (`routing.rules[i]`)

```ts
{
  type: "field",
  inboundTag: rule.inboundTags?.length ? rule.inboundTags : [hopInboundTag],
  ...(rule.domains?.length       ? { domain:        rule.domains }                : {}),
  ...(rule.ips?.length           ? { ip:            rule.ips }                    : {}),
  ...(rule.ports                 ? { port:          rule.ports }                  : {}),
  ...(rule.sourcePorts           ? { sourcePort:    rule.sourcePorts }            : {}),
  ...(rule.protocols?.length     ? { protocol:      rule.protocols }              : {}),
  ...(rule.networks?.length      ? { network:       rule.networks.join(",") }     : {}),
  ...(rule.sources?.length       ? { source:        rule.sources }                : {}),
  ...(rule.users?.length         ? { user:          rule.users }                  : {}),
  ...(rule.attrs                 ? { attrs:         rule.attrs }                  : {}),
  ...(rule.ruleTag               ? { ruleTag:       rule.ruleTag }                : {}),
  ...(rule.domainMatcher         ? { domainMatcher: rule.domainMatcher }          : {}),
  outboundTag: resolveOutboundTag(rule.outboundTag, hop),
}
```

Note: xray's `network` field is a comma-joined string, not an array. Everything else is emitted in its native array/string form.

**Zero rules:** when a profile has no user rules, the emitted config for that hop contains only the provisioner's `inboundTag → <next-hop-or-direct>` rule. All traffic on the inbound falls through to the provisioner rule. This is the expected state for fresh hops after the wipe-and-start-fresh migration.

### `resolveOutboundTag`

- `'direct'`   → the hop's direct outbound tag (the `freedom` outbound on the panel, resolved via the existing `findFreedomOutboundTag` helper).
- `'blocked'`  → the hop's blackhole outbound tag (typically `blocked` on the panel; fall back to a known-blocked outbound if present).
- `'next-hop'` → the hop's upstream-proxy outbound tag (invalid for terminal hops; already rejected by the API layer).
- Any other string → passed through verbatim; xray performs the definitive check at config-load time.

### Reconciliation algorithm on each save

Given a hop's current `routing.rules` array fetched from its panel:

1. **Filter out** every existing rule whose `inboundTag` array intersects the hop's inbound tag set (this removes the previous snapshot of our rules and the provisioner's fallback rule).
2. **Build** the new rules block: `[userRule_0, userRule_1, ..., userRule_n, provisionerFallbackRule]`, each emitted per the mapping above.
3. **Concatenate** the new block ahead of the rules kept from step 1, so our rules fire before any operator-authored rules that target different inbounds.
4. **Write** the updated `xray` object back to the panel with the existing `updatePanelXraySetting` helper and restart xray via the existing `restartXrayService` helper (`provisionMultihopChainClientAccess` already uses both).

### Panel credentials for the PATCH push

`routing` handlers fetch panel credentials via the same path chain provisioning uses. Each hop resolves to a VPN profile, which resolves to stored `adminUsername` + encrypted `adminPassword` + `panelBaseUrl`. The PATCH handler decrypts once per request and passes them into the emitter.

### Transactional semantics of `PATCH /api/routing/:id`

The handler performs:

1. Validate the request body and compute the normalized rules list (no panel I/O).
2. Begin a SQL transaction, update `routing_profiles` (no `default_action` anymore), delete and re-insert `rules` rows. Do **not** commit yet.
3. Perform the panel push (`emitRoutingRulesToPanel`).
4. Commit the SQL transaction on panel-push success; roll back on panel-push failure.
5. Return the new profile on success; return HTTP 502 with `{ error: "panel-push-failed: <message>" }` on panel failure (the DB is unchanged).

SQLite with `bun:sqlite` supports this ordering because the transaction is held open through the async fetch; the handler serializes panel I/O inside the open transaction. Known trade-off: while the transaction is open, other routing writes on the same connection will queue. Acceptable for a per-user admin UI.

### Changes to `provisionMultihopChainClientAccess`

- After the existing `mergeInboundToOutboundRule` call, also apply the current stored routing rules for that hop via the same `emitRoutingRulesToPanel` helper, so provisioning a chain always publishes the latest rules.
- `compensateCreatedInbounds` needs no changes — it deletes inbounds on rollback; the routing rules bound to a removed inbound are removed on next emission or become orphaned rules the operator can clean up. (Orphaned-rule cleanup on chain delete is out of scope for this spec; flagged as a follow-up.)

### Removed code paths

- All reads of `defaultAction` from DB and from request bodies.
- The terminal-hop default-action validation (replaced by the per-rule `next-hop` allowlist check at the API layer).

## Validation

### Server-side (`PATCH /api/routing/:routingProfileId` and any other rule-writing path)

1. `rules` is an array (possibly empty).
2. Each rule's `outboundTag` is a non-empty string in the hop's `allowedOutboundTags`.
3. Every rule **except the last** has at least one match field (`domains`, `ips`, `ports`, `sourcePorts`, `protocols`, `networks`, `sources`, `users`, `inboundTags`, `attrs`).
4. `ports` / `sourcePorts` match `^\d+(-\d+)?(,\d+(-\d+)?)*$` and every range `a-b` satisfies `0 < a ≤ b ≤ 65535`.
5. `protocols` ⊆ `{'http','tls','bittorrent','quic'}`; `networks` ⊆ `{'tcp','udp'}`; no duplicates within a rule.
6. `domainMatcher` ∈ `{'hybrid','linear'}` if present; rejected when `domains` is empty/null.
7. `attrs` is a flat `string → string` object.
8. `ruleTag` is a non-empty string if provided (null allowed).
9. Every element in every string-array field is a non-empty trimmed string — empty strings are rejected rather than silently dropped.
10. Client-supplied `id` / `position` are ignored; server assigns `position` from array order.

Each failure returns HTTP 400 with `{ error: string, ruleIndex?: number, field?: string }`. The client uses `ruleIndex` / `field` to highlight the offending modal field.

### Client-side

Mirrors rules 1–9. Runs in the Edit modal before allowing Save and on the page-level **Save changes** button as a last check before PATCH. Gives instant per-field feedback without a round-trip; the server remains the source of truth for stale bundles.

### `allowedOutboundTags` delivery

Returned by `GET /api/routing/by-hop/:chainHopId`. The modal's outbound-tag select is populated from it. The client never guesses which tags are valid.

## Testing

### Automated tests (Bun)

1. **Schema migration** — starting from a DB at the pre-change schema with seeded profiles, old-shape `rules` rows, and `default_action` values, run the migration and assert `rules` is empty, new columns exist, old columns are gone, `routing_profiles.default_action` is gone, and `routing_profiles` rows are preserved.

2. **Routing validation unit tests** — one test per rule in the validation section; happy-path tests covering single catch-all, multi-rule profiles with various field combinations, terminal vs. middle outbound-tag allowlists, and port-string edge cases (`"80"`, `"80,443"`, `"1000-2000"`, `"80,1000-2000,8443"`; rejects `"0-100"`, `"100-99"`, `"abc"`, `"80,,443"`).

3. **Routing API integration** — extend the existing routing API test file:
   - `GET /api/routing/by-hop/:id` returns the new shape including `allowedOutboundTags`.
   - `PATCH` replaces rules atomically; failure mid-transaction leaves prior state intact.
   - Unknown fields (e.g. legacy `defaultAction`) are silently ignored.
   - Terminal hop rejects `next-hop` outbound tag.

4. **Xray emitter unit tests** (new `apps/server/src/xui/emitRoutingRulesForHop.test.ts`):
   - Rich rule (domains + ips + ports + protocols + inboundTags + attrs + ruleTag + domainMatcher) emits each key only when the source field is non-empty; `network` is comma-joined not array.
   - A rule with empty `inboundTags` gets auto-scoped with the hop's inbound tag in the emitted config.
   - A rule with non-empty `inboundTags` is emitted verbatim.
   - Reconciliation: rules with `inboundTag` intersecting the chain's inbound tags are removed from the existing panel rules; rules targeting other inbounds are preserved.
   - Positioning: user rules precede the provisioner's fallback rule; both precede any preserved unrelated rules.
   - `outboundTag` resolution for `'direct'` / `'blocked'` / `'next-hop'` maps to the hop's actual outbound tags; unknown strings pass through verbatim.

5. **Integration tests** — extend `apps/server/src/xui/provisionMultihopChainClientAccess.test.ts`:
   - On provision, stored routing rules for each hop are pushed to the panel in addition to the existing inbound→outbound fallback.
   - Routing PATCH test (in `apps/server/src/routes/routing.test.ts`) confirms the handler:
     - Pushes to the mocked panel on success.
     - Rolls back the DB write and returns 502 if the mocked panel push fails.

6. **TypeScript check** — `cd apps/web && bunx tsc -b` must pass.

### Manual / GUI testing (via `computerUse` during implementation)

Captured as walkthrough artifacts:

- Open Routing page → select a chain with a middle hop → open **Add rule** modal → fill a multi-field rule (chip inputs for domains and ips, port-string for ports, protocol checkboxes) → Save → row renders with the pill outbound tag and collapsed `Match` summary.
- Drag a rule to reorder → page state reflects the new order → click **Save changes** → reload → order persists.
- Click **Edit** on an existing rule → modify → Save.
- Switch to a terminal hop → outbound-tag select offers only `direct` / `blocked`.
- Invalid port string in the modal → inline error prevents Save.
- Catch-all rule placed not at the end → page-level Save shows validation error from the server.
- Video walkthrough of the happy path.

### Out of scope for tests

- Migration round-trip (rollback). The migration is one-way.
- E2E tests that push configs to a live 3x-ui panel beyond what already exists.

## Dependencies added

- `@dnd-kit/core` and `@dnd-kit/sortable` in `apps/web` for drag-to-reorder.

## Files expected to change

Non-exhaustive, to give scope:

**Server — schema and migration:**

- `apps/server/src/db/schema.sql` — update the `rules` table definition to the new columns; drop `routing_profiles.default_action`.
- `apps/server/src/db/migrate*.ts` — add a new `migrateRulesXrayShapeIfNeeded.ts` module called from `migrate.ts` that detects the old shape, drops the old `rules` table and `default_action` column, and recreates the new `rules` table.

**Server — routing API and validation:**

- `apps/server/src/routes/routing.ts` — new rule shape + validator + replace-all writer; updated GET/PATCH handlers and response shape; emit `allowedOutboundTags`; remove `defaultAction` handling; integrate the panel-push step into PATCH.
- `apps/server/src/routes/routing.test.ts` — updated to the new shape + new test cases.

**Server — xray emitter:**

- `apps/server/src/xui/emitRoutingRulesForHop.ts` (new) — reconciliation and mapping helper. Exposes `emitRoutingRulesToPanel` used by both the PATCH handler and `provisionMultihopChainClientAccess`.
- `apps/server/src/xui/emitRoutingRulesForHop.test.ts` (new) — unit tests for reconciliation, auto-scoping, and tag resolution.
- `apps/server/src/xui/provisionMultihopChainClientAccess.ts` — call `emitRoutingRulesToPanel` after the existing merge step so provisioning publishes current stored rules.
- `apps/server/src/xui/mergeChainRoutingIntoXray.ts` — extend to support array-of-rules insertion while keeping backward-compatible single-rule helpers.

**Server — import/export (schema ripple):**

- `apps/server/src/import/insertChainWithHops.ts` — update `insertRoutingProfilesForHops` to stop setting `default_action`; accept the new empty-rules initial state.
- `apps/server/src/import/applyImport.ts` — update routing-rule writes to the new shape; remove `defaultAction` handling.
- `apps/server/src/import/buildImportPlan.ts` — update import validation for the new rule shape; remove terminal-hop `defaultAction` check, add terminal-hop `outboundTag` check.
- `apps/server/src/import/*.test.ts`, `apps/server/src/export/*.test.ts` — updated fixtures and assertions.
- `apps/server/src/export/buildExport.ts` — export the new rule shape; drop `defaultAction`.

**Server — chains hop creation:**

- `apps/server/src/routes/chains.ts` — drop `default_action` from `insertRoutingProfilesForHops`; chains created after the migration produce empty-rules profiles.
- `apps/server/src/routes/chains.test.ts` — updated assertions.

**Web — Routing page:**

- `apps/web/src/pages/RoutingPage.tsx` — rebuild Rules table, remove Default-action fieldset, wire modal state, drag-to-reorder.
- `apps/web/src/components/` — new `RoutingRuleModal.tsx`, `ChipInput.tsx`, `OutboundTagPill.tsx`, `RuleMatchSummary.tsx` (names indicative).
- `apps/web/package.json` — add `@dnd-kit/core`, `@dnd-kit/sortable`.

**Tests:** see the Testing section.
