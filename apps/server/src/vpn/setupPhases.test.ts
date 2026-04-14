import { describe, expect, test } from "bun:test";
import {
  buildSetupPhases,
  CADDYFILE_CONF_D_IMPORT_LINE,
  PLACEHOLDER_ADMIN_PASS,
  PLACEHOLDER_ADMIN_USER,
} from "./setupPhases";

describe("buildSetupPhases", () => {
  test("includes panel hostname and placeholders in scripts", () => {
    const phases = buildSetupPhases({
      panelHostname: "panel.example.com",
      acmeEmail: "ops@example.com",
      xuiLocalPort: 2053,
      adminUsername: PLACEHOLDER_ADMIN_USER,
      adminPassword: PLACEHOLDER_ADMIN_PASS,
      webBasePath: "ab12cd34ef56gh78ij",
    });
    expect(phases.length).toBe(7);
    const joined = phases.map((p) => p.script).join("\n");
    expect(joined).toContain("panel.example.com");
    expect(joined).toContain(PLACEHOLDER_ADMIN_USER);
    expect(joined).toContain(PLACEHOLDER_ADMIN_PASS);
    expect(joined).toContain("127.0.0.1");
    expect(joined).toContain("listenIP");
  });

  test("configure_caddy script includes the shared Caddyfile import line exactly once", () => {
    const phases = buildSetupPhases({
      panelHostname: "panel.example.com",
      acmeEmail: "ops@example.com",
      xuiLocalPort: 2053,
      adminUsername: "u1",
      adminPassword: "p1",
      webBasePath: "abc",
    });
    const configureCaddy = phases.find((p) => p.id === "configure_caddy");
    expect(configureCaddy).toBeDefined();
    const script = configureCaddy!.script;
    const occurrences = script.split(CADDYFILE_CONF_D_IMPORT_LINE).length - 1;
    expect(occurrences).toBe(1);
  });

  test("configure_caddy omits global email block when acmeEmail is empty or whitespace", () => {
    const phases = buildSetupPhases({
      panelHostname: "panel.example.com",
      acmeEmail: "  ",
      xuiLocalPort: 2053,
      adminUsername: "u1",
      adminPassword: "p1",
      webBasePath: "abc",
    });
    const configureCaddy = phases.find((p) => p.id === "configure_caddy");
    expect(configureCaddy).toBeDefined();
    const script = configureCaddy!.script;
    expect(script).not.toContain("\temail ");
    expect(script).toContain("panel.example.com {");
  });

  test("phase ids are stable", () => {
    const phases = buildSetupPhases({
      panelHostname: "p.example.net",
      acmeEmail: "a@b.co",
      xuiLocalPort: 2096,
      adminUsername: "u1",
      adminPassword: "p1",
      webBasePath: "xyz",
    });
    expect(phases.map((p) => p.id)).toEqual([
      "preflight",
      "ufw",
      "install_xui",
      "configure_xui",
      "install_caddy",
      "configure_caddy",
      "verify",
    ]);
  });

  test("caddy site key and verify URL support IPv4 and public IPv6", () => {
    const v4 = buildSetupPhases({
      panelHostname: "203.0.113.5",
      acmeEmail: "ops@example.com",
      xuiLocalPort: 2053,
      adminUsername: "u",
      adminPassword: "p",
      webBasePath: "abc",
    });
    const joined4 = v4.map((p) => p.script).join("\n");
    expect(joined4).toContain("203.0.113.5 {");
    expect(joined4).toContain("https://203.0.113.5/");

    const v6 = buildSetupPhases({
      panelHostname: "2001:4860:4860::8888",
      acmeEmail: "ops@example.com",
      xuiLocalPort: 2053,
      adminUsername: "u",
      adminPassword: "p",
      webBasePath: "abc",
    });
    const joined6 = v6.map((p) => p.script).join("\n");
    expect(joined6).toContain("[2001:4860:4860::8888] {");
    expect(joined6).toContain("https://[2001:4860:4860::8888]/");
  });
});
