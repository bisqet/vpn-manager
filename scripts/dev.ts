#!/usr/bin/env bun
/**
 * Runs server + web dev together and tears down the full process tree on exit.
 * Port sweep runs synchronously in the signal handler (`spawnSync`): when Bun is
 * stopped via SIGINT from a parent process, `process.on("exit")` may not run.
 */
import {
  execSync,
  spawn,
  spawnSync,
  type ChildProcess,
} from "node:child_process";
import { join } from "node:path";
import { once } from "node:events";

const repoRoot = join(import.meta.dir, "..");
const children: ChildProcess[] = [];
let shuttingDown = false;
let shutdownSignal: NodeJS.Signals | null = null;
let exitCode = 0;

function sweepDevPortsSync() {
  const script = join(repoRoot, "scripts", "sweep-dev-ports.ts");
  const exe =
    process.execPath.toLowerCase().includes("bun") ? process.execPath : "bun";
  try {
    spawnSync(exe, [script], {
      cwd: repoRoot,
      env: process.env,
      stdio: "ignore",
      windowsHide: true,
      timeout: 15_000,
    });
  } catch {
    /* timeout or spawn failure */
  }
}

function killTree(pid: number | undefined) {
  if (pid === undefined) return;
  if (process.platform === "win32") {
    try {
      execSync(`taskkill /PID ${pid} /T /F`, {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      /* already exited */
    }
  } else {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* ignore */
      }
    }
  }
}

function shutdown(from: NodeJS.Signals | "error" | "child-exit") {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  if (
    from === "SIGINT" ||
    from === "SIGTERM" ||
    from === "SIGHUP" ||
    from === "SIGBREAK"
  ) {
    shutdownSignal = from;
  }
  for (const child of children) {
    killTree(child.pid);
  }
  sweepDevPortsSync();
}

for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(sig, () => shutdown(sig));
}
if (process.platform === "win32") {
  process.on("SIGBREAK", () => shutdown("SIGBREAK"));
}

const spawnOpts =
  process.platform === "win32"
    ? { stdio: "inherit" as const, env: process.env }
    : { stdio: "inherit" as const, env: process.env, detached: true as const };

children.push(
  spawn("bun", ["--cwd", "apps/server", "dev"], spawnOpts),
  spawn("bun", ["--cwd", "apps/web", "dev"], spawnOpts),
);

for (const child of children) {
  child.on("error", (err) => {
    console.error(err);
    exitCode = 1;
    shutdown("error");
  });
  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    if (signal || (code !== null && code !== 0)) {
      exitCode = code === null ? 1 : code || 1;
      shutdown("child-exit");
    }
  });
}

await Promise.all(children.map((c) => once(c, "exit")));
sweepDevPortsSync();

if (shutdownSignal === "SIGINT") process.exit(130);
if (shutdownSignal === "SIGTERM") process.exit(143);
if (shutdownSignal === "SIGHUP") process.exit(129);
if (shutdownSignal === "SIGBREAK") process.exit(131);
process.exit(exitCode);
