import { describe, expect, test } from "bun:test";
import { dialHostForVpnProfile } from "./dialHostForVpnProfile";

describe("dialHostForVpnProfile", () => {
  test("trimmed panel hostname wins over host", () => {
    expect(
      dialHostForVpnProfile({
        panel_hostname: "  panel.example.com  ",
        host: "192.0.2.1",
      }),
    ).toBe("panel.example.com");
  });

  test("empty panel_hostname falls back to host", () => {
    expect(
      dialHostForVpnProfile({
        panel_hostname: "",
        host: "  192.0.2.2  ",
      }),
    ).toBe("192.0.2.2");
  });

  test("whitespace-only panel_hostname falls back to host", () => {
    expect(
      dialHostForVpnProfile({
        panel_hostname: "   \t  ",
        host: "hop.internal",
      }),
    ).toBe("hop.internal");
  });
});
