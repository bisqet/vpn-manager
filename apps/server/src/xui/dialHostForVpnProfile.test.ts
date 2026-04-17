import { describe, expect, test } from "bun:test";
import { dialHostForVpnProfile } from "./dialHostForVpnProfile";

describe("dialHostForVpnProfile", () => {
  test("trimmed panel hostname wins over host", () => {
    expect(
      dialHostForVpnProfile({
        panel_hostname: "  panel.example.com  ",
        host: "hop.fallback.example.com",
      }),
    ).toBe("panel.example.com");
  });

  test("empty panel_hostname falls back to host", () => {
    expect(
      dialHostForVpnProfile({
        panel_hostname: "",
        host: "  hop.trim.example.com  ",
      }),
    ).toBe("hop.trim.example.com");
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
