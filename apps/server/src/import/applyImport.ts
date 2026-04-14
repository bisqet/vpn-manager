import type { Database } from "bun:sqlite";
import { encryptVpnPassword } from "../crypto/vpnSecret";
import type { Env } from "../env";
import { normalizeDomainSuffix } from "../rules/domain";
import { buildImportPlan } from "./buildImportPlan";
import { insertChainWithHops } from "./insertChainWithHops";
import type { NormalizedImport } from "./parseImportDocument";

export type ApplyImportOptions = {
  db: Database;
  env: Pick<Env, "masterKey">;
  normalized: NormalizedImport;
  passwords: Record<string, string>;
  panelHostnames: Record<string, string>;
};

export type ApplyImportResult =
  | { ok: true; chainIds: number[]; profileIds: number[] }
  | { ok: false; error: string; status?: number };

function resolveChainName(db: Database, proposed: string): string {
  const exists = (name: string): boolean =>
    db.query<{ id: number }, [string]>("SELECT id FROM chains WHERE name = ?").get(name) !== null;

  if (!exists(proposed)) return proposed;

  let counter = 2;
  for (;;) {
    const candidate = `${proposed} (imported ${counter})`;
    if (!exists(candidate)) return candidate;
    counter++;
  }
}

export async function applyImport(options: ApplyImportOptions): Promise<ApplyImportResult> {
  const { db, env, normalized, passwords, panelHostnames } = options;

  const planResult = buildImportPlan(db, normalized);
  if (!planResult.canApply) {
    return { ok: false, error: planResult.errors.join("; "), status: 422 };
  }
  const plan = planResult.plan!;

  for (const key of planResult.passwordKeys) {
    const val = passwords[key];
    if (!val || val.trim() === "") {
      return { ok: false, error: `Missing password for key: ${key}`, status: 400 };
    }
  }
  for (const key of planResult.panelHostnameKeys) {
    const val = panelHostnames[key];
    if (!val || val.trim() === "") {
      return { ok: false, error: `Missing panelHostname for key: ${key}`, status: 400 };
    }
  }

  db.exec("BEGIN");
  try {
    const createdProfileIds: number[] = [];
    const createdChainIds: number[] = [];

    for (const standaloneVpn of plan.standaloneVpns) {
      if (standaloneVpn.mode === "link") continue;

      const vpn = normalized.vpns[standaloneVpn.vpnIndex]!;
      const password = standaloneVpn.passwordKey
        ? passwords[standaloneVpn.passwordKey]!
        : vpn.sshPassword!;
      const panelHostname = standaloneVpn.panelHostnameKey
        ? panelHostnames[standaloneVpn.panelHostnameKey]!
        : (vpn.panelHostname ?? "");

      const { ciphertext, nonce } = await encryptVpnPassword(env.masterKey, password);
      const result = db
        .query(
          `INSERT INTO vpn_profiles
            (label, host, ssh_port, ssh_user, ssh_password_ciphertext, ssh_password_nonce, panel_hostname)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          vpn.label,
          vpn.host.trim(),
          vpn.sshPort,
          vpn.sshUser,
          ciphertext,
          nonce,
          panelHostname.trim(),
        );

      createdProfileIds.push(Number(result.lastInsertRowid));
    }

    for (let sourceIndex = 0; sourceIndex < normalized.chains.length; sourceIndex++) {
      const exportV2 = normalized.chains[sourceIndex]!;
      const planChain = plan.chains[sourceIndex]!;
      const vpnProfileIds: number[] = [];

      for (let hopIndex = 0; hopIndex < exportV2.chain.length; hopIndex++) {
        const hop = planChain.hops[hopIndex]!;
        const chainHop = exportV2.chain[hopIndex]!;

        if (hop.mode === "link") {
          vpnProfileIds.push(hop.existingProfileId!);
        } else {
          const password = passwords[hop.passwordKey!]!;
          const panelHostname = panelHostnames[hop.panelHostnameKey!]!;
          const { ciphertext, nonce } = await encryptVpnPassword(env.masterKey, password);

          const result = db
            .query(
              `INSERT INTO vpn_profiles
                (label, host, ssh_port, ssh_user, ssh_password_ciphertext, ssh_password_nonce, panel_hostname)
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              chainHop.host.trim(),
              chainHop.host.trim(),
              chainHop.sshPort,
              chainHop.sshUser,
              ciphertext,
              nonce,
              panelHostname.trim(),
            );

          const newProfileId = Number(result.lastInsertRowid);
          createdProfileIds.push(newProfileId);
          vpnProfileIds.push(newProfileId);
        }
      }

      const proposedName = exportV2.name ?? `imported-chain-${exportV2.chainId}`;
      const chainName = resolveChainName(db, proposedName);

      const chainId = insertChainWithHops(db, { name: chainName, vpnProfileIds });
      createdChainIds.push(chainId);

      for (let hopIndex = 0; hopIndex < exportV2.routingByHop.length; hopIndex++) {
        const routingHop = exportV2.routingByHop[hopIndex]!;

        const hopRow = db
          .query<{ id: number }, [number, number]>(
            "SELECT id FROM chain_hops WHERE chain_id = ? AND position = ?",
          )
          .get(chainId, hopIndex);
        if (!hopRow) {
          throw new Error(`chain_hop not found for chain ${chainId} position ${hopIndex}`);
        }

        const rpRow = db
          .query<{ id: number }, [number]>(
            "SELECT id FROM routing_profiles WHERE chain_hop_id = ?",
          )
          .get(hopRow.id);
        if (!rpRow) {
          throw new Error(`routing_profile not found for chain_hop ${hopRow.id}`);
        }

        db.query("UPDATE routing_profiles SET default_action = ? WHERE id = ?").run(
          routingHop.defaultAction,
          rpRow.id,
        );

        db.query("DELETE FROM rules WHERE routing_profile_id = ?").run(rpRow.id);

        for (let rulePos = 0; rulePos < routingHop.rules.length; rulePos++) {
          const rule = routingHop.rules[rulePos]!;
          const matchValue =
            rule.matchKind === "domain"
              ? normalizeDomainSuffix(rule.matchValue)
              : rule.matchValue;
          db.query(
            "INSERT INTO rules (routing_profile_id, position, match_kind, match_value, action) VALUES (?, ?, ?, ?, ?)",
          ).run(rpRow.id, rulePos, rule.matchKind, matchValue, rule.action);
        }
      }
    }

    db.exec("COMMIT");
    return { ok: true, chainIds: createdChainIds, profileIds: createdProfileIds };
  } catch (error) {
    db.exec("ROLLBACK");
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Unknown error during import",
      status: 500,
    };
  }
}
