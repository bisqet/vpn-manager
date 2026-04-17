import { appendFileSync } from "node:fs";
import { join } from "node:path";

/** Repo-root `debug-c22698.log` (this file lives in `apps/server/src/`). */
const DEBUG_LOG_PATH = join(import.meta.dir, "../../..", "debug-c22698.log");

const INGEST = "http://127.0.0.1:7907/ingest/37f1e3ca-29d9-4454-a50b-967f8f04eace";

/** Debug-mode NDJSON (session c22698). No secrets. */
export function debugAgentLog(payload: {
  hypothesisId: string;
  location: string;
  message: string;
  data?: Record<string, unknown>;
}) {
  const body = JSON.stringify({
    sessionId: "c22698",
    timestamp: Date.now(),
    ...payload,
  });
  try {
    appendFileSync(DEBUG_LOG_PATH, `${body}\n`);
  } catch {
    // ignore missing dir / permissions
  }
  fetch(INGEST, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "c22698" },
    body,
  }).catch(() => {});
}
