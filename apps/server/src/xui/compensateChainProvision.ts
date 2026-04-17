import { loginCookie } from "./panelLoginCookie";
import { deletePanelInboundById, resolveInboundIdByTag } from "./panelInboundDelete";
import type { CreatedInboundRef } from "./provisionMultihopChainClientAccess";

export async function compensateCreatedInbounds(input: {
  createdInbounds: CreatedInboundRef[];
  fetchFn?: typeof fetch;
}): Promise<void> {
  const fetchFn = input.fetchFn ?? fetch;
  for (const ref of [...input.createdInbounds].reverse()) {
    const { base, cookieHeader } = await loginCookie({
      panelBaseUrl: ref.panelBaseUrl,
      adminUsername: ref.adminUsername,
      adminPassword: ref.adminPassword,
      fetchFn,
    });
    let id = ref.inboundId;
    if (id == null) {
      id = (await resolveInboundIdByTag({
        panelApiBase: base,
        cookieHeader,
        inboundTag: ref.inboundTag,
        fetchFn,
      })) ?? null;
    }
    if (id == null) continue;
    try {
      await deletePanelInboundById({ panelApiBase: base, cookieHeader, inboundId: id, fetchFn });
    } catch {
      /* best-effort: swallow per spec */
    }
  }
}
