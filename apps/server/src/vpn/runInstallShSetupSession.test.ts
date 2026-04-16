import { describe, expect, test } from "bun:test";
import {
  VPNMGR_RECOVER_MARKER_AFTER_SET,
  VPNMGR_RECOVER_MARKER_AFTER_SHOW,
} from "./installShExistingPanelRecover";
import { VPNMGR_SUB_PATH_HARDEN_OK } from "./installShSubscriptionPathHardening";
import { runInstallShSetupSession } from "./runInstallShSetupSession";

const encoder = new TextEncoder();

const completionBanner = `
Panel Installation Complete!
Username: Ab12cdEfGh
Password: Xy9zSecret01
WebBasePath: webpath123456789012
Access URL: https://panel.example.com:8443/webpath123456789012
`;

describe("runInstallShSetupSession", () => {
  test("port prompt then completion banner yields success with parsed credentials", async () => {
    const writes: string[] = [];
    const ac = new AbortController();
    let handlerRef: ((c: Uint8Array) => void) | null = null;

    const result = await runInstallShSetupSession({
      write: (data) => {
        const s = typeof data === "string" ? data : new TextDecoder().decode(data);
        writes.push(s);
        const h = handlerRef;
        if (h && s.includes("subJsonPath") && s.includes("sqlite3")) {
          queueMicrotask(() => h(encoder.encode(`${VPNMGR_SUB_PATH_HARDEN_OK}\n`)));
        }
      },
      subscribePtyData: (handler) => {
        handlerRef = handler;
        queueMicrotask(() => {
          handler(encoder.encode("Would you like to customize the Panel Port settings?\n"));
          queueMicrotask(() => {
            handler(encoder.encode(completionBanner));
          });
        });
        return () => {};
      },
      panelHostname: "panel.example.com",
      signal: ac.signal,
      installCommand: ":",
      tailDrainAfterCompleteMs: 0,
    });

    expect(result.outcome).toBe("success");
    if (result.outcome !== "success") throw new Error("expected success");
    expect(result.adminUsername).toBe("Ab12cdEfGh");
    expect(result.adminPassword).toBe("Xy9zSecret01");
    expect(result.webBasePath).toBe("webpath123456789012");
    expect(result.panelPort).toBe(8443);
    expect(result.plainTranscript).toContain("Panel Installation Complete");
    expect(writes[0]).toBe(":\n");
    expect(writes.some((w) => w === "n\n")).toBe(true);
  });

  test("no completion anchor within global timeout yields failed timeout", async () => {
    const ac = new AbortController();
    const result = await runInstallShSetupSession({
      write: () => {},
      subscribePtyData: (handler) => {
        handler(encoder.encode("only partial log line\n"));
        return () => {};
      },
      panelHostname: "panel.example.com",
      signal: ac.signal,
      globalTimeoutMs: 20,
      installCommand: ":",
      tailDrainAfterCompleteMs: 0,
    });

    expect(result.outcome).toBe("failed");
    if (result.outcome !== "failed") throw new Error("expected failed");
    expect(result.reason).toBe("install.sh setup timed out");
    expect(result.plainTranscript).toContain("only partial log line");
  });

  test("banner chunk before credential lines still parses when tail drain catches later PTY", async () => {
    const writes: string[] = [];
    const ac = new AbortController();
    let handlerRef: ((c: Uint8Array) => void) | null = null;

    const result = await runInstallShSetupSession({
      write: (data) => {
        const s = typeof data === "string" ? data : new TextDecoder().decode(data);
        writes.push(s);
        const h = handlerRef;
        if (h && s.includes("subJsonPath") && s.includes("sqlite3")) {
          queueMicrotask(() => h(encoder.encode(`${VPNMGR_SUB_PATH_HARDEN_OK}\n`)));
        }
      },
      subscribePtyData: (handler) => {
        handlerRef = handler;
        handler(encoder.encode("Would you like to customize the Panel Port settings?\n"));
        handler(encoder.encode("Panel Installation Complete!\n"));
        setTimeout(() => {
          handler(
            encoder.encode(`Username: Ab12cdEfGh
Password: Xy9zSecret01
WebBasePath: webpath123456789012
Access URL: https://panel.example.com:8443/webpath123456789012
`),
          );
        }, 40);
        return () => {};
      },
      panelHostname: "panel.example.com",
      signal: ac.signal,
      installCommand: ":",
      tailDrainAfterCompleteMs: 200,
    });

    expect(result.outcome).toBe("success");
    if (result.outcome !== "success") throw new Error("expected success");
    expect(result.adminUsername).toBe("Ab12cdEfGh");
    expect(result.webBasePath).toBe("webpath123456789012");
    expect(result.panelPort).toBe(8443);
    expect(writes.some((w) => w === "n\n")).toBe(true);
  });

  test("install finished without Panel banner uses CLI recovery", async () => {
    const enc = new TextEncoder();
    const dec = new TextDecoder();
    let handlerRef: ((c: Uint8Array) => void) | null = null;
    const writes: string[] = [];

    const result = await runInstallShSetupSession({
      write: (data) => {
        const s = typeof data === "string" ? data : dec.decode(data);
        writes.push(s);
        const h = handlerRef;
        if (!h) return;
        if (s.includes("setting -show")) {
          queueMicrotask(() =>
            h(
              enc.encode(
                `/usr/local/x-ui/x-ui setting -show true 2>&1\nwebBasePath: reinstallpath18\nport: 45543\n${VPNMGR_RECOVER_MARKER_AFTER_SHOW}\n`,
              ),
            ),
          );
        }
        if (s.includes("setting -username")) {
          queueMicrotask(() => h(enc.encode(`ok\n${VPNMGR_RECOVER_MARKER_AFTER_SET}\n`)));
        }
        if (s.includes("subJsonPath") && s.includes("sqlite3")) {
          queueMicrotask(() => h(enc.encode(`${VPNMGR_SUB_PATH_HARDEN_OK}\n`)));
        }
      },
      subscribePtyData: (h) => {
        const isFirst = handlerRef === null;
        handlerRef = h;
        if (isFirst) {
          h(enc.encode("Would you like to customize the Panel Port settings?\n"));
          h(enc.encode("x-ui v2.8.11 installation finished, it is running now...\n"));
        }
        return () => {};
      },
      panelHostname: "panel.example.com",
      signal: new AbortController().signal,
      installCommand: ":",
      tailDrainAfterCompleteMs: 0,
    });

    expect(result.outcome).toBe("success");
    if (result.outcome !== "success") throw new Error("expected success");
    expect(result.webBasePath).toBe("reinstallpath18");
    expect(result.panelPort).toBe(45543);
    expect(writes.some((w) => w.includes("setting -show"))).toBe(true);
    expect(writes.some((w) => w.includes("setting -username"))).toBe(true);
  });

  test("subscription hardening failure yields failed outcome", async () => {
    const result = await runInstallShSetupSession({
      write: () => {},
      subscribePtyData: (h) => {
        h(encoder.encode("Would you like to customize the Panel Port settings?\n"));
        h(encoder.encode(completionBanner));
        return () => {};
      },
      panelHostname: "panel.example.com",
      signal: new AbortController().signal,
      installCommand: ":",
      tailDrainAfterCompleteMs: 0,
      runSubscriptionPathHardeningOnPtyImpl: async () => false,
    });

    expect(result.outcome).toBe("failed");
    if (result.outcome !== "failed") throw new Error("expected failed");
    expect(result.reason.toLowerCase()).toContain("subscription uri hardening");
  });
});
