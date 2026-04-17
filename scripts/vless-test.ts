#!/usr/bin/env bun
/**
 * Prints the public IPv4/IPv6 seen when egressing through a VLESS share link.
 *
 * Requires Xray-core and `curl` on PATH, **or** `VPN_MANAGER_XRAY` / `XRAY_PATH`,
 * **or** run `bun run download-xray` once to install into `tools/xray/`.
 *
 * Usage: bun run vless-test -- "vless://uuid@host:port?..."
 */
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type ParsedVlessReality = {
  uuid: string;
  address: string;
  port: number;
  flow: string;
  fingerprint: string;
  sni: string;
  publicKey: string;
  shortId: string;
  spiderX: string;
};

function pickVlessUriFromArgv(argv: string[]): string | null {
  for (const a of argv) {
    if (a.startsWith("vless://")) return a;
  }
  return null;
}

/** Split `uuid@host:port` / `uuid@[ipv6]:port` after the scheme and before `?` / `#`. */
export function parseVlessUri(raw: string): ParsedVlessReality {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("vless://")) {
    throw new Error("Expected a URI starting with vless://");
  }

  const withoutScheme = trimmed.slice("vless://".length);
  const hashIdx = withoutScheme.indexOf("#");
  const noHash = hashIdx >= 0 ? withoutScheme.slice(0, hashIdx) : withoutScheme;
  const qIdx = noHash.indexOf("?");
  const authorityAndParams = qIdx >= 0 ? noHash.slice(0, qIdx) : noHash;
  const queryString = qIdx >= 0 ? noHash.slice(qIdx + 1) : "";
  const params = new URLSearchParams(queryString);

  const atIdx = authorityAndParams.lastIndexOf("@");
  if (atIdx < 0) {
    throw new Error("Invalid vless URI: expected uuid@host:port");
  }

  const userinfo = decodeURIComponent(authorityAndParams.slice(0, atIdx));
  const hostport = authorityAndParams.slice(atIdx + 1);

  let address: string;
  let port: number;
  if (hostport.startsWith("[")) {
    const endBracket = hostport.indexOf("]");
    if (endBracket < 0) {
      throw new Error("Invalid vless URI: unclosed IPv6 address");
    }
    address = hostport.slice(1, endBracket);
    const rest = hostport.slice(endBracket + 1);
    if (rest.startsWith(":")) {
      port = Number(rest.slice(1));
    } else {
      port = 443;
    }
  } else {
    const colonIdx = hostport.lastIndexOf(":");
    if (colonIdx < 0) {
      address = hostport;
      port = 443;
    } else {
      address = hostport.slice(0, colonIdx);
      port = Number(hostport.slice(colonIdx + 1));
    }
  }

  if (userinfo === "" || address === "") {
    throw new Error("Invalid vless URI: empty uuid or host");
  }
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error("Invalid vless URI: bad port");
  }

  const security = (params.get("security") ?? "").toLowerCase();
  if (security !== "reality") {
    throw new Error(`Unsupported security=${security || "(missing)"}; only security=reality is supported`);
  }

  const type = (params.get("type") ?? "tcp").toLowerCase();
  if (type !== "tcp") {
    throw new Error(`Unsupported type=${type}; only type=tcp is supported`);
  }

  const pbk = params.get("pbk") ?? "";
  const sni = params.get("sni") ?? "";
  const sid = params.get("sid") ?? "";
  if (!pbk || !sni || !sid) {
    throw new Error("VLESS REALITY URI must include pbk, sni, and sid query parameters");
  }

  const flow = params.get("flow") ?? "";
  const fp = params.get("fp") ?? "chrome";
  const spx = params.get("spx") ?? "/";

  return {
    uuid: userinfo,
    address,
    port,
    flow,
    fingerprint: fp,
    sni,
    publicKey: pbk,
    shortId: sid,
    spiderX: spx === "" ? "/" : spx,
  };
}

function envPathTrim(name: string): string {
  const v = process.env[name];
  return typeof v === "string" ? v.trim() : "";
}

/** Resolve path to Xray-core binary for this script. */
export function findXrayExecutable(): string | null {
  const explicit = envPathTrim("VPN_MANAGER_XRAY") || envPathTrim("XRAY_PATH");
  if (explicit !== "" && existsSync(explicit)) {
    return explicit;
  }

  const onPath = Bun.which("xray") ?? Bun.which("xray.exe");
  if (onPath) return onPath;

  const repoRoot = join(import.meta.dir, "..");
  const localCandidates =
    process.platform === "win32"
      ? [join(repoRoot, "tools", "xray", "xray.exe"), join(repoRoot, "tools", "xray.exe")]
      : [join(repoRoot, "tools", "xray", "xray"), join(repoRoot, "tools", "xray")];
  for (const p of localCandidates) {
    if (existsSync(p)) return p;
  }

  return null;
}

function printXrayNotFoundHelp() {
  console.error("Xray-core was not found (no `xray` / `xray.exe` on PATH, no env path, no repo copy).");
  console.error("");
  console.error("Quick fix on Windows — point at xray.exe (PowerShell):");
  console.error('  $env:VPN_MANAGER_XRAY = "C:\\full\\path\\to\\xray.exe"');
  console.error('  bun run vless-test -- "vless://..."');
  console.error("");
  console.error("Or drop the binary here (gitignored): tools\\xray\\xray.exe");
  console.error("");
  console.error("Download: https://github.com/XTLS/Xray-core/releases (e.g. Xray-windows-64.zip → xray.exe).");
}

function findCurl(): string | null {
  return Bun.which("curl") ?? Bun.which("curl.exe");
}

async function reserveLocalPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.unref();
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      const port = typeof a === "object" && a !== null ? a.port : 0;
      s.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
    s.on("error", reject);
  });
}

function buildXrayConfig(input: { socksPort: number; v: ParsedVlessReality }): Record<string, unknown> {
  const user: Record<string, unknown> = {
    id: input.v.uuid,
    encryption: "none",
  };
  if (input.v.flow !== "") {
    user.flow = input.v.flow;
  }

  return {
    log: { loglevel: "error" },
    inbounds: [
      {
        tag: "socks-in",
        listen: "127.0.0.1",
        port: input.socksPort,
        protocol: "socks",
        settings: { udp: true, auth: "noauth" },
      },
    ],
    outbounds: [
      {
        tag: "proxy",
        protocol: "vless",
        settings: {
          vnext: [
            {
              address: input.v.address,
              port: input.v.port,
              users: [user],
            },
          ],
        },
        streamSettings: {
          network: "tcp",
          security: "reality",
          tcpSettings: {
            header: { type: "none" },
          },
          realitySettings: {
            serverName: input.v.sni,
            fingerprint: input.v.fingerprint,
            publicKey: input.v.publicKey,
            shortId: input.v.shortId,
            spiderX: input.v.spiderX,
          },
        },
      },
      { tag: "direct", protocol: "freedom", settings: {} },
    ],
    routing: {
      domainStrategy: "AsIs",
      rules: [{ type: "field", inboundTag: ["socks-in"], outboundTag: "proxy" }],
    },
  };
}

async function curlThroughSocks(curlPath: string, socksPort: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    const child = spawn(
      curlPath,
      [
        "-sS",
        "--max-time",
        "25",
        "--socks5-hostname",
        `127.0.0.1:${socksPort}`,
        "https://api.ipify.org",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    child.stdout?.on("data", (d: Buffer) => chunks.push(d));
    child.stderr?.on("data", (d: Buffer) => errChunks.push(d));
    child.on("error", reject);
    child.on("close", (code) => {
      const out = Buffer.concat(chunks).toString("utf8").trim();
      const errText = Buffer.concat(errChunks).toString("utf8").trim();
      if (code === 0 && out !== "") {
        resolve(out);
        return;
      }
      reject(new Error(errText || `curl exited with code ${code}`));
    });
  });
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const uri = pickVlessUriFromArgv(process.argv);
  if (!uri) {
    console.error('Usage: bun run vless-test -- "vless://uuid@host:port?..."');
    console.error("Requires: Xray-core + curl (see script header for VPN_MANAGER_XRAY / tools/xray).");
    process.exit(2);
  }

  const xrayPath = findXrayExecutable();
  if (!xrayPath) {
    printXrayNotFoundHelp();
    process.exit(1);
  }

  const curlPath = findCurl();
  if (!curlPath) {
    console.error("curl was not found on PATH.");
    process.exit(1);
  }

  let parsed: ParsedVlessReality;
  try {
    parsed = parseVlessUri(uri);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }

  const socksPort = await reserveLocalPort();
  const configDir = await mkdtemp(join(tmpdir(), "vpnmgr-vless-test-"));
  const configPath = join(configDir, "config.json");
  const config = buildXrayConfig({ socksPort, v: parsed });
  await writeFile(configPath, JSON.stringify(config, null, 2), "utf8");

  const child = spawn(xrayPath, ["run", "-c", configPath], {
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });

  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (d: string) => {
    stderr += d;
  });

  const cleanup = async () => {
    child.kill("SIGTERM");
    await rm(configDir, { recursive: true, force: true }).catch(() => {});
  };

  process.on("SIGINT", () => {
    void cleanup().finally(() => process.exit(130));
  });

  try {
    let lastErr: unknown = null;
    for (let i = 0; i < 40; i++) {
      if (child.exitCode !== null) {
        throw new Error(`xray exited early (code ${child.exitCode}). ${stderr.slice(-2000)}`);
      }
      try {
        const ip = await curlThroughSocks(curlPath, socksPort);
        if (/^[\d.:a-fA-F]+$/.test(ip)) {
          console.log(ip);
          return;
        }
        lastErr = new Error(`unexpected response: ${ip}`);
      } catch (e) {
        lastErr = e;
      }
      await sleep(150);
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  } finally {
    await cleanup();
  }
}

if (import.meta.main) {
  await main();
}
