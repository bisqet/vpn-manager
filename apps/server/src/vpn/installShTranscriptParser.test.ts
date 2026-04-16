import { describe, expect, test } from "bun:test";
import { parseInstallShCredentials } from "./installShTranscriptParser";

const sample = `
some noise
\x1b[32m Panel Installation Complete! \x1b[0m
\x1b[32mUsername: \x1b[0m\x1b[32mAb12cdEfGh\x1b[0m
\x1b[32mPassword: \x1b[0m\x1b[32mXy9zSecret01\x1b[0m
\x1b[32mWebBasePath: \x1b[0m\x1b[32mwebpath123456789012\x1b[0m
\x1b[32mAccess URL: https://panel.example.com:8443/webpath123456789012\x1b[0m
`;

describe("parseInstallShCredentials", () => {
  test("extracts username password webBasePath when Access URL host matches panel hostname", () => {
    const r = parseInstallShCredentials(sample, "panel.example.com");
    expect(r).toEqual({
      adminUsername: "Ab12cdEfGh",
      adminPassword: "Xy9zSecret01",
      webBasePath: "webpath123456789012",
    });
  });

  test("returns null when URL host does not match panel hostname", () => {
    expect(parseInstallShCredentials(sample, "other.example.net")).toBeNull();
  });

  test("returns null without Panel Installation Complete anchor", () => {
    const noAnchor = sample.replace("Panel Installation Complete", "");
    expect(parseInstallShCredentials(noAnchor, "panel.example.com")).toBeNull();
  });
});
