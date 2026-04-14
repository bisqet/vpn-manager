# Browser PTY SSH session — design

**Date:** 2026-04-14  
**Status:** Approved for implementation planning  
**Scope:** Replace the VPNs page **placeholder SSH sheet** with a **real interactive shell** (full PTY) to each profile’s `host:sshPort` as `ssh_user`, initiated from **VPN Manager server** and rendered in the browser. **Does not** change the 3x-ui **setup** phased runner except where shared SSH policy applies.

## Relationship to other specs

- **`2026-04-14-vpn-profile-setup-ssh-placeholder-design.md`:** Defined the **fake** terminal for manual notes. This spec **supersedes** that behavior for the **SSH** entry point once implemented: the sheet becomes a **real** session when allowed.
- **`2026-04-14-3x-ui-api-ssh-setup-design.md`:** Setup remains **API-driven**, non-interactive scripts. Browser PTY is **orthogonal** (operators may use it alongside or instead of copy-paste from the sheet).

## Goal

Operators open **SSH** from a VPN profile row and get a **normal TTY** on the remote host (e.g. `vim`, pagers, **Ctrl+C**, line editing, **SIGWINCH** / resize), with I/O flowing **browser ↔ VPN Manager server ↔ SSH server**.

## Non-goals (this spec)

- **File upload/download** (SFTP, `scp` integration) beyond what a plain shell already allows interactively.
- **Automatic reconnect** after disconnect (v1: user clicks **Reconnect** for a new session).
- **Recording / session replay** or shared collaborative terminals.
- **Jump hosts / ProxyJump** chains (future; single hop only in v1).
- **SSH public-key auth** from VPN Manager to host (v1 stays **password**-based to match stored profile credentials; key-based may be a later spec).

## Recommended approach

**In-process SSH client library** (e.g. **`ssh2`** or equivalent that runs on **Bun** and supports **shell + PTY**), plus **WebSocket** for byte transport and **xterm.js** in the SPA.

**Rationale:** Avoids **native OS PTY addons** and `ssh` subprocess pairing (`node-pty` + `ssh`) which are brittle under Bun and on Windows dev machines. Behavior must still **align** with existing **`sshExec`** host-key rules (see §Host keys).

**Deferred alternative:** Spawn **`ssh -tt`** with a real PTY only if the library path fails on Bun or operational requirements demand byte-identical OpenSSH CLI semantics.

## Architecture

### Components

| Layer | Responsibility |
|-------|------------------|
| **Browser (`apps/web`)** | **xterm.js** (or equivalent): rendering, focus, copy/paste, UTF-8. Opens **WebSocket** to the API origin when the operator opens the SSH sheet. Sends **resize** control messages; sends **raw keystrokes** as binary; receives **raw terminal output** as binary. |
| **VPN Manager server (`apps/server`)** | After **session auth**, load profile, **decrypt SSH password**, dial **one SSH connection** with **interactive shell + PTY**, bridge streams to the WebSocket. Enforce **gates**, **limits**, and **cleanup** on close. |

### Data flow

1. User opens **SSH** for `profileId` (existing UI affordance).
2. Client connects **`ws`/`wss`** to a dedicated route (see §API), **same origin** as the web app, so the browser sends the existing **`SESSION_COOKIE`** on the upgrade request.
3. Server validates the session (**same logic as `requireAuth`**) and that the user may access the profile (same authorization rules as other profile mutations that imply using stored credentials).
4. If **`VPN_SSH_ENABLED`** is false, **reject** the upgrade immediately (no TCP dial to the host).
5. Server opens SSH, starts **shell + PTY**, pipes **stdin/stdout/stderr** (as provided by the library) to/from WebSocket **binary** frames.
6. On disconnect (client tab close, network drop, SSH failure), server **closes** SSH and WebSocket and drops references to decrypted material.

### Concurrent setup

**v1:** **Allow** a browser PTY session **while** automated setup is running for the same profile. Operators accept duplicate connections and resource use. If this causes problems in practice, a follow-up may add **mutex** or warnings.

## API and transport

- **Route shape (v1):** `GET` (or `WS` upgrade on) **`/api/profiles/:id/ssh`** under the **authenticated** API tree — exact Hono/Bun wiring is implementation detail, but the **WebSocket upgrade** must occur only after **cookie session** validation equivalent to **`requireAuth`** (`SESSION_COOKIE` + `getSessionUserId`).
- **TLS:** Production uses **`wss://`**; local dev may use `ws://`.
- **`VPN_SSH_ENABLED`:** When false, **do not** dial the profile host; close the socket with an **application-level** error the UI can display (“SSH disabled by administrator”).

## Wire protocol

- **Terminal I/O:** **Binary WebSocket messages** carrying **raw bytes** (UTF-8 terminal stream in both directions).
- **Control messages:** **Text JSON** messages for non-stream events only, for example:
  - `{ "type": "resize", "cols": <number>, "rows": <number> }` — debounced from xterm **fit** / window resize.
  - Optional `{ "type": "ping" }` / `{ "type": "pong" }` for half-open detection (either direction may initiate).
- **Framing rule:** If a message **parses as JSON** and has `"type"`, treat as control; otherwise implementations must ensure binary frames never collide (in practice: **control = text**, **I/O = binary** only).

## Host keys and SSH options

Align with **`buildSshExecUsingSpawn`** in `apps/server/src/vpn/sshExec.ts`:

- If **`SSH_KNOWN_HOSTS_FILE`** (`env.sshKnownHostsFile`) is **set**: use that file and **`StrictHostKeyChecking=yes`** (fail if host not listed).
- If **unset**: use **`StrictHostKeyChecking=accept-new`** (auto-append new hosts).

The interactive client **must not** weaken this policy relative to setup, so operators do not see **setup succeeds / terminal refuses** mismatches for the same env configuration.

## Security

| Topic | Requirement |
|-------|-------------|
| **AuthZ** | No host, user, or password from the client for the SSH leg; server loads from DB after cookie session proves identity. |
| **Secrets in memory** | Decrypted SSH password exists only for the **active** session; clear references on teardown. |
| **Error messages** | Client-facing close reasons are **short** and **non-leaking**; details in **server logs** only. |
| **Rate / duration** | Implement **per-user or per-IP connection limits** and **idle timeout** (recommended band: **30–60 minutes** idle; **max session duration** optional). Exact numbers are implementation-tuned. |
| **Abuse** | Cap concurrent PTY sessions per profile or globally to protect server file descriptors and outbound connections. |

## Client UX (v1)

- Replace fake scrollback with **xterm** attached to the WebSocket.
- On **disconnect**, show status and a **Reconnect** button (opens a **new** session; no auto-reconnect).
- Preserve **Escape** to close the sheet if that behavior already exists, **after** confirming it does not steal keys needed by terminal apps (document choice: e.g. close only when focus is **outside** xterm, or use a visible **Close** button as primary exit).

## Error handling

| Condition | Behavior |
|-----------|----------|
| Not logged in / invalid cookie | **401** / WebSocket close **before** SSH dial. |
| `VPN_SSH_ENABLED` false | Close with documented **app error**; no outbound connection. |
| Unknown profile / forbidden | **404** / **403** as for REST profile routes; no dial. |
| SSH auth failure, timeout, DNS, host key mismatch | Close socket; UI shows generic “Could not connect”; server logs detail. |

## Testing

- **Automated:** Mock the SSH stream at the server boundary — verify **auth gate**, **`vpnSshEnabled` false** (no dial mock invoked), **resize** control forwarded to the mocked PTY layer, **binary echo** round-trip.
- **Manual / staging:** Real VM — **`vim`**, **`top`/`htop`**, **Ctrl+C**, **window resize**, paste.

## Dependencies (anticipated)

- Server: SSH client library compatible with **Bun** + **PTY shell**.
- Web: **xterm.js** (+ **FitAddon** or equivalent for resize).

---

**Spec self-review (2026-04-14):** Placeholder scan clean; host-key rules explicitly tied to `sshExec`; `VPN_SSH_ENABLED` applies to PTY dial; auth mechanism fixed to **session cookie** matching existing middleware; concurrent setup explicitly **allowed** in v1; framing rule avoids JSON/binary ambiguity.
