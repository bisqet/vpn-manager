# Routing Rules — xray / 3x-ui parity

**Date:** 2026-04-20
**Status:** Approved design, ready for implementation plan
**Scope:** Expand the per-hop Routing Rules UI and backend so each rule carries the full set of xray-core `RoutingRule` fields and the table looks like 3x-ui's routing table.

## Summary

The Routing page currently stores rules as `{ matchKind: 'domain' | 'cidr', matchValue, action }` with a separate per-hop `defaultAction`. This spec replaces that model with xray-compatible rules (`domain`, `ip`, `port`, `protocol`, `network`, `source`, `sourcePort`, `user`, `inboundTag`, `attrs`, `ruleTag`, `domainMatcher`, `outboundTag`) and drops the separate default-action control — users add an explicit catch-all rule at the end when they want a fallback.

Rules stay **per hop** (keyed by `chainHopId`). The **per-hop model is retained**; only the rule schema and the UI around it change.

The outbound-tag field is a free-text string validated at write time against a hop-specific allowlist: middle hops → `{direct, blocked, next-hop}`, terminal hops → `{direct, blocked}`.

No data is migrated from the old schema. The migration drops `routing_rules` and `routing_profiles.default_action`, recreates `routing_rules` with the new schema, and leaves users to re-enter rules on each hop.

## Non-goals

- No global (per-panel) rules table — rules remain per hop.
- No migration of existing rules into the new shape.
- No API versioning — existing `/api/routing/by-hop/:id` and `/api/routing/:id` paths evolve in place.
- No live-panel end-to-end test expansion beyond what already exists.

## Data model

### `routing_profiles`

Drop `default_action`. Keep `id`, `name`, `chain_id`, `chain_hop_id`.

### `routing_rules`

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

## Xray config generation

`provisionChainClientAccess` and `provisionMultihopChainClientAccess` in `apps/server/src/xui/` change as follows.

### Rule-to-xray mapping (`routing.rules[i]`)

```ts
{
  type: "field",
  ...(rule.inboundTags?.length   ? { inboundTag:    rule.inboundTags }            : {}),
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

Note: xray's `network` wants a comma-joined string, not an array. Everything else is emitted in its native array/string form.

**Zero rules:** when a profile has no rules, the emitted xray config contains no `routing.rules` for this hop and the implicit-default outbound ordering alone determines behavior (all traffic goes to the first outbound). This is the expected state for fresh hops after the wipe-and-start-fresh migration.

### `resolveOutboundTag`

- `'direct'`   → the hop's direct outbound tag.
- `'blocked'`  → the hop's blackhole outbound tag.
- `'next-hop'` → the hop's upstream-proxy outbound tag (invalid for terminal hops; already rejected by the API).
- Any other string → passed through verbatim; xray performs the definitive check at config-load time.

### Implicit default via outbound ordering

Each hop's emitted `outbounds` array is ordered so the hop's **proxy outbound** (or for a terminal hop, the hop's `direct` outbound) is listed first. Xray's documented behavior is that the first outbound is the default when no routing rule matches, so this replaces the old appended catch-all rule.

Relationship with user-authored catch-all rules: the outbound ordering only kicks in when **no** rule matches. A user who wants a specific fallback different from "proxy / direct" (e.g. `block` everything unmatched) still adds an explicit trailing catch-all rule — that's the user-visible knob the removed "Default action" control used to be.

### Removed code paths

- All reads of `defaultAction` from DB and from request bodies.
- The "append implicit catch-all rule" logic in chain provisioning.
- The terminal-hop default-action validation (replaced by the per-rule `next-hop` allowlist check at the API layer).

`compensateChainProvision` stays unchanged conceptually; it doesn't reference `defaultAction`, so it just needs to compile against the new types.

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

1. **Schema migration** — starting from a DB at the pre-change schema with seeded profiles, old-shape rules, and `default_action` values, run the migration and assert `routing_rules` is empty, new columns exist, old columns are gone, `routing_profiles.default_action` is gone, and profile rows are preserved.

2. **Routing validation unit tests** — one test per rule in the validation section; happy-path tests covering single catch-all, multi-rule profiles with various field combinations, terminal vs. middle outbound-tag allowlists, and port-string edge cases (`"80"`, `"80,443"`, `"1000-2000"`, `"80,1000-2000,8443"`; rejects `"0-100"`, `"100-99"`, `"abc"`, `"80,,443"`).

3. **Routing API integration** — extend the existing routing API test file:
   - `GET /api/routing/by-hop/:id` returns the new shape including `allowedOutboundTags`.
   - `PATCH` replaces rules atomically; failure mid-transaction leaves prior state intact.
   - Unknown fields (e.g. legacy `defaultAction`) are silently ignored.
   - Terminal hop rejects `next-hop` outbound tag.

4. **Xray config emission** — extend `provisionChainClientAccess.test.ts` and `provisionMultihopChainClientAccess.test.ts`:
   - Rich rule (domains + ips + ports + protocols + inboundTags + attrs + ruleTag + domainMatcher) emits each key only when the source field is non-empty; `network` is comma-joined not array.
   - Outbound ordering places the hop's proxy/direct outbound first.
   - `outboundTag` resolution for `'direct'` / `'blocked'` / `'next-hop'` maps to the hop's actual outbound tags; unknown strings pass through verbatim.

5. **TypeScript check** — `cd apps/web && bunx tsc -b` must pass.

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

- `apps/server/src/db/migrations/` — new migration dropping and recreating the rules schema.
- `apps/server/src/routing/` — new rule shape, validator, replace-all writer; remove `defaultAction` handling.
- `apps/server/src/http/routes/routing.ts` (or equivalent) — update GET/PATCH handlers and response shape; emit `allowedOutboundTags`.
- `apps/server/src/xui/provisionChainClientAccess.ts`, `provisionMultihopChainClientAccess.ts` — emit the xray routing rules from the new shape; order outbounds so the first is the implicit default.
- `apps/web/src/pages/RoutingPage.tsx` — rebuild Rules table, remove Default-action fieldset, wire modal state, drag-to-reorder.
- `apps/web/src/components/` — new `RoutingRuleModal`, `ChipInput`, `OutboundTagPill`, `RuleMatchSummary` components (names indicative, not binding).
- `apps/web/package.json` — add `@dnd-kit/core`, `@dnd-kit/sortable`.
- Test files listed in the Testing section.
