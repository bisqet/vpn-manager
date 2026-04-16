# 3x-ui `install.sh`–driven setup terminal (SSH-parity PTY + auto-prompts + transcript credentials) — design

**Date:** 2026-04-16  
**Status:** Approved (2026-04-16)  
**Supersedes (for setup automation content):** `2026-04-15-setup-via-terminal-design.md` describes the **previous** model (phased `buildSetupPhases`, viewer-only client, Caddy-backed HTTPS). This spec replaces that **automation** story while keeping the **same route and sheet** where practical (`GET /api/profiles/:id/setup-terminal`, Pending gates, mutex, detach/stop semantics unless revised below).

## Decision log

| Topic | Choice |
|-------|--------|
| Installer | Upstream **`install.sh`** fetched from GitHub **`master`** (URL fixed in implementation; branch may be pinned later). |
| Prior phased remote scripts | **Remove** from the setup path: no `buildSetupPhases` execution for setup-terminal (preflight, ufw, tarball install, `configure_xui`, Caddy install/configure, loopback verify). |
| Client UX | **Same interaction model as SSH:** xterm sends **resize + keystrokes** to the server; server forwards to the PTY **when policy allows** (see “Input policy”). |
| Prompts | **Server answers** all `install.sh` prompts **without requiring the operator to type**, via an **expect-style** driver (pattern match on PTY output → inject bytes). |
| Post-install secrets | **(A)** Recover **admin username and password** by **parsing fixed phrases / patterns** from the **combined PTY transcript** (stdout as seen on the wire). **No** post-step `x-ui setting -username …` to overwrite installer-chosen values (that was option B). |

## Goals

1. **Single provisioning story:** Launch `install.sh` (e.g. `bash <(curl -fsSL …/install.sh)` or download-then-`bash`) inside an **`ssh2` interactive shell + PTY** on the profile host.
2. **Operator-visible:** Full-color transcript in the browser terminal, indistinguishable from SSH for **transport** (binary frames, xterm).
3. **Unattended prompts:** Driver supplies answers for every `read`/menu the script performs during automated setup, using profile context (`panel_hostname`, app settings as needed) and **generated** values only where the transcript parser will later find them **or** where the script prints them after generation internal to `install.sh`.
4. **Profile completion:** On success, extract credentials from transcript, **encrypt** and persist like today (`xui_secrets_*`, `xui_web_base_path` if still derivable from transcript or from known install defaults — **explicit rule:** web base path must be defined: either parsed from transcript or set to empty only if product allows; implementation plan must pick one and test it).
5. **Failure diagnostics:** `last_setup_error` includes **which prompt** stalled (if timeout) and/or **tail of transcript**, without new plaintext secret logging on disk beyond existing practices.

## Non-goals

- **Re-implementing** upstream install behavior in shell phases (no VPN Manager–owned Caddy/UFW/x-ui tarball path for this flow).
- **Guaranteeing** TLS/firewall behavior: deferred to whatever `install.sh` + OS provide.
- **Multi-region** or **multi-API** coordination beyond existing per-`profileId` mutex.

## Risks and mitigations (especially for choice A)

| Risk | Mitigation |
|------|------------|
| Upstream changes prompt text or credential banner format → parser returns wrong values or null. | **Fixture tests:** recorded transcripts (sanitized) from **known** `install.sh` revisions; CI regex/parsing; **optional** follow-up to pin script URL to a **commit** or tag if GitHub exposes it. |
| Secrets appear in transcript → XSS in operator clipboard / logs. | Treat terminal like SSH: **no extra server logging** of frames; document that **browser history / screen capture** may contain secrets. |
| Parser false-positive on random output. | Require **multiple anchors** (e.g. URL line + “username” + “password” proximity) before accepting a parse; fail closed → `last_setup_error` “could not parse credentials”. |
| Race: user types while driver sends answers. | **Input policy (v1):** While the **automated driver** is in **`running`**, **do not forward** browser keystrokes to the PTY (ignore or buffer-drop); still show **live** output. After driver enters **`finished_success`** or **`finished_failure`**, optionally **enable** full SSH-like forwarding for a short tail session **or** close socket — pick one in implementation plan (default: **close on completion** with optional “Open SSH” CTA). |

## Architecture

### Server

| Piece | Responsibility |
|-------|------------------|
| **Setup WebSocket bridge** | Open **`ssh2` `shell` + PTY** (same primitive as `createProfileSshWebSocketHandlers`), register setup mutex, pipe **server→client** PTY bytes unchanged. |
| **Client→server messages** | **JSON resize** (same shape as SSH). **Binary/text** from xterm: forwarded to PTY **only when** input policy allows (see above). |
| **Install driver** | After shell ready, write **install invocation** command. Maintain **ring buffer** of recent PTY text (ANSI-stripped or dual: raw + plain) for matching. State machine: **wait prompt → write answer → wait next**. |
| **Transcript parser (A)** | On **successful** script exit (shell prompt return or driver-detected completion marker), run **deterministic extractors** over **full session capture** for `adminUsername`, `adminPassword`, and **`webBasePath`** if required by DB/schema. |
| **DB writer** | Reuse **`encryptXuiSecretsJson`** and status transition on parse + validation success; else Pending + error. |

### Client (`SetupTerminalSheet`)

- Align **WebSocket send** behavior with **`SshTerminalSheet`**: `term.onData` → socket (subject to server ignoring during automation — operator may still type but it has no effect until policy says otherwise; optional UI hint: “Automation is controlling input…”).
- Keep **resize** behavior.
- Preserve **Escape** detach/stop dialog if still applicable when WebSocket stays open for long installs.
- **Setup complete:** Server may send a small **JSON** footer (existing `{ type: "setupComplete", outcome }`) **after** PTY stream ends **or** on a side channel; implementation plan chooses ordering to avoid xterm corruption (e.g. send JSON only after binary stream closed, or use a two-phase close — **must not** break xterm decoding).

### Removed / unused by this path

- **`buildSetupPhases`** / **`runLiveSetupPhases`** / **`runPhaseScriptOnPtyStream`** from **`profileSetupTerminalBridge`** (code may be deleted or retained only if another entry point still uses it — implementation plan audits **`executeProfileSetup`**, dry-run, tests).

## Gates and policy

- Reuse existing **auth**, **`vpnSshEnabled`**, **Pending**, **`panel_hostname` non-empty**, **mutex** rules unless product relaxes them.
- **SSH vs setup:** Second concurrent shell is still **allowed** unless operations say otherwise (same as prior spec).

## Testing

- **Unit:** Prompt matcher tables; transcript parser golden files (redacted samples committed as fixtures).
- **Bridge:** Mock `ssh2` stream with scripted PTY bytes including credential epilogue; assert DB update or error.
- **Manual:** Run against disposable VM when changing patterns after upstream `install.sh` update.

## Open points for implementation plan (not blockers for this spec)

1. Exact **install URL** (`master` vs commit hash).
2. **Completion detection:** shell prompt vs explicit string from `install.sh`.
3. **webBasePath** source when not printed clearly (fallback rule).
4. Whether to send **`setupComplete` JSON** on the same WebSocket without garbling xterm (protocol tweak vs new subprotocol).

## Self-review (2026-04-16)

- No unresolved “TBD” left; open points are explicitly listed above.
- Choice **A** is consistent with “no `x-ui setting` overwrite after install.”
- Scope is single-product-path replacement for setup-terminal automation; does not claim to preserve bare-IP Caddy behavior from earlier specs.
