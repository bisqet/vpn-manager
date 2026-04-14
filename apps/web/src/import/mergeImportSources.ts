/**
 * Client-side merge of multiple parsed JSON roots into one synthetic v3 bundle.
 * Rules align with `docs/superpowers/specs/2026-04-14-import-screen-design.md` §2.1
 * and bare / v2 detection order in `apps/server/src/import/parseImportDocument.ts`.
 */
import { isFqdnPanel, isPublicIpLiteral } from "../lib/panelAddress";

export const MAX_MERGE_ROOTS = 50;
export const MAX_MERGED_IMPORT_BYTES = 10 * 1024 * 1024;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

const EXPORT_V2_ROOT_KEYS = new Set(["schemaVersion", "exportedAt", "chainId", "name", "chain", "routingByHop"]);
const EXPORT_V2_HOP_KEYS = new Set(["chainHopId", "profileId", "host", "sshPort", "sshUser"]);
const EXPORT_V2_ROUTING_KEYS = new Set([
  "hopIndex",
  "chainHopId",
  "routingProfileId",
  "defaultAction",
  "rules",
]);
const EXPORT_V2_RULE_KEYS = new Set(["matchKind", "matchValue", "action"]);

const BARE_VPN_ROOT_KEYS = new Set([
  "label",
  "host",
  "sshPort",
  "sshUser",
  "sshPassword",
  "panelHostname",
  "schemaVersion",
  "chain",
]);

const V3_ROOT_KEYS = new Set(["schemaVersion", "chains", "vpns"]);

function isInt(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

const DEFAULT_ACTIONS = new Set(["use_chain", "direct", "block"]);
const RULE_ACTIONS = DEFAULT_ACTIONS;
const MATCH_KINDS = new Set(["domain", "cidr"]);

function validateExportV2Rule(r: unknown, path: string): string[] {
  if (!isPlainObject(r)) return [`${path}: expected object`];
  const extra = Object.keys(r).filter((k) => !EXPORT_V2_RULE_KEYS.has(k));
  if (extra.length) return [`${path}: unrecognized key(s): ${extra.join(", ")}`];
  const errs: string[] = [];
  if (!MATCH_KINDS.has(r.matchKind as string)) {
    errs.push(`${path}.matchKind: Invalid enum value. Expected 'domain' | 'cidr', received '${String(r.matchKind)}'`);
  }
  if (typeof r.matchValue !== "string") {
    errs.push(`${path}.matchValue: Expected string, received ${typeof r.matchValue}`);
  }
  if (!RULE_ACTIONS.has(r.action as string)) {
    errs.push(`${path}.action: Invalid enum value. Expected 'direct' | 'use_chain' | 'block', received '${String(r.action)}'`);
  }
  return errs;
}

function validateExportV2Routing(h: unknown, path: string): string[] {
  if (!isPlainObject(h)) return [`${path}: expected object`];
  const extra = Object.keys(h).filter((k) => !EXPORT_V2_ROUTING_KEYS.has(k));
  if (extra.length) return [`${path}: unrecognized key(s): ${extra.join(", ")}`];
  const errs: string[] = [];
  if (!isInt(h.hopIndex)) errs.push(`${path}.hopIndex: Expected integer, received ${typeof h.hopIndex}`);
  if (!isInt(h.chainHopId)) errs.push(`${path}.chainHopId: Expected integer, received ${typeof h.chainHopId}`);
  if (!isInt(h.routingProfileId)) {
    errs.push(`${path}.routingProfileId: Expected integer, received ${typeof h.routingProfileId}`);
  }
  if (!DEFAULT_ACTIONS.has(h.defaultAction as string)) {
    errs.push(
      `${path}.defaultAction: Invalid enum value. Expected 'use_chain' | 'direct' | 'block', received '${String(h.defaultAction)}'`,
    );
  }
  if (!Array.isArray(h.rules)) {
    errs.push(`${path}.rules: Expected array, received ${typeof h.rules}`);
  } else {
    h.rules.forEach((rule, i) => {
      errs.push(...validateExportV2Rule(rule, `${path}.rules.${i}`));
    });
  }
  return errs;
}

function validateExportV2Hop(ch: unknown, path: string): string[] {
  if (!isPlainObject(ch)) return [`${path}: expected object`];
  const extra = Object.keys(ch).filter((k) => !EXPORT_V2_HOP_KEYS.has(k));
  if (extra.length) return [`${path}: unrecognized key(s): ${extra.join(", ")}`];
  const errs: string[] = [];
  if (!isInt(ch.chainHopId)) errs.push(`${path}.chainHopId: Expected integer, received ${typeof ch.chainHopId}`);
  if (!isInt(ch.profileId)) errs.push(`${path}.profileId: Expected integer, received ${typeof ch.profileId}`);
  if (typeof ch.host !== "string") errs.push(`${path}.host: Expected string, received ${typeof ch.host}`);
  if (!isInt(ch.sshPort) || ch.sshPort < 1 || ch.sshPort > 65535) {
    errs.push(`${path}.sshPort: Number must be between 1 and 65535`);
  }
  if (typeof ch.sshUser !== "string") errs.push(`${path}.sshUser: Expected string, received ${typeof ch.sshUser}`);
  return errs;
}

/** Structural validation equivalent to server `exportV2Schema` (strict). */
function validateExportV2Shape(root: Record<string, unknown>): string[] {
  const errs: string[] = [];
  const rootExtra = Object.keys(root).filter((k) => !EXPORT_V2_ROOT_KEYS.has(k));
  if (rootExtra.length) {
    return [`Unrecognized key(s) in object: ${rootExtra.join(", ")}`];
  }
  if (root.schemaVersion !== 2) {
    errs.push(`schemaVersion: Invalid literal value, expected 2`);
  }
  if (!isNonEmptyString(root.exportedAt)) {
    errs.push(`exportedAt: exportedAt is required`);
  }
  if (!isInt(root.chainId)) errs.push(`chainId: Expected integer, received ${typeof root.chainId}`);
  if (root.name !== undefined && typeof root.name !== "string") {
    errs.push(`name: Expected string, received ${typeof root.name}`);
  }
  if (!Array.isArray(root.chain)) {
    errs.push(`chain: Expected array, received ${typeof root.chain}`);
  } else {
    root.chain.forEach((hop, i) => {
      errs.push(...validateExportV2Hop(hop, `chain.${i}`));
    });
  }
  if (!Array.isArray(root.routingByHop)) {
    errs.push(`routingByHop: Expected array, received ${typeof root.routingByHop}`);
  } else {
    root.routingByHop.forEach((rh, i) => {
      errs.push(...validateExportV2Routing(rh, `routingByHop.${i}`));
    });
  }
  return errs;
}

type BareShapeResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; errors: string[] };

function parseBareVpnShape(root: Record<string, unknown>): BareShapeResult {
  const extra = Object.keys(root).filter((k) => !BARE_VPN_ROOT_KEYS.has(k));
  if (extra.length) {
    return { ok: false, errors: [`Unrecognized key(s) in object: ${extra.join(", ")}`] };
  }
  const errs: string[] = [];
  if (root.label !== undefined) {
    if (typeof root.label !== "string" || root.label.length < 1) {
      errs.push(`label: String must contain at least 1 character(s)`);
    }
  }
  if (!isNonEmptyString(root.host)) {
    errs.push(`host: String must contain at least 1 character(s)`);
  }
  if (!isInt(root.sshPort) || root.sshPort < 1 || root.sshPort > 65535) {
    errs.push(`sshPort: Number must be between 1 and 65535`);
  }
  if (!isNonEmptyString(root.sshUser)) {
    errs.push(`sshUser: String must contain at least 1 character(s)`);
  }
  if (root.sshPassword !== undefined) {
    if (typeof root.sshPassword !== "string" || root.sshPassword.length < 1) {
      errs.push(`sshPassword: String must contain at least 1 character(s)`);
    }
  }
  if (!isNonEmptyString(root.panelHostname)) {
    errs.push(`panelHostname: String must contain at least 1 character(s)`);
  }
  if (root.schemaVersion !== undefined && typeof root.schemaVersion !== "number") {
    errs.push(`schemaVersion: Expected number, received ${typeof root.schemaVersion}`);
  }
  if (root.chain !== undefined && !Array.isArray(root.chain)) {
    errs.push(`chain: Expected array, received ${typeof root.chain}`);
  }
  if (errs.length) return { ok: false, errors: errs };
  return { ok: true, data: root };
}

function classifyNonV3Root(root: Record<string, unknown>): { ok: true; vpn: unknown } | { ok: false; errors: string[] } {
  if ("routingByHop" in root) {
    return { ok: false, errors: ["Bare VPN import must not include routingByHop"] };
  }

  if (Array.isArray(root.chain) && root.chain.length > 0 && root.schemaVersion !== 2) {
    return {
      ok: false,
      errors: ["Import document is ambiguous: non-empty chain requires schemaVersion 2 export shape"],
    };
  }

  if (typeof root.schemaVersion === "number" && root.schemaVersion !== 2 && root.schemaVersion !== 3) {
    return { ok: false, errors: ["unknown schemaVersion"] };
  }

  const bare = parseBareVpnShape(root);
  if (bare.ok) {
    const d = bare.data;
    const panel = String(d.panelHostname).trim();
    if (!isFqdnPanel(panel) && !isPublicIpLiteral(panel)) {
      return { ok: false, errors: ["panelHostname must be a valid FQDN or a public IP address."] };
    }
    const host = String(d.host).trim();
    const sshUser = String(d.sshUser).trim();
    const labelRaw = d.label;
    const label =
      typeof labelRaw === "string" && labelRaw.trim().length > 0 ? labelRaw.trim() : host;
    const vpn: Record<string, unknown> = {
      label,
      host,
      sshPort: d.sshPort,
      sshUser,
      panelHostname: panel,
    };
    if (d.sshPassword !== undefined) {
      vpn.sshPassword = d.sshPassword;
    }
    return { ok: true, vpn };
  }

  if (
    root.host !== undefined ||
    root.sshUser !== undefined ||
    root.sshPort !== undefined ||
    root.panelHostname !== undefined
  ) {
    return { ok: false, errors: bare.errors };
  }

  return { ok: false, errors: ["Unrecognized import document"] };
}

function assertNoDuplicateChainFingerprints(chains: unknown[]): string | null {
  const seen = new Map<string, number>();
  for (const c of chains) {
    if (!isPlainObject(c)) continue;
    const chainId = c.chainId;
    const exportedAt = c.exportedAt;
    if (!isInt(chainId)) continue;
    if (typeof exportedAt !== "string" || exportedAt.length === 0) continue;
    const key = `${chainId}\0${exportedAt}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  for (const [, count] of seen) {
    if (count > 1) {
      return "Duplicate chain export (same chainId and exportedAt).";
    }
  }
  return null;
}

function validateV3RootShape(root: Record<string, unknown>): string[] {
  const extra = Object.keys(root).filter((k) => !V3_ROOT_KEYS.has(k));
  if (extra.length) {
    return [`Unrecognized key(s) in object: ${extra.join(", ")}`];
  }
  const errs: string[] = [];
  if (root.chains !== undefined && !Array.isArray(root.chains)) {
    errs.push(`chains: Expected array, received ${typeof root.chains}`);
  }
  if (root.vpns !== undefined && !Array.isArray(root.vpns)) {
    errs.push(`vpns: Expected array, received ${typeof root.vpns}`);
  }
  return errs;
}

export function mergeParsedRootsToImportJson(
  roots: unknown[],
):
  | { ok: true; json: { schemaVersion: 3; chains: unknown[]; vpns: unknown[] } }
  | { ok: false; errors: string[] } {
  if (roots.length > MAX_MERGE_ROOTS) {
    return {
      ok: false,
      errors: [`At most ${MAX_MERGE_ROOTS} import sources are allowed (${roots.length} provided).`],
    };
  }

  const chains: unknown[] = [];
  const vpns: unknown[] = [];

  for (let i = 0; i < roots.length; i++) {
    const root = roots[i];
    if (!isPlainObject(root)) {
      return { ok: false, errors: [`Root ${i}: Unrecognized import document (top-level value must be a JSON object).`] };
    }

    if (root.schemaVersion === 3) {
      const shapeErrs = validateV3RootShape(root);
      if (shapeErrs.length) {
        return { ok: false, errors: shapeErrs.map((e) => `Root ${i}: ${e}`) };
      }
      const c = root.chains !== undefined ? root.chains : [];
      const v = root.vpns !== undefined ? root.vpns : [];
      chains.push(...(c as unknown[]));
      vpns.push(...(v as unknown[]));
      continue;
    }

    if (root.schemaVersion === 2) {
      const v2errs = validateExportV2Shape(root);
      if (v2errs.length) {
        return { ok: false, errors: v2errs.map((e) => `Root ${i}: ${e}`) };
      }
      chains.push(root);
      continue;
    }

    const classified = classifyNonV3Root(root);
    if (!classified.ok) {
      return { ok: false, errors: classified.errors.map((e) => `Root ${i}: ${e}`) };
    }
    vpns.push(classified.vpn);
  }

  if (chains.length === 0 && vpns.length === 0) {
    return {
      ok: false,
      errors: ["Import bundle has no chains and no VPN profiles (both arrays empty)."],
    };
  }

  const dup = assertNoDuplicateChainFingerprints(chains);
  if (dup) {
    return { ok: false, errors: [dup] };
  }

  const json = { schemaVersion: 3 as const, chains, vpns };
  const serialized = JSON.stringify(json);
  const byteLen = new TextEncoder().encode(serialized).length;
  if (byteLen > MAX_MERGED_IMPORT_BYTES) {
    return {
      ok: false,
      errors: [
        `Import document exceeds maximum size of ${MAX_MERGED_IMPORT_BYTES} bytes (${byteLen} bytes).`,
      ],
    };
  }

  return { ok: true, json };
}
