import { describe, expect, test } from "bun:test";
import {
  buildChainRoutingGraph,
  type ChainHopInput,
  type RoutingProfileInput,
} from "./chainTrafficGraph";

function hop(
  id: number,
  position: number,
  label: string,
  vpnProfileId: number = id,
): ChainHopInput {
  return {
    id,
    position,
    vpnProfileId,
    label,
  };
}

describe("buildChainRoutingGraph", () => {
  test("backbone only when routing map is empty", () => {
    const hops = [hop(10, 0, "A"), hop(11, 1, "B")];
    const graph = buildChainRoutingGraph(hops, new Map());
    expect(graph.links.filter((l) => l.variant === "backbone")).toEqual([
      expect.objectContaining({ sourceId: "entry", targetId: "hop:10" }),
      expect.objectContaining({ sourceId: "hop:10", targetId: "hop:11" }),
    ]);
    expect(graph.nodes.every((n) => !n.id.startsWith("sink:"))).toBe(true);
    expect(graph.truncatedRuleCountByHopId).toEqual({});
  });

  test("default direct and rule use_chain to next hop", () => {
    const hops = [hop(1, 0, "First"), hop(2, 1, "Second")];
    const routing = new Map<number, RoutingProfileInput>();
    routing.set(1, {
      chainHopId: 1,
      defaultAction: "direct",
      rules: [{ position: 0, matchKind: "domain", matchValue: "x.test", action: "use_chain" }],
    });
    const graph = buildChainRoutingGraph(hops, routing);
    expect(graph.links).toContainEqual(
      expect.objectContaining({
        id: "link:1:default",
        sourceId: "hop:1",
        targetId: "sink:1:direct",
        variant: "direct",
      }),
    );
    expect(graph.links).toContainEqual(
      expect.objectContaining({
        id: "link:1:rule:0",
        sourceId: "hop:1",
        targetId: "hop:2",
        variant: "continue",
      }),
    );
  });

  test("terminal hop default use_chain emits no default continue edge", () => {
    const hops = [hop(5, 0, "Only")];
    const routing = new Map<number, RoutingProfileInput>();
    routing.set(5, { chainHopId: 5, defaultAction: "use_chain", rules: [] });
    const graph = buildChainRoutingGraph(hops, routing);
    expect(graph.links.find((l) => l.id === "link:5:default")).toBeUndefined();
  });

  test("truncates rules after 8 and reports count", () => {
    const hops = [hop(9, 0, "H")];
    const rules = Array.from({ length: 10 }, (_, i) => ({
      position: i,
      matchKind: "cidr" as const,
      matchValue: `10.0.${i}.0/24`,
      action: "block" as const,
    }));
    const routing = new Map<number, RoutingProfileInput>();
    routing.set(9, { chainHopId: 9, defaultAction: "direct", rules });
    const graph = buildChainRoutingGraph(hops, routing);
    expect(graph.links.filter((l) => l.id.startsWith("link:9:rule:")).length).toBe(8);
    expect(graph.truncatedRuleCountByHopId[9]).toBe(2);
  });

  test("per-hop sinks: second hop block uses sink on that hop only", () => {
    const hops = [hop(1, 0, "A"), hop(2, 1, "B")];
    const routing = new Map<number, RoutingProfileInput>();
    routing.set(2, {
      chainHopId: 2,
      defaultAction: "block",
      rules: [],
    });
    const graph = buildChainRoutingGraph(hops, routing);
    expect(graph.nodes.some((n) => n.id === "sink:2:block")).toBe(true);
    expect(graph.nodes.some((n) => n.id === "sink:1:block")).toBe(false);
    expect(graph.links).toContainEqual(
      expect.objectContaining({
        sourceId: "hop:2",
        targetId: "sink:2:block",
        variant: "block",
      }),
    );
  });
});
