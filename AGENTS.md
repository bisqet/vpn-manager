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
- **Panel TLS (FQDN or public IP)**: VPN profile `panelHostname` may be a **FQDN** or **public IP** for the 3x-ui panel behind Caddy. **Let’s Encrypt IP certificates** are short-lived; the target VPS should run a **recent Caddy** so automatic HTTPS can obtain them. See `docs/superpowers/specs/2026-04-14-bare-ip-panel-tls-design.md`.
- **Vite proxies `/api` to `:3000`**: Start the API server before or alongside the Vite dev server. The web app at `:5173` proxies all `/api/*` requests to `localhost:3000`.
- **No ESLint configured**: The project does not include ESLint. TypeScript checking via `bunx tsc -b` in `apps/web` is the primary lint-like check.
- **Bun may not be on PATH by default**: If `bun` is not found, source it with `export BUN_INSTALL="$HOME/.bun" && export PATH="$BUN_INSTALL/bin:$PATH"`.
