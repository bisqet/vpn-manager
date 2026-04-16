import { describe, expect, test } from "bun:test";
import { createInstallShPromptRules, runPromptDriver, type PromptRule } from "./installShPromptDriver";
import { createPtyPlaintextBuffer } from "./ptyPlaintext";

const encoder = new TextEncoder();

describe("createInstallShPromptRules", () => {
  test("orders rules by descending whenIncludes length", () => {
    const rules = createInstallShPromptRules({ panelHostname: "panel.example.com", isPanelIp: false });
    for (let i = 1; i < rules.length; i++) {
      expect(rules[i - 1]!.whenIncludes.length).toBeGreaterThanOrEqual(rules[i]!.whenIncludes.length);
    }
  });

  test("SSL menu: FQDN sends 1, panel IP sends 2", () => {
    const fqdn = createInstallShPromptRules({ panelHostname: "panel.example.com", isPanelIp: false });
    const sslFqdn = fqdn.find((r) => r.id === "ssl-menu-ip-vs-domain");
    expect(sslFqdn?.send).toBe("1");

    const ip = createInstallShPromptRules({ panelHostname: "203.0.113.10", isPanelIp: true });
    const sslIp = ip.find((r) => r.id === "ssl-menu-ip-vs-domain");
    expect(sslIp?.send).toBe("2");
  });

  test("domain prompt sends panel hostname", () => {
    const rules = createInstallShPromptRules({ panelHostname: "vpn.example.net", isPanelIp: false });
    const domain = rules.find((r) => r.id === "domain-name");
    expect(domain?.send).toBe("vpn.example.net");
  });
});

describe("runPromptDriver", () => {
  test("replies to scripted Panel Port customize prompt", async () => {
    const writes: string[] = [];
    const ac = new AbortController();
    const prompt =
      "Some banner text\nWould you like to customize the Panel Port settings? (If not, a random port will be applied) [y/n]: ";

    const result = await runPromptDriver({
      write: (s) => writes.push(s),
      subscribeData: (cb) => {
        cb(encoder.encode(prompt));
        queueMicrotask(() => ac.abort());
        return () => {};
      },
      rules: createInstallShPromptRules({ panelHostname: "panel.example.com", isPanelIp: false }),
      plaintext: createPtyPlaintextBuffer(),
      globalTimeoutMs: 30_000,
      signal: ac.signal,
    });

    expect(writes).toEqual(["n\n"]);
    expect(result.status).toBe("aborted");
    expect(result.lastRuleId).toBe("panel-port-customize");
  });

  test("first matching rule follows rules array order (longest-first matters)", async () => {
    const writes: string[] = [];
    const ac = new AbortController();
    const text =
      "Would you like to customize the Panel Port settings? (If not, a random port will be applied) [y/n]: ";

    const misordered: PromptRule[] = [
      { id: "short", whenIncludes: "Would you like", send: "BAD", timeoutMs: 1 },
      {
        id: "long",
        whenIncludes: "Would you like to customize the Panel Port settings?",
        send: "n",
        timeoutMs: 1,
      },
    ];

    await runPromptDriver({
      write: (s) => writes.push(s),
      subscribeData: (cb) => {
        cb(encoder.encode(text));
        queueMicrotask(() => ac.abort());
        return () => {};
      },
      rules: misordered,
      plaintext: createPtyPlaintextBuffer(),
      globalTimeoutMs: 30_000,
      signal: ac.signal,
    });

    expect(writes).toEqual(["BAD\n"]);
  });

  test("longer whenIncludes wins when listed first", async () => {
    const writes: string[] = [];
    const ac = new AbortController();
    const text =
      "Would you like to customize the Panel Port settings? (If not, a random port will be applied) [y/n]: ";

    const ordered: PromptRule[] = [
      {
        id: "long",
        whenIncludes: "Would you like to customize the Panel Port settings?",
        send: "n",
        timeoutMs: 1,
      },
      { id: "short", whenIncludes: "Would you like", send: "BAD", timeoutMs: 1 },
    ];

    await runPromptDriver({
      write: (s) => writes.push(s),
      subscribeData: (cb) => {
        cb(encoder.encode(text));
        queueMicrotask(() => ac.abort());
        return () => {};
      },
      rules: ordered,
      plaintext: createPtyPlaintextBuffer(),
      globalTimeoutMs: 30_000,
      signal: ac.signal,
    });

    expect(writes).toEqual(["n\n"]);
  });

  test("sequential chunks answer stacked install.sh prompts in order", async () => {
    const writes: string[] = [];
    const ac = new AbortController();
    const port =
      "Would you like to customize the Panel Port settings? [y/n]: \n";
    const ssl = "Choose an option (default 2 for IP): \n";

    await runPromptDriver({
      write: (s) => writes.push(s),
      subscribeData: (cb) => {
        cb(encoder.encode(port));
        queueMicrotask(() => {
          cb(encoder.encode(ssl));
          queueMicrotask(() => ac.abort());
        });
        return () => {};
      },
      rules: createInstallShPromptRules({ panelHostname: "panel.example.com", isPanelIp: false }),
      plaintext: createPtyPlaintextBuffer(),
      globalTimeoutMs: 30_000,
      signal: ac.signal,
    });

    expect(writes).toEqual(["n\n", "1\n"]);
  });

  test("fires each rule id at most once", async () => {
    const writes: string[] = [];
    const ac = new AbortController();
    const chunk =
      "Would you like to customize the Panel Port settings? [y/n]: \n" +
      "Would you like to customize the Panel Port settings? [y/n]: \n";

    await runPromptDriver({
      write: (s) => writes.push(s),
      subscribeData: (cb) => {
        cb(encoder.encode(chunk));
        queueMicrotask(() => ac.abort());
        return () => {};
      },
      rules: createInstallShPromptRules({ panelHostname: "x.example.com", isPanelIp: false }),
      plaintext: createPtyPlaintextBuffer(),
      globalTimeoutMs: 30_000,
      signal: ac.signal,
    });

    expect(writes.filter((w) => w === "n\n").length).toBe(1);
  });

  test("completionIncludes settles completed after rules (second chunk)", async () => {
    const writes: string[] = [];
    const result = await runPromptDriver({
      write: (s) => writes.push(s),
      subscribeData: (cb) => {
        cb(encoder.encode("Would you like to customize the Panel Port settings? [y/n]: \n"));
        queueMicrotask(() => {
          cb(encoder.encode("Panel Installation Complete!\n"));
        });
        return () => {};
      },
      rules: createInstallShPromptRules({ panelHostname: "panel.example.com", isPanelIp: false }),
      plaintext: createPtyPlaintextBuffer(),
      globalTimeoutMs: 30_000,
      signal: new AbortController().signal,
      completionIncludes: "Panel Installation Complete",
    });

    expect(writes).toEqual(["n\n"]);
    expect(result.status).toBe("completed");
  });

  test("global idle timeout returns lastRuleId after a write", async () => {
    const writes: string[] = [];
    const result = await runPromptDriver({
      write: (s) => writes.push(s),
      subscribeData: (cb) => {
        cb(encoder.encode("Choose an option (default 2 for IP): "));
        return () => {};
      },
      rules: createInstallShPromptRules({ panelHostname: "1.2.3.4", isPanelIp: true }),
      plaintext: createPtyPlaintextBuffer(),
      globalTimeoutMs: 25,
      signal: new AbortController().signal,
    });

    expect(writes).toEqual(["2\n"]);
    expect(result.status).toBe("timeout");
    expect(result.lastRuleId).toBe("ssl-menu-ip-vs-domain");
  });
});
