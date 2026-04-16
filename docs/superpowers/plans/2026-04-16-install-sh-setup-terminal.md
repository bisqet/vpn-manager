# 3x-ui `install.sh` setup terminal — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace phased remote `buildSetupPhases` setup with **upstream `install.sh`**, driven over **`ssh2` shell + PTY** on `GET /api/profiles/:id/setup-terminal`, using an **expect-style** prompt driver, **SSH-parity** resize + (ignored-during-automation) keystrokes from the browser, and **transcript parsing (choice A)** for credentials. **Dry-run** when `vpnSshEnabled` is false must still return a useful JSON shape without claiming obsolete Caddy/UFW steps.

**Architecture:** New focused modules (`ptyText`, `installShTranscriptParser`, `installShPromptDriver`, `runInstallShSetupSession`) encapsulate ANSI handling, regex extraction for the “Panel Installation Complete” banner, and ordered prompt rules. `profileSetupTerminalBridge.ts` switches from `exec`+phase loop to **`shell`** + driver + DB encrypt like `setupLivePhaseLoop` today. **`setupComplete`** is sent as a **WebSocket text** frame (already supported in `tryConsumeSetupCompleteJson` in `VpnsPage.tsx`) after PTY output stops, so xterm is not corrupted.

**Tech stack:** Bun, `ssh2`, Hono WebSocket, React + xterm (`apps/web`), existing `encryptXuiSecretsJson` (`apps/server/src/crypto/xuiSecrets.ts`).

**Authoritative spec:** `docs/superpowers/specs/2026-04-16-install-sh-setup-terminal-design.md`

---

## File map (create / modify)

| Path | Role |
|------|------|
| `apps/server/src/vpn/ptyPlaintext.ts` | Append PTY bytes → rolling plaintext (optional ANSI strip for matchers). |
| `apps/server/src/vpn/installShTranscriptParser.ts` | `parseInstallShCredentials(plainTranscript, panelHostname): { username, password, webBasePath } \| null` |
| `apps/server/src/vpn/installShTranscriptParser.test.ts` | Golden transcript fixtures (no real secrets; use `userREDACTED` / `passREDACTED`). |
| `apps/server/src/vpn/installShPromptDriver.ts` | Ordered rules: `{ whenIncludes: string | RegExp; send: string; timeoutMs: number }[]`, `driveInstallShSession(opts)` async API. |
| `apps/server/src/vpn/installShPromptDriver.test.ts` | Fake stream sequences → expected writes. |
| `apps/server/src/vpn/runInstallShSetupSession.ts` | Orchestrates: start command, run driver until completion marker or global timeout, parse transcript, return `{ outcome, transcriptTail, stallHint? }`. |
| `apps/server/src/vpn/profileSetupTerminalBridge.ts` | **Major rewrite:** `shell` not `exec`; forward resize; gate `onMessage` writes while driver `running`; call `runInstallShSetupSession`; send text `setupComplete`; remove `buildSetupPhases` / `runPhaseScriptOnPtyStream` / `_runLiveSetupPhases` hook. |
| `apps/server/src/vpn/profileSetupTerminalBridge.test.ts` | Mock shell stream + driver stub; assert WS text JSON + DB fields. |
| `apps/server/src/vpn/setupRunner.ts` | Dry-run: return **one** synthetic phase describing `install.sh`; **remove** live `runLiveSetupPhases` branch (production HTTP already returns 410 when SSH enabled). |
| `apps/server/src/routes/profiles.test.ts` | Update `executeProfileSetup` tests: dry-run expectations; **remove or rewrite** live-path tests that depended on phased SSH exec. |
| `apps/server/src/vpn/setupPhases.ts` | **Optional:** keep file for `curlLoopbackResolve` / teardown if still imported elsewhere; otherwise trim dead exports only in a later cleanup task. Do **not** delete until `executeProfileTeardown` / imports audited. |
| `apps/server/src/vpn/setupLivePhaseLoop.ts` | If nothing imports after Task 7, delete; else leave with comment “HTTP live setup removed — only historical”. |
| `apps/web/src/pages/VpnsPage.tsx` | `SetupTerminalSheet`: add `term.onData` → `socket.send` (mirror `SshTerminalSheet`); optional subtitle “Automation controls input…”; remove debug `fetch` to `127.0.0.1:7907` if still present. |

---

### Task 1: Transcript parser (TDD)

**Files:**
- Create: `apps/server/src/vpn/installShTranscriptParser.ts`
- Create: `apps/server/src/vpn/installShTranscriptParser.test.ts`

**Fixture source:** From upstream `config_after_install` the script prints lines like `Username:`, `Password:`, `WebBasePath:`, `Access URL:` after “Panel Installation Complete” (see `install.sh` ~696–704 in `MHSanaei/3x-ui` `master`). Real runs include ANSI (`\x1b[32m`, etc.).

- [ ] **Step 1: Write failing tests**

In `installShTranscriptParser.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { parseInstallShCredentials } from "./installShTranscriptParser";

const sample = `
some noise
\x1b[32m Panel Installation Complete! \x1b[0m
\x1b[32mUsername: \x1b[0m\x1b[32mAb12cdEfGh\x1b[0m
\x1b[32mPassword: \x1b[0m\x1b[32mXy9zSecret01\x1b[0m
\x1b[32mWebBasePath: \x1b[0m\x1b[32mwebpath123456789012\x1b[0m
\x1b[32mAccess URL: https://panel.example.com:8443/webpath123456789012\x1b[0m
`;

describe("parseInstallShCredentials", () => {
  test("extracts username password webBasePath when Access URL host matches panel hostname", () => {
    const r = parseInstallShCredentials(sample, "panel.example.com");
    expect(r).toEqual({
      adminUsername: "Ab12cdEfGh",
      adminPassword: "Xy9zSecret01",
      webBasePath: "webpath123456789012",
    });
  });

  test("returns null when URL host does not match panel hostname", () => {
    expect(parseInstallShCredentials(sample, "other.example.net")).toBeNull();
  });

  test("returns null without Panel Installation Complete anchor", () => {
    const noAnchor = sample.replace("Panel Installation Complete", "");
    expect(parseInstallShCredentials(noAnchor, "panel.example.com")).toBeNull();
  });
});
```

Run: `bun test apps/server/src/vpn/installShTranscriptParser.test.ts`  
Expected: **FAIL** (module missing).

- [ ] **Step 2: Implement parser**

`installShTranscriptParser.ts`: strip ANSI with a small regex (e.g. `\x1b\[[0-9;]*m`); require substring `Panel Installation Complete`; extract `Username:`, `Password:`, `WebBasePath:` lines (trim, capture token after colon); parse `Access URL: https://HOST:PORT/PATH` with `URL` and verify `HOST` equals `panelHostname` **or** normalized IPv6 bracket form; `webBasePath` must match path segment (no leading slash) and equal captured `WebBasePath` line for **multi-anchor** consistency.

Run: `bun test apps/server/src/vpn/installShTranscriptParser.test.ts`  
Expected: **PASS**

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/vpn/installShTranscriptParser.ts apps/server/src/vpn/installShTranscriptParser.test.ts
git commit -m "feat(vpn): parse 3x-ui install transcript for panel credentials"
```

---

### Task 2: PTY plaintext helper

**Files:**
- Create: `apps/server/src/vpn/ptyPlaintext.ts`
- Create: `apps/server/src/vpn/ptyPlaintext.test.ts` (optional small test for ANSI strip)

- [ ] **Step 1:** Export `appendPtyChunk(state, chunk: Uint8Array): void` keeping last **256 KiB** UTF-8 decoded text (drop oldest on overflow) and `getPlaintext(state): string` after stripping ANSI the same way as parser.

- [ ] **Step 2:** `bun test apps/server/src/vpn/ptyPlaintext.test.ts` (or co-locate tests).

- [ ] **Step 3:** Commit `feat(vpn): add PTY plaintext ring buffer for install driver`

---

### Task 3: Prompt rule table + unit tests

**Files:**
- Create: `apps/server/src/vpn/installShPromptDriver.ts`
- Create: `apps/server/src/vpn/installShPromptDriver.test.ts`

**Initial rules (extend during integration):** At minimum, handle fresh install path in `config_after_install`:

| When PTY plaintext ends with / includes | Send (plus `\n`) |
|----------------------------------------|------------------|
| `Would you like to customize the Panel Port settings?` | `n` |
| `Please set up the panel port:` | *(should not appear if `n` above — skip)* |
| `Choose an option (default 2 for IP):` | `2` or `1` depending on product: **use `1` (domain LE)** when `panel_hostname` is FQDN, **`2` (IP cert)** when profile host is IP — document in code comment; v1 can always send `2` **only if** product only supports IP panels (today supports FQDN — prefer branch on `isPublicIpLiteral(panelHostname)` from `apps/server/src/net/panelAddress.ts`). |
| `Port to use for ACME HTTP-01 listener (default 80):` | `\n` (empty → 80) |
| `Do you have an IPv6 address to include?` | `\n` |
| `Please enter your domain name:` | `${panelHostname}` when ssl path needs domain |
| `Please choose which port to use (default is 80):` | `\n` |
| `Would you like to modify --reloadcmd` | `n` |
| `Would you like to set this certificate for the panel?` | `y` |

Use **longest-match-first** ordering for `whenIncludes` strings to avoid premature replies.

- [ ] **Step 1:** Implement `createInstallShPromptRules(ctx: { panelHostname: string; isPanelIp: boolean }): PromptRule[]` and `runPromptDriver({ write, onData, rules, globalTimeoutMs })`.

- [ ] **Step 2:** Unit-test with fake `onData` that pushes chunks and collects `write` calls.

- [ ] **Step 3:** Commit `feat(vpn): add install.sh expect-style prompt driver`

---

### Task 4: Session orchestrator

**Files:**
- Create: `apps/server/src/vpn/runInstallShSetupSession.ts`

- [ ] **Step 1:** Export async function:

```ts
export type InstallShSetupResult =
  | { outcome: "success"; adminUsername: string; adminPassword: string; webBasePath: string; plainTranscript: string }
  | { outcome: "failed"; reason: string; plainTranscript: string };

export async function runInstallShSetupSession(options: {
  write: (data: string | Uint8Array) => void;
  subscribePtyData: (handler: (chunk: Uint8Array) => void) => () => void;
  panelHostname: string;
  signal: AbortSignal;
  installCommand?: string;
}): Promise<InstallShSetupResult>;
```

Default `installCommand`:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/MHSanaei/3x-ui/master/install.sh)
```

- [ ] **Step 2:** Flow: subscribe → `write` command + `\n` → run driver concurrently with **completion wait** until plaintext contains `Panel Installation Complete` **or** `x-ui installation finished` **and** parser returns non-null — **then** stop driver; if parser fails, return `failed` with tail slice.

- [ ] **Step 3:** Unit-test with mock `subscribePtyData` replaying a saved transcript fixture.

- [ ] **Step 4:** Commit `feat(vpn): orchestrate install.sh session and credential parse`

---

### Task 5: Rewrite `profileSetupTerminalBridge`

**Files:**
- Modify: `apps/server/src/vpn/profileSetupTerminalBridge.ts`
- Modify: `apps/server/src/vpn/profileSetupTerminalBridge.test.ts`

- [ ] **Step 1:** Replace `conn.exec(SETUP_TERMINAL_REMOTE_CMD, …)` with `conn.shell({ term: "xterm-256color", cols: 80, rows: 24 }, …)` mirroring `profileSshBridge.ts`.

- [ ] **Step 2:** Remove imports: `runPhaseScriptOnPtyStream`, `runLiveSetupPhases`, `buildSetupPhases`, random admin/password generation **for DB** (credentials come from parser). Remove `_runLiveSetupPhases` option **or** repurpose as `_runInstallShSetupSession` injectable for tests.

- [ ] **Step 3:** State: `automationState: "running" | "idle"`. `onMessage`: if JSON resize → `setWindow`; else if `automationState === "running"` → **return** (drop keystrokes); else → `stream.write` like SSH.

- [ ] **Step 4:** On shell ready: `subscribePtyData` from the `data` listener; call `runInstallShSetupSession`; on success `encryptXuiSecretsJson` + same SQL as `setupLivePhaseLoop.ts` success branch (`operational_status`, `xui_web_base_path`, etc.); on failure set `last_setup_error`.

- [ ] **Step 5:** After outcome resolved: `ws.send(JSON.stringify({ type: "setupComplete", outcome: "success" | "failed" }))` as **string** frame, then `ws.close(1000, "done")` (and `stream.end()` if needed).

- [ ] **Step 6:** Update tests: mock `Client` with shell callback; feed bytes; assert text JSON sent.

- [ ] **Step 7:** Commit `refactor(vpn): drive setup-terminal via install.sh shell session`

---

### Task 6: Web `SetupTerminalSheet` — SSH-like input

**Files:**
- Modify: `apps/web/src/pages/VpnsPage.tsx`

- [ ] **Step 1:** In `SetupTerminalSheet`, after `term.open`, add `term.onData` mirroring `SshTerminalSheet` (lines ~491–495): send `TextEncoder` bytes on `WebSocket.OPEN`.

- [ ] **Step 2:** Add muted one-line hint above terminal: `Input is ignored while automation runs (same as spec).`

- [ ] **Step 3:** Remove agent-debug `fetch("http://127.0.0.1:7907/ingest/...")` blocks in this sheet if still present.

- [ ] **Step 4:** `cd apps/web && bunx tsc -b` — expect **PASS**

- [ ] **Step 5:** Commit `fix(web): forward setup terminal keystrokes (server-gated)`

---

### Task 7: `setupRunner` dry-run + test cleanup

**Files:**
- Modify: `apps/server/src/vpn/setupRunner.ts`
- Modify: `apps/server/src/routes/profiles.test.ts`

- [ ] **Step 1:** In `executeProfileSetup`, when `!vpnSshEnabled`, return **one** synthetic phase, e.g. `id: "install_sh_upstream"`, `title: "3x-ui (upstream install.sh)"`, `script` a short comment block listing the fixed GitHub URL and that prompts are automated in the browser terminal when SSH is enabled.

- [ ] **Step 2:** Remove the **live** branch (`sshExec`, `runLiveSetupPhases`) from `executeProfileSetup` **or** have it throw `Error("live setup only via setup-terminal")` — prefer **remove** + fix all tests.

- [ ] **Step 3:** Delete/update each `executeProfileSetup` live test in `profiles.test.ts` to either **mock setup-terminal** (out of scope) or assert dry-run only — simplest: **only** test dry-run JSON for `vpnSshEnabled: false` DB fixture; for live DB behavior use `profileSetupTerminalBridge.test.ts`.

- [ ] **Step 4:** `bun test apps/server` — **PASS**

- [ ] **Step 5:** Commit `refactor(vpn): align setupRunner dry-run with install.sh path`

---

### Task 8: Dead code and docs hygiene

**Files:**
- Possibly delete: `apps/server/src/vpn/setupLivePhaseLoop.ts`, `apps/server/src/vpn/setupLivePhaseLoop.test.ts` — **only if** `rg runLiveSetupPhases` shows no imports.
- Modify: `docs/superpowers/specs/2026-04-15-setup-via-terminal-design.md` — add one-line banner at top: “Superseded for automation by `2026-04-16-install-sh-setup-terminal-design.md`.”

- [ ] **Step 1:** `rg runLiveSetupPhases apps/server` — remove files if zero.

- [ ] **Step 2:** Keep `setupShellDriver.ts` if still tested in isolation; else remove only when unused.

- [ ] **Step 3:** Commit `chore(vpn): remove obsolete live phase loop after install.sh migration`

---

## Self-review (plan vs spec)

| Spec requirement | Task coverage |
|------------------|---------------|
| Remove phased setup from setup-terminal | Task 5 |
| `install.sh` from GitHub master | Tasks 4–5 (`installCommand`) |
| SSH-parity WS + block input while driver | Tasks 5–6 |
| Expect-style prompts | Task 3–4 |
| Transcript credential parse (A) | Task 1, 4–5 |
| `setupComplete` without garbling PTY | Task 5 (text frame) + existing client |
| Failure: stall hint + transcript tail | Task 4–5 |
| Fixture / TDD | Tasks 1–3 |
| Mutex / gates unchanged | Implicit — do not weaken `profileSetupTerminalGate` / `setupRunRegistry` |

**Placeholder scan:** None intentional.

**Gap:** `executeProfileTeardown` may still reference Caddy paths in `setupPhases`-like strings — out of scope for this plan; add follow-up if `rg caddy` in teardown breaks.

---

## Manual QA checklist (human)

- [ ] Pending profile + `VPN_SSH_ENABLED=true` + valid `panel_hostname`: Setup opens, colors scroll, completes, profile becomes **working**, panel URL opens.
- [ ] Upstream `install.sh` changes prompts: confirm **clear** stall error (no hang forever — global timeout ~45–90 min TBD).
- [ ] Detach (4401) / cancel (4400) still behave sensibly after shell rewrite.

---

**Plan complete and saved to `docs/superpowers/plans/2026-04-16-install-sh-setup-terminal.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — Dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach do you want?**
