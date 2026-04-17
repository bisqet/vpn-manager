export type VpnProfileDialRow = {
  panel_hostname: string;
  host: string;
};

export function dialHostForVpnProfile(row: VpnProfileDialRow): string {
  const panel = row.panel_hostname.trim();
  if (panel !== "") return panel;
  return row.host.trim();
}
