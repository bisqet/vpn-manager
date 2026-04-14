import * as d3 from "d3";
import { useLayoutEffect, useRef } from "react";
import type { CSSProperties } from "react";
import {
  buildChainRoutingGraph,
  type ChainHopInput,
  type RoutingProfileInput,
} from "../chainTrafficGraph";

export type ChainTrafficDiagramProps = {
  width: number;
  hops: ChainHopInput[];
  routingByChainHopId: Map<number, RoutingProfileInput>;
  routingFailedChainHopIds: Set<number>;
  routingLoading: boolean;
  draftLabels?: string[];
};

const COLORS: Record<string, string> = {
  backbone: "#111827",
  continue: "#2563eb",
  direct: "#059669",
  block: "#b91c1c",
  text: "#374151",
  muted: "#6b7280",
};

function orderedHopIdsFromBackbone(links: { sourceId: string; targetId: string; variant: string }[]): number[] {
  const nextFrom = new Map<string, string>();
  for (const l of links) {
    if (l.variant !== "backbone") {
      continue;
    }
    nextFrom.set(l.sourceId, l.targetId);
  }
  const ids: number[] = [];
  let cur: string | undefined = nextFrom.get("entry");
  while (cur?.startsWith("hop:")) {
    ids.push(Number(cur.slice(4)));
    cur = nextFrom.get(cur);
  }
  return ids;
}

function layoutNodes(
  graph: ReturnType<typeof buildChainRoutingGraph>,
  width: number,
): { positions: Map<string, { x: number; y: number }>; height: number } {
  const padding = 20;
  const hopY = 72;
  const sinkY1 = hopY + 88;
  const sinkY2 = hopY + 128;
  const hopOrder = orderedHopIdsFromBackbone(graph.links);
  const n = hopOrder.length;
  const usable = Math.max(200, width - 2 * padding);
  const colW = n > 0 ? Math.min(150, usable / Math.max(n + 2, 2)) : usable / 3;

  const positions = new Map<string, { x: number; y: number }>();

  positions.set("entry", { x: padding + colW * 0.5, y: hopY });

  hopOrder.forEach((hid, i) => {
    positions.set(`hop:${hid}`, { x: padding + colW * (i + 1.5), y: hopY });
  });

  const sinksX = Math.min(width - padding - 40, padding + colW * (n + 1.5));
  positions.set("sink:direct", { x: sinksX, y: sinkY1 });
  positions.set("sink:block", { x: sinksX, y: sinkY2 });

  const height = Math.max(220, sinkY2 + 56);
  return { positions, height };
}

function strokeForVariant(v: string): string {
  return COLORS[v] ?? COLORS.backbone;
}

export function ChainTrafficDiagram({
  width,
  hops,
  routingByChainHopId,
  routingFailedChainHopIds,
  routingLoading,
  draftLabels,
}: ChainTrafficDiagramProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);

  useLayoutEffect(() => {
    const svgEl = svgRef.current;
    if (!svgEl || width <= 0) {
      return;
    }

    const sortedHops = [...hops].sort((a, b) => a.position - b.position);
    const graph =
      sortedHops.length > 0
        ? buildChainRoutingGraph(sortedHops, routingByChainHopId)
        : null;

    const svg = d3.select(svgEl);
    svg.selectAll("*").remove();

    if (!graph && (!draftLabels || draftLabels.length === 0)) {
      const g0 = svg.append("g");
      g0
        .append("text")
        .attr("x", 12)
        .attr("y", 24)
        .attr("fill", COLORS.muted)
        .attr("font-size", 13)
        .text("Add hops to see traffic flow.");
      return;
    }

    if (!graph && draftLabels && draftLabels.length > 0) {
      const padding = 20;
      const colW = Math.min(150, (width - 2 * padding) / Math.max(draftLabels.length + 1, 1));
      const hopY = 72;
      const height = 200;
      svg.attr("viewBox", `0 0 ${width} ${height}`);
      const g = svg.append("g");
      g.append("circle")
        .attr("cx", padding + colW * 0.5)
        .attr("cy", hopY)
        .attr("r", 10)
        .attr("fill", COLORS.backbone);
      g.append("text")
        .attr("x", padding + colW * 0.5)
        .attr("y", hopY + 4)
        .attr("text-anchor", "middle")
        .attr("fill", "#fff")
        .attr("font-size", 10)
        .text("Entry");
      draftLabels.forEach((label, i) => {
        const x = padding + colW * (i + 1.5);
        g.append("rect")
          .attr("x", x - 52)
          .attr("y", hopY - 18)
          .attr("width", 104)
          .attr("height", 36)
          .attr("rx", 8)
          .attr("fill", "#f9fafb")
          .attr("stroke", "#e5e7eb");
        g.append("text")
          .attr("x", x)
          .attr("y", hopY + 4)
          .attr("text-anchor", "middle")
          .attr("fill", COLORS.text)
          .attr("font-size", 11)
          .text(label.length > 14 ? `${label.slice(0, 13)}…` : label);
        const prevX = i === 0 ? padding + colW * 0.5 : padding + colW * (i + 0.5);
        const seg = d3
          .line<[number, number]>()
          .x((d) => d[0])
          .y((d) => d[1])([
          [prevX, hopY],
          [x, hopY],
        ]);
        g.append("path")
          .attr("d", seg ?? "")
          .attr("fill", "none")
          .attr("stroke", COLORS.backbone)
          .attr("stroke-width", 2);
      });
      g.append("text")
        .attr("x", 12)
        .attr("y", 160)
        .attr("fill", COLORS.muted)
        .attr("font-size", 12)
        .text("Save the chain to load per-hop routing on this diagram.");
      return;
    }

    if (!graph) {
      return;
    }

    const { positions, height } = layoutNodes(graph, width);
    svg.attr("viewBox", `0 0 ${width} ${height}`);

    const gRoot = svg.append("g");

    const linkGroup = gRoot.append("g").attr("class", "links");
    const nodeGroup = gRoot.append("g").attr("class", "nodes");

    const line = d3
      .line<[number, number]>()
      .curve(d3.curveBumpX)
      .x((d) => d[0])
      .y((d) => d[1]);

    for (const link of graph.links) {
      const s = positions.get(link.sourceId);
      const t = positions.get(link.targetId);
      if (!s || !t) {
        continue;
      }
      const midY =
        link.variant === "backbone"
          ? s.y
          : s.y + 22 + (Math.abs(link.id.charCodeAt(link.id.length - 1) || 0) % 5) * 6;
      const pathData: [number, number][] =
        link.variant === "backbone"
          ? [
              [s.x, s.y],
              [t.x, t.y],
            ]
          : [
              [s.x, s.y],
              [s.x + (t.x - s.x) * 0.35, midY],
              [t.x, t.y],
            ];
      linkGroup
        .append("path")
        .attr("d", line(pathData) ?? "")
        .attr("fill", "none")
        .attr("stroke", strokeForVariant(link.variant))
        .attr("stroke-width", link.variant === "backbone" ? 2.5 : 1.5)
        .attr("stroke-dasharray", link.variant === "backbone" ? "none" : "4 3")
        .attr("opacity", 0.9);

      if (link.label && link.variant !== "backbone") {
        linkGroup
          .append("text")
          .attr("x", (s.x + t.x) / 2)
          .attr("y", midY - 6)
          .attr("text-anchor", "middle")
          .attr("fill", COLORS.muted)
          .attr("font-size", 9)
          .text(link.label.length > 36 ? `${link.label.slice(0, 35)}…` : link.label);
      }
    }

    for (const node of graph.nodes) {
      const p = positions.get(node.id);
      if (!p) {
        continue;
      }
      if (node.kind === "entry") {
        nodeGroup
          .append("circle")
          .attr("cx", p.x)
          .attr("cy", p.y)
          .attr("r", 12)
          .attr("fill", COLORS.backbone);
        nodeGroup
          .append("text")
          .attr("x", p.x)
          .attr("y", p.y + 4)
          .attr("text-anchor", "middle")
          .attr("fill", "#fff")
          .attr("font-size", 10)
          .text("Entry");
      } else if (node.kind === "hop") {
        nodeGroup
          .append("rect")
          .attr("x", p.x - 58)
          .attr("y", p.y - 20)
          .attr("width", 116)
          .attr("height", 40)
          .attr("rx", 10)
          .attr("fill", node.chainHopId && routingFailedChainHopIds.has(node.chainHopId) ? "#fef2f2" : "#f9fafb")
          .attr("stroke", node.chainHopId && routingFailedChainHopIds.has(node.chainHopId) ? "#fecaca" : "#e5e7eb");
        nodeGroup
          .append("text")
          .attr("x", p.x)
          .attr("y", p.y - 2)
          .attr("text-anchor", "middle")
          .attr("fill", COLORS.text)
          .attr("font-size", 11)
          .attr("font-weight", 600)
          .text(node.label.length > 16 ? `${node.label.slice(0, 15)}…` : node.label);
        if (node.sublabel) {
          nodeGroup
            .append("text")
            .attr("x", p.x)
            .attr("y", p.y + 12)
            .attr("text-anchor", "middle")
            .attr("fill", COLORS.muted)
            .attr("font-size", 9)
            .text(node.sublabel);
        }
        if (node.chainHopId && routingFailedChainHopIds.has(node.chainHopId)) {
          nodeGroup
            .append("text")
            .attr("x", p.x)
            .attr("y", p.y + 34)
            .attr("text-anchor", "middle")
            .attr("fill", COLORS.block)
            .attr("font-size", 9)
            .text("Routing unavailable");
        }
      } else {
        nodeGroup
          .append("rect")
          .attr("x", p.x - 44)
          .attr("y", p.y - 14)
          .attr("width", 88)
          .attr("height", 28)
          .attr("rx", 8)
          .attr("fill", node.kind === "sink_direct" ? "#ecfdf5" : "#fef2f2")
          .attr("stroke", node.kind === "sink_direct" ? "#a7f3d0" : "#fecaca");
        nodeGroup
          .append("text")
          .attr("x", p.x)
          .attr("y", p.y + 4)
          .attr("text-anchor", "middle")
          .attr("fill", COLORS.text)
          .attr("font-size", 11)
          .text(node.label);
      }
    }

    const legendY = height - 28;
    const items: [string, string][] = [
      ["Backbone", COLORS.backbone],
      ["Continue", COLORS.continue],
      ["Direct", COLORS.direct],
      ["Block", COLORS.block],
    ];
    let lx = 12;
    for (const [label, color] of items) {
      gRoot.append("circle").attr("cx", lx).attr("cy", legendY).attr("r", 4).attr("fill", color);
      gRoot
        .append("text")
        .attr("x", lx + 10)
        .attr("y", legendY + 4)
        .attr("fill", COLORS.muted)
        .attr("font-size", 10)
        .text(label);
      lx += 88;
    }

    const truncated = graph.truncatedRuleCountByHopId;
    const hopIdsTrunc = Object.keys(truncated);
    if (hopIdsTrunc.length > 0) {
      const total = hopIdsTrunc.reduce((a, k) => a + (truncated[Number(k)] ?? 0), 0);
      gRoot
        .append("text")
        .attr("x", width - 12)
        .attr("y", legendY + 4)
        .attr("text-anchor", "end")
        .attr("fill", COLORS.muted)
        .attr("font-size", 10)
        .text(`+${total} more rule(s) — edit on Routing page`);
    }

    if (routingLoading) {
      gRoot
        .append("text")
        .attr("x", width - 12)
        .attr("y", 18)
        .attr("text-anchor", "end")
        .attr("fill", COLORS.muted)
        .attr("font-size", 11)
        .text("Loading routing…");
    }
  }, [width, hops, routingByChainHopId, routingFailedChainHopIds, routingLoading, draftLabels]);

  const showDraftOnly = hops.length === 0 && !!draftLabels?.length;
  const showEmpty = hops.length === 0 && !draftLabels?.length;

  const outerStyle: CSSProperties = {
    width: "100%",
    minHeight: showEmpty ? 48 : showDraftOnly ? 200 : 220,
    borderRadius: 14,
    border: "1px solid #e5e7eb",
    background: "#ffffff",
    overflow: "hidden",
  };

  return (
    <div style={outerStyle}>
      <svg
        ref={svgRef}
        width={width}
        height={showEmpty ? 48 : showDraftOnly ? 200 : 240}
        style={{ display: "block" }}
      />
    </div>
  );
}
