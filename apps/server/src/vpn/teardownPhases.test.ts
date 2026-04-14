import { describe, expect, test } from "bun:test";
import { buildTeardownPhases } from "./teardownPhases";
import { CADDYFILE_CONF_D_IMPORT_LINE } from "./setupPhases";

describe("buildTeardownPhases", () => {
  test("returns ordered phases with expected ids and paths", () => {
    const phases = buildTeardownPhases();
    expect(phases.map((p) => p.id)).toEqual([
      "stop_xui",
      "remove_xui_install",
      "stop_caddy",
      "remove_caddy_site",
      "trim_caddyfile_import",
      "purge_caddy",
      "remove_caddy_apt_wiring",
    ]);
    const joined = phases.map((p) => p.script).join("\n");
    expect(joined).toContain("/usr/local/x-ui");
    expect(joined).toContain("/etc/caddy/conf.d/vpn-manager-3x-ui.caddy");
    expect(joined).toContain("apt-get purge -y caddy");
    expect(joined).toContain(CADDYFILE_CONF_D_IMPORT_LINE);
    expect(joined).toContain("caddy-stable.list");
  });
});
