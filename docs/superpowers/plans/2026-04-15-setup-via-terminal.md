# Setup via in-browser terminal (server-driven PTY) — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When **VPN_SSH_ENABLED** is on, **Setup** opens a **read-only xterm** wired to a **new WebSocket**; the server runs the **same logical setup phases** as today by **injecting scripts into one `ssh2` shell PTY** and updates the DB on success/failure. **Closing** the sheet while running shows a **confirm**: **Stop** (cancel + `Pending` + error) or **Continue in background** (WS closes with a **detach** close code; driver runs to completion). **Interactive SSH** is unchanged. **Dry-run** when SSH is disabled stays on **`POST /api/profiles/:id/setup`**.

**Architecture:** Add **`GET /api/profiles/:id/setup-terminal`** (WebSocket upgrade) parallel to **`/:id/ssh`**, implemented by a **new bridge module** (do not overload `profileSshBridge.ts`). Introduce a **shell phase driver** that wraps each phase script in a **base64 + `bash -c`** envelope and parses a unique **`VPNMGR_PHASE_EXIT:<id>:<code>`** line from the PTY stream. Extract a **shared live phase loop** from `setupRunner.ts` that accepts a **`SshExecFn`-shaped async function** so both **`ssh2` exec** (legacy / tests) and **PTY injection** share DB + encryption rules. In-process **`setupRunRegistry`** enforces **one automated setup per profile id** per API process. **`POST /setup`** returns **410** when live SSH setup must use the terminal; returns **dry-run** JSON when **`vpnSshEnabled`** is false.

**Tech Stack:** Bun, `bun:sqlite`, Hono `upgradeWebSocket`, `ssh2`, Bun test runner, React, TanStack Query, xterm.js (existing).

**Spec:** `docs/superpowers/specs/2026-04-15-setup-via-terminal-design.md`

---

## File structure (create / modify)

| Path | Responsibility |
|------|----------------|
| `apps/server/src/vpn/setupShellDriver.ts` | **New.** Encode script for PTY, write wrapper command, read stream until exit marker or timeout; return `{ code, tail }` for one phase. |
| `apps/server/src/vpn/setupShellDriver.test.ts` | **New.** Fake duplex stream; asserts delimiter parsing and non-zero exit. |
| `apps/server/src/vpn/setupRunRegistry.ts` | **New.** `tryBeginSetupRun(profileId)`, `endSetupRun(profileId)`, `markRunDetached(profileId)`, `signalRunCancel(profileId)`, `isSetupRunActive(profileId)`. |
| `apps/server/src/vpn/setupRunRegistry.test.ts` | **New.** Mutex: second begin fails; cancel signals `AbortSignal`. |
| `apps/server/src/vpn/setupLivePhaseLoop.ts` | **New.** `runLiveSetupPhases(options)` — shared loop: phases + executor + DB writes for failures + success encryption block; extracted from current `executeProfileSetup` live path. |
| `apps/server/src/vpn/setupLivePhaseLoop.test.ts` | **New.** Fake executor returning codes; asserts DB `operational_status` / `last_setup_error`. |
| `apps/server/src/vpn/setupRunner.ts` | **Modify.** Dry-run unchanged; live path calls `runLiveSetupPhases` with `sshExec`; export types if needed. |
| `apps/server/src/vpn/profileSetupTerminalBridge.ts` | **New.** WebSocket handlers: gate row includes `operational_status`, `panel_hostname`; register run; `ssh2` shell; pipe PTY→WS; driver calls `runLiveSetupPhases` with PTY executor; **onClose**: if code **4401** detach else cancel cleanup; **no 45m idle kill** during active setup driver (use phase timeout only). |
| `apps/server/src/vpn/profileSetupTerminalBridge.test.ts` | **New.** Fake `Client` / stream; assert `onMessage` ignores non-resize JSON for keystrokes; assert close detach path does not call `stream.end` immediately. |
| `apps/server/src/vpn/profileSshTerminalGate.ts` | **Optional modify.** Either add `resolveProfileSetupTerminalGate(...)` in this file or **new** `profileSetupTerminalGate.ts` returning **409** for `working`, **400** for empty `panel_hostname`, reusing decrypt + auth pattern. |
| `apps/server/src/routes/profiles.ts` | **Modify.** Register **`/:id/setup-terminal`** WebSocket; **`POST /:id/setup`**: if `getAppSettings(db).vpnSshEnabled` then **410** JSON `{ error: "...", useSetupTerminal: true }` (skip live `executeProfileSetup`); else existing dry-run behavior. |
| `apps/server/src/routes/profiles.test.ts` | **Modify.** New WS tests (upgrade expected, 401/403/404/409); **POST setup** when SSH enabled → **410**; dry-run unchanged when disabled. |
| `apps/web/src/pages/VpnsPage.tsx` | **Modify.** If preflight `sshTerminalEnabled`, **Setup** opens **`SetupTerminalSheet`** (viewer-only WS, close codes **4400**/**4401**); else keep **`setupMutation`** POST for dry-run sheet. Confirm dialog on close while `setupRunning`. |

### WebSocket close codes (client → server)

| Code | Meaning |
|------|---------|
| **4400** | User chose **Stop setup** (or abnormal tab close treated as stop). Server **aborts** driver and SSH. |
| **4401** | User chose **Continue in background**. Server **detaches**: WebSocket closes but **driver + ssh2** continue until completion or external cancel. |

---

### Task 1: `setupShellDriver` (TDD)

**Files:**
- Create: `apps/server/src/vpn/setupShellDriver.ts`
- Create: `apps/server/src/vpn/setupShellDriver.test.ts`

**Protocol (lock this in):**

1. Generate `marker = "VPNMGR_PHASE_EXIT_" + randomAlnum(20)`.
2. `b64 = Buffer.from(script, "utf8").toString("base64")` (Bun `Buffer` is available).
3. Write to PTY (UTF-8): `bash -c 'eval "$(printf %s "' + b64 + '" | base64 -d)"'; printf '\n%s:%s\n' '` + marker + `' "$?"\n`  
   Adjust quoting so the **only** dynamic parts are `b64` and `marker`; the remote must run `bash -c` with a single argument — use a safe pattern (e.g. pass `b64` via environment variable set in the same line: `B64='...' bash -c 'eval "$(printf %s "$B64" | base64 -d)"; ...'` if nested quotes become unmaintainable).
4. Read combined PTY output until a line matching `^${marker}:(\d+)$` (multiline buffer) or **timeout** (`PHASE_TIMEOUT_MS` from `setupRunner.ts` — **import the same constant** or move it to a tiny `apps/server/src/vpn/setupConstants.ts` if you need to avoid circular imports).
5. Return `{ code: number, captured: string }` where `captured` is the tail (bounded, e.g. last 16KiB) for DB error fields.

- [ ] **Step 1: Write failing test** in `setupShellDriver.test.ts`

```ts
import { describe, expect, test } from "bun:test";
import { runPhaseScriptOnPtyStream } from "./setupShellDriver";

function createFakePtyPair() {
  const fromHostChunks: string[] = [];
  let onData: (chunk: string) => void = () => {};

  const toHost = {
    write(data: string) {
      fromHostChunks.push(data);
      if (data.includes("echo hello") || data.includes("base64")) {
        queueMicrotask(() => onData("hello-out\nVPNMGR_PHASE_EXIT_testmarker:0\n"));
      }
    },
  };

  const fromHost = {
    setListener(fn: (chunk: string) => void) {
      onData = fn;
    },
  };

  return { toHost, fromHost, fromHostChunks };
}

describe("runPhaseScriptOnPtyStream", () => {
  test("parses exit marker from mixed PTY output", async () => {
    const { toHost, fromHost } = createFakePtyPair();
    const result = await runPhaseScriptOnPtyStream({
      write: (s) => toHost.write(s),
      onOutput: (cb) => fromHost.setListener(cb),
      script: "echo hello",
      timeoutMs: 5_000,
      markerPrefix: "VPNMGR_PHASE_EXIT_",
    });
    expect(result.code).toBe(0);
    expect(result.captured).toContain("hello-out");
  });
});
```

Adapt the fake to match the **actual** exported function signature you implement (e.g. pass `Duplex` interface). The test above is illustrative — **align names** with your real API in Step 3.

- [ ] **Step 2: Run test — expect FAIL**

Run: `bun test apps/server/src/vpn/setupShellDriver.test.ts`  
Expected: **FAIL** (missing export).

- [ ] **Step 3: Implement** `setupShellDriver.ts` with exported `runPhaseScriptOnPtyStream` (or equivalent) implementing the protocol in this task.

- [ ] **Step 4: Run test — expect PASS**

Run: `bun test apps/server/src/vpn/setupShellDriver.test.ts`  
Expected: **PASS**

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/vpn/setupShellDriver.ts apps/server/src/vpn/setupShellDriver.test.ts
git commit -m "feat(server): add PTY setup shell phase driver"
```

---

### Task 2: `setupRunRegistry` (TDD)

**Files:**
- Create: `apps/server/src/vpn/setupRunRegistry.ts`
- Create: `apps/server/src/vpn/setupRunRegistry.test.ts`

```ts
import { describe, expect, test } from "bun:test";
import {
  beginSetupRun,
  endSetupRun,
  isSetupRunActive,
  signalSetupRunCancel,
} from "./setupRunRegistry";

describe("setupRunRegistry", () => {
  test("rejects second begin for same profileId", () => {
    const a = beginSetupRun(1);
    expect(a.ok).toBe(true);
    const b = beginSetupRun(1);
    expect(b.ok).toBe(false);
    if (a.ok) endSetupRun(1);
  });

  test("signalSetupRunCancel aborts registered signal", () => {
    const r = beginSetupRun(2);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    let aborted = false;
    r.signal.addEventListener("abort", () => {
      aborted = true;
    });
    signalSetupRunCancel(2);
    expect(aborted).toBe(true);
    endSetupRun(2);
  });

  test("isSetupRunActive reflects registry", () => {
    expect(isSetupRunActive(3)).toBe(false);
    const r = beginSetupRun(3);
    expect(r.ok).toBe(true);
    expect(isSetupRunActive(3)).toBe(true);
    if (r.ok) endSetupRun(3);
    expect(isSetupRunActive(3)).toBe(false);
  });
});
```

- [ ] Implement `beginSetupRun(profileId: number): { ok: true; signal: AbortSignal } | { ok: false }`, `endSetupRun(profileId)`, `signalSetupRunCancel(profileId)`, `isSetupRunActive(profileId)`. Use `Map<number, AbortController>`; `signal` is `abortController.signal`.

- [ ] **Run:** `bun test apps/server/src/vpn/setupRunRegistry.test.ts` → **PASS**

- [ ] **Commit:** `feat(server): add in-process automated setup run registry`

---

### Task 3: Extract `runLiveSetupPhases` (TDD)

**Files:**
- Create: `apps/server/src/vpn/setupLivePhaseLoop.ts`
- Create: `apps/server/src/vpn/setupLivePhaseLoop.test.ts`
- Modify: `apps/server/src/vpn/setupRunner.ts`

**Behavior to preserve:** Identical outcomes for the current **`sshExec`** loop: same `SetupPhaseResult[]` shape, same `UPDATE` on phase failure, same success `UPDATE` with encrypted x-ui secrets.

- [ ] **Step 1:** In `setupLivePhaseLoop.test.ts`, use an in-memory DB with the same `vpn_profiles` columns as `setupRunner` tests (copy minimal `INSERT` from `apps/server/src/routes/profiles.test.ts` or `setupRunner` usage), **`fakeSshExec`** that returns `{ code: 0, stdout: "", stderr: "" }`, call `runLiveSetupPhases`, expect `operational_status === 'working'`.

- [ ] **Step 2:** Move the **live** loop + success DB transaction from `executeProfileSetup` into `runLiveSetupPhases({ db, env, profileId, row, sshPassword, phases, exec, signal })` where `exec` matches `SshExecFn`.

- [ ] **Step 3:** `executeProfileSetup` calls `runLiveSetupPhases` with `sshExec` and **`AbortSignal.none`** (or `undefined` meaning non-cancellable for HTTP path).

- [ ] **Run:** `bun test apps/server/src/vpn/setupLivePhaseLoop.test.ts apps/server/src/vpn/setupRunner.ts apps/server/src/routes/profiles.test.ts` (or `bun test apps/server`) → **PASS**

- [ ] **Commit:** `refactor(server): extract shared live setup phase loop`

---

### Task 4: `profileSetupTerminalBridge` + gate helper

**Files:**
- Create: `apps/server/src/vpn/profileSetupTerminalGate.ts` (if not extending `profileSshTerminalGate.ts`)
- Create: `apps/server/src/vpn/profileSetupTerminalBridge.ts`
- Create: `apps/server/src/vpn/profileSetupTerminalBridge.test.ts`

**Gate SQL** must load at least: `id, host, ssh_port, ssh_user, operational_status, panel_hostname, ssh_password_*`, and reject with **400** if `panel_hostname` blank, **409** if `operational_status !== 'pending'`, **404** missing row, **401/403** same as SSH terminal.

**Bridge flow:**

1. `onOpen`: `beginSetupRun(profileId)` — if `{ ok: false }`, `ws.close(1011, "setup already running")` and return (WS cannot return HTTP 409 after upgrade; tests assert this close path).
2. Connect `ssh2`, `shell({ term: "xterm-256color", cols, rows })`.
3. Forward every PTY `data` chunk to `ws.send` as **binary** (mirror `profileSshBridge.ts`).
4. Start **one** async driver: call **`runLiveSetupPhases`** with `signal` from the registry and an **`exec` adapter** that implements `SshExecFn` by calling **`runPhaseScriptOnPtyStream`** on the open shell (ignore `host`/`port`/`user`/`password` in args — the session is already authenticated). Single loop, no per-phase duplicate calls to `runLiveSetupPhases`.
5. On success or terminal failure, send **one text** JSON control frame **`{ "type": "setupComplete", "outcome": "success" | "failed" }`** then `ws.close(1000, "done")` so the client can skip the close confirm dialog when the run is already finished.
6. **`onMessage`:** Only handle `{ "type": "resize", ... }` like `profileSshBridge.ts`; **ignore** other text (no keystrokes to host).
7. **`onClose`:** If code **4401**, **detach**: do not destroy the PTY until the driver finishes; if **4400** or abnormal, call **`signalSetupRunCancel(profileId)`** then **`cleanup()`**. Always **`endSetupRun(profileId)`** when the ssh2 connection is fully torn down.
8. **Idle:** Do **not** use the 45-minute idle timer from interactive SSH; rely on **per-phase** timeout inside `runPhaseScriptOnPtyStream`.

- [ ] **Tests:** Fake `ClientImpl` like `profileSshBridge.test.ts`; assert that after `onClose` with detach code the fake stream is **not** ended synchronously.

- [ ] **Run:** `bun test apps/server/src/vpn/profileSetupTerminalBridge.test.ts`  
- [ ] **Commit:** `feat(server): add setup-terminal WebSocket bridge`

---

### Task 5: Wire route + change `POST /setup`

**Files:**
- Modify: `apps/server/src/routes/profiles.ts`
- Modify: `apps/server/src/routes/profiles.test.ts`

- [ ] Add **`app.get("/:id/setup-terminal", ...)`** mirroring **`/:id/ssh`**: non-WebSocket → **426**; reuse session + `vpnSshEnabled`; call **new gate**; on success `uw((c) => createProfileSetupTerminalWebSocketHandlers({ ... }))`.

- [ ] In **`POST /:id/setup`**, after loading settings, if **`vpnSshEnabled`** is **true**, return **`410`** with body:

```json
{
  "error": "Live setup runs in the browser terminal",
  "useSetupTerminal": true
}
```

Do **not** run `executeProfileSetup` for live in that branch.

- [ ] When **`vpnSshEnabled`** is **false**, keep current **`executeProfileSetup`** dry-run return.

- [ ] **Tests:**  
  - `POST` with fake env `vpnSshEnabled: true` → **410** + JSON keys above.  
  - `GET` upgrade `setup-terminal` without session → **401** JSON before upgrade (match how `/ssh` tests work).  
  - Valid session + pending profile + second concurrent connection: second gets close or 409 per your bridge — assert **one** succeeds.  
  - **Update every existing test** that currently expects **200** from **`POST .../setup`** with **`vpnSshEnabled: true`** to either use **`vpnSshEnabled: false`** for dry-run assertions or assert **410** and then drive **`setup-terminal`** if full live setup is under test.

Run: `bun test apps/server/src/routes/profiles.test.ts`

- [ ] **Commit:** `feat(server): add setup-terminal route and gate live POST setup`

---

### Task 6: Web — `SetupTerminalSheet` + `VpnsPage` flow

**Files:**
- Modify: `apps/web/src/pages/VpnsPage.tsx`

- [ ] **Preflight:** Reuse `GET /api/profiles/ssh-terminal/preflight` (`sshTerminalEnabled`). When **false**, **`handleSetup`** keeps calling **`setupProfile` POST** and **`setupMutation`** (dry-run sheet).

- [ ] **When true:** **`handleSetup(profile)`** sets state `setSetupTerminalProfile(profile)` instead of mutation (or opens sheet with profile id).

- [ ] **New component** `SetupTerminalSheet` (same file or extract if >400 lines — prefer same file to match existing `SshTerminalSheet` pattern):  
  - `Terminal` + `FitAddon` like **`SshTerminalSheet`**.  
  - WebSocket URL: `` `${wsProtocol}//${window.location.host}/api/profiles/${profile.id}/setup-terminal` ``  
  - **`term.onData`:** **do not** send to socket (viewer-only).  
  - **Resize:** same JSON as SSH path.  
  - **`socket.onclose`:** if `code === 1000` and setup succeeded, invalidate queries (profile should be **working**); if failure, show `disconnectHint` from server close reason (non-secret).

- [ ] **Close / Escape / backdrop:** If `setupActive` (socket `OPEN` and server has not sent a small JSON **control** message `{ "type": "setupComplete", "outcome": "success" | "failed" }` — **recommended** to add this **one** text JSON from server at end so client knows to skip confirm), show **`window.confirm`** with text like:  
  `"Setup is still running. OK = continue in background, Cancel = stop setup"`  
  Map: **OK** → `socket.close(4401, "detach")`, **Cancel** → `socket.close(4400, "cancel")`.  
  (Adjust copy to match UX standards — the spec requires two explicit outcomes; `confirm` is acceptable for v1.)

- [ ] **Remove** reliance on **`setupMutation`** for live success sheet — success closes terminal or shows brief “Setup complete”; **invalidate** `profilesQueryKey`.

- [ ] **`setupBusy`:** derive from `setupTerminalProfile?.id === profile.id && socketNotTerminalIdle` local state.

- [ ] **Run:** `bun test apps/web` (if tests exist) and **`bun run build:web`** or **`bun --cwd apps/web exec tsc --noEmit`** per repo norms.

- [ ] **Commit:** `feat(web): run setup via setup-terminal WebSocket`

---

### Task 7: Verification sweep

- [ ] Run: `bun test apps/server`  
  Expected: **all PASS**

- [ ] Manual smoke (optional in plan): `bun run dev`, pending profile, **Setup** opens terminal, output scrolls, profile becomes **working**.

- [ ] **Commit:** `chore: verify setup-terminal integration` (only if you made fixes; otherwise skip empty commit)

---

## Spec coverage (self-review)

| Spec section | Plan tasks |
|--------------|------------|
| Dedicated WS route | Task 5 |
| Server-driven PTY + viewer browser | Tasks 1, 4, 6 |
| Same phases / DB / secrets | Tasks 1, 3, 4 |
| Mutex per profile | Tasks 2, 4, 5 |
| Close confirm stop vs background | Tasks 4, 6 + close codes |
| Interactive SSH unchanged | Task 4 (new file), Task 5 does not touch `/ssh` handlers |
| Dry-run when SSH disabled | Task 5–6 |
| `POST` live deprecated (410) | Task 5–6 |
| Phase timeout vs idle 45m | Tasks 1, 4 |
| Tests (unit + routes) | Tasks 1–5, 7 |

**Placeholder scan:** None intentional; marker protocol is fixed in Task 1.

**Type consistency:** `SshExecFn` in `apps/server/src/vpn/sshExec.ts` remains the type for **`runLiveSetupPhases`** `exec` parameter; PTY bridge implements `({ remoteScript, timeoutMs, ... }) => Promise<{ code, stdout, stderr }>` adapting host/port from the already-open stream (ignore host in adapter).

---

**Plan complete and saved to `docs/superpowers/plans/2026-04-15-setup-via-terminal.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — Dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
