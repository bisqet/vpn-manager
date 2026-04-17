const INGEST =
  "http://127.0.0.1:7907/ingest/37f1e3ca-29d9-4454-a50b-967f8f04eace" as const;

/** NDJSON debug ingest (Cursor debug mode). No-op unless VPN_MANAGER_AGENT_DEBUG=1. */
export function agentDebugLog(payload: Record<string, unknown>): void {
  if (process.env.VPN_MANAGER_AGENT_DEBUG?.trim() !== "1") return;
  const body = JSON.stringify({
    sessionId: "ac8c04",
    timestamp: Date.now(),
    ...payload,
  });
  void fetch(INGEST, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "ac8c04" },
    body,
  }).catch(() => {});
}

/** Always-on error breadcrumb for generate-profile (no secrets). */
export function agentDebugLogError(payload: Record<string, unknown>): void {
  const body = JSON.stringify({
    sessionId: "ac8c04",
    timestamp: Date.now(),
    ...payload,
  });
  void fetch(INGEST, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "ac8c04" },
    body,
  }).catch(() => {});
}
