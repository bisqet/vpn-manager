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

function hopNodeId(chainHopId: number): string {
  return `hop:${chainHopId}`;
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

function targetForAction(
  action: RuleAction,
  nextHopId: number | null,
): string | null {
  if (action === "use_chain") {
    if (nextHopId === null) {
      return null;
    }
    return hopNodeId(nextHopId);
  }
  if (action === "direct") {
    return "sink:direct";
  }
  return "sink:block";
}

export function buildChainRoutingGraph(
  hops: ChainHopInput[],
  routingByChainHopId: Map<number, RoutingProfileInput>,
): ChainTrafficGraph {
  const sorted = [...hops].sort((a, b) => a.position - b.position);
  const truncatedRuleCountByHopId: Record<number, number> = {};

  const nodes: GraphNode[] = [
    { id: "entry", kind: "entry", label: "Entry" },
    { id: "sink:direct", kind: "sink_direct", label: "Direct" },
    { id: "sink:block", kind: "sink_block", label: "Blocked" },
  ];

  for (const h of sorted) {
    nodes.push({
      id: hopNodeId(h.id),
      kind: "hop",
      label: h.label,
      sublabel: `#${h.vpnProfileId}`,
      chainHopId: h.id,
    });
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

  const hopIndexById = new Map<number, number>();
  sorted.forEach((h, i) => hopIndexById.set(h.id, i));

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
          ? "sink:direct"
          : "sink:block";

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
      const tgt = targetForAction(rule.action, nextHopId);
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
