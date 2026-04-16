import { describe, expect, test } from "bun:test";
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

    const result = await runInstallShSetupSession({
      write: (data) => {
        writes.push(typeof data === "string" ? data : new TextDecoder().decode(data));
      },
      subscribePtyData: (handler) => {
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
    });

    expect(result.outcome).toBe("success");
    if (result.outcome !== "success") throw new Error("expected success");
    expect(result.adminUsername).toBe("Ab12cdEfGh");
    expect(result.adminPassword).toBe("Xy9zSecret01");
    expect(result.webBasePath).toBe("webpath123456789012");
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
    });

    expect(result.outcome).toBe("failed");
    if (result.outcome !== "failed") throw new Error("expected failed");
    expect(result.reason).toBe("install.sh setup timed out");
    expect(result.plainTranscript).toContain("only partial log line");
  });
});
