import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const INGEST =
  "http://127.0.0.1:7907/ingest/37f1e3ca-29d9-4454-a50b-967f8f04eace" as const;

const SESSION = "ac8c04" as const;

/** Repo root: apps/server/src/debug -> ../../../../ */
function sessionDebugLogPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "..", "..", ".cursor", `debug-${SESSION}.log`);
}

/** Local NDJSON fallback when ingest does not write to the workspace. */
export function appendAgentSessionLog(entry: Record<string, unknown>): void {
  try {
    const file = sessionDebugLogPath();
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(entry)}\n`, "utf8");
  } catch {
    // ignore
  }
}

/** NDJSON debug ingest (Cursor debug mode). No-op unless VPN_MANAGER_AGENT_DEBUG=1. */
export function agentDebugLog(payload: Record<string, unknown>): void {
  if (process.env.VPN_MANAGER_AGENT_DEBUG?.trim() !== "1") return;
  const entry = { sessionId: SESSION, timestamp: Date.now(), ...payload };
  appendAgentSessionLog(entry);
  void fetch(INGEST, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Debug-Session-Id": SESSION },
    body: JSON.stringify(entry),
  }).catch(() => {});
}

/** Always-on error breadcrumb for generate-profile (no secrets). */
export function agentDebugLogError(payload: Record<string, unknown>): void {
  const entry = { sessionId: SESSION, timestamp: Date.now(), ...payload };
  appendAgentSessionLog(entry);
  void fetch(INGEST, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Debug-Session-Id": SESSION },
    body: JSON.stringify(entry),
  }).catch(() => {});
}
