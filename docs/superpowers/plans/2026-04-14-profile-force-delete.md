# Profile force delete (chain hop cleanup) implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `DELETE /api/profiles/:id?force=true` to remove a VPN profile after cleaning up `chain_hops` (and cascaded routing), renumbering remaining hops, removing empty chains; surface a **Delete anyway** path on the VPNs page when the normal delete returns 409.

**Architecture:** Keep the existing `DELETE` without query as the safe path. Parse `force` on the same Hono route; when set, run a single SQLite transaction: record affected `chain_id`s, delete hops for this profile, for each affected chain either delete the chain if no hops remain or renumber `position` to `0..n-1`, then delete the profile. Web: extend `deleteProfile` with an optional query flag; on 409 from the first delete, show **Delete anyway** plus a stricter `confirm`, then call force delete.

**Tech stack:** Bun, Hono, `bun:sqlite`, React, TanStack Query, TypeScript.

**Spec:** `docs/superpowers/specs/2026-04-14-profile-force-delete-design.md`

---

## File map

| File | Role |
|------|------|
| `apps/server/src/routes/profiles.ts` | Parse `force` query; implement transactional cleanup + delete; keep existing FK catch for non-force path. |
| `apps/server/src/routes/profiles.test.ts` | Tests: 409 without force; success with force; multi-hop renumber; empty chain removed; profile row gone. |
| `apps/web/src/pages/VpnsPage.tsx` | `deleteProfile(id, options?)`, delete mutation variables as `{ id, force? }`, 409 handling, UI for **Delete anyway**. |

---

### Task 1: Server — failing tests for force delete

**Files:**

- Modify: `apps/server/src/routes/profiles.test.ts`

- [ ] **Step 1: Add tests (they fail until Task 2 implements behavior)**

Append tests inside the existing `describe` for profile routes (same style as `"returns a conflict error when deleting a profile referenced by a chain hop"`).

```typescript
test("force-deletes profile, removes hops, renumbers remaining hops, removes empty chains", async () => {
  const app = createApp(db, env);

  for (const body of [
    { label: "A", host: "a.example.com", sshPort: 22, sshUser: "u", sshPassword: "p", panelHostname: "panel.a.example.com" },
    { label: "B", host: "b.example.com", sshPort: 22, sshUser: "u", sshPassword: "p", panelHostname: "panel.b.example.com" },
  ]) {
    const res = await app.request("/api/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: `${SESSION_COOKIE}=session-token` },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(201);
  }

  db.query("INSERT INTO chains (name) VALUES (?)").run("Multi");
  db.query("INSERT INTO chain_hops (chain_id, position, vpn_profile_id) VALUES (?, ?, ?)").run(1, 0, 1);
  db.query("INSERT INTO chain_hops (chain_id, position, vpn_profile_id) VALUES (?, ?, ?)").run(1, 1, 2);

  const forceRes = await app.request("/api/profiles/1?force=true", {
    method: "DELETE",
    headers: { Cookie: `${SESSION_COOKIE}=session-token` },
  });
  expect(forceRes.status).toBe(200);
  expect(await forceRes.json()).toEqual({ ok: true });

  expect(db.query("SELECT id FROM vpn_profiles WHERE id = ?").get(1)).toBeNull();

  const hops = db
    .query<{ chain_id: number; position: number; vpn_profile_id: number }, []>(
      "SELECT chain_id, position, vpn_profile_id FROM chain_hops ORDER BY chain_id, position",
    )
    .all();
  expect(hops).toEqual([{ chain_id: 1, position: 0, vpn_profile_id: 2 }]);

  expect(db.query("SELECT id FROM chains WHERE id = ?").get(1)).not.toBeNull();
});

test("force-deletes profile and removes chain when it was the only hop", async () => {
  const app = createApp(db, env);

  const createRes = await app.request("/api/profiles", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `${SESSION_COOKIE}=session-token` },
    body: JSON.stringify({
      label: "Solo",
      host: "solo.example.com",
      sshPort: 22,
      sshUser: "u",
      sshPassword: "p",
      panelHostname: "panel.solo.example.com",
    }),
  });
  expect(createRes.status).toBe(201);

  db.query("INSERT INTO chains (name) VALUES (?)").run("Only");
  db.query("INSERT INTO chain_hops (chain_id, position, vpn_profile_id) VALUES (?, ?, ?)").run(1, 0, 1);

  const forceRes = await app.request("/api/profiles/1?force=true", {
    method: "DELETE",
    headers: { Cookie: `${SESSION_COOKIE}=session-token` },
  });
  expect(forceRes.status).toBe(200);

  expect(db.query("SELECT id FROM vpn_profiles WHERE id = ?").get(1)).toBeNull();
  expect(db.query("SELECT id FROM chain_hops WHERE chain_id = ?", [1]).all()).toEqual([]);
  expect(db.query("SELECT id FROM chains WHERE id = ?", [1]).get(1)).toBeNull();
});
```

- [ ] **Step 2: Run tests — expect failures**

Run:

```bash
bun test apps/server/src/routes/profiles.test.ts
```

Expected: new tests **FAIL** (404 or 409 or wrong DB state) until Task 2 is done.

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/routes/profiles.test.ts
git commit -m "test: add profile force-delete scenarios"
```

---

### Task 2: Server — implement `?force=true` delete

**Files:**

- Modify: `apps/server/src/routes/profiles.ts`

- [ ] **Step 1: Add helper next to route handlers (same module)**

Insert a function used only by the delete handler:

```typescript
function deleteVpnProfileWithHopCleanup(db: Database, id: number) {
  const affectedRows = db
    .query<{ chain_id: number }, [number]>("SELECT DISTINCT chain_id FROM chain_hops WHERE vpn_profile_id = ?")
    .all(id);
  const affectedChainIds = affectedRows.map((r) => r.chain_id);

  db.query("DELETE FROM chain_hops WHERE vpn_profile_id = ?").run(id);

  for (const chainId of affectedChainIds) {
    const remaining = db
      .query<{ id: number }, [number]>(
        "SELECT id FROM chain_hops WHERE chain_id = ? ORDER BY position ASC, id ASC",
      )
      .all(chainId);

    if (remaining.length === 0) {
      db.query("DELETE FROM chains WHERE id = ?").run(chainId);
      continue;
    }

    for (let i = 0; i < remaining.length; i++) {
      db.query("UPDATE chain_hops SET position = ? WHERE id = ?").run(i, remaining[i].id);
    }
  }

  db.query("DELETE FROM vpn_profiles WHERE id = ?").run(id);
}
```

- [ ] **Step 2: Replace the `app.delete("/:id", ...)` body**

Behavior:

1. Parse `id` as today; return 400 if invalid.
2. `getProfileById`; return 404 if missing.
3. Read `const rawForce = c.req.query("force");`  
   - If `rawForce !== undefined && rawForce !== "true" && rawForce !== "1"`, return `c.json({ error: "Invalid force parameter" }, 400)`.
4. If `rawForce === "true" || rawForce === "1"`:
   - `db.exec("BEGIN"); try { deleteVpnProfileWithHopCleanup(db, id); db.exec("COMMIT"); } catch (e) { db.exec("ROLLBACK"); throw e; }`
   - Return `c.json({ ok: true })`.
5. Else (no force): keep existing `try { DELETE FROM vpn_profiles ... } catch` with 409 on FK message.

Ensure `PRAGMA foreign_keys` is already ON for the app test DB (it is in `schema.sql`).

- [ ] **Step 3: Run profile route tests**

Run:

```bash
bun test apps/server/src/routes/profiles.test.ts
```

Expected: **PASS** (including the older conflict test and both new tests).

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/routes/profiles.ts
git commit -m "feat: force-delete VPN profile and clean chain hops"
```

---

### Task 3: Web — API helper and mutation shape

**Files:**

- Modify: `apps/web/src/pages/VpnsPage.tsx`

Constants (near other helpers):

```typescript
const PROFILE_IN_USE_ERROR = "Profile is in use by one or more chain hops";

function deleteProfile(id: number, options?: { force?: boolean }) {
  const q = options?.force ? "?force=true" : "";
  return apiFetch<{ ok: true }>(`/api/profiles/${id}${q}`, {
    method: "DELETE",
  });
}
```

- [ ] **Step 1: Change `useMutation` for delete**

```typescript
const deleteMutation = useMutation({
  mutationFn: (variables: { id: number; force?: boolean }) => deleteProfile(variables.id, { force: variables.force }),
  onSuccess: async (_, variables) => {
    await queryClient.invalidateQueries({ queryKey: profilesQueryKey });
    setSshProfile((current) => (current?.id === variables.id ? null : current));
    setSetupSheet((current) => (current?.profile.id === variables.id ? null : current));
    setPendingForceDeleteId(null);
  },
});
```

Add state near other `useState` calls:

```typescript
const [pendingForceDeleteId, setPendingForceDeleteId] = useState<number | null>(null);
```

Import/use `useState` already present.

- [ ] **Step 2: Update `handleDelete`**

```typescript
async function handleDelete(profile: VpnProfile) {
  if (!window.confirm(`Delete VPN profile "${profile.label}"?`)) {
    return;
  }

  setPendingForceDeleteId(null);
  try {
    await deleteMutation.mutateAsync({ id: profile.id });
  } catch (error) {
    if (
      error instanceof ApiError &&
      error.status === 409 &&
      error.message === PROFILE_IN_USE_ERROR
    ) {
      setPendingForceDeleteId(profile.id);
    }
    throw error;
  }
}
```

Note: `mutateAsync` rethrows; React Query still records `deleteMutation.error`. That is fine: the banner shows the message and **Delete anyway** uses `pendingForceDeleteId`.

- [ ] **Step 3: Add `handleForceDelete`**

```typescript
async function handleForceDelete(profile: VpnProfile) {
  if (
    !window.confirm(
      `Delete "${profile.label}" anyway?\n\nThis removes every chain hop that uses this profile (routing rules on those hops are lost), deletes chains that would have no hops left, then deletes the profile. This cannot be undone.`,
    )
  ) {
    return;
  }

  setPendingForceDeleteId(null);
  await deleteMutation.mutateAsync({ id: profile.id, force: true });
}
```

- [ ] **Step 4: Fix all `deleteMutation` variable reads**

Where the table uses `deleteMutation.variables === profile.id`, change to `deleteMutation.variables?.id === profile.id`.

- [ ] **Step 5: UI under the mutation error line**

Replace the single error line with a fragment that optionally shows the button:

```tsx
{mutationError ? (
  <div style={errorStyle}>
    <div>{getErrorMessage(mutationError)}</div>
    {pendingForceDeleteId !== null ? (
      <div style={{ marginTop: 8 }}>
        <button
          disabled={isDeleting}
          onClick={() => {
            const p = profiles.find((x) => x.id === pendingForceDeleteId);
            if (p) void handleForceDelete(p);
          }}
          style={dangerButtonStyle}
          type="button"
        >
          {isDeleting ? "Deleting..." : "Delete anyway"}
        </button>
      </div>
    ) : null}
  </div>
) : null}
```

Resolve `profiles` from `profilesQuery.data ?? []` (use whatever name the page already uses for the array).

- [ ] **Step 6: Typecheck web**

Run (from repo root):

```powershell
cd apps/web; bunx tsc -b
```

Expected: exit code **0**.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/pages/VpnsPage.tsx
git commit -m "feat(web): delete VPN profile anyway after chain-hop conflict"
```

---

### Task 4: Verification gate

- [ ] **Step 1: Full server tests**

Run:

```bash
bun test apps/server
```

Expected: all tests **PASS**.

- [ ] **Step 2: Manual smoke (optional)**

1. Create two profiles; create a chain with both; delete the first profile → 409 message and **Delete anyway** → confirm → profile gone, chain shows one hop at position 0.  
2. Create one profile; chain with only that profile; force delete → chain disappears from Chains page.

---

## Plan self-review (spec coverage)

| Spec item | Task |
|-----------|------|
| Default `DELETE` unchanged, 409 same JSON | Task 2 keeps non-force branch. |
| `?force=true` / `force=1`, transaction, hop delete + renumber + empty chain + profile delete | Task 2 helper + `BEGIN`/`COMMIT`. |
| 400 invalid `force` | Task 2. |
| UI 409 + second confirm + **Delete anyway** | Task 3. |
| Same post-delete invalidation | Task 3 `onSuccess`. |
| Server tests | Tasks 1–2. |

No TBD lines; types consistent (`{ id, force? }` everywhere for delete mutation).

---

**Plan complete and saved to `docs/superpowers/plans/2026-04-14-profile-force-delete.md`. Two execution options:**

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration  
2. **Inline Execution** — run tasks in this session with checkpoints between tasks  

Which approach do you want?
