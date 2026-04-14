import { z } from "zod";
import type { ExportV2 } from "../export/buildExport";
import { isFqdnPanel, isPublicIpLiteral } from "../net/panelAddress";

export const MAX_IMPORT_BYTES = 10 * 1024 * 1024;

const exportV2RuleSchema = z
  .object({
    matchKind: z.enum(["domain", "cidr"]),
    matchValue: z.string(),
    action: z.enum(["direct", "use_chain", "block"]),
  })
  .strict();

const exportV2RoutingHopSchema = z
  .object({
    hopIndex: z.number().int(),
    chainHopId: z.number().int(),
    routingProfileId: z.number().int(),
    defaultAction: z.enum(["use_chain", "direct", "block"]),
    rules: z.array(exportV2RuleSchema),
  })
  .strict();

const exportV2ChainHopSchema = z
  .object({
    chainHopId: z.number().int(),
    profileId: z.number().int(),
    host: z.string(),
    sshPort: z.number().int(),
    sshUser: z.string(),
  })
  .strict();

export const exportV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    exportedAt: z.string().min(1, "exportedAt is required"),
    chainId: z.number().int(),
    name: z.string().optional(),
    chain: z.array(exportV2ChainHopSchema),
    routingByHop: z.array(exportV2RoutingHopSchema),
  })
  .strict();

const importVpnSchema = z
  .object({
    label: z.string().min(1),
    host: z.string().min(1),
    sshPort: z.number().int().min(1).max(65535),
    sshUser: z.string().min(1),
    sshPassword: z.string().min(1).optional(),
    panelHostname: z.string().optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.panelHostname === undefined) return;
    const p = data.panelHostname.trim();
    if (p === "") return;
    if (!isFqdnPanel(p) && !isPublicIpLiteral(p)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "panelHostname must be a valid FQDN or a public IP address.",
        path: ["panelHostname"],
      });
    }
  });

export type ImportVpnInput = z.infer<typeof importVpnSchema>;

export type NormalizedImport = {
  schemaVersion: 3;
  chains: ExportV2[];
  vpns: ImportVpnInput[];
};

const v3BundleSchema = z
  .object({
    schemaVersion: z.literal(3),
    chains: z.array(exportV2Schema).optional(),
    vpns: z.array(importVpnSchema).optional(),
  })
  .strict();

function formatZodErrors(error: z.ZodError): string[] {
  return error.issues.map((i) => {
    const path = i.path.length ? `${i.path.join(".")}: ` : "";
    return `${path}${i.message}`;
  });
}

function assertNoDuplicateChainFingerprints(chains: ExportV2[]): string | null {
  const seen = new Map<string, number>();
  for (const c of chains) {
    const key = `${c.chainId}\0${c.exportedAt}`;
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
  }
  for (const [, count] of seen) {
    if (count > 1) {
      return "Duplicate chain export (same chainId and exportedAt).";
    }
  }
  return null;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

const bareVpnShapeSchema = z
  .object({
    label: z.string().min(1).optional(),
    host: z.string().min(1),
    sshPort: z.number().int().min(1).max(65535),
    sshUser: z.string().min(1),
    sshPassword: z.string().min(1).optional(),
    panelHostname: z.string().min(1, "panelHostname is required"),
    schemaVersion: z.number().optional(),
    chain: z.array(z.unknown()).optional(),
  })
  .strict();

export function parseImportDocument(
  text: string,
): { ok: true; normalized: NormalizedImport } | { ok: false; errors: string[] } {
  let t = text;
  if (t.charCodeAt(0) === 0xfeff) {
    t = t.slice(1);
  }

  const byteLen = new TextEncoder().encode(t).length;
  if (byteLen > MAX_IMPORT_BYTES) {
    return {
      ok: false,
      errors: [`Import document exceeds maximum size of ${MAX_IMPORT_BYTES} bytes (${byteLen} bytes).`],
    };
  }

  let root: unknown;
  try {
    root = JSON.parse(t);
  } catch {
    return { ok: false, errors: ["Invalid JSON"] };
  }

  if (!isPlainObject(root)) {
    return { ok: false, errors: ["Unrecognized import document"] };
  }

  if (root.schemaVersion === 3) {
    const parsed = v3BundleSchema.safeParse(root);
    if (!parsed.success) {
      return { ok: false, errors: formatZodErrors(parsed.error) };
    }
    const chains = parsed.data.chains ?? [];
    const vpns = parsed.data.vpns ?? [];
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
    return { ok: true, normalized: { schemaVersion: 3, chains, vpns } };
  }

  if (root.schemaVersion === 2) {
    const parsed = exportV2Schema.safeParse(root);
    if (parsed.success) {
      return {
        ok: true,
        normalized: { schemaVersion: 3, chains: [parsed.data], vpns: [] },
      };
    }
    return { ok: false, errors: formatZodErrors(parsed.error) };
  }

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

  const bareParsed = bareVpnShapeSchema.safeParse(root);
  if (bareParsed.success) {
    const d = bareParsed.data;
    const panel = d.panelHostname.trim();
    if (!isFqdnPanel(panel) && !isPublicIpLiteral(panel)) {
      return {
        ok: false,
        errors: ["panelHostname must be a valid FQDN or a public IP address."],
      };
    }
    const vpn: ImportVpnInput = {
      label: d.label?.trim() && d.label.trim().length > 0 ? d.label.trim() : d.host.trim(),
      host: d.host.trim(),
      sshPort: d.sshPort,
      sshUser: d.sshUser.trim(),
      ...(d.sshPassword !== undefined ? { sshPassword: d.sshPassword } : {}),
      panelHostname: panel,
    };
    return { ok: true, normalized: { schemaVersion: 3, chains: [], vpns: [vpn] } };
  }

  if (
    root.host !== undefined ||
    root.sshUser !== undefined ||
    root.sshPort !== undefined ||
    root.panelHostname !== undefined
  ) {
    return { ok: false, errors: formatZodErrors(bareParsed.error) };
  }

  return { ok: false, errors: ["Unrecognized import document"] };
}
