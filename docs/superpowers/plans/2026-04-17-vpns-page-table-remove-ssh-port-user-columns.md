# VPNs page table: remove SSH port and SSH user columns — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the **SSH port** and **SSH user** columns from the VPNs profiles table on `VpnsPage` only; keep **IP or Host** and all modals/APIs unchanged.

**Architecture:** Single-file JSX edit: delete the two `<th>` and matching two `<td>` elements so header and body column counts stay aligned. No new components or data changes.

**Tech stack:** React 18, `apps/web` (Vite + TypeScript).

**Spec:** `docs/superpowers/specs/2026-04-17-vpns-page-table-remove-ssh-port-user-columns-design.md`

---

## File map

| File | Change |
|------|--------|
| `apps/web/src/pages/VpnsPage.tsx` | Remove SSH port / SSH user table header cells and body cells in the profiles `<table>`. |

No new files. Per spec, no new automated tests for `VpnsPage`; verify with `apps/web` build.

---

### Task 1: Remove columns from the profiles table

**Files:**
- Modify: `apps/web/src/pages/VpnsPage.tsx` (profiles `<table>`, ~lines 1100–1135)

- [ ] **Step 1: Edit thead**

In the `<thead><tr>` of the profiles table, delete these two lines (keep **IP or Host** immediately before **Panel**):

```tsx
                  <th style={tableHeadCellStyle}>SSH port</th>
                  <th style={tableHeadCellStyle}>SSH user</th>
```

- [ ] **Step 2: Edit tbody**

In the same file, inside `profiles.map` row `<tr>`, delete the two `<td>` cells that render `profile.sshPort` and `profile.sshUser` (the pair immediately after the `profile.host` cell).

After edit, the row order must be: `label` → `host` → Panel cell → Panel user → Panel pass → status → actions.

- [ ] **Step 3: Run web build**

Run:

```bash
bun --cwd apps/web build
```

Expected: `tsc -b` and `vite build` complete with exit code 0.

- [ ] **Step 4: Run web unit tests (regression)**

Run:

```bash
bun --cwd apps/web test
```

Expected: all tests in `apps/web/src` pass.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/VpnsPage.tsx
git commit -m "feat(web): drop SSH port and user from VPNs table"
```

---

## Plan self-review

- **Spec coverage:** Table columns match spec (Label, IP or Host, Panel, Panel user, Panel pass, Status, Actions); modals untouched — Task 1 only touches table markup.
- **Placeholders:** None.
- **Consistency:** Header and body both lose two columns — no colspan changes needed.

---

## Execution handoff

**Plan saved to** `docs/superpowers/plans/2026-04-17-vpns-page-table-remove-ssh-port-user-columns.md`.

**1. Subagent-driven (recommended)** — one subagent per task with review between tasks.

**2. Inline execution** — run all steps in this session with executing-plans checkpoints.

Which approach do you want?
