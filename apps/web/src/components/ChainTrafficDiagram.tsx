import * as d3 from "d3";
import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
} from "react";
import type { CSSProperties } from "react";
import {
  buildChainRoutingGraph,
  hopNodeId,
  type ChainHopInput,
  type RoutingProfileInput,
} from "../chainTrafficGraph";

export type ChainTrafficDiagramHandle = {
  resetView: () => void;
};

export type ChainTrafficDiagramProps = {
  diagramKey: string;
  width: number;
  hops: ChainHopInput[];
  routingByChainHopId: Map<number, RoutingProfileInput>;
  routingFailedChainHopIds: Set<number>;
  routingLoading: boolean;
  draftLabels?: string[];
  /** When true, omit the toolbar "Reset view" (e.g. modal renders its own). Default false. */
  hideInternalReset?: boolean;
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
  const sinkRowY = hopY + 82;
  const hopOrder = orderedHopIdsFromBackbone(graph.links);
  const n = hopOrder.length;
  const usable = Math.max(200, width - 2 * padding);
  const colW = n > 0 ? Math.min(150, usable / Math.max(n + 2, 2)) : usable / 3;

  const positions = new Map<string, { x: number; y: number }>();

  positions.set("entry", { x: padding + colW * 0.5, y: hopY });

  hopOrder.forEach((hid, i) => {
    positions.set(hopNodeId(hid), { x: padding + colW * (i + 1.5), y: hopY });
  });

  for (const node of graph.nodes) {
    if (node.kind !== "sink_direct" && node.kind !== "sink_block") {
      continue;
    }
    const hid = node.chainHopId;
    if (hid === undefined) {
      continue;
    }
    const hopPos = positions.get(hopNodeId(hid));
    if (!hopPos) {
      continue;
    }

    const directId = `sink:${hid}:direct`;
    const blockId = `sink:${hid}:block`;
    const hasDirect = graph.nodes.some((x) => x.id === directId);
    const hasBlock = graph.nodes.some((x) => x.id === blockId);

    if (node.kind === "sink_direct") {
      if (hasDirect && hasBlock) {
        positions.set(node.id, { x: hopPos.x - 52, y: sinkRowY });
      } else {
        positions.set(node.id, { x: hopPos.x, y: sinkRowY });
      }
    } else if (hasDirect && hasBlock) {
      positions.set(node.id, { x: hopPos.x + 52, y: sinkRowY });
    } else {
      positions.set(node.id, { x: hopPos.x, y: sinkRowY });
    }
  }

  const sinkBottom = sinkRowY + 22;
  const height = Math.max(248, sinkBottom + 52);
  return { positions, height };
}

function strokeForVariant(v: string): string {
  return COLORS[v] ?? COLORS.backbone;
}

export const ChainTrafficDiagram = forwardRef<
  ChainTrafficDiagramHandle,
  ChainTrafficDiagramProps
>(function ChainTrafficDiagram(
  {
    diagramKey,
    width,
    hops,
    routingByChainHopId,
    routingFailedChainHopIds,
    routingLoading,
    draftLabels,
    hideInternalReset = false,
  },
  ref,
) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const transformRef = useRef<d3.ZoomTransform>(d3.zoomIdentity);
  const prevDiagramKeyRef = useRef<string | null>(null);
  const zoomBehaviorRef = useRef<d3.ZoomBehavior<SVGSVGElement, unknown> | null>(null);

  const handleResetView = useCallback(() => {
    const svgEl = svgRef.current;
    const zoom = zoomBehaviorRef.current;
    if (!svgEl || !zoom) {
      transformRef.current = d3.zoomIdentity;
      return;
    }
    const svg = d3.select(svgEl);
    transformRef.current = d3.zoomIdentity;
    svg.call(zoom.transform, d3.zoomIdentity);
  }, []);

  useImperativeHandle(ref, () => ({ resetView: handleResetView }), [handleResetView]);

  useLayoutEffect(() => {
    const svgEl = svgRef.current;
    if (!svgEl || width <= 0) {
      return;
    }

    if (prevDiagramKeyRef.current !== diagramKey) {
      prevDiagramKeyRef.current = diagramKey;
      transformRef.current = d3.zoomIdentity;
    }

    const sortedHops = [...hops].sort((a, b) => a.position - b.position);
    const graph =
      sortedHops.length > 0
        ? buildChainRoutingGraph(sortedHops, routingByChainHopId)
        : null;

    const svg = d3.select(svgEl);
    svg.selectAll("*").remove();
    const zoomRoot = svg.append("g").attr("class", "chain-traffic-zoom-root");

    if (!graph && (!draftLabels || draftLabels.length === 0)) {
      zoomRoot
        .append("text")
        .attr("x", 12)
        .attr("y", 24)
        .attr("fill", COLORS.muted)
        .attr("font-size", 13)
        .text("Add hops to see traffic flow.");
    } else if (!graph && draftLabels && draftLabels.length > 0) {
      const padding = 20;
      const colW = Math.min(150, (width - 2 * padding) / Math.max(draftLabels.length + 1, 1));
      const hopY = 72;
      const height = 200;
      svg.attr("viewBox", `0 0 ${width} ${height}`);
      zoomRoot
        .append("circle")
        .attr("cx", padding + colW * 0.5)
        .attr("cy", hopY)
        .attr("r", 10)
        .attr("fill", COLORS.backbone);
      zoomRoot
        .append("text")
        .attr("x", padding + colW * 0.5)
        .attr("y", hopY + 4)
        .attr("text-anchor", "middle")
        .attr("fill", "#fff")
        .attr("font-size", 10)
        .text("Entry");
      draftLabels.forEach((label, i) => {
        const x = padding + colW * (i + 1.5);
        zoomRoot
          .append("rect")
          .attr("x", x - 52)
          .attr("y", hopY - 18)
          .attr("width", 104)
          .attr("height", 36)
          .attr("rx", 8)
          .attr("fill", "#f9fafb")
          .attr("stroke", "#e5e7eb");
        zoomRoot
          .append("text")
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
        zoomRoot
          .append("path")
          .attr("d", seg ?? "")
          .attr("fill", "none")
          .attr("stroke", COLORS.backbone)
          .attr("stroke-width", 2);
      });
      zoomRoot
        .append("text")
        .attr("x", 12)
        .attr("y", 160)
        .attr("fill", COLORS.muted)
        .attr("font-size", 12)
        .text("Save the chain to load per-hop routing on this diagram.");
    } else if (graph) {
      const { positions, height } = layoutNodes(graph, width);
      svg.attr("viewBox", `0 0 ${width} ${height}`);

      const linkGroup = zoomRoot.append("g").attr("class", "links");
      const nodeGroup = zoomRoot.append("g").attr("class", "nodes");

      const line = d3
        .line<[number, number]>()
        .curve(d3.curveBumpX)
        .x((d) => d[0])
        .y((d) => d[1]);

      graph.links.forEach((link, linkIndex) => {
        const s = positions.get(link.sourceId);
        const t = positions.get(link.targetId);
        if (!s || !t) {
          return;
        }
        const midY =
          link.variant === "backbone"
            ? s.y
            : s.y + 18 + (linkIndex % 6) * 7;
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
      });

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
          const hopLabel =
            node.chainHopId !== undefined
              ? graph.nodes.find((x) => x.kind === "hop" && x.chainHopId === node.chainHopId)?.label
              : undefined;
          nodeGroup
            .append("rect")
            .attr("x", p.x - 44)
            .attr("y", p.y - 14)
            .attr("width", 88)
            .attr("height", hopLabel ? 38 : 28)
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
          if (hopLabel) {
            nodeGroup
              .append("text")
              .attr("x", p.x)
              .attr("y", p.y + 22)
              .attr("text-anchor", "middle")
              .attr("fill", COLORS.muted)
              .attr("font-size", 8)
              .text(`hop: ${hopLabel.length > 12 ? `${hopLabel.slice(0, 11)}…` : hopLabel}`);
          }
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
        zoomRoot.append("circle").attr("cx", lx).attr("cy", legendY).attr("r", 4).attr("fill", color);
        zoomRoot
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
        zoomRoot
          .append("text")
          .attr("x", width - 12)
          .attr("y", legendY + 4)
          .attr("text-anchor", "end")
          .attr("fill", COLORS.muted)
          .attr("font-size", 10)
          .text(`+${total} more rule(s) — edit on Routing page`);
      }

      if (routingLoading) {
        zoomRoot
          .append("text")
          .attr("x", width - 12)
          .attr("y", 18)
          .attr("text-anchor", "end")
          .attr("fill", COLORS.muted)
          .attr("font-size", 11)
          .text("Loading routing…");
      }
    }

    const zoom = d3
      .zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.35, 4])
      .on("zoom", (event) => {
        transformRef.current = event.transform;
        zoomRoot.attr("transform", event.transform.toString());
      });

    svg.call(zoom);
    zoomBehaviorRef.current = zoom;
    svg.call(zoom.transform, transformRef.current);
  }, [width, hops, routingByChainHopId, routingFailedChainHopIds, routingLoading, draftLabels, diagramKey]);

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
      {!showEmpty && !hideInternalReset ? (
        <div style={{ display: "flex", justifyContent: "flex-end", padding: "8px 12px 0" }}>
          <button
            type="button"
            onClick={handleResetView}
            style={{
              padding: "4px 10px",
              borderRadius: "8px",
              fontSize: "0.8rem",
              fontWeight: 600,
              cursor: "pointer",
              border: "1px solid #d1d5db",
              background: "#ffffff",
              color: "#374151",
            }}
          >
            Reset view
          </button>
        </div>
      ) : null}
      <svg
        ref={svgRef}
        width={width}
        height={showEmpty ? 48 : showDraftOnly ? 200 : 240}
        style={{ display: "block" }}
      />
    </div>
  );
});
