# Chain VLESS + REALITY client access — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add **Generate profile** for **single-hop** chains so each click provisions a **new** VLESS + REALITY (`yahoo.com`, `xtls-rprx-vision`) inbound on the hop’s **3x-ui** host and shows a **modal** with **VLESS share link** and **subscription URL**.

**Architecture:** The VPN Manager API extends **`chainsRoutes`** with **`POST /api/chains/:id/generate-profile`**, passing **`masterKey`** for decrypting **`xui_secrets_*`**. A dedicated **`xui`** module performs **cookie-based panel login** and **`POST /panel/api/inbounds/add`**, then derives the **VLESS URI** and **subscription URL** from the panel response and inbound settings (same HTTPS base URL pattern as **`GET /api/profiles/:id/panel-login`**). The web app calls this endpoint and renders a **modal** with two copy fields. **No SQLite persistence** of created inbounds in v1.

**Tech Stack:** Bun, Hono, `bun:test`, TanStack Query, React; outbound HTTPS via global **`fetch`** (injectable in tests).

**Spec:** `docs/superpowers/specs/2026-04-17-chain-vless-reality-client-access-design.md`

---

## File map (create / modify)

| File | Role |
|------|------|
| `apps/server/src/xui/realityKeyMaterial.ts` | Generate UUID, shortId, and REALITY key material (private key + public key encoding) compatible with Xray/3x-ui expectations. Keep small and tested. |
| `apps/server/src/xui/buildVlessRealityInboundBody.ts` | Builds the JSON body (matching 3x-ui `Inbound` form fields: `protocol`, `port`, `listen`, `settings`, `streamSettings`, `sniffing`, `remark`, `enable`, etc.) for **VLESS + REALITY** with **dest `yahoo.com`**, client **flow `xtls-rprx-vision`**, and **listen `0.0.0.0`**. |
| `apps/server/src/xui/provisionChainClientAccess.ts` | Orchestrates `buildPanelHttpsUrl` → login → `inbounds/add` → parse **`vlessShareLink`** + **`subscriptionUrl`**. Accepts **`fetch`** and optional **`now`** for tests. |
| `apps/server/src/xui/provisionChainClientAccess.test.ts` | HTTP-mocked tests for login failure, add failure, success path. |
| `apps/server/src/routes/chains.ts` | New **`POST /:id/generate-profile`** route; extend **`chainsRoutes(db, env)`** with **`Pick<Env, "masterKey">`**. |
| `apps/server/src/routes/chains.test.ts` | Auth, hop-count validation, non-working profile, happy path with **mocked `provisionChainClientAccess`** or injected fetch at route boundary (prefer **exporting a test-only hook** only if unavoidable; cleaner: mock **`fetch`** globally in that test file via `globalThis.fetch`). |
| `apps/server/src/index.ts` | Pass **`env`** into **`chainsRoutes`**. |
| `apps/web/src/pages/ChainsPage.tsx` | **Generate profile** button (only when **`chain.hops.length === 1`** and that hop’s profile is **`working`**), mutation, modal UI. |

**Reference upstream (read before coding bodies):**

- `https://github.com/MHSanaei/3x-ui/blob/main/web/controller/inbound.go` — routes under **`/panel/api/inbounds/`** (`add`, `list`, `get/:id`).
- Login route and cookie name: search **`login`** in the same repo’s **`web/controller`** and **`web/session`** (cookie is commonly tied to the **`3x-ui`** session name; **verify in source**, do not guess in production without confirmation).

---

### Task 1: REALITY key material + inbound JSON builder

**Files:**

- Create: `apps/server/src/xui/realityKeyMaterial.ts`
- Create: `apps/server/src/xui/buildVlessRealityInboundBody.ts`
- Test: `apps/server/src/xui/realityKeyMaterial.test.ts` and `apps/server/src/xui/buildVlessRealityInboundBody.test.ts`

**Procedure:** Capture one working **VLESS + REALITY** inbound JSON from a **dev panel** (Network tab on **Add inbound** → copy request payload), then generalize into **`buildVlessRealityInboundBody(input)`** where `input` includes at least **`port`**, **`clientUuid`**, **`clientEmail`**, **`realityPrivateKeyB64`**, **`realityPublicKeyB64`**, **`shortId`**, **`subId`**. Constants: **`dest: "yahoo.com"`**, **`serverNames` including `yahoo.com`**, client **`flow: "xtls-rprx-vision"`**. **`realityKeyMaterial.ts`** generates random **`shortId`** (hex, length per Xray conventions), **`clientUuid`**, and an **x25519** keypair, exporting keys in the **same base64 encoding** your captured sample uses.

- [ ] **Step 1: Write failing test for key material shape**

```typescript
import { describe, expect, test } from "bun:test";
import { generateRealityClientMaterial } from "./realityKeyMaterial";

describe("generateRealityClientMaterial", () => {
  test("returns uuid, subId-like string, shortId hex, and non-empty x25519 keys as base64", () => {
    const a = generateRealityClientMaterial();
    const b = generateRealityClientMaterial();
    expect(a.clientUuid).not.toBe(b.clientUuid);
    expect(a.shortId.length).toBeGreaterThan(0);
    expect(a.realityPrivateKeyB64.length).toBeGreaterThan(20);
    expect(a.realityPublicKeyB64.length).toBeGreaterThan(20);
    expect(a.subId.length).toBeGreaterThan(8);
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

Run: `bun test apps/server/src/xui/realityKeyMaterial.test.ts`  
Expected: FAIL (module missing).

- [ ] **Step 3: Implement `realityKeyMaterial.ts`**

Use `crypto.getRandomValues` for UUID bytes and shortId; use **`crypto.subtle` X25519** key generation if available in Bun, or **`nacl`** only if already in repo (check `package.json` first; **avoid new deps** unless necessary).

- [ ] **Step 4: Write failing test for inbound body JSON**

```typescript
import { describe, expect, test } from "bun:test";
import { buildVlessRealityInboundBody } from "./buildVlessRealityInboundBody";

describe("buildVlessRealityInboundBody", () => {
  test("includes vless protocol, vision flow, and yahoo.com reality dest", () => {
    const body = buildVlessRealityInboundBody({
      port: 443,
      remark: "vpn-mgr-test",
      clientEmail: "u1@local",
      clientUuid: "11111111-1111-4111-8111-111111111111",
      subId: "subidtest12",
      shortId: "0123456789abcdef",
      realityPrivateKeyB64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      realityPublicKeyB64: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=",
    });
    expect(body.protocol).toBe("vless");
    expect(body.port).toBe(443);
    const stream = JSON.parse(body.streamSettings);
    expect(stream.security).toBe("reality");
    expect(stream.realitySettings?.dest).toBe("yahoo.com");
    const settings = JSON.parse(body.settings);
    expect(settings.clients[0].flow).toBe("xtls-rprx-vision");
    expect(settings.clients[0].email).toBe("u1@local");
  });
});
```

Adjust JSON paths (`realitySettings` vs nested keys) to **match your captured 3x-ui sample** exactly.

- [ ] **Step 5: Run tests — expect PASS**

Run: `bun test apps/server/src/xui/realityKeyMaterial.test.ts apps/server/src/xui/buildVlessRealityInboundBody.test.ts`

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/xui/realityKeyMaterial.ts apps/server/src/xui/realityKeyMaterial.test.ts apps/server/src/xui/buildVlessRealityInboundBody.ts apps/server/src/xui/buildVlessRealityInboundBody.test.ts
git commit -m "feat(server): add VLESS+REALITY inbound body builder for 3x-ui"
```

---

### Task 2: Panel provision orchestration (login + add inbound + URLs)

**Files:**

- Create: `apps/server/src/xui/provisionChainClientAccess.ts`
- Create: `apps/server/src/xui/provisionChainClientAccess.test.ts`

**Types (export from `provisionChainClientAccess.ts`):**

```typescript
export type ChainClientAccessResult = {
  vlessShareLink: string;
  subscriptionUrl: string;
};

export type ProvisionChainClientAccessInput = {
  panelBaseUrl: string; // trailing slash optional; normalize internally
  adminUsername: string;
  adminPassword: string;
  inboundBody: Record<string, unknown>; // output of buildVlessRealityInboundBody
  fetchFn?: typeof fetch;
};
```

**VLESS link:** After successful **`add`**, 3x-ui returns an **`Inbound`** object in **`obj`** (see **`jsonMsgObj`** usage in upstream **`addInbound`**). If the response does **not** include a ready-made URI, build **`vless://`** from **`panel_hostname`**, **`port`**, **`clientUuid`**, **`flow`**, **`security=reality`**, **`pbk`**, **`fp`**, **`sni`**, **`sid`**, **`spx`**, **`type=tcp`** per Xray URI rules — **prefer panel-provided link** if present on the model or on nested client stats. **Subscription URL:** Build `new URL(\`sub/${subId}\`, panelBaseUrl).href` **only after** confirming the path against your panel’s **Subscription** route (inspect panel; many use **`/sub/:id`**). If the panel uses a **different pattern**, encode that in one function **`buildSubscriptionUrl(panelBaseUrl, subId)`** with a unit test.

- [ ] **Step 1: Write failing test with mock `fetch`**

```typescript
import { describe, expect, mock, test } from "bun:test";
import { provisionChainClientAccess } from "./provisionChainClientAccess";

describe("provisionChainClientAccess", () => {
  test("logs in, posts add, returns vless + subscription", async () => {
    const calls: string[] = [];
    const fetchFn = mock(async (input: RequestInfo, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.url;
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/login")) {
        return new Response(JSON.stringify({ success: true, msg: "ok" }), {
          status: 200,
          headers: { "Set-Cookie": "3x-ui=abc; Path=/" },
        });
      }
      if (url.includes("/panel/api/inbounds/add")) {
        return new Response(
          JSON.stringify({
            success: true,
            msg: "created",
            obj: {
              port: 443,
              settings: JSON.stringify({
                clients: [
                  {
                    id: "11111111-1111-4111-8111-111111111111",
                    email: "u1@local",
                    subId: "subidtest12",
                    flow: "xtls-rprx-vision",
                  },
                ],
              }),
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    });

    const inboundBody = {
      protocol: "vless",
      port: 443,
      listen: "0.0.0.0",
      remark: "r",
      enable: true,
      settings: "{}",
      streamSettings: "{}",
      sniffing: "{}",
    };

    const out = await provisionChainClientAccess({
      panelBaseUrl: "https://panel.example.com/p/",
      adminUsername: "a",
      adminPassword: "b",
      inboundBody,
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(calls.some((c) => c.includes("POST") && c.endsWith("/login"))).toBe(true);
    expect(out.subscriptionUrl).toContain("subidtest12");
    expect(out.vlessShareLink.startsWith("vless://")).toBe(true);
  });
});
```

Tune assertions to your real **`provisionChainClientAccess`** return shape once implemented.

- [ ] **Step 2: Run test — expect FAIL**

Run: `bun test apps/server/src/xui/provisionChainClientAccess.test.ts`

- [ ] **Step 3: Implement `provisionChainClientAccess.ts`**

1. Normalize **`panelBaseUrl`** to end with **`/`**.  
2. **`POST`** login using the **same content type** the panel expects (verify from 3x-ui: often **`application/x-www-form-urlencoded`** with **`username`**, **`password`**, **`twoFactorCode`** empty).  
3. Forward **`Set-Cookie`** on subsequent **`POST {base}panel/api/inbounds/add`** with **`Content-Type: application/json`** (or form type the panel expects — **`ShouldBind`** in upstream suggests **JSON** for inbounds).  
4. Parse JSON; if **`success` is false**, throw a typed error **`PanelRequestError`** carrying **`msg`**.  
5. Never **`console.log`** full URLs.

- [ ] **Step 4: Run test — expect PASS**

Run: `bun test apps/server/src/xui/provisionChainClientAccess.test.ts`

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/xui/provisionChainClientAccess.ts apps/server/src/xui/provisionChainClientAccess.test.ts
git commit -m "feat(server): provision VLESS+REALITY inbound via 3x-ui panel API"
```

---

### Task 3: `POST /api/chains/:id/generate-profile` route

**Files:**

- Modify: `apps/server/src/routes/chains.ts`
- Modify: `apps/server/src/index.ts`
- Modify: `apps/server/src/routes/chains.test.ts`

**Signature change:**

```typescript
// chains.ts
export function chainsRoutes(db: Database, env: Pick<Env, "masterKey">) {
```

```typescript
// index.ts
authed.route("/chains", chainsRoutes(db, { masterKey: env.masterKey }));
```

**Route logic sketch:**

```typescript
app.post("/:id/generate-profile", async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) return c.json({ error: "Invalid chain id" }, 400);

  const chain = getChainById(db, id);
  if (!chain) return c.json({ error: "Chain not found" }, 404);
  if (chain.hops.length !== 1) {
    return c.json({ error: "Generate profile requires a single-hop chain." }, 400);
  }

  const hop = chain.hops[0]!;
  const row = db
    .query<
      {
        operational_status: string;
        panel_hostname: string;
        xui_web_base_path: string | null;
        xui_panel_port: number | null;
        xui_secrets_ciphertext: Uint8Array | null;
        xui_secrets_nonce: Uint8Array | null;
      },
      [number]
    >(
      `SELECT operational_status, panel_hostname, xui_web_base_path, xui_panel_port,
              xui_secrets_ciphertext, xui_secrets_nonce
       FROM vpn_profiles WHERE id = ?`,
    )
    .get(hop.vpnProfileId);

  if (!row || row.operational_status !== "working" || !row.xui_secrets_ciphertext || !row.xui_secrets_nonce) {
    return c.json({ error: "VPN profile must be working with stored panel credentials." }, 409);
  }

  const secrets = await decryptXuiSecretsJson(env.masterKey, row.xui_secrets_ciphertext, row.xui_secrets_nonce);
  const panelUrl = buildPanelHttpsUrl(row.panel_hostname, row.xui_web_base_path, row.xui_panel_port);
  if (!panelUrl) return c.json({ error: "Panel URL is not available for this profile." }, 409);

  const material = generateRealityClientMaterial();
  const clientEmail = `vpnmgr-${material.clientUuid}@chain-${id}.local`;
  const inboundBody = buildVlessRealityInboundBody({
    port: 443, // or pick high port if 443 blocked — align with spec note; v1 uses 443 constant
    remark: `chain-${id}-${Date.now()}`,
    clientEmail,
    clientUuid: material.clientUuid,
    subId: material.subId,
    shortId: material.shortId,
    realityPrivateKeyB64: material.realityPrivateKeyB64,
    realityPublicKeyB64: material.realityPublicKeyB64,
  });

  try {
    const result = await provisionChainClientAccess({
      panelBaseUrl: panelUrl,
      adminUsername: secrets.adminUsername,
      adminPassword: secrets.adminPassword,
      inboundBody,
    });
    return c.json(result);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return c.json({ error: "Panel request failed.", details: message }, 502);
  }
});
```

Import **`decryptXuiSecretsJson`**, **`buildPanelHttpsUrl`**, helpers from **`../xui/...`**. Choose **port `443`** for v1; if tests collide with multiple inbounds on same dev host, use **`randomPort`** only in tests via optional parameter (YAGNI: keep **443** in production code unless spec updated).

- [ ] **Step 1: Add failing route tests** (multi-hop `400`, missing chain `404`, pending profile `409`)

Reuse **`seedVpnProfile`** from **`chains.test.ts`** and **`seedWorkingProfileAfterInstall`** pattern from **`profiles.test.ts`** (copy the small helper into **`chains.test.ts`** or import from a **`test/seed.ts`** if you extract it — **duplicating once** is acceptable to stay YAGNI).

- [ ] **Step 2: Run tests — expect FAIL**

Run: `bun test apps/server/src/routes/chains.test.ts`

- [ ] **Step 3: Implement route + wiring**

- [ ] **Step 4: Mock `fetch` in happy-path test** so no real network.

- [ ] **Step 5: Run full server tests**

Run: `bun test apps/server`

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/routes/chains.ts apps/server/src/routes/chains.test.ts apps/server/src/index.ts
git commit -m "feat(server): add generate-profile endpoint for single-hop chains"
```

---

### Task 4: Web — button + modal

**Files:**

- Modify: `apps/web/src/pages/ChainsPage.tsx`
- (Optional) Create: `apps/web/src/components/ChainClientAccessModal.tsx` if **`ChainsPage.tsx`** becomes unwieldy

**API helper:**

```typescript
type GenerateProfileResponse = {
  vlessShareLink: string;
  subscriptionUrl: string;
};

function postGenerateProfile(chainId: number) {
  return apiFetch<GenerateProfileResponse>(`/api/chains/${chainId}/generate-profile`, {
    method: "POST",
  });
}
```

**UI rules:**

- Show **Generate profile** only when **`chain.hops.length === 1`** **and** the profile for **`chain.hops[0].vpnProfileId`** has **`operationalStatus === "working"`** (use **`profilesQuery.data`** map by id).  
- **`useMutation`** with **`onError`** → `setFormError` or a small inline error under the button (match existing **`ApiError`** handling).  
- Modal: two **`<input readOnly>`** + **Copy** buttons (`navigator.clipboard.writeText`), focus trap not required for v1.

- [ ] **Step 1: Manual check in browser** (working chain + panel reachable): click generates modal with two values.

- [ ] **Step 2: Typecheck web**

Run: `cd apps/web && bunx tsc -b`

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/pages/ChainsPage.tsx
git commit -m "feat(web): generate profile modal for single-hop chains"
```

---

## Plan self-review

| Spec requirement | Task coverage |
|------------------|---------------|
| Single-hop only | Task 3 route + Task 4 UI gating |
| VLESS + REALITY, yahoo.com, vision | Task 1 builder |
| New resource each request | Task 2–3 (no DB persistence) |
| Modal: VLESS + subscription | Task 4 |
| Panel HTTP API | Tasks 2–3 |
| No secrets in logs | Task 2 implementation note |
| Tests | Tasks 1–3 automated; Task 4 manual |

**Placeholder scan:** None intentional; **login body** and **exact `streamSettings` JSON** must be filled from **upstream + one captured sample** during Task 1–2 (not left as TODO in committed code).

**Type consistency:** Response type **`GenerateProfileResponse`** must match server JSON keys **`vlessShareLink`** and **`subscriptionUrl`**.

---

**Plan complete and saved to** `docs/superpowers/plans/2026-04-17-chain-vless-reality-client-access.md`.

**Two execution options:**

1. **Subagent-Driven (recommended)** — Dispatch a fresh subagent per task, review between tasks, fast iteration. **REQUIRED SUB-SKILL:** superpowers:subagent-driven-development.

2. **Inline Execution** — Execute tasks in this session using executing-plans with checkpoints. **REQUIRED SUB-SKILL:** superpowers:executing-plans.

**Which approach do you want?**
