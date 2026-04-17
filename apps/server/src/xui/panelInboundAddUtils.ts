import { PanelRequestError } from "./panelRequestError";

export function parseInboundIdFromAddJson(addJson: { obj?: unknown }): number | null {
  const obj = addJson.obj;
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    const id = (obj as Record<string, unknown>).id;
    if (typeof id === "number" && Number.isFinite(id)) {
      return id;
    }
  }
  return null;
}

export function inboundTagFromAddResponse(
  addJson: { obj?: unknown },
  inboundBody: Record<string, unknown>,
): string {
  const obj = addJson.obj;
  if (obj && typeof obj === "object") {
    const tag = (obj as Record<string, unknown>).tag;
    if (typeof tag === "string" && tag.trim() !== "") return tag;
  }
  const portRaw = inboundBody.port;
  const port =
    typeof portRaw === "number" ? portRaw : typeof portRaw === "string" ? Number(portRaw) : NaN;
  if (Number.isFinite(port) && port > 0) {
    return `inbound-${port}`;
  }
  throw new PanelRequestError("unable to determine inbound tag from panel response");
}
