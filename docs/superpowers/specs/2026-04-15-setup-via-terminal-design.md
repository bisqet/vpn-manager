# VPN profile setup via in-browser terminal (server-driven) — design

**Date:** 2026-04-15  
**Status:** Superseded for **automation** by `2026-04-16-install-sh-setup-terminal-design.md` (install.sh + transcript credentials). Retained as reference for **WebSocket / detach** UX; phased `buildSetupPhases` automation described below is no longer the live setup-terminal path.  
**Scope:** Change **Setup** so it opens the **in-app terminal** (xterm) on a **dedicated WebSocket**, with the **VPN Manager server** driving provisioning **automatically** through that **single interactive shell** (PTY). **Interactive SSH** (existing row action) remains unchanged. **Clear server** / teardown is **out of scope** unless a follow-up spec extends the same pattern.

## Relationship to other specs

- **`2026-04-14-browser-pty-ssh-design.md`:** Defines the **interactive** `GET /api/profiles/:id/ssh` session (keystrokes → host). This spec adds a **separate** setup-terminal path; it does **not** replace interactive SSH.
- **`2026-04-14-3x-ui-api-ssh-setup-design.md` / `setupRunner`:** Today’s **live** setup uses **`sshExec`** (`ssh2` **`exec("bash -s")`**) per phase. This spec introduces a **shell-backed** executor for the **setup-terminal** path only; phase **definitions** (`buildSetupPhases`, ordering, secrets persistence) stay aligned with the existing runner unless intentionally changed in implementation.
- **`2026-04-14-vpn-profile-setup-ssh-placeholder-design.md`:** Dry-run and non-SSH behavior remain relevant where **`vpnSshEnabled`** is false.

## Goals

1. **Setup** opens a **real terminal view** (same UX family as **SSH**): server opens **`ssh2` shell + PTY** to the profile host and streams **raw terminal bytes** to the browser.
2. **Fully automatic:** no operator typing on the host during setup; the **server** injects phase scripts into that **one** PTY.
3. **Server-driven:** automation logic runs on the API process; the browser is primarily a **viewer** (plus **resize** and sheet chrome).
4. **Coexistence:** For **Pending** profiles, **both Setup and SSH** remain available — **Setup** = automated provisioning session; **SSH** = normal interactive session (today’s behavior).
5. **Close / Escape while running:** A **confirmation** dialog offers **Stop setup** (cancel, profile stays **Pending**, record a clear **cancelled / interrupted** outcome) or **Continue in background** (WebSocket closes; **SSH connection + driver** continue until success or failure; UI reflects status via existing profile queries / toasts as appropriate).

## Non-goals

- **Teardown / clear server** through the same terminal pattern (future spec).
- **Multi-instance API coordination** for a single logical setup run (e.g. Redis locks). **v1:** in-process **mutex** per `profileId` only; horizontal scale-out is explicitly deferred.
- **Automatic reconnect** of the setup WebSocket mid-run (v1: user may use background continuation instead).
- **SFTP / file transfer** beyond what the shell already allows in interactive SSH.

## Recommended approach

**Dedicated authenticated WebSocket route** for **setup terminal** (exact path is an implementation detail; e.g. `GET /api/profiles/:id/setup-terminal` or a clearly named sibling of `/ssh`). **Do not** overload interactive `/ssh` with a mode flag in v1 — reduces regression risk and keeps handler responsibilities narrow.

**Rationale:** Interactive and setup sessions differ in **onClose** semantics (background continuation), **input policy** (viewer-only vs full PTY), and **timeouts**. A separate route keeps `createProfileSshWebSocketHandlers` behavior stable while a new bridge (or forked variant) implements setup-specific lifecycle.

## Architecture

### Components

| Layer | Responsibility |
|-------|----------------|
| **Browser (`apps/web`)** | **Setup** opens an xterm sheet wired to the **setup-terminal** WebSocket. During an active automated run, **do not** forward keystrokes to the host (resize JSON only, same shape as interactive SSH). Implement **beforeunload / close** confirmation: **Stop setup** vs **Continue in background** when a run is in progress. |
| **VPN Manager server** | After auth and gates, open **`ssh2` shell + PTY**, register an **active setup run** (mutex), run **phase loop** using a **shell-backed executor** (writes to / reads from the PTY stream), update DB on success/failure, clear registry. **onClose:** if user chose **background**, **do not** tear down SSH until the driver finishes or **Stop** cancels; if **stop** or implied cancel, clean up and persist **Pending** + error. |

### Execution engine

- Reuse **`buildSetupPhases`** and the same **phase ordering** and **credential generation** semantics as **`executeProfileSetup`** (admin user/password, web base path, encrypted x-ui secrets on success).
- Replace **`sshExec`** for this path with a **shell session driver**: for each phase, inject a **bounded** script into the **existing** shell (implementation detail: heredoc, base64 wrapper, or delimiter protocol), parse **exit status** and optional **captured tail** for `last_setup_error` / internal assertions.
- **Idle timeout:** The interactive bridge’s **45-minute idle** rule assumes user input. Setup mode must use a **phase-oriented timeout** (reuse **`PHASE_TIMEOUT_MS`** semantics per phase or equivalent) so long-running installs are not cut off for “no keystrokes.”

### Mutex and concurrency

- **At most one** **automated setup** run per profile **ID** on a given API instance. A second **Setup** attempt while one is active returns **409** (or equivalent) with a clear message.
- **Interactive SSH** while automated setup runs: **allowed** in v1 (consistent with earlier “concurrent PTY + setup” tolerance). Revisit only if operational issues appear.

### Dry-run and SSH disabled

- When **`vpnSshEnabled`** is false: **no** live PTY setup WebSocket. Preserve a **read-only** operator path (today’s **dry-run** JSON / sheet or equivalent) so expectations stay clear.

### HTTP `POST /api/profiles/:id/setup`

- **Default recommendation:** **Live** provisioning is initiated only via the **setup-terminal WebSocket** (client opens WS → server starts driver). **`POST /setup`** for live mode may return **410 Gone** / **400** with a message pointing to the new flow, or be removed from the client — exact choice is for the implementation plan. **Dry-run** may continue to use HTTP if that remains the simplest operator experience.

## Wire protocol (setup-terminal)

- **Server → client:** **binary** frames = raw terminal output (same as interactive SSH).
- **Client → server:** **JSON** `{ "type": "resize", "cols", "rows" }` only during automated run (and any minimal control needed for implementation). **No** raw keystroke bytes to the host during automation.
- Optional: small JSON **control** channel for future features; v1 should avoid unless strictly necessary.

## Gates (server)

Match existing policy where applicable:

- Authenticated session (**same** rules as profile mutations using stored credentials).
- **`vpnSshEnabled`** true for live setup-terminal upgrade.
- Profile exists; **`operational_status`** is **Pending** (not **Working**).
- **`panel_hostname`** non-empty (same as current `executeProfileSetup`).
- **Mutex:** no active automated setup for this `profileId`.

## Security notes

- Treat **terminal scrollback** as **sensitive** (passwords and tokens may appear in output). Do not add new server-side logging of secrets beyond existing DB encryption practices.
- WebSocket **close reasons** must remain **non-secret** (existing **`webSocketCloseReasonFromError`** truncation rules apply).

## Testing strategy

- **Unit:** shell-backed executor against a **fake** duplex stream (delimiter / exit parsing).
- **Unit:** setup run registry — start, **cancel**, **detach on close** (background), second start rejected.
- **Integration:** route gating (401 / 403 / 404 / 409), using **fake `ssh2`** patterns consistent with `profileSshBridge.test.ts`.

## Open points for implementation plan only

- Exact **URL** and **Hono/Bun** wiring for the new WebSocket.
- Precise **PTY injection protocol** per phase (delimiter design, maximum script size, binary-safe transport).
- Whether **`POST /setup`** remains for **dry-run only** or is fully superseded.
