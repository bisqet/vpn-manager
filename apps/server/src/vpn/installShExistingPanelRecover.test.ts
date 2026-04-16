import { describe, expect, test } from "bun:test";
import {
  parseLastWebBasePathFromSettingShow,
  parsePanelPortFromLastSettingShowOutput,
  recoverPanelSecretsWhenNoInstallBanner,
  VPNMGR_RECOVER_MARKER_AFTER_SET,
  VPNMGR_RECOVER_MARKER_AFTER_SHOW,
} from "./installShExistingPanelRecover";
import { createPtyPlaintextBuffer } from "./ptyPlaintext";

describe("parseLastWebBasePathFromSettingShow", () => {
  test("returns last webBasePath with leading slash stripped", () => {
    expect(parseLastWebBasePathFromSettingShow("a\nwebBasePath: /seg18charslong000\n")).toBe("seg18charslong000");
    expect(parseLastWebBasePathFromSettingShow("webBasePath: first\nwebBasePath: secondpath18")).toBe("secondpath18");
  });

  test("returns null when missing", () => {
    expect(parseLastWebBasePathFromSettingShow("port: 3\n")).toBeNull();
  });
});

describe("parsePanelPortFromLastSettingShowOutput", () => {
  test("parses port between show command and marker", () => {
    const chunk = `noise
/usr/local/x-ui/x-ui setting -show true
current panel settings as follows:
port: 45543
webBasePath: abc
${VPNMGR_RECOVER_MARKER_AFTER_SHOW}
`;
    expect(parsePanelPortFromLastSettingShowOutput(chunk, VPNMGR_RECOVER_MARKER_AFTER_SHOW)).toBe(45543);
  });
});

describe("recoverPanelSecretsWhenNoInstallBanner", () => {
  test("reads webBasePath then applies new credentials", async () => {
    const enc = new TextEncoder();
    const dec = new TextDecoder();
    let handlerRef: ((c: Uint8Array) => void) | null = null;
    const writes: string[] = [];

    const result = await recoverPanelSecretsWhenNoInstallBanner({
      write: (data) => {
        const s = typeof data === "string" ? data : dec.decode(data);
        writes.push(s);
        const h = handlerRef;
        if (!h) return;
        if (s.includes("setting -show")) {
          queueMicrotask(() =>
            h(
              enc.encode(
                `/usr/local/x-ui/x-ui setting -show true 2>&1\ncurrent panel settings as follows:\nport: 2099\nwebBasePath: recoverpath18charsxx\n${VPNMGR_RECOVER_MARKER_AFTER_SHOW}\n`,
              ),
            ),
          );
        }
        if (s.includes("setting -username")) {
          queueMicrotask(() =>
            h(enc.encode(`Username and password updated successfully\n${VPNMGR_RECOVER_MARKER_AFTER_SET}\n`)),
          );
        }
      },
      subscribePtyData: (h) => {
        handlerRef = h;
        return () => {};
      },
      plaintext: createPtyPlaintextBuffer(),
      signal: new AbortController().signal,
    });

    expect(result).not.toBeNull();
    if (!result) throw new Error("expected credentials");
    expect(result.webBasePath).toBe("recoverpath18charsxx");
    expect(result.panelPort).toBe(2099);
    expect(result.adminUsername).toHaveLength(10);
    expect(result.adminPassword).toHaveLength(16);
    expect(writes.some((w) => w.includes("setting -show"))).toBe(true);
    expect(writes.some((w) => w.includes("setting -username"))).toBe(true);
  });
});
