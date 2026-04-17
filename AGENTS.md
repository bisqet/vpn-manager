# AGENTS.md

## Cursor Cloud specific instructions

The Git default branch for this repository is **`master`**. Open pull requests and base new work on `master` (the `main` branch is not used).

### Overview

VPN Manager is a monorepo with two apps — a Hono API server (`apps/server`, port 3000) and a Vite + React SPA (`apps/web`, port 5173). The entire stack runs on **Bun** (runtime, package manager, test runner). SQLite is embedded via `bun:sqlite`; no external database needed.

### Quick reference

| Task | Command |
|------|---------|
| Install deps | `bun install` (from repo root) |
| Run API server | `bun --cwd apps/server dev` |
| Run web dev server | `bun --cwd apps/web dev` |
| Run tests | `bun test apps/server` |
| TypeScript check (web) | `cd apps/web && bunx tsc -b` |
| Create admin user | `cd apps/server && ADMIN_USERNAME=admin ADMIN_PASSWORD=changeme bun scripts/create-admin.ts` |
| Build web | `bun --cwd apps/web build` |

### Environment setup gotchas

- **`.env` file required**: Copy `apps/server/.env.example` to `apps/server/.env` before starting the server. The `VPN_MANAGER_MASTER_KEY` is pre-filled with a dev-safe all-zero key.
- **Admin user creation**: Use explicit `ADMIN_USERNAME` / `ADMIN_PASSWORD` env vars on the command line (not from `.env`) to avoid potential issues with shell escaping. Run from `apps/server` directory: `ADMIN_USERNAME=admin ADMIN_PASSWORD=changeme bun scripts/create-admin.ts`.
- **Database auto-creates**: SQLite DB is created automatically at the path specified by `DATABASE_PATH` in `.env` on first server start or `create-admin` run. No migration command needed — schema migration runs automatically.
- **Panel TLS (`panelHostname`)**: Use a **FQDN** or **public IP** (with **`:<port>`** when the panel is not on 443) that matches the HTTPS URL used to reach 3x-ui. **TLS is operator-supplied** (3x-ui / install script / another proxy). For **FQDN vs public IP** validation semantics, see `docs/superpowers/specs/2026-04-14-bare-ip-panel-tls-design.md` (older “reverse proxy (historical)” wording there is archival only).
- **Vite proxies `/api` to `:3000`**: Start the API server before or alongside the Vite dev server. The web app at `:5173` proxies all `/api/*` requests to `localhost:3000`.
- **No ESLint configured**: The project does not include ESLint. TypeScript checking via `bunx tsc -b` in `apps/web` is the primary lint-like check.
- **Bun may not be on PATH by default**: If `bun` is not found, source it with `export BUN_INSTALL="$HOME/.bun" && export PATH="$BUN_INSTALL/bin:$PATH"`.

## Learned User Preferences

- Prefers an in-app **modal overlay** (large panel) over the browser **Fullscreen API** when expanding embedded diagrams such as the Chains **traffic diagram**.
- When executing multi-task implementation plans, may choose **subagent-driven** execution (separate subagents per task with review between tasks) instead of doing every step in one chat.
- For diagram-style views in the web app, prefers **pointer drag to pan**, **mouse wheel zoom without a modifier key**, and a visible **Reset view** control.
- After a reproduced issue is fixed, expects **temporary debug logs, telemetry, and other one-off instrumentation** to be removed rather than left in the tree.
- Prefers a **popup** that offers both a **VLESS share link** and a **subscription URL** so the user can pick which format to copy.
- When bulk-clearing **SSH-related** fields on servers, only clear **SSH port** and **SSH user**; do not change **IP** or **hostname** columns.
- Prefers installing the **Xray** binary for local tooling through an explicit script (for example **`bun download-xray`**) rather than hooking downloads into **`postinstall`**.
- In **PowerShell**, passes **VLESS URIs** on the command line wrapped in **single quotes** so **`&`** in the query string is not parsed as a command separator.
- Expects **`vless-test`-style connectivity checks** to succeed within **a few seconds** when the path is healthy, rather than relying on long retry-heavy runs as the primary behavior.
- For **local bind ports** in tests or ephemeral tooling, prefers choosing a **random free port** instead of **incrementing** from a fixed base port.
- Wants a **small refresh control** next to **panel reachability** on the VPNs page to **manually trigger** another probe in addition to automatic async checks.

## Learned Workspace Facts

- **No bundled reverse proxy:** This project **does not** ship or require a dedicated TLS reverse proxy (historical docs may still name one); TLS termination is whatever the operator or upstream installer provides.
- When the panel is exposed on a **non-default HTTPS port**, any **panel URL shown in the app** must include that **`:<port>`** segment; omitting it produced links that did not match the reachable endpoint.
- From the repo root, **`bun run dev`** starts both workspaces’ dev servers via `bun run --filter "./apps/*" dev` in the root **`package.json`**.
- Password-based SSH from the VPN Manager machine expects **`sshpass`** to be installed where the server runs.
- **`DELETE /api/profiles/:id?force=true`** (or **`force=1`**) removes **`chain_hops`** that reference the profile (with cascade to their routing data), **renumbers** remaining hops per chain, **deletes** chains that would have zero hops, then deletes the profile; **`DELETE`** without **`force`** still returns **409** when hops reference the profile.
- **Live browser SSH** can be enabled with an **empty ACME email** in app settings when validation allows; optional ACME contact is not documented here as requiring any particular TLS stack.
- Per-hop routing **`default_action`** allows **`use_chain`**, **`direct`**, and **`block`**; the **terminal hop** in a chain must not default to **`use_chain`** (only **`direct`** or **`block`**).
- **Panel client links:** VLESS/subscription outputs are **regenerated on each open** for now; longer-lived **profile or subscription management** for those links is planned as a later change.
- When **`VPN_MANAGER_PANEL_TLS_INSECURE`** is enabled, server-side panel HTTP clients should **use HTTP** and/or **retry with HTTP after HTTPS fails**, instead of forcing HTTPS-only access to the panel.
