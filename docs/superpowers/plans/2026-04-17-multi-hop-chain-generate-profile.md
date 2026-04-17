# Multi-hop chain Generate profile — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend **Generate profile** so a chain with **any number of hops ≥ 1** provisions **VLESS + REALITY (`yahoo.com`) + `xtls-rprx-vision`** on each hop as needed, wires **hop 1 → hop 2 → … → hop n → internet** via **3x-ui panel HTTP APIs**, and returns **only hop 1’s** `vlessShareLink` and `subscriptionUrl`.

**Architecture:** Reuse **`buildVlessRealityInboundBody`** + **`generateRealityClientMaterial`** for every new inbound. For **n = 1**, keep the current behavior (login → **`panel/api/inbounds/add`** only). For **n > 1**, after creating **downstream inbounds** on hops **2…n** and the **user inbound** on hop **1**, merge **outbounds** and **routing.rules** into each hop’s **saved Xray JSON** using **`POST {base}panel/xray/`** (read) and **`POST {base}panel/xray/update`** (form `xraySetting` + `outboundTestUrl`), matching MHSanaei/3x-ui `web/html/xray.html` and `web/controller/xray_setting.go`. Outbound dial address uses **`panel_hostname.trim() || host`** per spec. Optionally call **`POST {base}panel/api/server/restartXrayService`** after each successful Xray save so routing applies without waiting for the panel cron (verify response shape in **`web/controller/server.go`** before relying on it).

**Tech Stack:** Bun, Hono, `bun:test`, React, TanStack Query, `globalThis.fetch` (mockable in tests).

**Spec:** `docs/superpowers/specs/2026-04-17-multi-hop-chain-vless-reality-design.md`

---

## File map (create / modify)

| File | Role |
|------|------|
| `apps/server/src/xui/dialHostForVpnProfile.ts` | Pure helper: dial host string from DB row (`panel_hostname` trimmed if non-empty else `host`). |
| `apps/server/src/xui/dialHostForVpnProfile.test.ts` | Tests for trim / fallback. |
| `apps/server/src/xui/buildVlessRealityOutbound.ts` | Builds one Xray **outbound** object (VLESS + REALITY + vision) for dialing the next hop. |
| `apps/server/src/xui/buildVlessRealityOutbound.test.ts` | Asserts tag, address, port, flow, REALITY fields. |
| `apps/server/src/xui/mergeChainRoutingIntoXray.ts` | Pure merge: given parsed Xray object, outbound tag, inbound tag(s), next-hop freedom routing for terminal hop; prepends `routing.rules` entries; appends outbound. |
| `apps/server/src/xui/mergeChainRoutingIntoXray.test.ts` | Tests with minimal Xray fixture JSON. |
| `apps/server/src/xui/panelXrayClient.ts` | Session-authenticated **`panel/xray/`** read and **`panel/xray/update`** write (+ optional restart). Shares login/cookie parsing patterns with `provisionChainClientAccess.ts` (consider extracting **`panelSessionFetch.ts`** only if duplication exceeds ~40 lines). |
| `apps/server/src/xui/panelXrayClient.test.ts` | Mocked `fetch` for read/update. |
| `apps/server/src/xui/provisionMultihopChainClientAccess.ts` | Orchestrates multi-hop: per-hop material, inbound creation order, Xray merges, returns hop-1 client URLs. |
| `apps/server/src/xui/provisionMultihopChainClientAccess.test.ts` | Full `fetch` mock timeline for 2-hop happy path + failure mid-chain. |
| `apps/server/src/routes/chains.ts` | Remove single-hop-only guard; load all hops; validate all profiles; call orchestrator. |
| `apps/server/src/routes/chains.test.ts` | Replace “400 multi-hop” with success/failure cases; keep single-hop regression. |
| `apps/web/src/pages/ChainsPage.tsx` | **`getGenerateProfileDisabledReason`**: every hop’s profile must be **working**. |

**Upstream references (read before coding Xray merge):**

- `https://github.com/MHSanaei/3x-ui/blob/main/web/controller/xray_setting.go` — `POST /panel/xray/`, `POST /panel/xray/update` (`PostForm("xraySetting")`).
- `https://github.com/MHSanaei/3x-ui/blob/main/web/html/xray.html` — `getXraySetting` / `updateXraySetting` payloads.
- Xray routing rule shape: `{"type":"field","inboundTag":["inbound-443"],"outboundTag":"your-outbound-tag"}`.

---

### Task 0: Spike — confirm panel Xray read/write contract

**Files:**

- None (evidence in commit message or a short comment in `panelXrayClient.ts` once implemented).

- [ ] **Step 1: Record real panel behavior**

On a **dev** 3x-ui host, with browser devtools open on **Xray settings**, capture:

1. Request/response for **`POST …/panel/xray/`** (note `Content-Type`, whether `obj` is a JSON string, and the shape of `xraySetting` after one `JSON.parse`).
2. Request body for **`POST …/panel/xray/update`** (confirm `application/x-www-form-urlencoded` vs `multipart/form-data` by inspecting **`HttpUtil.post`** in 3x-ui assets or source).
3. Whether **`POST …/panel/api/server/restartXrayService`** returns `{ success: true }` on your version when called with the same session cookie.

- [ ] **Step 2: Run**

No automated test; spike notes inform `panelXrayClient.ts` field names.

- [ ] **Step 3: Commit**

```bash
git commit --allow-empty -m "chore: spike notes for 3x-ui panel/xray API (multi-hop chain)"
```

(If you prefer not to use empty commits, skip Step 3 and fold notes into the `panelXrayClient.ts` commit in Task 4.)

---

### Task 1: Dial host helper

**Files:**

- Create: `apps/server/src/xui/dialHostForVpnProfile.ts`
- Create: `apps/server/src/xui/dialHostForVpnProfile.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, test } from "bun:test";
import { dialHostForVpnProfile } from "./dialHostForVpnProfile";

describe("dialHostForVpnProfile", () => {
  test("uses trimmed panel hostname when non-empty", () => {
    expect(
      dialHostForVpnProfile({ panel_hostname: "  panel.example.com  ", host: "10.0.0.1" }),
    ).toBe("panel.example.com");
  });

  test("falls back to host when panel hostname is empty", () => {
    expect(dialHostForVpnProfile({ panel_hostname: "", host: "vpn.example.net" })).toBe("vpn.example.net");
  });

  test("falls back when panel hostname is whitespace only", () => {
    expect(dialHostForVpnProfile({ panel_hostname: "   ", host: "vpn.example.net" })).toBe("vpn.example.net");
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

Run: `bun test apps/server/src/xui/dialHostForVpnProfile.test.ts`  
Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

```typescript
export type VpnProfileDialRow = {
  panel_hostname: string;
  host: string;
};

export function dialHostForVpnProfile(row: VpnProfileDialRow): string {
  const panel = row.panel_hostname.trim();
  if (panel !== "") return panel;
  return row.host.trim();
}
```

- [ ] **Step 4: Run test — expect PASS**

Run: `bun test apps/server/src/xui/dialHostForVpnProfile.test.ts`

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/xui/dialHostForVpnProfile.ts apps/server/src/xui/dialHostForVpnProfile.test.ts
git commit -m "feat(server): dial host helper for inter-hop outbounds"
```

---

### Task 2: VLESS + REALITY outbound builder

**Files:**

- Create: `apps/server/src/xui/buildVlessRealityOutbound.ts`
- Create: `apps/server/src/xui/buildVlessRealityOutbound.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, test } from "bun:test";
import { buildVlessRealityOutbound } from "./buildVlessRealityOutbound";

describe("buildVlessRealityOutbound", () => {
  test("builds vless outbound with vision flow and reality to yahoo.com", () => {
    const o = buildVlessRealityOutbound({
      tag: "vpnmgr-out-test",
      address: "hop2.example.com",
      port: 443,
      uuid: "11111111-1111-4111-8111-111111111111",
      publicKey: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=",
      shortId: "0123456789abcdef",
    });
    expect(o.tag).toBe("vpnmgr-out-test");
    expect(o.protocol).toBe("vless");
    const vnext = (o.settings as { vnext: { address: string; port: number; users: { id: string; flow: string }[] }[] })
      .vnext;
    expect(vnext[0]!.address).toBe("hop2.example.com");
    expect(vnext[0]!.port).toBe(443);
    expect(vnext[0]!.users[0]!.flow).toBe("xtls-rprx-vision");
    const stream = o.streamSettings as {
      security: string;
      realitySettings: { serverName: string; publicKey: string; shortId: string; fingerprint: string; spiderX: string };
    };
    expect(stream.security).toBe("reality");
    expect(stream.realitySettings.serverName).toBe("yahoo.com");
    expect(stream.realitySettings.publicKey).toBe("BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=");
    expect(stream.realitySettings.shortId).toBe("0123456789abcdef");
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

Run: `bun test apps/server/src/xui/buildVlessRealityOutbound.test.ts`

- [ ] **Step 3: Implement**

```typescript
export type VlessRealityOutboundInput = {
  tag: string;
  address: string;
  port: number;
  uuid: string;
  publicKey: string;
  shortId: string;
};

/** Xray outbound JSON fragment for VLESS + REALITY + xtls-rprx-vision (client to next hop). */
export function buildVlessRealityOutbound(input: VlessRealityOutboundInput): Record<string, unknown> {
  return {
    tag: input.tag,
    protocol: "vless",
    settings: {
      vnext: [
        {
          address: input.address,
          port: input.port,
          users: [
            {
              id: input.uuid,
              encryption: "none",
              flow: "xtls-rprx-vision",
            },
          ],
        },
      ],
    },
    streamSettings: {
      network: "tcp",
      security: "reality",
      tcpSettings: {
        header: { type: "none" },
      },
      realitySettings: {
        serverName: "yahoo.com",
        fingerprint: "chrome",
        publicKey: input.publicKey,
        shortId: input.shortId,
        spiderX: "/",
      },
    },
  };
}
```

Adjust field names (`serverName` vs `serverNames`) if your Task 0 spike shows Xray expects a different shape for **outbound** REALITY on your 3x-ui version; update the test to match the spike.

- [ ] **Step 4: Run test — expect PASS**

Run: `bun test apps/server/src/xui/buildVlessRealityOutbound.test.ts`

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/xui/buildVlessRealityOutbound.ts apps/server/src/xui/buildVlessRealityOutbound.test.ts
git commit -m "feat(server): Xray VLESS+REALITY outbound builder for chain hops"
```

---

### Task 3: Pure Xray merge (routing + outbound)

**Files:**

- Create: `apps/server/src/xui/mergeChainRoutingIntoXray.ts`
- Create: `apps/server/src/xui/mergeChainRoutingIntoXray.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, test } from "bun:test";
import {
  findFreedomOutboundTag,
  mergeInboundToOutboundRule,
} from "./mergeChainRoutingIntoXray";

describe("mergeChainRoutingIntoXray", () => {
  const base = {
    log: {},
    routing: {
      domainStrategy: "AsIs",
      rules: [{ type: "field", network: "tcp,udp", outboundTag: "direct" }],
    },
    inbounds: [],
    outbounds: [
      { tag: "direct", protocol: "freedom", settings: {} },
      { tag: "blocked", protocol: "blackhole", settings: {} },
    ],
  };

  test("findFreedomOutboundTag prefers freedom protocol", () => {
    expect(findFreedomOutboundTag(base as never)).toBe("direct");
  });

  test("prepends inboundTag -> outboundTag rule", () => {
    const merged = mergeInboundToOutboundRule({
      xray: structuredClone(base) as Record<string, unknown>,
      inboundTag: "inbound-8443",
      outboundTag: "vpnmgr-out-1",
    });
    const rules = (merged.routing as { rules: unknown[] }).rules;
    expect(rules[0]).toEqual({
      type: "field",
      inboundTag: ["inbound-8443"],
      outboundTag: "vpnmgr-out-1",
    });
    expect(rules.length).toBeGreaterThan(1);
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

Run: `bun test apps/server/src/xui/mergeChainRoutingIntoXray.test.ts`

- [ ] **Step 3: Implement**

```typescript
export function findFreedomOutboundTag(xray: { outbounds?: unknown[] }): string {
  const list = xray.outbounds;
  if (!Array.isArray(list)) return "direct";
  for (const o of list) {
    if (!o || typeof o !== "object") continue;
    const tag = (o as { tag?: unknown }).tag;
    const protocol = (o as { protocol?: unknown }).protocol;
    if (typeof tag === "string" && protocol === "freedom") return tag;
  }
  return "direct";
}

export function mergeInboundToOutboundRule(input: {
  xray: Record<string, unknown>;
  inboundTag: string;
  outboundTag: string;
}): Record<string, unknown> {
  const x = structuredClone(input.xray);
  const routing = x.routing;
  if (!routing || typeof routing !== "object") {
    throw new Error("mergeInboundToOutboundRule: xray.routing missing");
  }
  const r = routing as { rules?: unknown[] };
  if (!Array.isArray(r.rules)) r.rules = [];
  r.rules.unshift({
    type: "field",
    inboundTag: [input.inboundTag],
    outboundTag: input.outboundTag,
  });
  return x;
}

export function appendOutbound(input: {
  xray: Record<string, unknown>;
  outbound: Record<string, unknown>;
}): Record<string, unknown> {
  const x = structuredClone(input.xray);
  const list = x.outbounds;
  if (!Array.isArray(list)) x.outbounds = [];
  (x.outbounds as unknown[]).push(input.outbound);
  return x;
}
```

- [ ] **Step 4: Run test — expect PASS**

Run: `bun test apps/server/src/xui/mergeChainRoutingIntoXray.test.ts`

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/xui/mergeChainRoutingIntoXray.ts apps/server/src/xui/mergeChainRoutingIntoXray.test.ts
git commit -m "feat(server): merge chain routing rules into Xray template"
```

---

### Task 4: Panel Xray client (read / update / optional restart)

**Files:**

- Create: `apps/server/src/xui/panelXrayClient.ts`
- Create: `apps/server/src/xui/panelXrayClient.test.ts`

Implement (names may vary; match Task 0 spike exactly):

- `fetchPanelXrayBundle(fetchFn, baseUrl, cookieHeader)` → parses top-level JSON, returns `{ xraySettingText: string; outboundTestUrl: string }` where `xraySettingText` is `JSON.stringify(parsed.xraySetting)` as the panel expects on save (if panel stores object, stringify with stable key order not required; use `JSON.stringify(obj)`).
- `updatePanelXraySetting(fetchFn, baseUrl, cookieHeader, xraySettingText, outboundTestUrl)` → `POST` `panel/xray/update` with `URLSearchParams` or `multipart/form-data` per spike.
- `restartPanelXray(fetchFn, baseUrl, cookieHeader)` → `POST` `panel/api/server/restartXrayService` if confirmed in spike.

Reuse `panelBaseForProvision` from `provisionChainClientAccess.ts` by **exporting** it from that file or **duplicating** the 8-line env toggle into `panelXrayClient.ts` (pick one; exporting avoids drift).

- [ ] **Step 1: Write failing test with fetch mock**

```typescript
import { describe, expect, mock, test } from "bun:test";
import { fetchPanelXrayBundle, updatePanelXraySetting } from "./panelXrayClient";

describe("panelXrayClient", () => {
  test("POST panel/xray/ returns parsed bundle strings", async () => {
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/panel/xray/")) {
        const payload = {
          xraySetting: { log: {}, inbounds: [], outbounds: [], routing: { rules: [] } },
          inboundTags: [],
          outboundTestUrl: "https://www.google.com/generate_204",
        };
        return new Response(
          JSON.stringify({ success: true, msg: "ok", obj: JSON.stringify(payload) }),
          { headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(url);
    });

    const b = await fetchPanelXrayBundle({
      panelBaseUrl: "https://panel.example.com/prefix/",
      cookieHeader: "3x-ui=abc",
      fetchFn: fetchMock as unknown as typeof fetch,
    });

    expect(b.outboundTestUrl).toContain("google");
    expect(b.xraySettingText).toContain("routing");
    expect(fetchMock).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `bun test apps/server/src/xui/panelXrayClient.test.ts`

- [ ] **Step 3: Implement** `fetchPanelXrayBundle` + `updatePanelXraySetting` (+ `restartPanelXray` if spike confirms).

- [ ] **Step 4: Add second test** that `updatePanelXraySetting` posts `xraySetting` and `outboundTestUrl` form fields and checks `success: true` handling.

- [ ] **Step 5: Run full file — PASS**

Run: `bun test apps/server/src/xui/panelXrayClient.test.ts`

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/xui/panelXrayClient.ts apps/server/src/xui/panelXrayClient.test.ts
# plus any export tweak in provisionChainClientAccess.ts if you exported panelBaseForProvision
git commit -m "feat(server): 3x-ui panel xray read/update client"
```

---

### Task 5: Multi-hop orchestrator

**Files:**

- Create: `apps/server/src/xui/provisionMultihopChainClientAccess.ts`
- Create: `apps/server/src/xui/provisionMultihopChainClientAccess.test.ts`

**Types (illustrative — align names with implementation):**

```typescript
export type HopPanelContext = {
  vpnProfileId: number;
  panelBaseUrl: string;
  adminUsername: string;
  adminPassword: string;
  dialHost: string;
};

export type ProvisionMultihopChainClientAccessInput = {
  chainId: number;
  hops: HopPanelContext[];
  fetchFn?: typeof fetch;
};
```

**Algorithm:**

1. If `hops.length === 0`, throw (caller should 400).
2. If `hops.length === 1`, call existing **`provisionChainClientAccess`** with hop 1 material (current single-hop behavior); return its result.
3. If `hops.length >= 2` (0-based: **`hops[0]`** = user entry, **`hops[n-1]`** = exit):
   - **Inter-hop inbounds** only on **`hops[1]…hops[n-1]`**: index **`k`** receives traffic from **`hops[k-1]`**.
   - **Inbound creation order:** `for (let k = hops.length - 1; k >= 1; k--)` provision on **`hops[k]`** (reverse so **`hops[k+1]`**’s port, tag, uuid, REALITY public key, and shortId are known before wiring **`hops[k]`**).
   - Then create the **user-facing** inbound on **`hops[0]`** and capture **`vlessShareLink`** / **`subscriptionUrl`** (same as **`provisionChainClientAccess`** — export **`resolveVlessShareLink`** or share a thin helper).
   - **Xray on forwarders `hops[0]…hops[n-2]`:** for each **`k`**, on **`hops[k]`**: login → **`fetchPanelXrayBundle`** → parse `xraySetting` → **`appendOutbound`**(`buildVlessRealityOutbound` toward **`hops[k+1].dialHost`** and that hop’s new inbound **port / uuid / publicKey / shortId**) → **`mergeInboundToOutboundRule`** for the **inbound tag that receives traffic on this hop** (user inbound when **`k===0`**; the inter-hop inbound you created on **`hops[k]`** when **`k>=1`**) → **`updatePanelXraySetting`** → optional **`restartPanelXray`**.
   - **Xray on last hop `hops[n-1]`:** **`fetchPanelXrayBundle`** → **`mergeInboundToOutboundRule`** mapping **that hop’s new inter-hop inbound tag** → tag from **`findFreedomOutboundTag`** → update + optional restart.

**Public key for outbound:** use the **server’s REALITY public key** from the **next hop’s inbound** `streamSettings` (same as today’s client URI logic: `realitySettings.settings.publicKey` in 3x-ui inbound JSON). When you only have your generated material, use the **`realityPublicKeyB64`** you already passed into **`buildVlessRealityInboundBody`** for that next hop.

- [ ] **Step 1: Write 2-hop fetch mock test**  
   Sequence: hop2 login + add inbound; hop1 login + add inbound; hop1 panel/xray read + update + restart; hop2 panel/xray read + update + restart. Assert order and that final result includes `vless://` for hop1.

- [ ] **Step 2: Run — FAIL**

Run: `bun test apps/server/src/xui/provisionMultihopChainClientAccess.test.ts`

- [ ] **Step 3: Implement orchestrator**

- [ ] **Step 4: Run — PASS**

Run: `bun test apps/server/src/xui/provisionMultihopChainClientAccess.test.ts`

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/xui/provisionMultihopChainClientAccess.ts apps/server/src/xui/provisionMultihopChainClientAccess.test.ts
git commit -m "feat(server): provision multi-hop chain client access on 3x-ui"
```

---

### Task 6: Route + web UI + integration tests

**Files:**

- Modify: `apps/server/src/routes/chains.ts`
- Modify: `apps/server/src/routes/chains.test.ts`
- Modify: `apps/web/src/pages/ChainsPage.tsx`

- [ ] **Step 1: Replace single-hop guard** in `chains.ts` with:

  - **400** if `chain.hops.length === 0` with message like `"Chain has no hops."`
  - Load **every** hop’s DB row + decrypt secrets like today; if **any** hop fails validation, **409** with the same safe message as today.
  - Build `HopPanelContext[]` in order using **`buildPanelHttpsUrl`**, **`dialHostForVpnProfile`**, decrypted admin user/pass.
  - Call **`provisionMultihopChainClientAccess`** inside the existing `try/catch` that maps to **502**.

- [ ] **Step 2: Update `chains.test.ts`**

  - Change **`generate-profile returns 400 for multi-hop chain`** to expect **200** when `globalThis.fetch` mocks the full multi-hop sequence (copy pattern from Task 5 mock, or mock **`provisionMultihopChainClientAccess`** via dependency injection **only if** you add an optional hook to `chainsRoutes` for tests — **prefer** `fetch` mocking to avoid production-only hooks).

- [ ] **Step 3: Update `ChainsPage.tsx` `getGenerateProfileDisabledReason`**

```typescript
function getGenerateProfileDisabledReason(chain: Chain): string | null {
  if (profilesQuery.isPending) {
    return "Loading VPN profiles…";
  }
  if (profilesQuery.isError) {
    return "VPN profiles could not be loaded.";
  }
  if (chain.hops.length === 0) {
    return "Add at least one hop before generating a client profile.";
  }
  for (const hop of chain.hops) {
    const profile = profilesQuery.data?.find((p) => p.id === hop.vpnProfileId);
    if (!profile) {
      return "A hop VPN profile was not found. Refresh or fix the chain.";
    }
    if (profile.operationalStatus !== "working") {
      return "Every hop VPN profile must have operational status Working.";
    }
  }
  return null;
}
```

- [ ] **Step 4: Run server + web checks**

Run:

```bash
bun test apps/server
cd apps/web && bunx tsc -b
```

Expected: all tests pass; `tsc` passes.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/routes/chains.ts apps/server/src/routes/chains.test.ts apps/web/src/pages/ChainsPage.tsx
git commit -m "feat: multi-hop generate profile API and chains UI gating"
```

---

## Plan self-review

| Spec requirement | Task covering it |
|------------------|-------------------|
| n ≥ 1 hops, hop 1 returns links | Task 5–6 |
| Same VLESS+REALITY+vision template inter-hop | Tasks 2 + 5 (reuse inbound builder) |
| Dial address `panel_hostname` else `host` | Task 1 + 5 |
| All hops working + secrets | Task 6 |
| Last hop → internet (freedom / direct) | Task 3 + 5 |
| No SQLite persistence | No DB migrations in plan |
| Panel-only (preferred) | Tasks 0, 4, 5 — SSH fallback **out of scope** unless Task 0 fails; then **stop** and revise spec |

**Placeholder scan:** none intentional; Task 0 captures unknowns.

**Type consistency:** `HopPanelContext.dialHost` uses Task 1 helper for **`hops[k+1]`** when building outbound from **`hops[k]`**.

---

**Plan complete and saved to `docs/superpowers/plans/2026-04-17-multi-hop-chain-generate-profile.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — Dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
