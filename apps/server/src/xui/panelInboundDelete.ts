import { PanelRequestError, type PanelJson, panelBaseForProvision } from "./provisionChainClientAccess";

async function readPanelJson(response: Response): Promise<PanelJson> {
  if (!response.ok) {
    throw new PanelRequestError(`panel HTTP ${response.status}`);
  }
  const body: unknown = await response.json();
  if (body === null || typeof body !== "object") {
    throw new PanelRequestError("panel returned non-object JSON");
  }
  return body as PanelJson;
}

export type DeletePanelInboundByIdInput = {
  panelApiBase: string;
  cookieHeader: string;
  inboundId: number;
  fetchFn?: typeof fetch;
};

export async function deletePanelInboundById(input: DeletePanelInboundByIdInput): Promise<void> {
  const fetchFn = input.fetchFn ?? fetch;
  const base = panelBaseForProvision(input.panelApiBase);
  const url = new URL(`panel/api/inbounds/del/${input.inboundId}`, base).href;
  const response = await fetchFn(url, {
    method: "POST",
    headers: {
      accept: "application/json",
      cookie: input.cookieHeader,
    },
  });
  const json = await readPanelJson(response);
  if (json.success !== true) {
    throw new PanelRequestError(typeof json.msg === "string" && json.msg !== "" ? json.msg : "delete inbound failed");
  }
}

export type ResolveInboundIdByTagInput = {
  panelApiBase: string;
  cookieHeader: string;
  inboundTag: string;
  fetchFn?: typeof fetch;
};

export async function resolveInboundIdByTag(input: ResolveInboundIdByTagInput): Promise<number | null> {
  const fetchFn = input.fetchFn ?? fetch;
  const base = panelBaseForProvision(input.panelApiBase);
  const url = new URL("panel/api/inbounds/list", base).href;
  const response = await fetchFn(url, {
    method: "GET",
    headers: { accept: "application/json", cookie: input.cookieHeader },
  });
  const json = await readPanelJson(response);
  const obj = json.obj;
  if (!Array.isArray(obj)) return null;
  for (const row of obj) {
    if (!row || typeof row !== "object") continue;
    const rec = row as Record<string, unknown>;
    if (rec.tag === input.inboundTag && typeof rec.id === "number" && Number.isFinite(rec.id)) {
      return rec.id;
    }
  }
  return null;
}
