# VPN Manager — 3x-ui UFW auto-sync — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After `POST /api/chains/:id/generate-profile` successfully mutates 3x-ui inbounds, optionally reconcile **UFW on each affected VPN profile host over SSH** when `vpn_ssh_enabled` is true; **skip silently** when SSH is disabled; **no error** when `ufw` is missing or inactive on the host; **retry** SSH failures; on final failure **return 502** and **best-effort delete** all inbounds created in that request.

**Architecture:** A root-owned **bash reconcile script** on the remote host reads **`/etc/x-ui/x-ui.db`** (override via `VPNMGR_XUI_DB_PATH`), removes only **`# vpnmgr-xui`** UFW rules, then re-adds rules for **`settings.webPort`** (TCP) and each **enabled inbound** (TCP, or UDP for `protocol=wireguard`). VPN Manager runs **`sudo -n /usr/local/sbin/vpnmgr-xui-ufw-sync`** via existing **`SshExecFn`** (`apps/server/src/vpn/sshExec.ts`) with **fixed remote command** (stdin `exec` wrapper). **`apps/server/src/xui/runXuiUfwSync.ts`** implements retries and orchestrates **compensating deletes** using a new **panel inbound delete** helper that calls **`POST /panel/api/inbounds/del/{id}`** after resolving numeric inbound ids from **`GET /panel/api/inbounds/list`**.

**Tech stack:** Bun, TypeScript, Hono, `bun:sqlite`, `ssh2` (via `buildSshExecUsingSpawn`), remote `bash`/`ufw`/`sqlite3`, 3x-ui HTTP JSON API.

**Spec:** `docs/superpowers/specs/2026-04-17-vpn-manager-3x-ui-ufw-sync-design.md`

---

## File map (before tasks)

| Path | Role |
|------|------|
| `scripts/vpnmgr-xui-ufw-sync.sh` | **Create** — idempotent UFW reconcile (installed to `/usr/local/sbin/` on servers). |
| `apps/server/src/xui/runXuiUfwSync.ts` | **Create** — `runXuiUfwSyncWithRetries`, constants `UFW_SYNC_MAX_ATTEMPTS`, `UFW_SYNC_REMOTE_COMMAND`, small helpers. |
| `apps/server/src/xui/runXuiUfwSync.test.ts` | **Create** — mock `SshExecFn`, assert command body, exit codes, retry count. |
| `apps/server/src/xui/panelInboundDelete.ts` | **Create** — `deleteInboundByTag` / `deleteInboundById` using list + del API (pick one public surface; see Task 5). |
| `apps/server/src/xui/panelInboundDelete.test.ts` | **Create** — fetch mock for list/del. |
| `apps/server/src/xui/panelLoginCookie.ts` | **Create** — move **`loginCookie`** (+ tiny helpers) out of `provisionMultihopChainClientAccess.ts` so **`compensateChainProvision`** does not create an import cycle. |
| `apps/server/src/xui/provisionMultihopChainClientAccess.ts` | **Modify** — return **`MultihopProvisionResult`** including **`createdInbounds: CreatedInboundRef[]`** for compensation (see Tasks 4 and 6). |
| `apps/server/src/xui/provisionChainClientAccess.ts` | **Modify** — optionally return **`inboundTag`** + **`inboundId`** if add JSON includes id (single-hop path may delegate to multihop only; see Task 6). |
| `apps/server/src/routes/chains.ts` | **Modify** — wire sync + compensation; load SSH columns + `getAppSettings`; pass **`sshExec`** for tests. |
| `apps/server/src/index.ts` | **Modify** — pass **`sshExec`** default into `chainsRoutes` if signature changes. |
| `apps/server/src/routes/chains.test.ts` | **Modify** — cover skip when `vpn_ssh_enabled=0`, success when mock exits 0, 502 + delete calls when mock exits 1. |
| `docs/superpowers/specs/2026-04-17-chain-vless-reality-client-access-design.md` | **Modify** (one paragraph) — note that **UFW sync** may run when `vpn_ssh_enabled` and SSH succeed; still no cloud SG automation. |

---

### Task 1: Add `scripts/vpnmgr-xui-ufw-sync.sh`

**Files:**

- Create: `scripts/vpnmgr-xui-ufw-sync.sh`

- [ ] **Step 1: Create the script file (full contents below)**

```bash
#!/usr/bin/env bash
set -euo pipefail

# Managed UFW comments must contain this substring (see design spec).
readonly TAG="vpnmgr-xui"
readonly DB_PATH="${VPNMGR_XUI_DB_PATH:-/etc/x-ui/x-ui.db}"

log() { printf '%s\n' "$*" >&2; }

if ! command -v ufw >/dev/null 2>&1; then
  log "vpnmgr-xui-ufw-sync: ufw not installed; skip"
  exit 0
fi

if ufw status 2>/dev/null | grep -qi '^Status:[[:space:]]*inactive'; then
  log "vpnmgr-xui-ufw-sync: ufw inactive; skip"
  exit 0
fi

if [ ! -r "$DB_PATH" ]; then
  log "vpnmgr-xui-ufw-sync: cannot read database: $DB_PATH"
  exit 1
fi

if ! command -v sqlite3 >/dev/null 2>&1; then
  log "vpnmgr-xui-ufw-sync: sqlite3 not found"
  exit 1
fi

delete_managed() {
  # Delete by rule number from highest to lowest so indices stay valid.
  while true; do
    mapfile -t nums < <(ufw status numbered 2>/dev/null | awk -F'[][]' -v t="$TAG" '
      $0 ~ t && $2 ~ /^[0-9]+$/ { print $2 }
    ' | sort -unr)
    if [ "${#nums[@]}" -eq 0 ]; then
      break
    fi
    n="${nums[0]}"
    yes "" | ufw delete "$n" >/dev/null 2>&1 || return 1
  done
}

delete_managed || exit 1

web_port="$(sqlite3 "$DB_PATH" "SELECT value FROM settings WHERE key='webPort' LIMIT 1;" 2>/dev/null || true)"
if [[ "$web_port" =~ ^[0-9]+$ ]] && [ "$web_port" -ge 1 ] && [ "$web_port" -le 65535 ]; then
  ufw allow "${web_port}/tcp" comment "${TAG} panel" >/dev/null
fi

while IFS='|' read -r port proto; do
  [[ "$port" =~ ^[0-9]+$ ]] || continue
  [ "$port" -ge 1 ] && [ "$port" -le 65535 ] || continue
  p="${proto:-vless}"
  p_lc="$(printf '%s' "$p" | tr '[:upper:]' '[:lower:]')"
  if [ "$p_lc" = "wireguard" ]; then
    ufw allow "${port}/udp" comment "${TAG} inbound ${port} udp" >/dev/null
  else
    ufw allow "${port}/tcp" comment "${TAG} inbound ${port} tcp" >/dev/null
  fi
done < <(sqlite3 -separator '|' "$DB_PATH" \
  "SELECT port, lower(protocol) FROM inbounds WHERE enable = 1 ORDER BY port ASC;")

exit 0
```

- [ ] **Step 2: Make executable locally**

Run:

```bash
chmod +x scripts/vpnmgr-xui-ufw-sync.sh
```

Expected: no output, exit code 0.

- [ ] **Step 3: Commit**

```bash
git add scripts/vpnmgr-xui-ufw-sync.sh
git commit -m "chore: add remote UFW reconcile script for 3x-ui"
```

---

### Task 2: `runXuiUfwSync.ts` + unit tests (retries, fixed remote body)

**Files:**

- Create: `apps/server/src/xui/runXuiUfwSync.ts`
- Create: `apps/server/src/xui/runXuiUfwSync.test.ts`

- [ ] **Step 1: Write failing test**

Create `apps/server/src/xui/runXuiUfwSync.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import type { SshExecFn } from "../vpn/sshExec";
import { runXuiUfwSyncWithRetries, UFW_SYNC_REMOTE_BODY } from "./runXuiUfwSync";

describe("runXuiUfwSyncWithRetries", () => {
  test("uses fixed remote script body and stops on exit 0", async () => {
    const calls: string[] = [];
    const sshExec: SshExecFn = async (args) => {
      calls.push(args.remoteScript);
      return { code: 0, stdout: "", stderr: "" };
    };
    await runXuiUfwSyncWithRetries({
      host: "10.0.0.5",
      port: 22,
      user: "root",
      password: "x",
      sshExec,
      timeoutMs: 5_000,
    });
    expect(calls.length).toBe(1);
    expect(calls[0]).toBe(UFW_SYNC_REMOTE_BODY);
  });

  test("retries until max attempts on non-zero exit", async () => {
    let n = 0;
    const sshExec: SshExecFn = async () => {
      n += 1;
      return { code: 1, stdout: "", stderr: "fail" };
    };
    await expect(
      runXuiUfwSyncWithRetries({
        host: "h",
        port: 22,
        user: "root",
        password: "x",
        sshExec,
        timeoutMs: 5_000,
        maxAttempts: 3,
        initialBackoffMs: 1,
      }),
    ).rejects.toThrow(/ufw sync failed/i);
    expect(n).toBe(3);
  });
});
```

Run:

```bash
cd apps/server && bun test src/xui/runXuiUfwSync.test.ts
```

Expected: **FAIL** (module missing).

- [ ] **Step 2: Implement `runXuiUfwSync.ts`**

Create `apps/server/src/xui/runXuiUfwSync.ts`:

```typescript
import type { SshExecFn } from "../vpn/sshExec";

/** Must be a single literal — passed to `bash -s` on the remote. */
export const UFW_SYNC_REMOTE_BODY = "set -euo pipefail\nexec sudo -n /usr/local/sbin/vpnmgr-xui-ufw-sync\n";

export type RunXuiUfwSyncArgs = {
  host: string;
  port: number;
  user: string;
  password: string;
  knownHostsFile?: string | null;
  sshExec: SshExecFn;
  timeoutMs: number;
  maxAttempts?: number;
  initialBackoffMs?: number;
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function runXuiUfwSyncWithRetries(args: RunXuiUfwSyncArgs): Promise<void> {
  const maxAttempts = args.maxAttempts ?? 4;
  const initialBackoffMs = args.initialBackoffMs ?? 250;
  let lastStderr = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await args.sshExec({
      host: args.host,
      port: args.port,
      user: args.user,
      password: args.password,
      remoteScript: UFW_SYNC_REMOTE_BODY,
      timeoutMs: args.timeoutMs,
      knownHostsFile: args.knownHostsFile ?? undefined,
    });
    if (result.code === 0) return;
    lastStderr = result.stderr;
    if (attempt < maxAttempts) {
      const backoff = initialBackoffMs * 2 ** (attempt - 1);
      await sleep(Math.min(backoff, 2000));
    }
  }
  throw new Error(`ufw sync failed after ${maxAttempts} attempts: ${lastStderr.trim()}`);
}
```

Run:

```bash
cd apps/server && bun test src/xui/runXuiUfwSync.test.ts
```

Expected: **PASS**.

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/xui/runXuiUfwSync.ts apps/server/src/xui/runXuiUfwSync.test.ts
git commit -m "feat(server): add SSH UFW sync runner with retries"
```

---

### Task 3: Panel inbound delete helper

**Files:**

- Create: `apps/server/src/xui/panelInboundDelete.ts`
- Create: `apps/server/src/xui/panelInboundDelete.test.ts`

- [ ] **Step 1: Write failing test for delete-by-id**

Use this exact test first (adjust import path if your test harness differs):

```typescript
import { describe, expect, mock, test } from "bun:test";
import { deletePanelInboundById } from "./panelInboundDelete";

describe("deletePanelInboundById", () => {
  test("POSTs /panel/api/inbounds/del/{id}", async () => {
    const seen: string[] = [];
    const fetchFn = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      seen.push(url);
      if (url.endsWith("/panel/api/inbounds/del/42")) {
        return new Response(JSON.stringify({ success: true, msg: "ok" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected ${url}`);
    });

    await deletePanelInboundById({
      panelApiBase: "http://panel.example/prefix/",
      cookieHeader: "3x-ui=abc",
      inboundId: 42,
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(seen.some((u) => u.includes("/panel/api/inbounds/del/42"))).toBe(true);
  });
});
```

Run:

```bash
cd apps/server && bun test src/xui/panelInboundDelete.test.ts
```

Expected: **FAIL** (missing export).

- [ ] **Step 2: Implement `deletePanelInboundById`**

```typescript
import { PanelRequestError, type PanelJson, panelBaseForProvision } from "./provisionChainClientAccess";

async function readPanelJson(response: Response): Promise<PanelJson> {
  if (!response.ok) {
    throw new PanelRequestError(`panel HTTP ${response.status}`);
  }
  const body: unknown = await response.json();
  if (body === null || typeof body !== "object") {
    throw new PanelRequestError("panel returned non-object JSON");
  }
  return body as PanelJson;
}

export type DeletePanelInboundByIdInput = {
  panelApiBase: string;
  cookieHeader: string;
  inboundId: number;
  fetchFn?: typeof fetch;
};

export async function deletePanelInboundById(input: DeletePanelInboundByIdInput): Promise<void> {
  const fetchFn = input.fetchFn ?? fetch;
  const base = panelBaseForProvision(input.panelApiBase);
  const url = new URL(`panel/api/inbounds/del/${input.inboundId}`, base).href;
  const response = await fetchFn(url, {
    method: "POST",
    headers: {
      accept: "application/json",
      cookie: input.cookieHeader,
    },
  });
  const json = await readPanelJson(response);
  if (json.success !== true) {
    throw new PanelRequestError(typeof json.msg === "string" && json.msg !== "" ? json.msg : "delete inbound failed");
  }
}
```

Run:

```bash
cd apps/server && bun test src/xui/panelInboundDelete.test.ts
```

Expected: **PASS**.

- [ ] **Step 3: Add `resolveInboundIdByTag` test + implementation**

Add to the same module a function used during compensation:

```typescript
export type ResolveInboundIdByTagInput = {
  panelApiBase: string;
  cookieHeader: string;
  inboundTag: string;
  fetchFn?: typeof fetch;
};

export async function resolveInboundIdByTag(input: ResolveInboundIdByTagInput): Promise<number | null> {
  const fetchFn = input.fetchFn ?? fetch;
  const base = panelBaseForProvision(input.panelApiBase);
  const url = new URL("panel/api/inbounds/list", base).href;
  const response = await fetchFn(url, {
    method: "GET",
    headers: { accept: "application/json", cookie: input.cookieHeader },
  });
  const json = await readPanelJson(response);
  const obj = json.obj;
  if (!Array.isArray(obj)) return null;
  for (const row of obj) {
    if (!row || typeof row !== "object") continue;
    const rec = row as Record<string, unknown>;
    if (rec.tag === input.inboundTag && typeof rec.id === "number" && Number.isFinite(rec.id)) {
      return rec.id;
    }
  }
  return null;
}
```

Test: mock list returning `[{ id: 7, tag: "inbound-443" }]` and assert `resolveInboundIdByTag` returns `7`.

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/xui/panelInboundDelete.ts apps/server/src/xui/panelInboundDelete.test.ts
git commit -m "feat(server): add 3x-ui inbound delete helpers"
```

---

### Task 4: Extend multihop provision return value (created inbounds for rollback)

**Files:**

- Modify: `apps/server/src/xui/provisionMultihopChainClientAccess.ts`
- Modify: `apps/server/src/xui/provisionMultihopChainClientAccess.test.ts`
- Modify: `apps/server/src/routes/chains.test.ts` (mock `obj` gains numeric `id` where needed)

- [ ] **Step 1: Define exported types at top of `provisionMultihopChainClientAccess.ts`**

```typescript
export type CreatedInboundRef = {
  panelBaseUrl: string;
  adminUsername: string;
  adminPassword: string;
  inboundTag: string;
  /** Numeric DB id from panel when available; tests should include `id` on add/list mocks. */
  inboundId: number | null;
};

export type MultihopProvisionResult = import("./provisionChainClientAccess").ChainClientAccessResult & {
  createdInbounds: CreatedInboundRef[];
};
```

Change `provisionMultihopChainClientAccess` to return **`MultihopProvisionResult`** with **`createdInbounds`** populated **in creation order** (entry hop last in the array is acceptable if compensation deletes **reverse** order — pick **reverse deletion order**: last created first deleted).

- [ ] **Step 2: Populate `inboundId`**

After each successful `addInbound`, parse `addJson.obj`:

```typescript
function parseInboundIdFromAddJson(addJson: import("./provisionChainClientAccess").PanelJson): number | null {
  const obj = addJson.obj;
  if (obj && typeof obj === "object") {
    const id = (obj as Record<string, unknown>).id;
    if (typeof id === "number" && Number.isFinite(id)) return id;
  }
  return null;
}
```

Push `{ panelBaseUrl: hop.panelBaseUrl, adminUsername, adminPassword, inboundTag, inboundId }` for every **`addInbound`** on receive hops, then for the entry **`userAddJson`**.

Single-hop branch that delegates to `provisionChainClientAccess` must wrap return as:

```typescript
return {
  ...(await provisionChainClientAccess({ ... })),
  createdInbounds: [
    {
      panelBaseUrl: h.panelBaseUrl,
      adminUsername: h.adminUsername,
      adminPassword: h.adminPassword,
      inboundTag: "<resolved-from-add-json>", // refactor small helper shared with multihop
      inboundId: parseInboundIdFromAddJson(addJson) // requires threading addJson from inner call — implement by inlining single-hop path or duplicating minimal add flow
    },
  ],
};
```

**Implementation note:** Refactor single-hop path so **`provisionChainClientAccess`** either returns `{ vlessShareLink, subscriptionUrl, inboundTag, inboundId }` or multihop calls an internal **`provisionSingleHopForChain`** that returns both client strings **and** one `CreatedInboundRef`. Prefer **one code path** to avoid drift.

- [ ] **Step 3: Run tests**

```bash
cd apps/server && bun test src/xui/provisionMultihopChainClientAccess.test.ts src/routes/chains.test.ts
```

Expected: **PASS** (update mocks so `inbounds/add` JSON includes `"id": <number>` inside `obj`).

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/xui/provisionMultihopChainClientAccess.ts apps/server/src/xui/provisionMultihopChainClientAccess.test.ts apps/server/src/routes/chains.test.ts apps/server/src/xui/provisionChainClientAccess.ts
git commit -m "feat(server): record created inbounds for chain provision rollback"
```

---

### Task 4b: Extract `panelLoginCookie.ts` (avoid import cycles)

**Files:**

- Create: `apps/server/src/xui/panelLoginCookie.ts` (move `loginCookie`, `readPanelJson`, `requireSuccess`, `readSetCookieLines`, `extractSessionCookieHeader` from `provisionMultihopChainClientAccess.ts` — or only export **`loginCookie`** and keep privates file-local in the new module)
- Modify: `apps/server/src/xui/provisionMultihopChainClientAccess.ts` — import `loginCookie` from `./panelLoginCookie`

- [ ] **Step 1: Run tests** — `bun test src/xui/provisionMultihopChainClientAccess.test.ts`

- [ ] **Step 2: Commit** — `refactor(server): extract panel login cookie helper`

---

### Task 5: Compensation orchestrator

**Files:**

- Create: `apps/server/src/xui/compensateChainProvision.ts`
- Create: `apps/server/src/xui/compensateChainProvision.test.ts`

- [ ] **Step 1: Implement `compensateCreatedInbounds`**

```typescript
import { loginCookie } from "./panelLoginCookie";
import { deletePanelInboundById, resolveInboundIdByTag } from "./panelInboundDelete";
import type { CreatedInboundRef } from "./provisionMultihopChainClientAccess";

export async function compensateCreatedInbounds(input: {
  createdInbounds: CreatedInboundRef[];
  fetchFn?: typeof fetch;
}): Promise<void> {
  const fetchFn = input.fetchFn ?? fetch;
  for (const ref of [...input.createdInbounds].reverse()) {
    const { base, cookieHeader } = await loginCookie({
      panelBaseUrl: ref.panelBaseUrl,
      adminUsername: ref.adminUsername,
      adminPassword: ref.adminPassword,
      fetchFn,
    });
    let id = ref.inboundId;
    if (id == null) {
      id = (await resolveInboundIdByTag({
        panelApiBase: base,
        cookieHeader,
        inboundTag: ref.inboundTag,
        fetchFn,
      })) ?? null;
    }
    if (id == null) continue;
    try {
      await deletePanelInboundById({ panelApiBase: base, cookieHeader, inboundId: id, fetchFn });
    } catch {
      /* best-effort: swallow per spec */
    }
  }
}
```

**Note:** **`loginCookie`** lives in **`panelLoginCookie.ts`** (Task 4b), not in the multihop module.

- [ ] **Step 2: Test with mocks** — assert `del` called for ids in reverse order when three refs provided.

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/xui/compensateChainProvision.ts apps/server/src/xui/compensateChainProvision.test.ts
git commit -m "feat(server): compensate chain provision by deleting created inbounds"
```

---

### Task 6: Wire `chains.ts` generate-profile

**Files:**

- Modify: `apps/server/src/routes/chains.ts`
- Modify: `apps/server/src/index.ts`
- Modify: `apps/server/src/routes/chains.test.ts`

- [ ] **Step 1: Extend `chainsRoutes` signature**

```typescript
import type { SshExecFn } from "../vpn/sshExec";
import { buildSshExecUsingSpawn } from "../vpn/sshExec";
import { getAppSettings } from "../db/appSettings";
import { decryptVpnPassword } from "../crypto/vpnSecret";
import { runXuiUfwSyncWithRetries } from "../xui/runXuiUfwSync";
import { compensateCreatedInbounds } from "../xui/compensateChainProvision";

export function chainsRoutes(
  db: Database,
  env: { masterKey: Uint8Array; sshExec?: SshExecFn },
) {
  const sshExec = env.sshExec ?? buildSshExecUsingSpawn();
  // ...
}
```

- [ ] **Step 2: In `POST /:id/generate-profile`**, after building `hops: HopPanelContext[]`, also collect **`vpnProfileIds`** in hop order (already available from `chain.hops`).

When `getAppSettings(db).vpnSshEnabled` is **false**: keep current behavior (call `provisionMultihopChainClientAccess`, return JSON) — **ignore** `createdInbounds` for sync.

When **true**:

1. `const provisioned = await provisionMultihopChainClientAccess(...)` (now returns `createdInbounds`).
2. Build **`uniqueProfileIds`** in hop order (dedupe with `Set` preserving order).
3. For each `vpnProfileId`, `SELECT host, ssh_port, ssh_user, ssh_password_ciphertext, ssh_password_nonce FROM vpn_profiles WHERE id=?`, `decryptVpnPassword`, then `runXuiUfwSyncWithRetries({ host: row.host, port: row.ssh_port, user: row.ssh_user, password, knownHostsFile: getAppSettings(db).sshKnownHostsFile, sshExec, timeoutMs: 60_000 })`.
4. If **any** sync throws: `await compensateCreatedInbounds({ createdInbounds: provisioned.createdInbounds, fetchFn })`, then `return c.json({ error: "Firewall sync failed." }, 502)`.
5. Else strip internal fields before responding:

```typescript
const { createdInbounds: _ci, ...clientBody } = provisioned;
return c.json(clientBody);
```

- [ ] **Step 3: Update `index.ts`**

```typescript
authed.route("/chains", chainsRoutes(db, { masterKey: env.masterKey }));
```

(if default `sshExec` is internal, no change beyond import types if needed).

- [ ] **Step 4: Tests in `chains.test.ts`**

- Seed `app_settings` with `vpn_ssh_enabled=0` for existing tests (if not already default in test DB helper).
- New test: set `vpn_ssh_enabled=1`, inject `sshExec` that returns `{code:0}`, assert called once per **unique** profile on single-hop chain.
- New test: `vpn_ssh_enabled=1`, `sshExec` returns `{code:1}` until fail, assert **502** and fetch mock saw **`inbounds/del`** (compensation).

- [ ] **Step 5: Run full server tests**

```bash
cd apps/server && bun test
```

Expected: **PASS**.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/routes/chains.ts apps/server/src/index.ts apps/server/src/routes/chains.test.ts
git commit -m "feat(server): sync UFW over SSH after chain generate-profile"
```

---

### Task 7: Operator doc touch-up

**Files:**

- Modify: `docs/superpowers/specs/2026-04-17-chain-vless-reality-client-access-design.md`

- [ ] **Step 1:** Add under **Non-goals** or **Relationship** a sentence: when **`vpn_ssh_enabled`** is true and the remote has **`/usr/local/sbin/vpnmgr-xui-ufw-sync`** + **`sudoers`**, generate-profile may reconcile **UFW**; operators without that remain unchanged.

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/2026-04-17-chain-vless-reality-client-access-design.md
git commit -m "docs: note optional UFW sync after generate-profile"
```

---

## Self-review (plan vs spec)

| Spec requirement | Task coverage |
|------------------|---------------|
| B: Manager drives via SSH | Tasks 2, 6 |
| Reconcile script from `x-ui.db`, tagged rules | Task 1 |
| Skip if ufw missing/inactive | Task 1 (`exit 0`) |
| Retries then fail (A) | Tasks 2, 6 |
| Best-effort delete compensation | Tasks 3, 5, 6 |
| Silent skip when `vpn_ssh_enabled` false | Task 6 |
| No client-controlled remote command | Task 2 (`UFW_SYNC_REMOTE_BODY` constant) |
| Logging / no secret leak | Task 6: use generic **502** message (already matches chains catch style) |

**Placeholder scan:** None intentional; `loginCookie` export is called out as an implementation fork.

**Type consistency:** `CreatedInboundRef` is the single shape for compensation across multihop and single-hop.

---

## Operator checklist (not a code task)

Install on each 3x-ui host:

```bash
sudo install -m 755 scripts/vpnmgr-xui-ufw-sync.sh /usr/local/sbin/vpnmgr-xui-ufw-sync
echo 'your_ssh_user ALL=(root) NOPASSWD: /usr/local/sbin/vpnmgr-xui-ufw-sync' | sudo tee /etc/sudoers.d/vpnmgr-xui-ufw-sync
sudo chmod 440 /etc/sudoers.d/vpnmgr-xui-ufw-sync
```

Turn on **`vpn_ssh_enabled`** in VPN Manager settings only when the above is true.

---

**Plan complete and saved to `docs/superpowers/plans/2026-04-17-vpn-manager-3x-ui-ufw-sync.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — Dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
