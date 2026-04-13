# VPN Manager

## Prerequisites

- [Bun](https://bun.sh/)

## Environment

- `VPN_MANAGER_MASTER_KEY`: required, base64-encoded 32-byte key
- `DATABASE_PATH`: optional, defaults to `data/vpn-manager.sqlite`
- `PORT`: optional, defaults to `3000`
- `STATIC_DIR`: optional for production, points to `apps/web/dist` after building the web app

## Create Admin User

PowerShell example:

```powershell
cd apps/server
$env:ADMIN_USERNAME = "admin"
$env:ADMIN_PASSWORD = "change-me"
bun scripts/create-admin.ts
```

## Development

Use two terminals.

Terminal 1 from the repo root:

```powershell
$env:VPN_MANAGER_MASTER_KEY = "<base64-32-byte-key>"
bun --cwd apps/server dev
```

Terminal 2 from the repo root:

```powershell
bun --cwd apps/web dev
```

## Production Build

Build the web app:

```powershell
bun --cwd apps/web build
```

Then start the server with `STATIC_DIR` set to the built frontend directory. Relative and absolute paths both work.

```powershell
$env:VPN_MANAGER_MASTER_KEY = "<base64-32-byte-key>"
$env:STATIC_DIR = "E:\work\VPN manager\.worktrees\vpn-web-ui\apps\web\dist"
bun --cwd apps/server start
```

You can also point `STATIC_DIR` at a relative path such as `apps/web/dist` when starting from the repo root.
