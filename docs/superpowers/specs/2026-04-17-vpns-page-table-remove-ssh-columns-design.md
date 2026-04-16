# VPNs page: remove SSH host and SSH user from profile table (UI only)

## Goal

Remove the **“IP or Host”** and **“SSH user”** columns from the VPN profiles **list table** on the VPNs page. Keep all persistence, APIs, and create/edit flows unchanged.

## Context

- `vpn_profiles` stores `host` (SSH target; labeled “IP or Host” in the UI) and `ssh_user`.
- The VPNs page table currently shows Label, IP or Host, SSH port, SSH user, Panel, panel credentials, Status, Actions.
- This change is **presentation only** in `apps/web/src/pages/VpnsPage.tsx`.

## Behavior

### In scope

- Remove the corresponding `<th>` and `<td>` elements for “IP or Host” and “SSH user” from the profiles table.

### Out of scope

- Database schema, migrations, server routes, Zod types, import/export, SSH runners, and modal form fields for host / SSH user.
- Other pages (e.g. chains) unless explicitly requested later.

## Rationale

The table is a summary view; SSH connection details remain available where they are edited. Narrowing the list reduces noise for operators who no longer need host/user visible at a glance.

## Testing

- Manual: open VPNs page with profiles loaded; confirm table columns omit host and SSH user while add/edit still shows and saves those fields.
- No new automated tests required unless the project adds page-level coverage for `VpnsPage`.

## Risks

Users cannot see SSH host or username from the list without opening edit. Accepted as part of the product decision.
