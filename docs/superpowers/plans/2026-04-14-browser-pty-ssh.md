# Browser PTY SSH session Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the VPNs page placeholder SSH sheet with a **real PTY** to each profile’s SSH server, using **WebSocket + server-side SSH client + xterm.js**, gated by **`VPN_SSH_ENABLED`** and **signed-in session**, with host-key policy aligned to **`sshExec`**.

**Architecture:** Add **`ssh2`** on the server to open an **interactive shell with PTY**, bridged to the browser over **Hono `upgradeWebSocket` + Bun `websocket` export**. Centralize **pre-upgrade gates** (session cookie, flag, profile row) in a small testable module. Add **`xterm.js`** (+ fit) in the web app; build WebSocket URL from **`window.location`** so Vite’s **`/api` proxy** carries upgrades in dev. Wrap **`fetch`** so **`app.fetch(req, { server })`** passes Bun’s server into Hono (required for WebSocket upgrade).

**Tech Stack:** Bun, Hono 4 (`hono/bun` WebSocket helpers), `ssh2`, React 18, Vite 5, `@xterm/xterm`, `@xterm/addon-fit`.

**Spec:** `docs/superpowers/specs/2026-04-14-browser-pty-ssh-design.md`

---

## File map

| File | Responsibility |
|------|----------------|
| `apps/server/package.json` | Add runtime dependency **`ssh2`** (and **`@types/ssh2`** if types are not bundled). |
| `apps/server/src/index.ts` | Import **`upgradeWebSocket`**, **`websocket`** from **`hono/bun`**; pass **`{ server }`** into **`app.fetch`**; **`export default`** includes **`websocket`**. Thread **`upgradeWebSocket`** into **`createApp`** (new parameter) so **`profilesRoutes`** can register the SSH route. |
| `apps/server/src/routes/profiles.ts` | Accept optional **`upgradeWebSocket`** in **`ProfilesRoutesOptions`**; register **`GET /:id/ssh`** using **`getCookie` + `getSessionUserId`** before upgrade; on success, attach **`onMessage` / `onClose`** bridge (implementation delegates to **`attachProfileSshBridge`**). |
| `apps/server/src/routes/profiles.test.ts` | HTTP tests: **`GET /api/profiles/:id/ssh`** without cookie → **401** JSON (no upgrade); with cookie but **`vpnSshEnabled: false`** → **403** JSON; invalid id → **400**; unknown profile → **404**. |
| `apps/server/src/vpn/profileSshTerminalGate.ts` | Pure gate: **`userId` null → 401**; **`!vpnSshEnabled` → 403**; invalid **`profileId` → 400**; missing row → **404**. Returns **`{ allow: true, row, password }`** after **`decryptVpnPassword`** when allowed. |
| `apps/server/src/vpn/profileSshTerminalGate.test.ts` | Unit tests for **`profileSshTerminalGate`** (all branches, uses in-memory DB + **`encryptVpnPassword`** fixture row). |
| `apps/server/src/vpn/ssh2ConnectOptions.ts` | **`buildSsh2ConnectOptions(args)`** — host, port, user, password, **`readyTimeout`**, **`hostVerifier`** / **`knownHosts`** behavior mirroring **`buildSshExecUsingSpawn`** (`accept-new` when **`sshKnownHostsFile` unset**; strict file when set). |
| `apps/server/src/vpn/ssh2ConnectOptions.test.ts` | Assert option shapes / hostVerifier branches with mocked fs read for known_hosts file case. |
| `apps/server/src/vpn/profileSshBridge.ts` | **`attachProfileSshBridge({ ws, row, password, env })`** — creates **`Client`**, **`connect`**, **`shell({ term, cols, rows })"`**, pipes **binary** to **`ws.send`**, parses **JSON text** resize messages, **`setWindow`**, idle timer, cleanup **`conn.end()`**. |
| `apps/server/src/vpn/profileSshBridge.test.ts` | Mock **`ssh2`** **`Client`** (inject factory) so **no network**; assert **binary echo**, **resize JSON** calls **`stream.setWindow`**, disconnect cleans up. |
| `apps/web/package.json` | Add **`@xterm/xterm`**, **`@xterm/addon-fit`**. |
| `apps/web/src/pages/VpnsPage.tsx` | Replace **`SshTerminalSheet`** fake terminal with **xterm** + WebSocket lifecycle; **sign-in gate** for SSH button; Escape handler skips when focus inside terminal. |
| `apps/web/src/App.tsx` | Pass **`user`** from **`VpnsShell`** into **`VpnsPage`** as **`authUser: AuthUser | null`** so SSH can be disabled for guests without duplicating session fetch. |

---

### Task 1: Server dependencies (`ssh2`)

**Files:**
- Modify: `apps/server/package.json`

- [ ] **Step 1: Add dependency**

In `apps/server/package.json`, under `"dependencies"`, add:

```json
"ssh2": "^1.16.0"
```

If `bun add ssh2` does not install types and `tsc` complains, add:

```json
"@types/ssh2": "^1.15.0"
```

to **`devDependencies`**.

- [ ] **Step 2: Install**

Run:

```bash
bun install
```

Expected: lockfile updated, **`node_modules/ssh2`** present.

- [ ] **Step 3: Commit**

```bash
git add apps/server/package.json bun.lock
git commit -m "chore(server): add ssh2 for interactive SSH sessions."
```

---

### Task 2: `profileSshTerminalGate` (TDD)

**Files:**
- Create: `apps/server/src/vpn/profileSshTerminalGate.ts`
- Create: `apps/server/src/vpn/profileSshTerminalGate.test.ts`

- [ ] **Step 1: Write failing tests**

Create `apps/server/src/vpn/profileSshTerminalGate.test.ts`:

```typescript
import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { encryptVpnPassword } from "../crypto/vpnSecret";
import { migrate } from "../db/migrate";
import { resolveProfileSshTerminal } from "./profileSshTerminalGate";

const masterKey = new Uint8Array(32).fill(7);

describe("resolveProfileSshTerminal", () => {
  let db: Database;

  beforeEach(async () => {
    db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys = ON;");
    migrate(db);
    const { ciphertext, nonce } = await encryptVpnPassword(masterKey, "secret");
    db.query(
      `INSERT INTO vpn_profiles (label, host, ssh_port, ssh_user, ssh_password_ciphertext, ssh_password_nonce, panel_hostname, operational_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("P", "10.0.0.5", 22, "root", ciphertext, nonce, "panel.example.com", "pending");
  });

  test("401 when userId is null", async () => {
    const r = await resolveProfileSshTerminal({
      db,
      masterKey,
      vpnSshEnabled: true,
      userId: null,
      profileId: 1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(401);
  });

  test("403 when VPN_SSH_ENABLED is false", async () => {
    const r = await resolveProfileSshTerminal({
      db,
      masterKey,
      vpnSshEnabled: false,
      userId: 1,
      profileId: 1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(403);
  });

  test("400 when profile id invalid", async () => {
    const r = await resolveProfileSshTerminal({
      db,
      masterKey,
      vpnSshEnabled: true,
      userId: 1,
      profileId: 0,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  test("404 when profile missing", async () => {
    const r = await resolveProfileSshTerminal({
      db,
      masterKey,
      vpnSshEnabled: true,
      userId: 1,
      profileId: 99,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(404);
  });

  test("200 returns row and decrypted password when allowed", async () => {
    const r = await resolveProfileSshTerminal({
      db,
      masterKey,
      vpnSshEnabled: true,
      userId: 1,
      profileId: 1,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.row.host).toBe("10.0.0.5");
      expect(r.sshPassword).toBe("secret");
    }
  });
});
```

Run:

```bash
bun test apps/server/src/vpn/profileSshTerminalGate.test.ts
```

Expected: **FAIL** — module or export missing.

- [ ] **Step 2: Implement gate**

Create `apps/server/src/vpn/profileSshTerminalGate.ts`:

```typescript
import type { Database } from "bun:sqlite";
import { decryptVpnPassword } from "../crypto/vpnSecret";

export type ProfileSshRow = {
  id: number;
  host: string;
  ssh_port: number;
  ssh_user: string;
  ssh_password_ciphertext: Uint8Array;
  ssh_password_nonce: Uint8Array;
};

export type ResolveProfileSshTerminalArgs = {
  db: Database;
  masterKey: Uint8Array;
  vpnSshEnabled: boolean;
  userId: number | null;
  profileId: number;
};

export type ResolveProfileSshTerminalResult =
  | { ok: true; row: ProfileSshRow; sshPassword: string }
  | { ok: false; status: 400 | 401 | 403 | 404 };

export async function resolveProfileSshTerminal(
  args: ResolveProfileSshTerminalArgs,
): Promise<ResolveProfileSshTerminalResult> {
  if (args.userId === null) {
    return { ok: false, status: 401 };
  }
  if (!args.vpnSshEnabled) {
    return { ok: false, status: 403 };
  }
  if (!Number.isInteger(args.profileId) || args.profileId < 1) {
    return { ok: false, status: 400 };
  }

  const row =
    args.db
      .query<ProfileSshRow, [number]>(
        `SELECT id, host, ssh_port, ssh_user, ssh_password_ciphertext, ssh_password_nonce
         FROM vpn_profiles WHERE id = ?`,
      )
      .get(args.profileId) ?? null;

  if (!row) {
    return { ok: false, status: 404 };
  }

  const sshPassword = await decryptVpnPassword(
    args.masterKey,
    row.ssh_password_ciphertext,
    row.ssh_password_nonce,
  );

  return { ok: true, row, sshPassword };
}
```

Run:

```bash
bun test apps/server/src/vpn/profileSshTerminalGate.test.ts
```

Expected: **PASS**.

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/vpn/profileSshTerminalGate.ts apps/server/src/vpn/profileSshTerminalGate.test.ts
git commit -m "feat(server): gate browser SSH terminal by session and VPN_SSH_ENABLED."
```

---

### Task 3: `ssh2` connect options (host key policy)

**Files:**
- Create: `apps/server/src/vpn/ssh2ConnectOptions.ts`
- Create: `apps/server/src/vpn/ssh2ConnectOptions.test.ts`

- [ ] **Step 1: Write tests for known_hosts file mode**

Create `apps/server/src/vpn/ssh2ConnectOptions.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { buildSsh2ConnectOptions } from "./ssh2ConnectOptions";

describe("buildSsh2ConnectOptions", () => {
  test("when knownHostsFile is set, hostVerifier is defined", () => {
    const o = buildSsh2ConnectOptions({
      host: "h.example",
      port: 22,
      username: "root",
      password: "pw",
      knownHostsFile: "/tmp/nonexistent-for-this-test",
      readyTimeoutMs: 5000,
    });
    expect(typeof o.hostVerifier).toBe("function");
  });

  test("when knownHostsFile is unset, hostVerifier still defined (accept path)", () => {
    const o = buildSsh2ConnectOptions({
      host: "h.example",
      port: 22,
      username: "root",
      password: "pw",
      knownHostsFile: undefined,
      readyTimeoutMs: 5000,
    });
    expect(typeof o.hostVerifier).toBe("function");
    expect(o.host).toBe("h.example");
    expect(o.port).toBe(22);
    expect(o.username).toBe("root");
    expect(o.password).toBe("pw");
  });
});
```

Run:

```bash
bun test apps/server/src/vpn/ssh2ConnectOptions.test.ts
```

Expected: **FAIL**.

- [ ] **Step 2: Implement**

Create `apps/server/src/vpn/ssh2ConnectOptions.ts` implementing:

- **`readyTimeout`** from **`readyTimeoutMs`**.
- **`host`**, **`port`**, **`username`**, **`password`** passed through.
- **`hostVerifier`**:  
  - If **`knownHostsFile`** is **`undefined`**: implement **process-lifetime** acceptance keyed by **`host:port` + key fingerprint** (in-memory **`Map`**) so the first key seen is pinned until server restart (approximates **`accept-new`** without writing `known_hosts` on disk in v1).  
  - If **`knownHostsFile`** is set: **`readFileSync`** that path (UTF-8); **`hostVerifier`** returns **true** only if the remote public key appears in that file content (string includes check on OpenSSH line format, or parse lines minimally). If file missing or unreadable, treat as **verification failure** (`callback(false)`).

Use **`import type { ConnectConfig } from "ssh2"`** and return **`ConnectConfig`**.

Run:

```bash
bun test apps/server/src/vpn/ssh2ConnectOptions.test.ts
```

Expected: **PASS**.

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/vpn/ssh2ConnectOptions.ts apps/server/src/vpn/ssh2ConnectOptions.test.ts
git commit -m "feat(server): build ssh2 connect options with host key policy."
```

---

### Task 4: `profileSshBridge` with mocked `ssh2.Client`

**Files:**
- Create: `apps/server/src/vpn/profileSshBridge.ts`
- Create: `apps/server/src/vpn/profileSshBridge.test.ts`

- [ ] **Step 1: Write bridge test with fake client**

Create `apps/server/src/vpn/profileSshBridge.test.ts` that:

1. Builds a **`FakeClient`** class with **`.on`**, **`.connect`**, **`.end`**, and **`shell`** invoking callback with a **`FakeStream`** that has **`.on("data")`**, **`.stderr.on("data")`**, **`setWindow`**, **`write`**, **`end`**.
2. Calls **`createProfileSshWebSocketHandlers({ row, sshPassword, env, ClientImpl: FakeClient })"`** and simulates **`onOpen`**, **`onMessage`**, **`onClose`** with a fake **`ws`** (**`send`**, **`close`**).
3. Simulates **`ws`** with **`sent: unknown[]`**, **`closed: boolean`**, matching **`WSContext`** subset (**`send`**, **`close`**).
4. Asserts: **binary** `Uint8Array` from stream is forwarded; **JSON** `'{"type":"resize","cols":120,"rows":40}'` leads to **`setWindow(120, 40, ...)`** (width/height px optional **0** or sensible defaults per **`ssh2`** docs).

Run:

```bash
bun test apps/server/src/vpn/profileSshBridge.test.ts
```

Expected: **FAIL**.

- [ ] **Step 2: Implement `createProfileSshWebSocketHandlers`**

Create `apps/server/src/vpn/profileSshBridge.ts` exporting:

```typescript
import type { WSContext } from "hono/ws";

export function createProfileSshWebSocketHandlers(options: {
  row: { host: string; ssh_port: number; ssh_user: string };
  sshPassword: string;
  env: { sshKnownHostsFile?: string };
  ClientImpl?: typeof import("ssh2").Client;
}): {
  onOpen: (evt: Event, ws: WSContext) => void;
  onMessage: (evt: MessageEvent, ws: WSContext) => void;
  onClose: (evt: CloseEvent, ws: WSContext) => void;
};
```

Implementation notes:

- Use **`Client`** from **`ssh2`** (or **`ClientImpl`**).
- **`onOpen`**: **`conn.connect(buildSsh2ConnectOptions({ ... }))`**, then **`conn.shell({ term: "xterm-256color", cols: 80, rows: 24 }, ...)`**; on stream **`data`**, **`ws.send(Uint8Array)`** (binary); store **`stream`** and **`conn`** on a **`const state = { ... }`** closed over by **`onMessage` / `onClose`**.
- **`onMessage`**: if **`evt.data`** is **`string`**, **`JSON.parse`** when it looks like JSON; if **`type === "resize"`**, **`stream.setWindow(cols, rows, 0, 0)`** (adjust dimensions per **`ssh2`** typings if needed). If **`ArrayBuffer`** or **`Uint8Array`**, **`stream.write(Buffer.from(...))`**.
- **`onClose`**: **`conn.end()`**, clear idle timer.
- **`idleTimeoutMs`**: **45 * 60 * 1000**; reset on each **`onMessage`**; on fire **`conn.end()`** and **`ws.close(4408, "idle")`**.

In **`profiles.ts`**, the **`uw(...)`** handler returns **`createProfileSshWebSocketHandlers({ row: gate.row, sshPassword: gate.sshPassword, env: { sshKnownHostsFile: env.sshKnownHostsFile } })`** spread into the **`WSEvents`** object (same keys).

Run:

```bash
bun test apps/server/src/vpn/profileSshBridge.test.ts
```

Expected: **PASS**.

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/vpn/profileSshBridge.ts apps/server/src/vpn/profileSshBridge.test.ts
git commit -m "feat(server): WebSocket handlers bridging xterm to ssh2 PTY."
```

---

### Task 5: Hono WebSocket route + Bun `fetch` / `websocket` export

**Files:**
- Modify: `apps/server/src/index.ts`
- Modify: `apps/server/src/routes/profiles.ts`
- Modify: `apps/server/src/routes/profiles.test.ts`

- [ ] **Step 1: Extend `createApp` and default export**

In **`apps/server/src/index.ts`**:

- Import **`upgradeWebSocket`**, **`websocket`** from **`"hono/bun"`**.
- Pass **`upgradeWebSocket`** into **`profilesRoutes`** via **`ProfilesRoutesOptions`** (optional override for tests; default the imported **`upgradeWebSocket`**).
- Change **`export default`** so **`fetch`** forwards Bun’s server into Hono (required for **`getBunServer(c)`** inside the Bun adapter):

```typescript
import { upgradeWebSocket, websocket } from "hono/bun";

export default {
  get port() {
    return getServerState().env.port;
  },
  fetch(req: Request, server: unknown) {
    const { app } = getServerState();
    return app.fetch(req, { server } as { server: unknown });
  },
  websocket,
};
```

Ensure **`createApp`** is called with **`profiles: { upgradeWebSocket }`** when building the app so **`profilesRoutes`** receives the same helper instance Bun expects (use the **same** **`upgradeWebSocket`** imported at module level).

- [ ] **Step 2: Register `GET /:id/ssh` with gate-before-upgrade**

In **`apps/server/src/routes/profiles.ts`**:

- Import **`getCookie`** from **`"hono/cookie"`**, **`SESSION_COOKIE`**, **`getSessionUserId`**, **`resolveProfileSshTerminal`**, **`createProfileSshWebSocketHandlers`** from **`../vpn/profileSshBridge`**.
- Extend **`ProfilesRoutesOptions`** with **`upgradeWebSocket?: typeof upgradeWebSocket`** (annotate using **`import type { UpgradeWebSocket } from "hono/ws"`** — this repo’s Hono export path for websocket types is **`hono/ws`** per **`package.json` `"./ws"`**).

Add **`const uw = options.upgradeWebSocket ?? upgradeWebSocket`** (import default **`upgradeWebSocket`** from **`hono/bun`** at top of file).

Register **one route** with **two handlers** (middleware first, then upgrade). **Gate must run before `upgradeWebSocket`** so failed auth never upgrades:

```typescript
app.get(
  "/:id/ssh",
  async (c, next) => {
    const upgrade = c.req.header("Upgrade");
    if (!upgrade || upgrade.toLowerCase() !== "websocket") {
      return c.json({ error: "Expected WebSocket upgrade" }, 426);
    }

    const id = parseId(c.req.param("id"));
    if (id === null) {
      return c.json({ error: "Invalid VPN profile id" }, 400);
    }

    const token = getCookie(c, SESSION_COOKIE);
    const userId = getSessionUserId(db, token);

    const gate = await resolveProfileSshTerminal({
      db,
      masterKey: env.masterKey,
      vpnSshEnabled: env.vpnSshEnabled,
      userId,
      profileId: id,
    });

    if (!gate.ok) {
      const message =
        gate.status === 401
          ? "Unauthorized"
          : gate.status === 403
            ? "SSH is disabled on this server"
            : "Profile not found";
      return c.json({ error: message }, gate.status === 404 ? 404 : gate.status);
    }

    c.set("sshTerminalGate", gate);
    await next();
  },
  uw((c) => {
    const gate = c.get("sshTerminalGate") as Extract<
      Awaited<ReturnType<typeof resolveProfileSshTerminal>>,
      { ok: true }
    >;

    return createProfileSshWebSocketHandlers({
      row: gate.row,
      sshPassword: gate.sshPassword,
      env: { sshKnownHostsFile: env.sshKnownHostsFile },
    });
  }),
);
```

Add a **`declare module "hono"`** **`Variables`** extension (in **`apps/server/src/types.ts`** if that file already augments Hono; otherwise add the minimal **`declare module "hono"` { interface Variables { sshTerminalGate: ... } }`** next to other server types) for **`sshTerminalGate`**.

- [ ] **Step 3: Run server smoke**

```bash
bun --cwd apps/server dev
```

Expected: server starts with no type errors.

- [ ] **Step 4: HTTP tests for gate (no real WS)**

Add to **`profiles.test.ts`**. Add this helper **once** inside the **`describe`**, using the same **`env.masterKey`** as other tests:

```typescript
async function insertVpnProfileId1ForSsh(db: Database) {
  const { ciphertext, nonce } = await encryptVpnPassword(env.masterKey, "pw");
  db.query(
    `INSERT INTO vpn_profiles (id, label, host, ssh_port, ssh_user, ssh_password_ciphertext, ssh_password_nonce, panel_hostname, operational_status)
     VALUES (1, 'Ssh', '127.0.0.1', 22, 'root', ?, ?, 'panel.test', 'pending')`,
  ).run(ciphertext, nonce);
}
```

```typescript
test("GET /api/profiles/1/ssh without session returns 401", async () => {
  await insertVpnProfileId1ForSsh(db);
  const app = createApp(db, { ...env, vpnSshEnabled: true });
  const res = await app.request("/api/profiles/1/ssh", {
    headers: { Upgrade: "websocket", Connection: "Upgrade" },
  });
  expect(res.status).toBe(401);
});

test("GET /api/profiles/1/ssh with session when VPN_SSH_ENABLED false returns 403", async () => {
  await insertVpnProfileId1ForSsh(db);
  const app = createApp(db, { ...env, vpnSshEnabled: false });
  const res = await app.request("/api/profiles/1/ssh", {
    headers: {
      Cookie: `${SESSION_COOKIE}=session-token`,
      Upgrade: "websocket",
      Connection: "Upgrade",
    },
  });
  expect(res.status).toBe(403);
});
```

Expect **JSON** bodies with **`401` / `403`** and **no WebSocket upgrade** (response is a normal **`Response`** from **`app.request`**).

Run:

```bash
bun test apps/server/src/routes/profiles.test.ts
```

Expected: **PASS**.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/index.ts apps/server/src/routes/profiles.ts apps/server/src/routes/profiles.test.ts
git commit -m "feat(server): WebSocket SSH terminal route with Bun adapter."
```

---

### Task 6: Web client — xterm + WebSocket

**Files:**
- Modify: `apps/web/package.json`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/pages/VpnsPage.tsx`

- [ ] **Step 1: Add xterm packages**

```json
"@xterm/xterm": "^5.5.0",
"@xterm/addon-fit": "^0.10.0"
```

Run **`bun install`** from repo root.

- [ ] **Step 2: Pass `authUser` into `VpnsPage`**

In **`App.tsx`**, change **`<VpnsPage />`** to **`<VpnsPage authUser={user} />`** inside **`VpnsShell`**.

Add prop type to **`VpnsPage`**.

- [ ] **Step 3: Replace `SshTerminalSheet` internals**

In **`VpnsPage.tsx`**:

- **`import "@xterm/xterm/css/xterm.css"`**  
- **`import { Terminal } from "@xterm/xterm"`**  
- **`import { FitAddon } from "@xterm/addon-fit"`**  
- **`useRef<HTMLDivElement>(null)`** for container; **`useEffect`** on open:
  - **`const ws = new WebSocket(wsUrl)`** where  
    **`const wsUrl = `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/api/profiles/${profile.id}/ssh`;`**
  - **`ws.binaryType = "arraybuffer"`**
  - Instantiate **`Terminal`**, **`FitAddon`**, **`terminal.open(ref)`**, **`fit()`**
  - **`terminal.onData((data) => ws.send(new TextEncoder().encode(data)))`** — or send **strings** if server accepts; align with server (**prefer binary `Uint8Array`** for input: **`ws.send`** with **`Uint8Array`** from **`TextEncoder`**).
  - **`ws.onmessage`**: if **`typeof ev.data === "string"`**, **`JSON.parse`** for control (ignore); else **`terminal.write(new Uint8Array(await (ev.data as Blob).arrayBuffer()))`** — if **`ArrayBuffer`**, use directly.
  - **`ws.onclose`**: show **“Disconnected”** in UI state + **Reconnect** button that re-runs effect key **`sessionKey`**.  
  - Cleanup: **`ws.close()`**, **`terminal.dispose()`**.

- [ ] **Step 4: Guest gate**

If **`authUser === null`**, **SSH** button **disabled** or opens sheet with message: **“Sign in to open a browser SSH session.”** and link to **`/login`**.

- [ ] **Step 5: Escape key**

Change global Escape listener: only call **`onClose`** if **`!event.defaultPrevented`** and **`!terminalContainerRef.current?.contains(event.target as Node)`**.

- [ ] **Step 6: Manual smoke**

```bash
bun run dev:server
```

(in one terminal)

```bash
bun run dev:web
```

Sign in, open SSH on a test profile with **`VPN_SSH_ENABLED=true`**, verify shell.

- [ ] **Step 7: Commit**

```bash
git add apps/web/package.json apps/web/src/App.tsx apps/web/src/pages/VpnsPage.tsx bun.lock
git commit -m "feat(web): real PTY SSH terminal via WebSocket and xterm."
```

---

### Task 7: Documentation touchpoint (env example only)

**Files:**
- Modify: `apps/server/.env.example` (if present)

- [ ] **Step 1: Document behavior**

Add comments: **`VPN_SSH_ENABLED`** must be **true** for browser SSH; **`SSH_KNOWN_HOSTS_FILE`** optional strict host keys.

- [ ] **Step 2: Commit**

```bash
git add apps/server/.env.example
git commit -m "docs(server): note VPN_SSH_ENABLED for browser SSH terminal."
```

---

## Spec coverage (self-review)

| Spec section | Tasks |
|--------------|-------|
| PTY + WebSocket + xterm | Tasks 4–6 |
| `VPN_SSH_ENABLED` gate | Tasks 2, 5 |
| Session cookie / signed-in for shell | Tasks 2, 5, 6 |
| Host keys aligned with `sshExec` | Task 3 (+ Task 4 uses options) |
| Binary + JSON resize | Tasks 4, 6 |
| Idle / lifecycle cleanup | Task 4 |
| No auto-reconnect | Task 6 (Reconnect button) |
| Escape vs xterm focus | Task 6 |

**Placeholder scan:** None intentional.

**Type consistency:** Use **`import type { UpgradeWebSocket, WSContext } from "hono/ws"`** (this repo’s Hono **`"./ws"`** export). If **`tsc`** rejects **`app.get` with three arguments**, split into **`app.use`** + **`app.get`** on the same path per Hono 4.12 docs.

---

Plan complete and saved to `docs/superpowers/plans/2026-04-14-browser-pty-ssh.md`. Two execution options:

**1. Subagent-Driven (recommended)** — Dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using **executing-plans**, batch execution with checkpoints.

Which approach do you want?
