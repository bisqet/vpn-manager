# VPNs page table: remove SSH port and SSH user columns

**Date:** 2026-04-17  
**Status:** Approved for implementation planning

## Goal

On the VPNs (`VpnsPage`) profiles table, remove the **SSH port** and **SSH user** list columns only. Keep the **IP or Host** column and all other table columns unchanged.

## Scope

- **In scope:** `apps/web/src/pages/VpnsPage.tsx` — delete the `<th>` / `<td>` pairs for SSH port and SSH user in the profiles `<table>` (header and body rows).
- **Out of scope:** Database schema, API routes, Zod types, create/edit modal fields, validation messages, import/export, chains UI, and any server-side logic.

## Rationale

The table is a summary view; SSH port and user remain available where operators enter them (add/edit profile). Removing duplicate detail from the grid reduces noise without changing behavior or stored data.

## Success criteria

- The VPNs list table columns are, in order: **Label**, **IP or Host**, **Panel**, **Panel user**, **Panel pass**, **Status**, **Actions** (SSH port and SSH user columns absent).
- Add and edit flows still collect and display `sshPort` and `sshUser` as today.
- No regressions to profile fetch/create/update APIs.

## Testing

- Manual: open VPNs page with at least one profile; confirm columns match spec and modals still show port and user.
- No new automated tests required unless the project later adds `VpnsPage` coverage.

## Risks

Users cannot see SSH port or username from the list alone; they must open a profile. Accepted as part of the product decision.
