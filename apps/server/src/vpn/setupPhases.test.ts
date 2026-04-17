import { describe, expect, test } from "bun:test";
import { buildPanelLoopbackHttpUrl } from "../net/panelAddress";
import { buildSetupPhases, PLACEHOLDER_ADMIN_PASS, PLACEHOLDER_ADMIN_USER } from "./setupPhases";

describe("buildSetupPhases", () => {
  test("includes placeholders and loopback verify URL", () => {
    const phases = buildSetupPhases({
      xuiLocalPort: 2053,
      adminUsername: PLACEHOLDER_ADMIN_USER,
      adminPassword: PLACEHOLDER_ADMIN_PASS,
      webBasePath: "ab12cd34ef56gh78ij",
    });
    expect(phases.length).toBe(5);
    const joined = phases.map((p) => p.script).join("\n");
    expect(joined).toContain(PLACEHOLDER_ADMIN_USER);
    expect(joined).toContain(PLACEHOLDER_ADMIN_PASS);
    expect(joined).toContain("127.0.0.1");
    expect(joined).toContain("listenIP");
    const expectUrl = buildPanelLoopbackHttpUrl(2053, "ab12cd34ef56gh78ij");
    expect(expectUrl).not.toBeNull();
    expect(joined).toContain(expectUrl!);
  });

  test("phase ids are stable", () => {
    const phases = buildSetupPhases({
      xuiLocalPort: 2096,
      adminUsername: "u1",
      adminPassword: "p1",
      webBasePath: "xyz",
    });
    expect(phases.map((p) => p.id)).toEqual(["preflight", "ufw", "install_xui", "configure_xui", "verify"]);
  });

  test("verify uses loopback HTTP URL (no external TLS assumptions)", () => {
    const phases = buildSetupPhases({
      xuiLocalPort: 2053,
      adminUsername: "u",
      adminPassword: "p",
      webBasePath: "abc",
    });
    const verify = phases.find((p) => p.id === "verify");
    expect(verify).toBeDefined();
    expect(verify!.script).toContain("http://127.0.0.1:2053/abc/");
    expect(verify!.script).not.toContain("https://");
  });
});
