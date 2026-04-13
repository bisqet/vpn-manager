# VPN Manager

## Prerequisites

- [Bun](https://bun.sh/)

## Environment

Templates with safe placeholders (copy to real `.env` files — those stay gitignored):

| File | Purpose |
|------|---------|
| [`.env.example`](.env.example) | Optional root notes / duplicate vars for your IDE |
| [`apps/server/.env.example`](apps/server/.env.example) | **API + `create-admin`** — copy to `apps/server/.env` |
| [`apps/web/.env.example`](apps/web/.env.example) | **Vite** — usually empty; copy to `apps/web/.env` if you add `VITE_*` later |

**`apps/server/.env` variables**

| Variable | Required | Default / notes |
|----------|----------|-----------------|
| `VPN_MANAGER_MASTER_KEY` | Yes | Base64 of **exactly 32 bytes**. The example file uses a dev-only all-zero key; replace for anything non-local. |
| `PORT` | No | `3000` |
| `DATABASE_PATH` | No | `data/vpn-manager.sqlite` (relative to `apps/server` cwd) |
| `STATIC_DIR` | No | Set after web build to serve the SPA (e.g. `../web/dist`) |
| `NODE_ENV` | No | Omit in dev. Use `production` when testing Secure cookies over HTTPS. |

**`create-admin.ts` (same `apps/server/.env` when you use `bun run create-admin`)**

| Variable | Required | Notes |
|----------|----------|-------|
| `ADMIN_USERNAME` | Yes | First admin login name |
| `ADMIN_PASSWORD` | Yes | Use a strong password |
| `DATABASE_PATH` | No | Same as server default if unset |

Server scripts load **`--env-file=.env`** from `apps/server` (missing file is OK; Bun ignores it).

## Create Admin User

After copying `apps/server/.env.example` → `apps/server/.env`, uncomment and set `ADMIN_USERNAME` / `ADMIN_PASSWORD`, then:

```powershell
bun --cwd apps/server create-admin
```

Or one-shot without a `.env` file:

```powershell
cd apps/server
$env:ADMIN_USERNAME = "admin"
$env:ADMIN_PASSWORD = "change-me"
bun scripts/create-admin.ts
```

## Development

**1.** Copy env templates:

```powershell
Copy-Item apps/server/.env.example apps/server/.env
# optional: Copy-Item apps/web/.env.example apps/web/.env
```

**2.** Edit `apps/server/.env` — at minimum keep or replace `VPN_MANAGER_MASTER_KEY`, and set admin vars before running `create-admin`.

**3.** Two terminals from repo root:

Terminal 1 (API — reads `apps/server/.env` automatically):

```powershell
bun --cwd apps/server dev
```

Terminal 2 (Vite):

```powershell
bun --cwd apps/web dev
```

## Production Build

Build the web app:

```powershell
bun --cwd apps/web build
```

Then start the server with `STATIC_DIR` set to the built frontend directory. Put values in `apps/server/.env` or set them in the shell; relative and absolute paths both work.

```powershell
# apps/server/.env should include VPN_MANAGER_MASTER_KEY and e.g.:
# STATIC_DIR=../web/dist
bun --cwd apps/server start
```

From repo root, a relative `STATIC_DIR` is resolved from `apps/server` cwd (e.g. `../web/dist` → `apps/web/dist`).
