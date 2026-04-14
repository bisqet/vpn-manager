import type { Database } from "bun:sqlite";
import { assertValidCidr } from "../rules/cidr";
import { assertValidDomainRule, normalizeDomainSuffix } from "../rules/domain";
import type { ExportV2 } from "../export/buildExport";
import type { NormalizedImport } from "./parseImportDocument";

export type ImportPlanHop = {
  hopIndex: number;
  host: string;
  sshPort: number;
  sshUser: string;
  mode: "link" | "create";
  existingProfileId?: number;
  passwordKey?: string;
  panelHostnameKey?: string;
};

export type ImportPlanChain = {
  sourceIndex: number;
  exportName?: string;
  hopCount: number;
  ruleCount: number;
  hops: ImportPlanHop[];
};

export type ImportPlanStandaloneVpn = {
  vpnIndex: number;
  label: string;
  host: string;
  mode: "link" | "create";
  existingProfileId?: number;
  passwordKey?: string;
  panelHostnameKey?: string;
};

export type ImportPlan = {
  chains: ImportPlanChain[];
  standaloneVpns: ImportPlanStandaloneVpn[];
};

function findProfileIdByHostPortUser(
  db: Database,
  host: string,
  sshPort: number,
  sshUser: string,
): number | null {
  const row = db
    .query<{ id: number }, [string, number, string]>(
      "SELECT id FROM vpn_profiles WHERE host = ? AND ssh_port = ? AND ssh_user = ?",
    )
    .get(host.trim(), sshPort, sshUser);
  return row ? row.id : null;
}

function validateExportV2(exportV2: ExportV2, sourceIndex: number): string[] {
  const errors: string[] = [];
  const prefix = `chains[${sourceIndex}]`;

  if (exportV2.chain.length !== exportV2.routingByHop.length) {
    errors.push(
      `${prefix}: chain.length (${exportV2.chain.length}) must equal routingByHop.length (${exportV2.routingByHop.length})`,
    );
    return errors;
  }

  const n = exportV2.chain.length;

  for (let i = 0; i < exportV2.routingByHop.length; i++) {
    const hop = exportV2.routingByHop[i]!;
    if (hop.hopIndex !== i) {
      errors.push(`${prefix}: routingByHop[${i}].hopIndex must be ${i}, got ${hop.hopIndex}`);
    }
  }

  if (n > 0) {
    const lastHop = exportV2.routingByHop[n - 1]!;
    if (lastHop.defaultAction === "use_chain") {
      errors.push(`${prefix}: terminal hop defaultAction must not be use_chain`);
    }
  }

  for (let i = 0; i < exportV2.routingByHop.length; i++) {
    const hop = exportV2.routingByHop[i]!;
    for (let j = 0; j < hop.rules.length; j++) {
      const rule = hop.rules[j]!;
      try {
        if (rule.matchKind === "domain") {
          const normalized = normalizeDomainSuffix(rule.matchValue);
          assertValidDomainRule(normalized);
        } else {
          assertValidCidr(rule.matchValue);
        }
      } catch (e) {
        errors.push(
          `${prefix}: routingByHop[${i}].rules[${j}]: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }

  return errors;
}

export function buildImportPlan(
  db: Database,
  normalized: NormalizedImport,
): {
  canApply: boolean;
  plan: ImportPlan | null;
  warnings: string[];
  errors: string[];
  passwordKeys: string[];
  panelHostnameKeys: string[];
} {
  const errors: string[] = [];
  const warnings: string[] = [];
  const passwordKeysSet = new Set<string>();
  const panelHostnameKeysSet = new Set<string>();

  for (let sourceIndex = 0; sourceIndex < normalized.chains.length; sourceIndex++) {
    const exportV2 = normalized.chains[sourceIndex]!;
    errors.push(...validateExportV2(exportV2, sourceIndex));
  }

  const existingChainNames = new Set(
    db
      .query<{ name: string }, []>("SELECT name FROM chains")
      .all()
      .map((r) => r.name),
  );

  for (let sourceIndex = 0; sourceIndex < normalized.chains.length; sourceIndex++) {
    const exportV2 = normalized.chains[sourceIndex]!;
    const proposedName = exportV2.name ?? `imported-chain-${exportV2.chainId}`;
    if (existingChainNames.has(proposedName)) {
      warnings.push(
        `Chain name "${proposedName}" already exists; a suffix will be applied at import time.`,
      );
    }
  }

  if (errors.length > 0) {
    return { canApply: false, plan: null, warnings, errors, passwordKeys: [], panelHostnameKeys: [] };
  }

  const chains: ImportPlanChain[] = [];

  for (let sourceIndex = 0; sourceIndex < normalized.chains.length; sourceIndex++) {
    const exportV2 = normalized.chains[sourceIndex]!;
    const ruleCount = exportV2.routingByHop.reduce((sum, h) => sum + h.rules.length, 0);
    const hops: ImportPlanHop[] = [];

    for (let hopIndex = 0; hopIndex < exportV2.chain.length; hopIndex++) {
      const chainHop = exportV2.chain[hopIndex]!;
      const existingProfileId = findProfileIdByHostPortUser(
        db,
        chainHop.host,
        chainHop.sshPort,
        chainHop.sshUser,
      );

      if (existingProfileId !== null) {
        hops.push({
          hopIndex,
          host: chainHop.host,
          sshPort: chainHop.sshPort,
          sshUser: chainHop.sshUser,
          mode: "link",
          existingProfileId,
        });
      } else {
        const key = `newProfile:${sourceIndex}:${hopIndex}`;
        passwordKeysSet.add(key);
        panelHostnameKeysSet.add(key);
        hops.push({
          hopIndex,
          host: chainHop.host,
          sshPort: chainHop.sshPort,
          sshUser: chainHop.sshUser,
          mode: "create",
          passwordKey: key,
          panelHostnameKey: key,
        });
      }
    }

    chains.push({
      sourceIndex,
      ...(exportV2.name !== undefined ? { exportName: exportV2.name } : {}),
      hopCount: exportV2.chain.length,
      ruleCount,
      hops,
    });
  }

  const standaloneVpns: ImportPlanStandaloneVpn[] = [];

  for (let vpnIndex = 0; vpnIndex < normalized.vpns.length; vpnIndex++) {
    const vpn = normalized.vpns[vpnIndex]!;
    const existingProfileId = findProfileIdByHostPortUser(db, vpn.host, vpn.sshPort, vpn.sshUser);

    if (existingProfileId !== null) {
      standaloneVpns.push({
        vpnIndex,
        label: vpn.label,
        host: vpn.host,
        mode: "link",
        existingProfileId,
      });
    } else {
      const key = `vpn:${vpnIndex}`;
      const entry: ImportPlanStandaloneVpn = {
        vpnIndex,
        label: vpn.label,
        host: vpn.host,
        mode: "create",
      };

      if (!vpn.sshPassword) {
        entry.passwordKey = key;
        passwordKeysSet.add(key);
      }

      if (!vpn.panelHostname || vpn.panelHostname.trim() === "") {
        entry.panelHostnameKey = key;
        panelHostnameKeysSet.add(key);
      }

      standaloneVpns.push(entry);
    }
  }

  return {
    canApply: true,
    plan: { chains, standaloneVpns },
    warnings,
    errors: [],
    passwordKeys: [...passwordKeysSet].sort(),
    panelHostnameKeys: [...panelHostnameKeysSet].sort(),
  };
}
