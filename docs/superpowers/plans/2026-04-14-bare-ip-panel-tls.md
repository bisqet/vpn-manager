# Bare IP (and FQDN) panel TLS — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow VPN profile `panel_hostname` to be a **FQDN or public IPv4/IPv6**, with **optional `panelHostname` on create/patch when `host` is a public IP** (derive panel from `host`); update **Caddy + verify scripts** and **web validation** accordingly.

**Architecture:** Centralize **parse / public-vs-reserved / normalize** in `apps/server/src/net/panelAddress.ts` using existing **`ip-address`** (`Address4` / `Address6`) and `isInSubnet` against a fixed list of **non-public CIDRs**. **`resolvePanelHostname({ host, panel })`** returns the string to persist or an error message. **Routes** call the resolver after Zod body parse (create + merged patch). **`buildSetupPhases`** formats **Caddy site keys** and **`curl` verify URLs** for FQDN vs IPv4 vs IPv6 (bracketed URL host for v6). **Caddy LE IP issuance:** follow **current Caddy documentation** during implementation for any extra `tls` / issuer options (do not guess).

**Tech stack:** Bun, Hono, Zod, `ip-address`, SQLite, React (VpnsPage).

---

## File map

| File | Responsibility |
|------|----------------|
| `apps/server/src/net/panelAddress.ts` (new) | Reserved CIDR lists, `isPublicIpLiteral`, `normalizeIpLiteral`, `isFqdnPanel`, `resolvePanelHostname`, optional `caddySiteAddressKey` / `httpsUrlHostForCurl` |
| `apps/server/src/net/panelAddress.test.ts` (new) | Unit tests for resolver + public IP detection |
| `apps/server/src/types.ts` | Loosen `panelHostname` on create (optional); update schema optional string; keep host/port/password rules |
| `apps/server/src/routes/profiles.ts` | Call resolver on POST; merge + resolver on PATCH; trim `host` / stored fields as needed |
| `apps/server/src/routes/profiles.test.ts` | Matrix for create/patch + setup error unchanged |
| `apps/server/src/vpn/setupPhases.ts` | Use helpers for Caddy site line + verify `curl` URL |
| `apps/server/src/vpn/setupPhases.test.ts` | Assert IPv4 / IPv6 / FQDN fragments |
| `apps/web/src/pages/VpnsPage.tsx` | Labels, help text, client validation aligned with server (optional empty panel when host is public IP) |
| `AGENTS.md` (optional small note) | Mention LE IP certs need recent Caddy + short renewal |

---

### Task 1: `panelAddress` module + unit tests

**Files:**

- Create: `apps/server/src/net/panelAddress.ts`
- Create: `apps/server/src/net/panelAddress.test.ts`
- Test: `bun test apps/server/src/net/panelAddress.test.ts`

- [ ] **Step 1: Write `apps/server/src/net/panelAddress.ts`**

Use **`ip-address`** (`Address4`, `Address6`, `AddressError`) like `apps/server/src/rules/cidr.ts`. Define **non-public** checks by testing the parsed address against **reserved CIDR strings** with `.isInSubnet(new Address4("…"))` or `Address6`.

**IPv4 reserved CIDRs** (reject if `addr.isInSubnet` is true for any):

- `0.0.0.0/8`, `10.0.0.0/8`, `127.0.0.0/8`, `169.254.0.0/16`, `172.16.0.0/12`, `192.168.0.0/16`, `100.64.0.0/10`, `224.0.0.0/4`, `240.0.0.0/4`

**IPv6 reserved CIDRs:**

- `::/128`, `::1/128`, `fe80::/10`, `fc00::/7`, `ff00::/8`, `2001:db8::/32`

**FQDN:** same pattern as today’s `types.ts` (copy the regex into this module as `FQDN_RE` or export a function `isFqdnPanel(s: string): boolean` using `/^([a-zA-Z0-9](-*[a-zA-Z0-9])*\.)+[a-zA-Z]{2,}$/`).

Implement:

```ts
import { Address4, Address6, AddressError } from "ip-address";

const RESERVED_V4 = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "100.64.0.0/10",
  "224.0.0.0/4",
  "240.0.0.0/4",
] as const;

const RESERVED_V6 = ["::/128", "::1/128", "fe80::/10", "fc00::/7", "ff00::/8", "2001:db8::/32"] as const;

const FQDN_RE = /^([a-zA-Z0-9](-*[a-zA-Z0-9])*\.)+[a-zA-Z]{2,}$/;

export function isFqdnPanel(value: string): boolean {
  return FQDN_RE.test(value);
}

function tryParseAddress(value: string): Address4 | Address6 | null {
  const v = value.trim();
  if (!v) return null;
  const looksV6 = v.includes(":");
  try {
    return looksV6 ? new Address6(v) : new Address4(v);
  } catch (e) {
    if (e instanceof AddressError) return null;
    throw e;
  }
}

function isReservedIp(addr: Address4 | Address6): boolean {
  const list = addr.v4 ? RESERVED_V4 : RESERVED_V6;
  for (const cidr of list) {
    const net = addr.v4 ? new Address4(cidr) : new Address6(cidr);
    if (addr.isInSubnet(net)) return true;
  }
  return false;
}

/** True only for global unicast public literals (no DNS lookup). */
export function isPublicIpLiteral(value: string): boolean {
  const addr = tryParseAddress(value);
  if (!addr) return false;
  if (!addr.isCorrect()) return false;
  return !isReservedIp(addr);
}

/** Normalize IP literals for storage (IPv6 RFC 5952-style via library `correctForm()`). */
export function normalizeIpLiteral(value: string): string {
  const addr = tryParseAddress(value);
  if (!addr) throw new Error("normalizeIpLiteral: not a valid IP");
  return addr.correctForm();
}

export type ResolvePanelHostnameResult =
  | { ok: true; panel: string }
  | { ok: false; message: string };

/**
 * `panel` is the trimmed explicit panel from the request or merged DB value (empty string = missing).
 * `host` is trimmed SSH host.
 */
export function resolvePanelHostname(input: { host: string; panel: string }): ResolvePanelHostnameResult {
  const h = input.host.trim();
  const p = input.panel.trim();
  if (p !== "") {
    if (isPublicIpLiteral(p)) return { ok: true, panel: normalizeIpLiteral(p) };
    if (isFqdnPanel(p)) return { ok: true, panel: p };
    return { ok: false, message: "panelHostname must be a valid FQDN or a public IP address." };
  }
  if (isPublicIpLiteral(h)) return { ok: true, panel: normalizeIpLiteral(h) };
  return {
    ok: false,
    message: "panelHostname is required unless host is a public IP address.",
  };
}

/** Caddy site address key (first token of site block, before `{`). */
export function caddySiteAddressKey(panel: string): string {
  if (isPublicIpLiteral(panel)) {
    const norm = normalizeIpLiteral(panel);
    return norm.includes(":") ? `[${norm}]` : norm;
  }
  return panel;
}

/** Host portion for https URL (IPv6 bracketed). */
export function httpsUrlHost(panel: string): string {
  if (isPublicIpLiteral(panel)) {
    const norm = normalizeIpLiteral(panel);
    return norm.includes(":") ? `[${norm}]` : norm;
  }
  return panel;
}
```

- [ ] **Step 2: Write failing tests in `apps/server/src/net/panelAddress.test.ts`**

```ts
import { describe, expect, test } from "bun:test";
import {
  caddySiteAddressKey,
  httpsUrlHost,
  isPublicIpLiteral,
  resolvePanelHostname,
} from "./panelAddress";

describe("isPublicIpLiteral", () => {
  test("accepts public IPv4", () => {
    expect(isPublicIpLiteral("203.0.113.10")).toBe(true);
  });
  test("rejects RFC1918", () => {
    expect(isPublicIpLiteral("10.0.0.1")).toBe(false);
  });
  test("rejects loopback", () => {
    expect(isPublicIpLiteral("127.0.0.1")).toBe(false);
  });
  test("accepts public IPv6", () => {
    expect(isPublicIpLiteral("2001:4860:4860::8888")).toBe(true);
  });
  test("rejects ULA", () => {
    expect(isPublicIpLiteral("fd12:3456:789a::1")).toBe(false);
  });
});

describe("resolvePanelHostname", () => {
  test("derives from host when panel empty and host public", () => {
    expect(resolvePanelHostname({ host: "203.0.113.1", panel: "" })).toEqual({
      ok: true,
      panel: "203.0.113.1",
    });
  });
  test("requires panel when host not public", () => {
    const r = resolvePanelHostname({ host: "vpn.internal", panel: "" });
    expect(r.ok).toBe(false);
  });
  test("accepts FQDN panel with non-public host", () => {
    expect(resolvePanelHostname({ host: "10.0.0.1", panel: "panel.example.com" })).toEqual({
      ok: true,
      panel: "panel.example.com",
    });
  });
});

describe("caddySiteAddressKey / httpsUrlHost", () => {
  test("brackets IPv6", () => {
    expect(caddySiteAddressKey("2001:db8::1")).toBe("[2001:db8::1]");
    expect(httpsUrlHost("2001:db8::1")).toBe("[2001:db8::1]");
  });
});
```

- [ ] **Step 3: Run tests**

Run: `bun test apps/server/src/net/panelAddress.test.ts`  
Expected: **PASS**

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/net/panelAddress.ts apps/server/src/net/panelAddress.test.ts
git commit -m "feat(server): add panel address parsing, public IP checks, and resolver"
```

---

### Task 2: Zod types for optional `panelHostname`

**Files:**

- Modify: `apps/server/src/types.ts`
- Test: `bun test apps/server/src/routes/profiles.test.ts` (will be updated in Task 3; run after Task 3 for green)

- [ ] **Step 1: Change `vpnProfileCreate`**

- `panelHostname`: `z.union([z.string(), z.undefined()]).optional()` — allow **omit** or **string** (including `""`).
- Remove the old **required** `panelHostnameSchema` from create only; keep a shared **`panelHostnameStringSchema`** as `z.string()` for trimming if desired, or leave unbounded and validate in resolver.

Minimal shape:

```ts
import { z } from "zod";

const panelHostnameStringSchema = z.string();

export const vpnProfileCreate = z.object({
  label: z.string().min(1),
  host: z.string().min(1),
  sshPort: z.number().int().min(1).max(65535),
  sshUser: z.string().min(1),
  sshPassword: z.string().min(1),
  panelHostname: panelHostnameStringSchema.optional(),
});
```

- [ ] **Step 2: Change `vpnProfileUpdate`**

```ts
export const vpnProfileUpdate = z.object({
  label: z.string().min(1).optional(),
  host: z.string().min(1).optional(),
  sshPort: z.number().int().min(1).max(65535).optional(),
  sshUser: z.string().min(1).optional(),
  sshPassword: z.string().min(1).optional(),
  panelHostname: panelHostnameStringSchema.optional(),
});
```

(Structural validation of FQDN vs IP happens in **`resolvePanelHostname`**, not in Zod, so PATCH can send `panelHostname: ""`.)

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/types.ts
git commit -m "feat(server): make panelHostname optional on VPN profile create/update"
```

---

### Task 3: `profiles` POST + PATCH use resolver

**Files:**

- Modify: `apps/server/src/routes/profiles.ts`
- Modify: `apps/server/src/routes/profiles.test.ts`

- [ ] **Step 1: Import and use resolver in POST**

After `safeParse` succeeds:

```ts
import { resolvePanelHostname } from "../net/panelAddress";

// inside POST handler:
const { label, host, sshPort, sshUser, sshPassword, panelHostname } = parsed.data;
const hostTrimmed = host.trim();
const panelRaw = panelHostname?.trim() ?? "";
const resolved = resolvePanelHostname({ host: hostTrimmed, panel: panelRaw });
if (!resolved.ok) {
  return c.json({ error: resolved.message }, 400);
}
const { ciphertext, nonce } = await encryptVpnPassword(env.masterKey, sshPassword);
// INSERT ... resolved.panel (store trimmed host as today or hostTrimmed — pick one and stay consistent)
```

Use **`hostTrimmed`** for `INSERT` `host` column if you want consistency with trim-on-write.

- [ ] **Step 2: PATCH merge + resolver**

After `safeParse` on PATCH:

```ts
import { resolvePanelHostname } from "../net/panelAddress";

const mergedHost = (host ?? existing.host).trim();
const mergedPanelRaw =
  panelHostname !== undefined ? panelHostname.trim() : existing.panel_hostname.trim();
const resolved = resolvePanelHostname({ host: mergedHost, panel: mergedPanelRaw });
if (!resolved.ok) {
  return c.json({ error: resolved.message }, 400);
}
// UPDATE uses mergedHost for host column, resolved.panel for panel_hostname
```

- [ ] **Step 3: Extend `profiles.test.ts`**

Add tests (names illustrative):

- **POST** public IP host, **omit** `panelHostname` → **201**, body `panelHostname` equals normalized IP.
- **POST** private host, omit `panelHostname` → **400**, message mentions required panel.
- **POST** explicit `panelHostname` public IP → stored normalized.
- **PATCH** change `host` to public IP, set `panelHostname` to `""` → derived panel (if your merge treats `""` as “clear”; must match resolver: `panelHostname !== undefined` with `""` → trim → empty → derive).

Adjust existing tests that assumed **required** `panelHostname` on create: keep at least one **FQDN** create test; add IP cases.

- [ ] **Step 4: Run server tests**

Run: `bun test apps/server/src/routes/profiles.test.ts`  
Expected: **PASS**

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/routes/profiles.ts apps/server/src/routes/profiles.test.ts
git commit -m "feat(server): resolve panel hostname from host when public IP"
```

---

### Task 4: `setupPhases` Caddy + verify URL

**Files:**

- Modify: `apps/server/src/vpn/setupPhases.ts`
- Modify: `apps/server/src/vpn/setupPhases.test.ts`

- [ ] **Step 1: Import helpers in `setupPhases.ts`**

```ts
import { caddySiteAddressKey, httpsUrlHost } from "../net/panelAddress";
```

In **`buildSetupPhases`**, replace bare `${panelHostname}` in the Caddy heredoc site line with **`${caddySiteAddressKey(panelHostname)}`**.

In the **verify** phase script, replace:

```bash
curl -fsS -o /dev/null "https://${panelHostname}${webPathForUrl}/"
```

with:

```bash
curl -fsS -g -o /dev/null "https://${httpsUrlHost(panelHostname)}${webPathForUrl}/"
```

(`-g` disables URL globbing so literal `[]` in IPv6 URLs is safe.)

- [ ] **Step 2: Documented Caddy / LE IP options (implementation research)**

Open current Caddy docs for **automatic HTTPS on IP addresses** (e.g. `https://caddyserver.com/docs/automatic-https` and search for “IP”). If the docs require **extra `tls` or global options** for Let’s Encrypt IP certificates (short-lived profile, etc.), add **only** those directives to the **`configure_caddy`** script template in this file, with a short comment in source pointing to the doc URL. If **no** extra directives are required for your minimum Caddy version, **do not add** guessed config.

- [ ] **Step 3: Extend `setupPhases.test.ts`**

```ts
test("caddy site key and verify URL support IPv4 and IPv6", () => {
  const v4 = buildSetupPhases({
    panelHostname: "203.0.113.5",
    acmeEmail: "ops@example.com",
    xuiLocalPort: 2053,
    adminUsername: "u",
    adminPassword: "p",
    webBasePath: "abc",
  });
  const joined4 = v4.map((p) => p.script).join("\n");
  expect(joined4).toContain("203.0.113.5 {");
  expect(joined4).toContain("https://203.0.113.5/");

  const v6 = buildSetupPhases({
    panelHostname: "2001:db8::1",
    acmeEmail: "ops@example.com",
    xuiLocalPort: 2053,
    adminUsername: "u",
    adminPassword: "p",
    webBasePath: "abc",
  });
  const joined6 = v6.map((p) => p.script).join("\n");
  expect(joined6).toContain("[2001:db8::1] {");
  expect(joined6).toContain("https://[2001:db8::1]/");
});
```

- [ ] **Step 4: Run tests**

Run: `bun test apps/server/src/vpn/setupPhases.test.ts`  
Expected: **PASS**

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/vpn/setupPhases.ts apps/server/src/vpn/setupPhases.test.ts
git commit -m "feat(server): format Caddy and verify URLs for IP panel addresses"
```

---

### Task 5: Web — `VpnsPage` labels + validation

**Files:**

- Modify: `apps/web/src/pages/VpnsPage.tsx`

- [ ] **Step 1: Share client-side “public IP” check or keep server-only**

**Minimum:** mirror **`resolvePanelHostname`** error messages on submit by calling the same rules **or** a thin duplicate: if `panelHostname` empty and `host` matches a **simple** public IPv4 regex, allow submit; otherwise require FQDN. **Better:** add **`apps/web/src/lib/panelAddress.ts`** that duplicates **`isPublicIpLiteral` + `isFqdnPanel`** only (copy regex + document “keep in sync with server”) **or** import shared code if you later extract a `packages/shared` package (YAGNI: duplicate small checks in web for now).

Recommended for this repo: **duplicate** `isPublicIpLiteral` / `isFqdnPanel` in `apps/web/src/lib/panelAddress.ts` with **same CIDR logic** as server (copy the constants and functions) to avoid bundling server-only deps in Vite.

- [ ] **Step 2: Update `validateFormValues`**

Replace “panel must be FQDN” with:

- If `panelHostname.trim()` non-empty: require **FQDN OR public IP** (same messages as server).
- If empty: allow only if **`isPublicIpLiteral(host.trim())`**; else error: panel required unless host is public IP.

- [ ] **Step 3: UI copy**

- Label: **Panel address (FQDN or public IP)**
- Hint under field matching spec.

- [ ] **Step 4: Typecheck web**

Run: `cd apps/web && bunx tsc -b`  
Expected: **no errors**

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/VpnsPage.tsx apps/web/src/lib/panelAddress.ts
git commit -m "feat(web): panel FQDN or public IP and optional panel when host is public"
```

---

### Task 6: Docs + final verification

**Files:**

- Modify: `AGENTS.md` (short bullet under server/VPN setup)

- [ ] **Step 1: AGENTS.md**

Add one bullet: **Panel TLS** may use **Let’s Encrypt IP certificates** (short-lived); target server needs a **recent Caddy**; see design spec `docs/superpowers/specs/2026-04-14-bare-ip-panel-tls-design.md`.

- [ ] **Step 2: Full server test run**

Run: `bun test apps/server`  
Expected: **all PASS**

- [ ] **Step 3: Commit**

```bash
git add AGENTS.md
git commit -m "docs: note LE IP certs and Caddy for panel TLS"
```

---

## Plan self-review

**1. Spec coverage**

| Spec section | Task |
|--------------|------|
| FQDN or public IP panel | Task 1 resolver; Task 2–3 routes |
| Omit panel when host public IP | Task 1 `resolvePanelHostname`; Task 3 POST/PATCH |
| No DNS resolution for derivation | Task 1 only parses literals |
| IPv6 RFC 5952 storage | Task 1 `normalizeIpLiteral` → `correctForm()` |
| Caddy site + verify URL | Task 4 |
| LE IP / Caddy version note | Task 4 research step + Task 6 AGENTS |
| Web UX | Task 5 |
| Tests | Tasks 1, 3, 4, 5 |

**2. Placeholder scan:** No `TBD` / vague “add validation” steps; research step points to **reading Caddy docs** instead of inventing directives.

**3. Type consistency:** Single resolver return shape `{ ok, panel | message }`; DB column stays `panel_hostname`; JSON field stays `panelHostname`.

---

**Plan complete and saved to `docs/superpowers/plans/2026-04-14-bare-ip-panel-tls.md`. Two execution options:**

**1. Subagent-driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline execution** — run tasks in this session using executing-plans-style checkpoints.

**Which approach do you want?**
