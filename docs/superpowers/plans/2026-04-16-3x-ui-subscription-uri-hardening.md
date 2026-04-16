# 3x-ui subscription URI path hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After automated setup (phased `buildSetupPhases` and browser `install.sh` flow), 3x-ui’s panel DB has non-default **`subPath`** and **`subJsonPath`** so Settings no longer warns on default **`/sub/`** and **`/json/`**.

**Architecture:** Reuse **cryptographically random alphanumerics** (same alphabet as today’s recover flow). Add **`makeDistinctSubscriptionPathDbValues(webBasePath)`** to produce two independent **`/<segment>/`** strings that are not **`/sub/`**, not **`/json/`**, not equal to each other, and whose bare segments differ from **`webBasePath`**. Apply values by **`sqlite3`** against **`/etc/x-ui/x-ui.db`** table **`settings`** while **`x-ui`** is stopped. Tarball path: extend **`configure_xui`** in **`setupPhases.ts`**. Install.sh path: second **`runPromptDriver`** completion (marker), same PTY buffer as install, after credentials are known.

**Tech Stack:** Bun test, TypeScript, `node:crypto` `randomBytes`, existing **`runPromptDriver`** / **`installShPromptDriver.ts`**.

**Spec:** `docs/superpowers/specs/2026-04-16-3x-ui-subscription-uri-hardening-design.md`

---

## File map

| File | Role |
|------|------|
| `apps/server/src/vpn/xuiRandom.ts` (new) | Shared **`randomXuiAlnum(n)`** used by recover + subscription path generation. |
| `apps/server/src/vpn/xuiSubscriptionPaths.ts` (new) | **`makeDistinctSubscriptionPathDbValues(webBasePath)`** + unit tests in colocated or separate test file. |
| `apps/server/src/vpn/installShExistingPanelRecover.ts` | Remove local **`randomAlnum`**, import **`randomXuiAlnum`** from **`xuiRandom.ts`**. |
| `apps/server/src/vpn/installShSubscriptionPathHardening.ts` (new) | Marker constant + **`runSubscriptionPathHardeningOnPty`** wrapping **`runPromptDriver`**. |
| `apps/server/src/vpn/setupPhases.ts` | Extend **`SetupPhaseContext`**, placeholders, embed sqlite hardening in **`configure_xui`** after existing **`x-ui setting`** + restart, before **`verify`** unchanged. |
| `apps/server/src/vpn/setupPhases.test.ts` | Assertions for sqlite, both keys, placeholders, non-default paths. |
| `apps/server/src/vpn/runInstallShSetupSession.ts` | After credentials, generate paths, call hardening; map failure to **`outcome: "failed"`**. |
| `apps/server/src/vpn/runInstallShSetupSession.test.ts` | Extend PTY mocks so hardening marker is emitted; add failure test. |

---

### Task 1: Shared `randomXuiAlnum`

**Files:**
- Create: `apps/server/src/vpn/xuiRandom.ts`
- Modify: `apps/server/src/vpn/installShExistingPanelRecover.ts` (swap local helper for import)
- Test: `apps/server/src/vpn/installShExistingPanelRecover.test.ts` (should still pass unchanged behavior)

- [ ] **Step 1: Write `xuiRandom.ts`**

```typescript
import { randomBytes } from "node:crypto";

const XUI_ALNUM = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/** Shell-safe segment for x-ui paths and credentials (matches prior `randomAlnum` in recover). */
export function randomXuiAlnum(length: number): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += XUI_ALNUM[bytes[i]! % XUI_ALNUM.length]!;
  }
  return out;
}
```

- [ ] **Step 2: Refactor recover to import it**

In **`installShExistingPanelRecover.ts`**, delete the local **`randomAlnum`** function and add:

```typescript
import { randomXuiAlnum } from "./xuiRandom";
```

Replace **`randomAlnum(10)`** → **`randomXuiAlnum(10)`**, **`randomAlnum(16)`** → **`randomXuiAlnum(16)`**.

- [ ] **Step 3: Run tests**

Run: `bun test apps/server/src/vpn/installShExistingPanelRecover.test.ts`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/vpn/xuiRandom.ts apps/server/src/vpn/installShExistingPanelRecover.ts
git commit -m "refactor(vpn): share randomXuiAlnum for x-ui automation"
```

---

### Task 2: `makeDistinctSubscriptionPathDbValues`

**Files:**
- Create: `apps/server/src/vpn/xuiSubscriptionPaths.ts`
- Create: `apps/server/src/vpn/xuiSubscriptionPaths.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// apps/server/src/vpn/xuiSubscriptionPaths.test.ts
import { describe, expect, test } from "bun:test";
import { makeDistinctSubscriptionPathDbValues } from "./xuiSubscriptionPaths";

describe("makeDistinctSubscriptionPathDbValues", () => {
  test("returns distinct paths with slashes and not defaults", () => {
    const wb = "webpath123456789012";
    const got = makeDistinctSubscriptionPathDbValues(wb);
    expect(got.subPathDb).not.toBe("/sub/");
    expect(got.subJsonPathDb).not.toBe("/json/");
    expect(got.subPathDb).not.toBe(got.subJsonPathDb);
    expect(got.subPathDb.startsWith("/")).toBe(true);
    expect(got.subPathDb.endsWith("/")).toBe(true);
    expect(got.subJsonPathDb.startsWith("/")).toBe(true);
    expect(got.subJsonPathDb.endsWith("/")).toBe(true);
  });

  test("segments are not equal to stripped webBasePath", () => {
    const wb = "aaaaaaaaaaaaaaaaaa";
    for (let i = 0; i < 30; i++) {
      const got = makeDistinctSubscriptionPathDbValues(wb);
      const s1 = got.subPathDb.slice(1, -1);
      const s2 = got.subJsonPathDb.slice(1, -1);
      expect(s1).not.toBe(wb);
      expect(s2).not.toBe(wb);
    }
  });
});
```

- [ ] **Step 2: Run tests — expect import/undefined failures**

Run: `bun test apps/server/src/vpn/xuiSubscriptionPaths.test.ts`
Expected: FAIL (module missing or function missing).

- [ ] **Step 3: Implement module**

```typescript
// apps/server/src/vpn/xuiSubscriptionPaths.ts
import { randomXuiAlnum } from "./xuiRandom";

const SEG_LEN = 18;

function stripSlashes(s: string): string {
  return s.trim().replace(/^\/+/, "").replace(/\/+$/, "");
}

function toDbPath(segment: string): string {
  return `/${segment}/`;
}

/**
 * Random subscription paths for 3x-ui `settings` keys `subPath` and `subJsonPath`.
 * Avoids defaults `/sub/` and `/json/`, duplicate segments, and matching `webBasePath`.
 */
export function makeDistinctSubscriptionPathDbValues(webBasePath: string): {
  subPathDb: string;
  subJsonPathDb: string;
} {
  const wb = stripSlashes(webBasePath);
  for (let attempt = 0; attempt < 100; attempt++) {
    const seg1 = randomXuiAlnum(SEG_LEN);
    const seg2 = randomXuiAlnum(SEG_LEN);
    if (seg1 === seg2) continue;
    if (seg1 === wb || seg2 === wb) continue;
    if (seg1 === "sub" || seg2 === "sub" || seg1 === "json" || seg2 === "json") continue;
    const subPathDb = toDbPath(seg1);
    const subJsonPathDb = toDbPath(seg2);
    if (subPathDb === "/sub/" || subJsonPathDb === "/json/") continue;
    return { subPathDb, subJsonPathDb };
  }
  throw new Error("makeDistinctSubscriptionPathDbValues: exhausted retries");
}
```

- [ ] **Step 4: Run tests — expect PASS**

Run: `bun test apps/server/src/vpn/xuiSubscriptionPaths.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/vpn/xuiSubscriptionPaths.ts apps/server/src/vpn/xuiSubscriptionPaths.test.ts
git commit -m "feat(vpn): generate distinct subscription DB path values"
```

---

### Task 3: PTY hardening helper (install.sh path)

**Files:**
- Create: `apps/server/src/vpn/installShSubscriptionPathHardening.ts`
- Test: covered in Task 5 **`runInstallShSetupSession.test.ts`**; optional small **`installShSubscriptionPathHardening.test.ts`** only if you want isolated driver test (YAGNI: session tests suffice).

- [ ] **Step 1: Add module**

```typescript
// apps/server/src/vpn/installShSubscriptionPathHardening.ts
import { runPromptDriver } from "./installShPromptDriver";
import type { RecoverSecretsOptions } from "./installShExistingPanelRecover";

export const VPNMGR_SUB_PATH_HARDEN_OK = "__VPNMGR_SUB_PATH_HARDEN_OK__";
export const XUI_PANEL_SETTINGS_DB = "/etc/x-ui/x-ui.db";

export type RunSubscriptionPathHardeningOnPtyOptions = RecoverSecretsOptions & {
  subPathDb: string;
  subJsonPathDb: string;
};

/**
 * Runs stop → sqlite3 UPDATE subPath + subJsonPath → start on the live PTY.
 * Paths must be shell-safe (implementation uses alphanumeric segments + slashes only).
 */
export async function runSubscriptionPathHardeningOnPty(
  options: RunSubscriptionPathHardeningOnPtyOptions,
): Promise<boolean> {
  const { write, subscribePtyData, plaintext, signal, subPathDb, subJsonPathDb } = options;

  const driver = await runPromptDriver({
    write: (s) => write(s),
    subscribeData: subscribePtyData,
    rules: [],
    plaintext,
    globalTimeoutMs: 120_000,
    signal,
    completionIncludes: VPNMGR_SUB_PATH_HARDEN_OK,
    tailDrainAfterCompleteMs: 400,
    afterSubscribe: () => {
      write(`\nset -euo pipefail
XUI_DB='${XUI_PANEL_SETTINGS_DB}'
test -f "$XUI_DB"
command -v sqlite3 >/dev/null || { export DEBIAN_FRONTEND=noninteractive; apt-get update -qq; apt-get install -y -qq sqlite3; }
systemctl stop x-ui
sub_changes=$(sqlite3 "$XUI_DB" "UPDATE settings SET value='${subPathDb}' WHERE key='subPath'; SELECT changes();")
json_changes=$(sqlite3 "$XUI_DB" "UPDATE settings SET value='${subJsonPathDb}' WHERE key='subJsonPath'; SELECT changes();")
test "$sub_changes" = "1"
test "$json_changes" = "1"
systemctl start x-ui
sleep 2
systemctl is-active --quiet x-ui
echo '${VPNMGR_SUB_PATH_HARDEN_OK}'
`);
    },
  });

  return driver.status === "completed";
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/server/src/vpn/installShSubscriptionPathHardening.ts
git commit -m "feat(vpn): PTY driver for subscription path sqlite hardening"
```

---

### Task 4: `runInstallShSetupSession` integration (with test hook)

**Files:**
- Modify: `apps/server/src/vpn/runInstallShSetupSession.ts`

- [ ] **Step 1: Extend options type**

Add optional:

```typescript
  /** Test hook: override subscription hardening (default: {@link runSubscriptionPathHardeningOnPty}). */
  runSubscriptionPathHardeningOnPtyImpl?: typeof runSubscriptionPathHardeningOnPty;
```

Import **`runSubscriptionPathHardeningOnPty`** and **`makeDistinctSubscriptionPathDbValues`** as in Task 3.

- [ ] **Step 2: Wire hardening after credentials**

Destructure **`runSubscriptionPathHardeningOnPtyImpl`** from **`options`**. Define:

```typescript
const harden = runSubscriptionPathHardeningOnPtyImpl ?? runSubscriptionPathHardeningOnPty;
```

Immediately before the successful **`return { outcome: "success", ...`** (after **`credentials`** is non-null):

```typescript
  const { subPathDb, subJsonPathDb } = makeDistinctSubscriptionPathDbValues(credentials.webBasePath);
  const hardened = await harden({
    write,
    subscribePtyData,
    plaintext: buffer,
    signal,
    subPathDb,
    subJsonPathDb,
  });
  if (!hardened) {
    return {
      outcome: "failed",
      reason:
        "subscription URI hardening failed (sqlite / systemd); panel may still use default /sub/ or /json/ paths — see transcript",
      plainTranscript: buffer.getPlaintext(),
    };
  }
```

- [ ] **Step 3: Commit (implementation only — tests in Task 5)**

```bash
git add apps/server/src/vpn/runInstallShSetupSession.ts
git commit -m "feat(vpn): harden subscription paths after install.sh success"
```

---

### Task 5: Update `runInstallShSetupSession` tests

**Files:**
- Modify: `apps/server/src/vpn/runInstallShSetupSession.test.ts`

- [ ] **Step 1: Import marker**

```typescript
import { VPNMGR_SUB_PATH_HARDEN_OK } from "./installShSubscriptionPathHardening";
```

- [ ] **Step 2: Extend success tests with `handlerRef` + `write` echo**

For each test that expects **`outcome: "success"`**, use the same pattern as the recovery test: **`let handlerRef: ((c: Uint8Array) => void) | null = null`**, assign in **`subscribePtyData`**, and in **`write`** when **`s.includes("subJsonPath") && s.includes("sqlite3")`** (the outbound hardening script), **`queueMicrotask(() => handlerRef!(encoder.encode(\`${VPNMGR_SUB_PATH_HARDEN_OK}\n\`)))`**.

- [ ] **Step 3: Failure test via inject hook (no 120s hang)**

```typescript
test("subscription hardening failure yields failed outcome", async () => {
  const result = await runInstallShSetupSession({
    write: () => {},
    subscribePtyData: (h) => {
      h(encoder.encode("Would you like to customize the Panel Port settings?\n"));
      h(encoder.encode(completionBanner));
      return () => {};
    },
    panelHostname: "panel.example.com",
    signal: new AbortController().signal,
    installCommand: ":",
    tailDrainAfterCompleteMs: 0,
    runSubscriptionPathHardeningOnPtyImpl: async () => false,
  });
  expect(result.outcome).toBe("failed");
  if (result.outcome !== "failed") throw new Error("expected failed");
  expect(result.reason.toLowerCase()).toContain("subscription uri hardening");
});
```

- [ ] **Step 4: Run tests**

Run: `bun test apps/server/src/vpn/runInstallShSetupSession.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/vpn/runInstallShSetupSession.test.ts
git commit -m "test(vpn): install.sh subscription hardening mocks and failure path"
```

---

### Task 6: `buildSetupPhases` / `configure_xui`

**Files:**
- Modify: `apps/server/src/vpn/setupPhases.ts`
- Modify: `apps/server/src/vpn/setupPhases.test.ts`

- [ ] **Step 1: Extend context and placeholders**

Add exports:

```typescript
export const PLACEHOLDER_SUB_PATH_DB = "<GENERATED_SUBSCRIPTION_SUB_PATH>";
export const PLACEHOLDER_SUB_JSON_PATH_DB = "<GENERATED_SUBSCRIPTION_JSON_PATH>";
```

Extend **`SetupPhaseContext`**:

```typescript
export type SetupPhaseContext = {
  xuiLocalPort: number;
  adminUsername: string;
  adminPassword: string;
  webBasePath: string;
  subPathDb: string;
  subJsonPathDb: string;
};
```

At top of **`buildSetupPhases`**, destructure **`subPathDb`, `subJsonPathDb`**.

- [ ] **Step 2: Append hardening to `configure_xui.script`**

After the existing block:

```bash
${XUI_BIN} setting -username '...' ...
systemctl restart ${XUI_SYSTEMD}
sleep 2
systemctl is-active --quiet ${XUI_SYSTEMD}
```

append (same template literal / bash style as **`ufw`** phase; use **`${XUI_SYSTEMD}`** consistently):

```bash
XUI_DB=/etc/x-ui/x-ui.db
test -f "$XUI_DB"
command -v sqlite3 >/dev/null || { export DEBIAN_FRONTEND=noninteractive; apt-get update -qq; apt-get install -y -qq sqlite3; }
systemctl stop ${XUI_SYSTEMD}
sub_changes=$(sqlite3 "$XUI_DB" "UPDATE settings SET value='${subPathDb}' WHERE key='subPath'; SELECT changes();")
json_changes=$(sqlite3 "$XUI_DB" "UPDATE settings SET value='${subJsonPathDb}' WHERE key='subJsonPath'; SELECT changes();")
test "$sub_changes" = "1"
test "$json_changes" = "1"
systemctl start ${XUI_SYSTEMD}
sleep 2
systemctl is-active --quiet ${XUI_SYSTEMD}
```

Use the **same** **`subPathDb` / `subJsonPathDb`** variable names as TypeScript interpolates from ctx (values are safe: **`/[A-Za-z0-9]+/`**).

- [ ] **Step 3: Update tests**

In **`setupPhases.test.ts`**, every **`buildSetupPhases({...})`** call adds:

```typescript
subPathDb: PLACEHOLDER_SUB_PATH_DB,
subJsonPathDb: PLACEHOLDER_SUB_JSON_PATH_DB,
```

or literal **`"/a1b2c3d4e5f6g7h8i9/"`** style for non-placeholder cases.

Add assertions on **`joined`**:

```typescript
expect(joined).toContain("/etc/x-ui/x-ui.db");
expect(joined).toContain("UPDATE settings");
expect(joined).toContain("subPath");
expect(joined).toContain("subJsonPath");
expect(joined).toContain("systemctl stop");
expect(joined).not.toContain("'/sub/'");
expect(joined).not.toContain("'/json/'");
```

- [ ] **Step 4: Call-site audit**

Search **`buildSetupPhases(`** under **`apps/server`**. As of this plan, **only** **`setupPhases.test.ts`** calls it — add the two new fields there. If **`setupLivePhaseLoop`** or **`profileSetupTerminalBridge`** is later wired to **`buildSetupPhases`**, the caller **must** supply **`makeDistinctSubscriptionPathDbValues(webBasePath)`** (not in this plan unless those imports already exist when you run Step 4).

- [ ] **Step 5: Run tests**

Run: `bun test apps/server/src/vpn/setupPhases.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/vpn/setupPhases.ts apps/server/src/vpn/setupPhases.test.ts
# include any caller fixes from Step 4
git commit -m "feat(vpn): sqlite subscription path hardening in setup phases"
```

---

### Task 7: Full server suite + self-review

- [ ] **Step 1: Run full server tests**

Run: `bun test apps/server`
Expected: all pass.

- [ ] **Step 2: Plan self-review (spec coverage)**

| Spec item | Task |
|-----------|------|
| Non-default **`subPath` / `subJsonPath`** | Task 2, 3, 4, 6 |
| Distinct from **`webBasePath`** and each other | Task 2 |
| Fail setup if hardening fails | Task 4, 5 injection test |
| Phased + install.sh | Task 3–6 |
| Placeholders / dry-run script text | Task 6 **`PLACEHOLDER_*`** |
| No VPN Manager DB columns | (no migration tasks) |

- [ ] **Step 3: Placeholder scan on this plan**

Confirm no **`TBD`** remains in this file.

- [ ] **Step 4: Final commit** (if any fixes from full test)

```bash
git commit -am "fix(vpn): subscription hardening follow-ups" # only if needed
```

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-16-3x-ui-subscription-uri-hardening.md`. Two execution options:

**1. Subagent-Driven (recommended)** — Dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach do you want?
