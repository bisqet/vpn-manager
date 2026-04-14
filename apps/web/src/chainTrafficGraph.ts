export type DefaultAction = "use_chain" | "direct" | "block";
export type RuleAction = "direct" | "use_chain" | "block";
export type MatchKind = "domain" | "cidr";

export type ChainHopInput = {
  id: number;
  position: number;
  vpnProfileId: number;
  label: string;
};

export type RoutingRuleInput = {
  position: number;
  matchKind: MatchKind;
  matchValue: string;
  action: RuleAction;
};

export type RoutingProfileInput = {
  chainHopId: number;
  defaultAction: DefaultAction;
  rules: RoutingRuleInput[];
};

export type GraphNodeKind = "entry" | "hop" | "sink_direct" | "sink_block";

export type GraphNode = {
  id: string;
  kind: GraphNodeKind;
  label: string;
  sublabel?: string;
  /** Hop id for hop nodes; owning hop id for per-hop sink nodes */
  chainHopId?: number;
};

export type GraphLinkVariant = "backbone" | "continue" | "direct" | "block";

export type GraphLink = {
  id: string;
  sourceId: string;
  targetId: string;
  label?: string;
  variant: GraphLinkVariant;
};

export type ChainTrafficGraph = {
  nodes: GraphNode[];
  links: GraphLink[];
  truncatedRuleCountByHopId: Record<number, number>;
};

const MAX_RULES_PER_HOP = 8;
const MAX_LABEL_LEN = 40;

export function hopNodeId(chainHopId: number): string {
  return `hop:${chainHopId}`;
}

function sinkDirectId(chainHopId: number): string {
  return `sink:${chainHopId}:direct`;
}

function sinkBlockId(chainHopId: number): string {
  return `sink:${chainHopId}:block`;
}

function truncateLabel(text: string): string {
  if (text.length <= MAX_LABEL_LEN) {
    return text;
  }
  return `${text.slice(0, MAX_LABEL_LEN - 1)}…`;
}

function ruleLabel(rule: RoutingRuleInput): string {
  return truncateLabel(`${rule.matchKind}: ${rule.matchValue}`);
}

function variantForAction(action: RuleAction): GraphLinkVariant {
  if (action === "use_chain") {
    return "continue";
  }
  if (action === "direct") {
    return "direct";
  }
  return "block";
}

function hopNeedsDirectSink(routing: RoutingProfileInput): boolean {
  if (routing.defaultAction === "direct") {
    return true;
  }
  return routing.rules.some((rule) => rule.action === "direct");
}

function hopNeedsBlockSink(routing: RoutingProfileInput): boolean {
  if (routing.defaultAction === "block") {
    return true;
  }
  return routing.rules.some((rule) => rule.action === "block");
}

function targetForAction(
  action: RuleAction,
  nextHopId: number | null,
  hopId: number,
): string | null {
  if (action === "use_chain") {
    if (nextHopId === null) {
      return null;
    }
    return hopNodeId(nextHopId);
  }
  if (action === "direct") {
    return sinkDirectId(hopId);
  }
  return sinkBlockId(hopId);
}

export function buildChainRoutingGraph(
  hops: ChainHopInput[],
  routingByChainHopId: Map<number, RoutingProfileInput>,
): ChainTrafficGraph {
  const sorted = [...hops].sort((a, b) => a.position - b.position);
  const truncatedRuleCountByHopId: Record<number, number> = {};

  const nodes: GraphNode[] = [{ id: "entry", kind: "entry", label: "Entry" }];

  for (const h of sorted) {
    nodes.push({
      id: hopNodeId(h.id),
      kind: "hop",
      label: h.label,
      sublabel: `#${h.vpnProfileId}`,
      chainHopId: h.id,
    });
  }

  const sinkIdsAdded = new Set<string>();

  const hopIndexById = new Map<number, number>();
  sorted.forEach((h, i) => hopIndexById.set(h.id, i));

  for (const h of sorted) {
    const routing = routingByChainHopId.get(h.id);
    if (!routing) {
      continue;
    }

    if (hopNeedsDirectSink(routing)) {
      const id = sinkDirectId(h.id);
      if (!sinkIdsAdded.has(id)) {
        sinkIdsAdded.add(id);
        nodes.push({
          id,
          kind: "sink_direct",
          label: "Direct",
          chainHopId: h.id,
        });
      }
    }
    if (hopNeedsBlockSink(routing)) {
      const id = sinkBlockId(h.id);
      if (!sinkIdsAdded.has(id)) {
        sinkIdsAdded.add(id);
        nodes.push({
          id,
          kind: "sink_block",
          label: "Blocked",
          chainHopId: h.id,
        });
      }
    }
  }

  const links: GraphLink[] = [];

  if (sorted.length > 0) {
    links.push({
      id: "link:backbone:entry",
      sourceId: "entry",
      targetId: hopNodeId(sorted[0].id),
      variant: "backbone",
    });
    for (let i = 0; i < sorted.length - 1; i++) {
      links.push({
        id: `link:backbone:${sorted[i].id}`,
        sourceId: hopNodeId(sorted[i].id),
        targetId: hopNodeId(sorted[i + 1].id),
        variant: "backbone",
      });
    }
  }

  for (const h of sorted) {
    const routing = routingByChainHopId.get(h.id);
    if (!routing) {
      continue;
    }

    const idx = hopIndexById.get(h.id) ?? -1;
    const nextHop = idx >= 0 && idx < sorted.length - 1 ? sorted[idx + 1] : null;
    const nextHopId = nextHop ? nextHop.id : null;

    const defaultTarget =
      routing.defaultAction === "use_chain"
        ? nextHopId !== null
          ? hopNodeId(nextHopId)
          : null
        : routing.defaultAction === "direct"
          ? sinkDirectId(h.id)
          : sinkBlockId(h.id);

    if (defaultTarget !== null) {
      const variant =
        routing.defaultAction === "use_chain" ? "continue" : variantForAction(routing.defaultAction);
      links.push({
        id: `link:${h.id}:default`,
        sourceId: hopNodeId(h.id),
        targetId: defaultTarget,
        label: routing.defaultAction === "use_chain" ? "default → chain" : "default",
        variant,
      });
    }

    const sortedRules = [...routing.rules].sort((a, b) => a.position - b.position);
    const visibleRules = sortedRules.slice(0, MAX_RULES_PER_HOP);
    const omitted = sortedRules.length - visibleRules.length;
    if (omitted > 0) {
      truncatedRuleCountByHopId[h.id] = omitted;
    }

    for (const rule of visibleRules) {
      const tgt = targetForAction(rule.action, nextHopId, h.id);
      if (tgt === null) {
        continue;
      }
      links.push({
        id: `link:${h.id}:rule:${rule.position}`,
        sourceId: hopNodeId(h.id),
        targetId: tgt,
        label: ruleLabel(rule),
        variant: variantForAction(rule.action),
      });
    }
  }

  return { nodes, links, truncatedRuleCountByHopId };
}
