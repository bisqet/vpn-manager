import { Database } from "bun:sqlite";
import { buildPanelHttpsUrl, httpsUrlHost } from "./panelAddress";

export type PanelReachability = "unknown" | "checking" | "reachable" | "unreachable";

export type PanelReachabilityRow = {
  panel_hostname: string;
  xui_web_base_path: string | null;
  xui_panel_port: number | null;
};

/** HTTP status codes that count as "panel speaks HTTPS" for v1 (see spec). */
export function httpStatusMeansReachable(status: number): boolean {
  if (status >= 200 && status < 400) return true;
  if (status === 401 || status === 403) return true;
  return false;
}

export function buildPanelProbeUrl(row: PanelReachabilityRow): string | null {
  const host = row.panel_hostname.trim();
  if (!host) return null;
  const port =
    row.xui_panel_port != null && Number.isFinite(row.xui_panel_port)
      ? Math.trunc(Number(row.xui_panel_port))
      : null;
  const portSuffix = port !== null && port > 0 && port !== 443 && port <= 65535 ? `:${port}` : "";
  const httpsHost = httpsUrlHost(host);
  const path = row.xui_web_base_path?.trim() ?? "";
  if (path !== "") {
    return buildPanelHttpsUrl(host, path, port);
  }
  return `https://${httpsHost}${portSuffix}/`;
}

export function summarizeProbeError(err: unknown): string {
  if (err instanceof Error && err.name === "AbortError") return "Probe timed out.";
  if (err instanceof Error) return err.message.slice(0, 200);
  return String(err).slice(0, 200);
}

export async function runPanelReachabilityProbe(options: {
  db: Database;
  profileId: number;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}): Promise<void> {
  const { db, profileId } = options;
  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? 4000;

  const row =
    db
      .query<PanelReachabilityRow, [number]>(
        `SELECT panel_hostname, xui_web_base_path, xui_panel_port FROM vpn_profiles WHERE id = ?`,
      )
      .get(profileId) ?? null;

  if (!row) return;

  const url = buildPanelProbeUrl(row);
  if (!url) {
    db.query(
      `UPDATE vpn_profiles SET panel_reachability = 'unreachable', panel_reachability_detail = ?, panel_reachability_checked_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
    ).run("Panel hostname is missing.", profileId);
    return;
  }

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, { method: "GET", redirect: "follow", signal: controller.signal });
    if (httpStatusMeansReachable(res.status)) {
      db.query(
        `UPDATE vpn_profiles SET panel_reachability = 'reachable', panel_reachability_detail = NULL, panel_reachability_checked_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
      ).run(profileId);
    } else {
      db.query(
        `UPDATE vpn_profiles SET panel_reachability = 'unreachable', panel_reachability_detail = ?, panel_reachability_checked_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
      ).run(`HTTP ${res.status}`, profileId);
    }
  } catch (e) {
    db.query(
      `UPDATE vpn_profiles SET panel_reachability = 'unreachable', panel_reachability_detail = ?, panel_reachability_checked_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
    ).run(summarizeProbeError(e), profileId);
  } finally {
    clearTimeout(t);
  }
}

export function schedulePanelReachabilityProbe(options: {
  db: Database;
  profileId: number;
  fetchFn?: typeof fetch;
}): void {
  void runPanelReachabilityProbe(options);
}
