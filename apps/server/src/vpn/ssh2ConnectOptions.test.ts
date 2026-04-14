import { describe, expect, test } from "bun:test";
import { buildSsh2ConnectOptions } from "./ssh2ConnectOptions";

describe("buildSsh2ConnectOptions", () => {
  test("when knownHostsFile is set, hostVerifier is defined", () => {
    const o = buildSsh2ConnectOptions({
      host: "h.example",
      port: 22,
      username: "root",
      password: "pw",
      knownHostsFile: "/tmp/nonexistent-for-this-test",
      readyTimeoutMs: 5000,
    });
    expect(typeof o.hostVerifier).toBe("function");
  });

  test("when knownHostsFile is unset, hostVerifier still defined (accept path)", () => {
    const o = buildSsh2ConnectOptions({
      host: "h.example",
      port: 22,
      username: "root",
      password: "pw",
      knownHostsFile: undefined,
      readyTimeoutMs: 5000,
    });
    expect(typeof o.hostVerifier).toBe("function");
    expect(o.host).toBe("h.example");
    expect(o.port).toBe(22);
    expect(o.username).toBe("root");
    expect(o.password).toBe("pw");
  });
});
