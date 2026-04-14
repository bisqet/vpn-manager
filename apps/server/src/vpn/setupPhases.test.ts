import { describe, expect, test } from "bun:test";
import { buildSetupPhases, PLACEHOLDER_ADMIN_PASS, PLACEHOLDER_ADMIN_USER } from "./setupPhases";

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
});
