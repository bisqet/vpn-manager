# Import screen — bundles, export v2, VPN profiles, and server preview/apply

**Date:** 2026-04-14  
**Status:** Approved (design sections 1–4 signed off in session)  
**Scope:** New **Import** page in the web app (file + drag-and-drop, clipboard, large text input), client-side merge of multiple JSON sources, **server-side parse preview and transactional apply**, supporting **export v2** payloads, **v3 multi-chain bundles**, **multiple files**, and **single-VPN** documents (API-shaped, extended bundle entries, or bare-object detection).

## 1. Problem and intent

Today only **Export** exists (`ExportPage`, `GET /api/chains/:id/export`, `buildExportV2`). Operators need a symmetric **Import** path to:

1. Restore or replicate **routing + chain topology** from **export v2** JSON.
2. Import **several chains** in one operation via a **versioned bundle** and/or **multiple JSON files**.
3. Import **VPN profiles** alone or alongside chains, accepting **multiple input shapes** (see section 3).

Import must be **safe and inspectable**: **preview** before **apply**, clear validation errors, and **atomic apply** (all-or-nothing per request).

## 2. Accepted payloads and detection order

All inputs are interpreted as **UTF-8 text**. A **UTF-8 BOM** (if present) is stripped before `JSON.parse`. **Strict JSON** only (no JSON5, no trailing commas).

### 2.1 Client-side merge (multiple files / textarea / clipboard)

- The browser reads each **file** as text and parses JSON independently.
- **Clipboard** and **textarea** supply one JSON document each (clipboard may be merged as an additional “virtual document” using the same rules as one file).
- **Merge rule:** each parsed **root** that is already a **v3 bundle** contributes its `chains[]` and `vpns[]` into a **single synthetic v3** `{ "schemaVersion": 3, "chains": [...], "vpns": [...] }` by concatenating arrays in order: **textarea first** (if present), then **clipboard** (if merged), then **files in selection/drop order**.
- Each parsed root that is a **v2 export** is appended as one element of the merged **`chains`** array (wrapped as the v2 object itself, not nested).
- Each parsed root that is a **bare VPN** (section 2.4) appends one element to merged **`vpns`**.
- If after merge the synthetic document has **both** `chains` and `vpns` empty → **validation error** (nothing to import).

**Conflict rule after merge:** if **two or more** v2 objects share the same **`chainId`** and **`exportedAt`** when both fields are present → **blocking error**. If **`name`** collisions occur for chains to be created → **warning** only; generated internal names may get a numeric suffix (implementation detail) as long as the DB `name` remains unique.

### 2.2 Version 3 bundle (multi-chain + multi-VPN)

Top-level shape:

```json
{
  "schemaVersion": 3,
  "chains": [ /* 0..n export-v2-shaped objects */ ],
  "vpns": [ /* 0..m VPN entries, see 2.5 */ ]
}
```

- **`chains`** and **`vpns`** are optional keys; **omitted** is treated like **empty array**.
- **Valid:** at least one of `chains` or `vpns` has **length ≥ 1** after client merge (otherwise error as above).
- Each element of **`chains`** must satisfy the **export v2** contract (section 2.3) including **`schemaVersion: 2`** on that object.

### 2.3 Export v2 (single chain document)

Unchanged contract from `buildExportV2` / existing export: **`schemaVersion: 2`**, `exportedAt`, `chainId`, `chain[]`, `routingByHop[]`, etc. Import **never** trusts `chainId` / old DB ids as final primary keys (section 4).

### 2.4 Bare single-VPN detection (heuristic C)

If the root is a **plain object** and **does not** qualify as v3 or v2 after steps **2.5.1–2.5.2**, treat it as a **bare VPN** when **all** hold:

- Has **`host`** (non-empty string), **`sshUser`** (non-empty string), **`sshPort`** (integer in valid port range).
- Does **not** contain **`routingByHop`** (export v2 marker).
- If the root has a **`chain`** property and it is a **non-empty array** and **`schemaVersion` is not `2`**, treat as **ambiguous** → **blocking error** (“Use `schemaVersion`: 2 or 3, or remove `chain` / use `vpns`”). Objects with **`schemaVersion: 2`** are handled earlier (section 2.6).
- Does **not** have **`schemaVersion`** equal to **2** or **3** (if `schemaVersion` is another number → **blocking error** unknown version).

Heuristic edge cases are **errors** with a message pointing users to wrap ambiguous content in **`schemaVersion: 3`**.

### 2.5 VPN entries (forms A and B)

**A — API-aligned:** object validates against the same logical fields as **`POST /api/vpn-profiles`** today (`label`, `host`, `sshPort`, `sshUser`, `sshPassword`, `panelHostname` per existing Zod schemas). For bundle import, **`sshPassword` may be omitted** in JSON; then it must be supplied via the **password map** on apply (section 4), same as passwords for hops inferred from v2.

**B — Extended:** same as A plus **optional documented fields** (listed in implementation); unknown keys are **stripped** or **rejected** — pick **reject** with 400 for unknown top-level keys on VPN objects to avoid silent data loss (spec choice: **reject** unknown keys on `vpns[]` and bare VPN).

**C** is the **bare** detection in 2.4; **A** and **B** also apply to objects inside **`vpns[]`**.

### 2.6 Parser detection order (server)

On the **merged single document** received by the server:

1. If **`schemaVersion === 3`** with object shape → validate v3 bundle.
2. Else if **`schemaVersion === 2`** with v2 export shape → treat as **one chain** import (equivalent to v3 with `chains: [obj]`, `vpns: []`).
3. Else if bare VPN heuristic matches → treat as **one VPN** import (`vpns: [obj]`).
4. Else → **blocking error** (“Unrecognized import document”).

The **client** should normalize multi-file results into v3 **before** POST when the merge contains **more than one** v2 root or mixes types; the server still accepts a **single** v2 or bare VPN at root for simple cases.

## 3. Web UI — Import page

**Route:** `/import`. **Nav:** add **Import** beside **Export** in `App.tsx` nav items. Visual patterns mirror **`ExportPage`** (card, eyebrow, typography, buttons).

### 3.1 Input modes

1. **Files:** `<input type="file" accept=".json,application/json" multiple />` plus **drag-and-drop** zone. List selected files with name, size, remove control, and **per-file parse error** if `JSON.parse` fails.
2. **Clipboard:** button **Paste from clipboard** using **`navigator.clipboard.readText()`** when available; on failure, show short guidance to paste into the textarea (permissions / non-secure context).
3. **Large input:** `<textarea>` (roughly **40vh** min height) for raw JSON.

All successful parses feed the **merge** pipeline (section 2.1), then one **`POST /api/import/preview`** with the merged JSON as the request body (section 5).

### 3.2 Preview panel

- **Parse & preview** button (default: **manual** parse; no auto-parse on every keystroke).
- Response drives UI: **plan** (counts, chain names, hops, rules, link-vs-create for profiles), **warnings** (non-blocking, amber), **errors** (blocking, red).
- **Password table:** one row per **new** profile required for the plan with **missing** password in source data; columns include suggested **label**, **host**, **ssh user**, **masked password** input. Keys must match **`passwords`** map keys returned from preview (section 5).

### 3.3 Actions

- **Apply import** — enabled only when preview reports **no blocking errors** and all required **password** fields are filled in the UI. Submits **`POST /api/import/apply`**.

### 3.4 Limits (client + server)

- **Total decoded UTF-8** after merge: max **10 MB** (hard error).
- **Max files** per operation: **50** (hard error).

## 4. Apply semantics, linking, passwords, transactions

### 4.1 Preview vs apply

- **Preview:** no DB writes; returns plan, warnings, errors, and stable **`passwordKeys`** for missing secrets.
- **Apply:** validates again, then runs **one SQLite transaction**. Any failure → full rollback, single error response.

### 4.2 ID remapping

- Exported **`chainId`**, **`chainHopId`**, **`profileId`**, and **`routingProfileId`** are **remapped** to newly created rows. **No** reuse of foreign IDs from the file as primary keys.

### 4.3 VPN profiles from v2 chain entries

- Export v2 lists **`host`**, **`sshPort`**, **`sshUser`** per hop but **not** `sshPassword`.
- **Before insert:** for each hop needing a profile row, if an **existing** row matches **`host` + `ssh_port` + `ssh_user`** (normalize host string consistently), **link** that hop to the existing profile and **do not** require a password for that hop.
- Otherwise require a password in **`passwords`** for the stable key **`newProfile:<chainIndex>:<hopIndex>`** (or server-defined equivalent returned in preview).

### 4.4 Chain creation

- **v1 product rule:** each v2 document creates a **new** chain (new `chains` row + `chain_hops` + `routing_profiles` + rules). **Merging into an existing chain** is **out of scope** unless added in a later spec.

### 4.5 Routing

- Recreate **routing profiles** and **rules** from **`routingByHop`** against **new** hop ids, preserving order and actions, subject to the same **terminal-hop default_action** constraints as the rest of the product (existing migrations/rules).

### 4.6 Naming collisions

- **Warnings** when display **`name`** may collide; DB must remain consistent (unique `chains.name` via suffix or disambiguation in implementation — choose **suffix** ` (imported N)`** as needed).

## 5. HTTP API

Both routes require **authenticated session** (same as other `/api` routes).

### 5.1 `POST /api/import/preview`

- **Request body:** the **merged import JSON** (single object: v3, v2, or bare VPN) — `Content-Type: application/json`.
- **Response 200:** `{ "canApply": boolean, "plan": <object | null>, "warnings": string[], "errors": string[], "passwordKeys": string[] }`. **`canApply`** is **true** iff **`errors`** is empty and **`plan`** is non-null. Semantic / validation problems use **200** with **`canApply: false`** and human-readable **`errors`** (same style as returning validation feedback in-body). Malformed JSON or over-size body → **400** or **413** as appropriate.
- **Response 400:** invalid JSON syntax, missing `Content-Type`, payload over size limit.

### 5.2 `POST /api/import/apply`

- **Request body:**

```json
{
  "import": { /* same merged JSON as preview */ },
  "passwords": {
    "newProfile:0:1": "plaintext-ssh-password",
    "...": "..."
  }
}
```

- Server **re-validates** `import` and checks every required **`passwords`** key is present and non-empty.
- **Response 200:** summary `{ "chainsCreated": n, "profilesCreated": m, "profilesLinked": p, ... }` (exact fields in implementation plan).
- **Response 400:** validation or missing password.

## 6. Parser and testing

### 6.1 Code organization

- Implement **`parseImportDocument`** in **`apps/server`** with **Zod** schemas aligned to existing **`vpnProfileCreate`** and export v2 types; used exclusively by preview and apply handlers.

### 6.2 Tests

- **Unit tests** for parser: v3 chains only, vpns only, both; v2 single; bare VPN; invalid version; ambiguous object; BOM handling; empty v3.
- **Route integration tests:** preview happy path, apply creates expected rows, apply **rolls back** on injected failure (e.g. force DB error after first insert in test).
- **Web (optional):** minimal render test for Import page if the repo’s web test setup stays lightweight.

## 7. Non-goals (this spec)

- **Merge import into an existing chain** by id picker.
- **JSON5** or non-JSON formats (YAML, zip archives).
- **Streaming** or partial apply across multiple HTTP requests.
- **Import** of secrets that are **not** SSH passwords (e.g. x-ui secrets) unless already present in the JSON and supported by existing types — not required here.

## 8. Implementation follow-up

After this spec is reviewed in-repo, use the **writing-plans** skill to produce a dated implementation plan under `docs/superpowers/plans/` with ordered tasks (server parser + routes + tests, then web Import page + nav + API client).
