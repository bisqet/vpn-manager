function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function findFreedomOutboundTag(xray: { outbounds?: unknown[] }): string {
  const outbounds = xray.outbounds;
  if (!Array.isArray(outbounds)) {
    return "direct";
  }
  for (const ob of outbounds) {
    if (!isRecord(ob)) continue;
    if (ob.protocol === "freedom") {
      const tag = ob.tag;
      return typeof tag === "string" ? tag : "direct";
    }
  }
  return "direct";
}

export function mergeInboundToOutboundRule(input: {
  xray: Record<string, unknown>;
  inboundTag: string;
  outboundTag: string;
}): Record<string, unknown> {
  const next = structuredClone(input.xray) as Record<string, unknown>;
  const routing = next.routing;
  if (!isRecord(routing)) {
    throw new Error("xray.routing is required");
  }
  const rulesRaw = routing.rules;
  const rules = Array.isArray(rulesRaw) ? [...rulesRaw] : [];
  rules.unshift({
    type: "field",
    inboundTag: [input.inboundTag],
    outboundTag: input.outboundTag,
  });
  routing.rules = rules;
  next.routing = routing;
  return next;
}

export function appendOutbound(input: {
  xray: Record<string, unknown>;
  outbound: Record<string, unknown>;
}): Record<string, unknown> {
  const next = structuredClone(input.xray) as Record<string, unknown>;
  const existing = next.outbounds;
  const outbounds = Array.isArray(existing) ? [...existing] : [];
  outbounds.push(input.outbound);
  next.outbounds = outbounds;
  return next;
}
