# VPNs page table: remove SSH host and user columns (UI only) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the “IP or Host” and “SSH user” columns from the VPN profiles list table on the VPNs page, without changing APIs, database, or modal forms.

**Architecture:** Single-file JSX change in the existing profiles `<table>`: delete the two header cells and the two matching body cells. No new components or state.

**Tech stack:** React 18, TypeScript, Vite (`apps/web`).

**Spec:** `docs/superpowers/specs/2026-04-17-vpns-page-table-remove-ssh-columns-design.md`

---

## File structure

| File | Role |
|------|------|
| `apps/web/src/pages/VpnsPage.tsx` | Profiles table markup: remove two columns only. |

No new files. No server or shared type changes.

---

### Task 1: Strip columns from the profiles table

**Files:**
- Modify: `apps/web/src/pages/VpnsPage.tsx` (profiles `<table>` inside the `profiles.length > 0` branch)

- [ ] **Step 1: Remove header cells**

In the `<thead><tr>` that starts around the “Label” header, delete the two `<th>` elements whose text is `IP or Host` and `SSH user`.

Before (excerpt):

```tsx
                  <th style={tableHeadCellStyle}>Label</th>
                  <th style={tableHeadCellStyle}>IP or Host</th>
                  <th style={tableHeadCellStyle}>SSH port</th>
                  <th style={tableHeadCellStyle}>SSH user</th>
                  <th style={tableHeadCellStyle}>Panel</th>
```

After (excerpt):

```tsx
                  <th style={tableHeadCellStyle}>Label</th>
                  <th style={tableHeadCellStyle}>SSH port</th>
                  <th style={tableHeadCellStyle}>Panel</th>
```

- [ ] **Step 2: Remove body cells**

In the same file, inside `profiles.map`, delete the two `<td>` elements that render `profile.host` and `profile.sshUser` immediately after the label cell.

Before (excerpt):

```tsx
                      <td style={tableBodyCellStyle}>{profile.label}</td>
                      <td style={tableBodyCellStyle}>{profile.host}</td>
                      <td style={tableBodyCellStyle}>{profile.sshPort}</td>
                      <td style={tableBodyCellStyle}>{profile.sshUser}</td>
                      <td style={tableBodyCellStyle}>
```

After (excerpt):

```tsx
                      <td style={tableBodyCellStyle}>{profile.label}</td>
                      <td style={tableBodyCellStyle}>{profile.sshPort}</td>
                      <td style={tableBodyCellStyle}>
```

Do not remove `host` / `sshUser` from types, form state, mutations, or modal fields elsewhere in this file.

- [ ] **Step 3: Verify TypeScript and production build**

Run from repo root:

```bash
bun --cwd apps/web build
```

Expected: `tsc -b` and `vite build` complete with exit code 0.

- [ ] **Step 4: (Optional) Web unit tests**

```bash
bun run test:web
```

Expected: PASS (no new tests required per spec; confirms no accidental breakage in `apps/web`).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/VpnsPage.tsx
git commit -m "feat(web): drop SSH host and user from VPNs profile table"
```

---

## Plan self-review

1. **Spec coverage:** Table-only removal, modal/API untouched — Task 1 covers the spec.
2. **Placeholders:** None.
3. **Consistency:** Column order remains Label → SSH port → Panel → … after removal.
