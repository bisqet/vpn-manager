#!/usr/bin/env bun
/**
 * Downloads the latest Xray-core release for this OS/arch into tools/xray/
 * (same layout used by `bun run vless-test`).
 *
 * Not run on install — invoke explicitly: `bun run download-xray`
 */
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { unzipSync } from "fflate";

type ReleaseJson = {
  tag_name: string;
  assets: { name: string; browser_download_url: string }[];
};

const GITHUB_API = "https://api.github.com/repos/XTLS/Xray-core/releases/latest";

function userAgent() {
  return "vpn-manager-download-xray (https://github.com/XTLS/Xray-core)";
}

function zipAssetNameForHost(): string {
  const { platform, arch } = process;

  if (platform === "win32") {
    if (arch === "x64" || arch === "amd64") return "Xray-windows-64.zip";
    if (arch === "ia32" || arch === "x32") return "Xray-windows-32.zip";
    if (arch === "arm64") return "Xray-windows-arm64-v8a.zip";
  }

  if (platform === "linux") {
    if (arch === "x64" || arch === "amd64") return "Xray-linux-64.zip";
    if (arch === "arm64") return "Xray-linux-arm64-v8a.zip";
    if (arch === "arm") return "Xray-linux-arm32-v7a.zip";
  }

  if (platform === "darwin") {
    if (arch === "arm64") return "Xray-macos-arm64-v8a.zip";
    if (arch === "x64") return "Xray-macos-64.zip";
  }

  throw new Error(
    `No predefined Xray zip for platform=${platform} arch=${arch}. ` +
      `Pick an asset from ${GITHUB_API} and download it manually into tools/xray/.`,
  );
}

function binaryBasename(): "xray.exe" | "xray" {
  return process.platform === "win32" ? "xray.exe" : "xray";
}

async function main() {
  const zipName = zipAssetNameForHost();
  const wantBin = binaryBasename();

  const apiRes = await fetch(GITHUB_API, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": userAgent(),
    },
  });
  if (!apiRes.ok) {
    throw new Error(`GitHub API HTTP ${apiRes.status} — try again later or set a GitHub token for higher rate limits.`);
  }

  const release = (await apiRes.json()) as ReleaseJson;
  const asset = release.assets.find((a) => a.name === zipName);
  if (!asset) {
    console.error(`Latest release (${release.tag_name}) has no asset named "${zipName}". Zip assets:`);
    for (const a of release.assets) {
      if (a.name.endsWith(".zip") && !a.name.includes(".dgst")) {
        console.error(`  ${a.name}`);
      }
    }
    process.exit(1);
  }

  const zipRes = await fetch(asset.browser_download_url, {
    headers: { "User-Agent": userAgent() },
  });
  if (!zipRes.ok) {
    throw new Error(`Download failed: HTTP ${zipRes.status}`);
  }

  const zipBytes = new Uint8Array(await zipRes.arrayBuffer());
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(zipBytes);
  } catch (e) {
    throw new Error(`Failed to unzip ${zipName}: ${e instanceof Error ? e.message : String(e)}`);
  }

  let payload: Uint8Array | null = null;
  for (const [path, data] of Object.entries(files)) {
    const base = path.split("/").pop() ?? path;
    if (base === wantBin) {
      payload = data;
      break;
    }
  }

  if (!payload) {
    const keys = Object.keys(files).join(", ");
    throw new Error(`Archive did not contain ${wantBin}. Entries: ${keys}`);
  }

  const repoRoot = join(import.meta.dir, "..");
  const outDir = join(repoRoot, "tools", "xray");
  await mkdir(outDir, { recursive: true });
  const outPath = join(outDir, wantBin);
  await writeFile(outPath, payload);
  if (process.platform !== "win32") {
    await chmod(outPath, 0o755);
  }

  console.log(`Xray-core ${release.tag_name}`);
  console.log(outPath);
}

if (import.meta.main) {
  try {
    await main();
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
