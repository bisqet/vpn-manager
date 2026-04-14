import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CSSProperties, FormEvent } from "react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ApiError, apiFetch } from "../api/client";
import { ChainTrafficDiagram } from "../components/ChainTrafficDiagram";
import type { ChainHopInput, RoutingProfileInput } from "../chainTrafficGraph";
import { chainRailStyle, chainsPageRootStackStyle } from "../chainsPageLayout";
import { trafficDiagramKey } from "../trafficDiagramKey";

const chainsQueryKey = ["chains"] as const;
const profilesQueryKey = ["profiles"] as const;

type ChainHop = {
  id: number;
  position: number;
  vpnProfileId: number;
  label: string;
};

type Chain = {
  id: number;
  name: string;
  vpnProfileIds: number[];
  hops: ChainHop[];
};

type DefaultAction = "use_chain" | "direct" | "block";
type MatchKind = "domain" | "cidr";
type RuleAction = "direct" | "use_chain" | "block";

type RoutingRule = {
  id: number;
  position: number;
  matchKind: MatchKind;
  matchValue: string;
  action: RuleAction;
};

type RoutingProfile = {
  id: number;
  name: string;
  chainId: number;
  chainHopId: number;
  defaultAction: DefaultAction;
  rules: RoutingRule[];
};

type VpnProfile = {
  id: number;
  label: string;
  host: string;
  sshPort: number;
  sshUser: string;
  panelHostname: string;
  operationalStatus: "pending" | "working";
  createdAt: string;
  updatedAt: string;
};

type ChainPayload = {
  name: string;
  vpnProfileIds: number[];
};

type HopRow = {
  key: number;
  vpnProfileId: string;
};

type EditorState =
  | { mode: "create" }
  | { mode: "edit"; chainId: number };

function fetchChains() {
  return apiFetch<Chain[]>("/api/chains");
}

function fetchProfiles() {
  return apiFetch<VpnProfile[]>("/api/profiles");
}

function fetchRoutingByHop(chainHopId: number) {
  return apiFetch<RoutingProfile>(`/api/routing/by-hop/${chainHopId}`);
}

function createChain(payload: ChainPayload) {
  return apiFetch<Chain>("/api/chains", {
    method: "POST",
    body: payload,
  });
}

function updateChain(id: number, payload: ChainPayload) {
  return apiFetch<Chain>(`/api/chains/${id}`, {
    method: "PATCH",
    body: payload,
  });
}

function deleteChain(id: number) {
  return apiFetch<{ ok: true }>(`/api/chains/${id}`, {
    method: "DELETE",
  });
}

function getErrorMessage(error: unknown) {
  if (error instanceof ApiError) {
    return error.message;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return "Something went wrong. Please try again.";
}

function validateChain(name: string, hopRows: HopRow[]) {
  const trimmedName = name.trim();
  if (trimmedName === "") {
    return { error: "Chain name is required." };
  }

  if (hopRows.length === 0) {
    return { error: "Add at least one hop before saving." };
  }

  const vpnProfileIds: number[] = [];
  for (const row of hopRows) {
    const vpnProfileId = Number(row.vpnProfileId);
    if (!Number.isInteger(vpnProfileId) || vpnProfileId < 1) {
      return { error: "Each hop must reference a valid VPN profile." };
    }
    vpnProfileIds.push(vpnProfileId);
  }

  if (new Set(vpnProfileIds).size !== vpnProfileIds.length) {
    return { error: "Each hop must use a unique VPN profile." };
  }

  return {
    payload: {
      name: trimmedName,
      vpnProfileIds,
    },
  };
}

function hasValidationError(
  result: ReturnType<typeof validateChain>,
): result is { error: string } {
  return "error" in result;
}

export default function ChainsPage() {
  const queryClient = useQueryClient();
  const nextHopKeyRef = useRef(0);
  const diagramContainerRef = useRef<HTMLDivElement>(null);
  const [diagramWidth, setDiagramWidth] = useState(0);
  const [diagramModalOpen, setDiagramModalOpen] = useState(false);
  const modalDiagramContainerRef = useRef<HTMLDivElement>(null);
  const [modalDiagramWidth, setModalDiagramWidth] = useState(0);
  const modalCloseButtonRef = useRef<HTMLButtonElement>(null);

  function chainHopRowsFromChain(chain: Chain): HopRow[] {
    if (chain.hops.length > 0) {
      return [...chain.hops]
        .sort((a, b) => a.position - b.position)
        .map((h) => ({
          key: nextHopKeyRef.current++,
          vpnProfileId: String(h.vpnProfileId),
        }));
    }

    return chain.vpnProfileIds.map((vpnProfileId) => ({
      key: nextHopKeyRef.current++,
      vpnProfileId: String(vpnProfileId),
    }));
  }

  const chainsQuery = useQuery({
    queryKey: chainsQueryKey,
    queryFn: fetchChains,
  });

  const profilesQuery = useQuery({
    queryKey: profilesQueryKey,
    queryFn: fetchProfiles,
  });

  const [editorState, setEditorState] = useState<EditorState>({ mode: "create" });
  const [chainName, setChainName] = useState("");
  const [hopRows, setHopRows] = useState<HopRow[]>([]);
  const [formError, setFormError] = useState<string | null>(null);

  const profiles = profilesQuery.data ?? [];
  const chains = chainsQuery.data ?? [];
  const selectedChain =
    editorState.mode === "edit"
      ? chains.find((chain) => chain.id === editorState.chainId) ?? null
      : null;

  useEffect(() => {
    if (editorState.mode === "edit") {
      const chain = chains.find((item) => item.id === editorState.chainId);
      if (!chain) {
        return;
      }

      setChainName(chain.name);
      setHopRows(chainHopRowsFromChain(chain));
      setFormError(null);
      return;
    }

    setChainName("");
    setHopRows([]);
    setFormError(null);
  }, [chains, editorState]);

  useEffect(() => {
    if (
      editorState.mode === "edit" &&
      chainsQuery.isSuccess &&
      !chains.some((chain) => chain.id === editorState.chainId)
    ) {
      setEditorState({ mode: "create" });
    }
  }, [chains, chainsQuery.isSuccess, editorState]);

  const createMutation = useMutation({
    mutationFn: createChain,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: chainsQueryKey });
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, payload }: { id: number; payload: ChainPayload }) =>
      updateChain(id, payload),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: chainsQueryKey });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: deleteChain,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: chainsQueryKey });
    },
  });

  const mutationError =
    createMutation.error ?? updateMutation.error ?? deleteMutation.error ?? null;
  const isSaving = createMutation.isPending || updateMutation.isPending;
  const isDeleting = deleteMutation.isPending;
  const isCreateMode = editorState.mode === "create";

  const sortedHopsForDiagram = useMemo((): ChainHopInput[] => {
    if (!selectedChain) {
      return [];
    }
    return [...selectedChain.hops].sort((a, b) => a.position - b.position);
  }, [selectedChain]);

  const routingQueries = useQueries({
    queries: sortedHopsForDiagram.map((h) => ({
      queryKey: ["routing", "by-hop", h.id] as const,
      queryFn: () => fetchRoutingByHop(h.id),
      enabled: editorState.mode === "edit" && sortedHopsForDiagram.length > 0,
    })),
  });

  const routingByChainHopId = useMemo(() => {
    const map = new Map<number, RoutingProfileInput>();
    sortedHopsForDiagram.forEach((h, index) => {
      const query = routingQueries[index];
      if (!query?.data) {
        return;
      }
      map.set(h.id, {
        chainHopId: query.data.chainHopId,
        defaultAction: query.data.defaultAction,
        rules: query.data.rules.map((rule) => ({
          position: rule.position,
          matchKind: rule.matchKind,
          matchValue: rule.matchValue,
          action: rule.action,
        })),
      });
    });
    return map;
  }, [routingQueries, sortedHopsForDiagram]);

  const routingFailedChainHopIds = useMemo(() => {
    const failed = new Set<number>();
    sortedHopsForDiagram.forEach((h, index) => {
      const query = routingQueries[index];
      if (query?.isError) {
        failed.add(h.id);
      }
    });
    return failed;
  }, [routingQueries, sortedHopsForDiagram]);

  const routingLoading = useMemo(
    () => routingQueries.some((query) => query.isPending || query.isFetching),
    [routingQueries],
  );

  const draftDiagramLabels = useMemo(() => {
    if (!isCreateMode) {
      return undefined;
    }

    return hopRows
      .map((row) => profiles.find((profile) => String(profile.id) === row.vpnProfileId)?.label)
      .filter((label): label is string => Boolean(label));
  }, [hopRows, isCreateMode, profiles]);

  const trafficDiagramKeyValue = useMemo(() => {
    if (editorState.mode === "create") {
      return trafficDiagramKey({
        mode: "create",
        draftVpnProfileIdsInOrder: hopRows.map((row) => row.vpnProfileId),
      });
    }
    return trafficDiagramKey({
      mode: "edit",
      chainId: editorState.chainId,
      hopIdsInOrder: sortedHopsForDiagram.map((h) => h.id),
    });
  }, [editorState, hopRows, sortedHopsForDiagram]);

  useLayoutEffect(() => {
    const element = diagramContainerRef.current;
    if (!element) {
      return;
    }

    const observer = new ResizeObserver(() => {
      setDiagramWidth(element.getBoundingClientRect().width);
    });

    observer.observe(element);
    setDiagramWidth(element.getBoundingClientRect().width);

    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    if (!diagramModalOpen) {
      return;
    }
    const el = modalDiagramContainerRef.current;
    if (!el) {
      return;
    }
    const ro = new ResizeObserver(() => {
      setModalDiagramWidth(el.getBoundingClientRect().width);
    });
    ro.observe(el);
    setModalDiagramWidth(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, [diagramModalOpen]);

  useEffect(() => {
    if (!diagramModalOpen) {
      return;
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setDiagramModalOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [diagramModalOpen]);

  useEffect(() => {
    if (diagramModalOpen) {
      modalCloseButtonRef.current?.focus();
    }
  }, [diagramModalOpen]);

  function makeHopRow() {
    return {
      key: nextHopKeyRef.current++,
      vpnProfileId: String(profiles[0]?.id ?? ""),
    };
  }

  function loadChainIntoEditor(chain: Chain) {
    setEditorState({ mode: "edit", chainId: chain.id });
    setChainName(chain.name);
    setHopRows(chainHopRowsFromChain(chain));
    setFormError(null);
  }

  function handleNewChain() {
    setEditorState({ mode: "create" });
  }

  function handleAddHop() {
    setHopRows((current) => [...current, makeHopRow()]);
    setFormError(null);
  }

  function handleRemoveHop(key: number) {
    setHopRows((current) => current.filter((row) => row.key !== key));
    setFormError(null);
  }

  function handleMoveHop(index: number, direction: -1 | 1) {
    setHopRows((current) => {
      const nextIndex = index + direction;
      if (nextIndex < 0 || nextIndex >= current.length) {
        return current;
      }

      const next = [...current];
      const [moved] = next.splice(index, 1);
      next.splice(nextIndex, 0, moved);
      return next;
    });
  }

  function handleHopChange(key: number, vpnProfileId: string) {
    setHopRows((current) =>
      current.map((row) => (row.key === key ? { ...row, vpnProfileId } : row)),
    );
    setFormError(null);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);

    const result = validateChain(chainName, hopRows);
    if (hasValidationError(result)) {
      setFormError(result.error);
      return;
    }

    if (editorState.mode === "create") {
      const created = await createMutation.mutateAsync(result.payload);
      loadChainIntoEditor(created);
      return;
    }

    const updated = await updateMutation.mutateAsync({
      id: editorState.chainId,
      payload: result.payload,
    });
    loadChainIntoEditor(updated);
  }

  async function handleDelete(chain: Chain) {
    if (!window.confirm(`Delete chain "${chain.name}"?`)) {
      return;
    }

    await deleteMutation.mutateAsync(chain.id);
    if (editorState.mode === "edit" && editorState.chainId === chain.id) {
      setEditorState({ mode: "create" });
    }
  }

  const saveLabel = isCreateMode
    ? isSaving
      ? "Creating..."
      : "Create chain"
    : isSaving
      ? "Saving..."
      : "Save changes";

  return (
    <div style={chainsPageRootStackStyle}>
      <section style={cardStyle}>
        <div style={headerRowStyle}>
          <div>
            <div style={eyebrowStyle}>Chains</div>
            <h2 style={pageTitleStyle}>VPN chains</h2>
            <p style={helperTextStyle}>
              Build ordered multi-hop routes by combining the VPN profiles you already
              manage.
            </p>
          </div>
          <button
            disabled={isSaving}
            onClick={handleNewChain}
            style={primaryButtonStyle}
            type="button"
          >
            New chain
          </button>
        </div>

        {chainsQuery.isPending ? (
          <div style={emptyStateStyle}>Loading chains...</div>
        ) : chainsQuery.isError ? (
          <div style={errorStyle}>{getErrorMessage(chainsQuery.error)}</div>
        ) : chains.length === 0 ? (
          <div style={emptyStateStyle}>No chains yet. Create one to get started.</div>
        ) : (
          <div style={{ marginTop: "20px" }}>
            <div style={chainRailStyle}>
              {chains.map((chain) => {
                const isSelected =
                  editorState.mode === "edit" && editorState.chainId === chain.id;
                const isDeletingThisChain =
                  isDeleting && deleteMutation.variables === chain.id;

                return (
                  <article
                    key={chain.id}
                    style={{
                      ...chainCardStyle,
                      borderColor: isSelected ? "#111827" : "#e5e7eb",
                      background: isSelected ? "#f9fafb" : "#ffffff",
                      minWidth: "240px",
                      flex: "0 0 auto",
                    }}
                  >
                    <div style={chainCardContentStyle}>
                      <div>
                        <h3 style={chainNameStyle}>{chain.name}</h3>
                        <div style={chainMetaStyle}>
                          {chain.vpnProfileIds.length}{" "}
                          {chain.vpnProfileIds.length === 1 ? "hop" : "hops"}
                        </div>
                      </div>
                      <div style={actionRowStyle}>
                        <button
                          disabled={isSaving || isDeletingThisChain}
                          onClick={() => loadChainIntoEditor(chain)}
                          style={secondaryButtonStyle}
                          type="button"
                        >
                          {isSelected ? "Editing" : "Edit"}
                        </button>
                        <button
                          disabled={isDeletingThisChain}
                          onClick={() => void handleDelete(chain)}
                          style={dangerButtonStyle}
                          type="button"
                        >
                          {isDeletingThisChain ? "Deleting..." : "Delete"}
                        </button>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          </div>
        )}
      </section>

      <section style={cardStyle}>
        <div style={editorHeaderStyle}>
          <div>
            <div style={eyebrowStyle}>
              {isCreateMode ? "New chain" : `Editing #${selectedChain?.id ?? ""}`}
            </div>
            <h2 style={pageTitleStyle}>{isCreateMode ? "Chain builder" : "Edit chain"}</h2>
            <p style={helperTextStyle}>
              Choose an ordered list of VPN profile hops. The first hop is the chain
              entry point.
            </p>
          </div>
        </div>

        {mutationError ? <div style={errorStyle}>{getErrorMessage(mutationError)}</div> : null}

        <form onSubmit={(event) => void handleSubmit(event)} style={formStyle}>
          <label style={labelStyle}>
            Chain name
            <input
              autoFocus
              onChange={(event) => {
                setChainName(event.target.value);
                setFormError(null);
              }}
              style={inputStyle}
              value={chainName}
            />
          </label>

          <div style={sectionHeaderStyle}>
            <div>
              <h3 style={sectionTitleStyle}>Hops</h3>
              <p style={helperTextStyle}>Reorder the selected VPN profiles to define the path.</p>
            </div>
            <button
              disabled={profilesQuery.isPending || profiles.length === 0}
              onClick={handleAddHop}
              style={secondaryButtonStyle}
              type="button"
            >
              Add hop
            </button>
          </div>

          {profilesQuery.isPending ? (
            <div style={emptyStateStyle}>Loading VPN profiles...</div>
          ) : profilesQuery.isError ? (
            <div style={errorStyle}>{getErrorMessage(profilesQuery.error)}</div>
          ) : profiles.length === 0 ? (
            <div style={emptyStateStyle}>
              No VPN profiles available yet. Create one on the VPNs page before building a
              chain.
            </div>
          ) : hopRows.length === 0 ? (
            <div style={emptyStateStyle}>Add your first hop to start building the chain.</div>
          ) : (
            <div style={hopListStyle}>
              {hopRows.map((row, index) => {
                const selectedProfileExists = profiles.some(
                  (profile) => String(profile.id) === row.vpnProfileId,
                );

                return (
                  <div key={row.key} style={hopRowStyle}>
                    <div style={hopIndexStyle}>Hop {index + 1}</div>
                    <select
                      onChange={(event) => handleHopChange(row.key, event.target.value)}
                      style={selectStyle}
                      value={row.vpnProfileId}
                    >
                      {!selectedProfileExists && row.vpnProfileId !== "" ? (
                        <option value={row.vpnProfileId}>
                          Profile {row.vpnProfileId} (unavailable)
                        </option>
                      ) : null}
                      {profiles.map((profile) => (
                        <option key={profile.id} value={String(profile.id)}>
                          #{profile.id} {profile.label}
                        </option>
                      ))}
                    </select>
                    <div style={actionRowStyle}>
                      <button
                        disabled={index === 0}
                        onClick={() => handleMoveHop(index, -1)}
                        style={secondaryButtonStyle}
                        type="button"
                      >
                        Up
                      </button>
                      <button
                        disabled={index === hopRows.length - 1}
                        onClick={() => handleMoveHop(index, 1)}
                        style={secondaryButtonStyle}
                        type="button"
                      >
                        Down
                      </button>
                      <button
                        onClick={() => handleRemoveHop(row.key)}
                        style={dangerButtonStyle}
                        type="button"
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {formError ? <div style={errorStyle}>{formError}</div> : null}

          <div style={editorActionsStyle}>
            <button
              disabled={isSaving}
              onClick={handleNewChain}
              style={ghostButtonStyle}
              type="button"
            >
              Reset editor
            </button>
            <button
              disabled={isSaving || profilesQuery.isPending}
              style={primaryButtonStyle}
              type="submit"
            >
              {saveLabel}
            </button>
          </div>
        </form>
      </section>

      <section style={cardStyle}>
        <div style={sectionHeaderStyle}>
          <h3 style={{ ...sectionTitleStyle, margin: 0 }}>Traffic diagram</h3>
          <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
            <button
              type="button"
              aria-haspopup="dialog"
              aria-expanded={diagramModalOpen}
              aria-label="Expand diagram"
              onClick={() => setDiagramModalOpen(true)}
              style={ghostButtonStyle}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 14 14"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                style={{ display: "block" }}
              >
                <path d="M1 5V1h4M9 1h4v4M13 9v4H9M5 13H1V9" />
              </svg>
            </button>
          </div>
        </div>
        <p style={helperTextStyle}>
          VPN hop order and per-hop routing. Edit routing rules on the Routing page.
        </p>
        <div ref={diagramContainerRef} style={diagramMeasureStyle}>
          {diagramWidth > 0 ? (
            <ChainTrafficDiagram
              diagramKey={trafficDiagramKeyValue}
              draftLabels={draftDiagramLabels}
              hops={isCreateMode ? [] : sortedHopsForDiagram}
              routingByChainHopId={routingByChainHopId}
              routingFailedChainHopIds={routingFailedChainHopIds}
              routingLoading={routingLoading}
              width={diagramWidth}
            />
          ) : null}
        </div>
      </section>

      {diagramModalOpen ? (
        <div
          role="presentation"
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 50,
            background: "rgba(15, 23, 42, 0.45)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "24px",
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="traffic-diagram-dialog-title"
            style={{
              width: "min(96vw, 1100px)",
              maxHeight: "90vh",
              overflow: "auto",
              borderRadius: "16px",
              background: "#ffffff",
              boxShadow: "0 24px 64px rgba(15, 23, 42, 0.2)",
              padding: "20px",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: "12px",
              }}
            >
              <h3
                id="traffic-diagram-dialog-title"
                style={{ ...sectionTitleStyle, margin: 0 }}
              >
                Traffic diagram
              </h3>
              <button
                ref={modalCloseButtonRef}
                type="button"
                aria-label="Close diagram"
                onClick={() => setDiagramModalOpen(false)}
                style={ghostButtonStyle}
              >
                Close
              </button>
            </div>
            <div ref={modalDiagramContainerRef} style={{ width: "100%", minHeight: 240 }}>
              {modalDiagramWidth > 0 ? (
                <ChainTrafficDiagram
                  diagramKey={trafficDiagramKeyValue}
                  draftLabels={draftDiagramLabels}
                  hops={isCreateMode ? [] : sortedHopsForDiagram}
                  routingByChainHopId={routingByChainHopId}
                  routingFailedChainHopIds={routingFailedChainHopIds}
                  routingLoading={routingLoading}
                  width={modalDiagramWidth}
                />
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

const cardStyle: CSSProperties = {
  padding: "24px",
  borderRadius: "16px",
  background: "#ffffff",
  boxShadow: "0 16px 40px rgba(15, 23, 42, 0.08)",
};

const headerRowStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: "16px",
};

const editorHeaderStyle: CSSProperties = {
  marginBottom: "24px",
};

const diagramMeasureStyle: CSSProperties = {
  marginTop: "12px",
  width: "100%",
};

const sectionHeaderStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: "16px",
};

const pageTitleStyle: CSSProperties = {
  margin: "8px 0 12px",
  fontSize: "1.75rem",
  color: "#111827",
};

const sectionTitleStyle: CSSProperties = {
  margin: "0 0 8px",
  fontSize: "1.15rem",
  color: "#111827",
};

const eyebrowStyle: CSSProperties = {
  fontSize: "0.75rem",
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  color: "#6b7280",
};

const helperTextStyle: CSSProperties = {
  margin: 0,
  color: "#4b5563",
  lineHeight: 1.5,
};

const chainCardStyle: CSSProperties = {
  padding: "16px",
  border: "1px solid #e5e7eb",
  borderRadius: "14px",
};

const chainCardContentStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: "16px",
};

const chainNameStyle: CSSProperties = {
  margin: 0,
  fontSize: "1rem",
  color: "#111827",
};

const chainMetaStyle: CSSProperties = {
  marginTop: "6px",
  color: "#4b5563",
  fontSize: "0.95rem",
};

const formStyle: CSSProperties = {
  display: "grid",
  gap: "20px",
};

const labelStyle: CSSProperties = {
  display: "grid",
  gap: "8px",
  fontWeight: 600,
  color: "#111827",
};

const inputStyle: CSSProperties = {
  width: "100%",
  padding: "12px 14px",
  border: "1px solid #d1d5db",
  borderRadius: "10px",
  fontSize: "1rem",
  boxSizing: "border-box",
};

const selectStyle: CSSProperties = {
  ...inputStyle,
  minWidth: 0,
};

const hopListStyle: CSSProperties = {
  display: "grid",
  gap: "12px",
};

const hopRowStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "auto minmax(0, 1fr) auto",
  gap: "12px",
  alignItems: "center",
  padding: "14px",
  borderRadius: "14px",
  border: "1px solid #e5e7eb",
  background: "#f9fafb",
};

const hopIndexStyle: CSSProperties = {
  minWidth: "56px",
  fontWeight: 700,
  color: "#374151",
};

const actionRowStyle: CSSProperties = {
  display: "flex",
  gap: "8px",
  flexWrap: "wrap",
};

const baseButtonStyle: CSSProperties = {
  padding: "10px 14px",
  borderRadius: "10px",
  fontSize: "0.95rem",
  fontWeight: 600,
  cursor: "pointer",
  border: "1px solid transparent",
};

const primaryButtonStyle: CSSProperties = {
  ...baseButtonStyle,
  background: "#111827",
  color: "#ffffff",
};

const secondaryButtonStyle: CSSProperties = {
  ...baseButtonStyle,
  background: "#ffffff",
  color: "#111827",
  borderColor: "#d1d5db",
};

const ghostButtonStyle: CSSProperties = {
  ...baseButtonStyle,
  background: "#ffffff",
  color: "#111827",
  borderColor: "#d1d5db",
};

const dangerButtonStyle: CSSProperties = {
  ...baseButtonStyle,
  background: "#fef2f2",
  color: "#b91c1c",
  borderColor: "#fecaca",
};

const editorActionsStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: "12px",
  flexWrap: "wrap",
};

const emptyStateStyle: CSSProperties = {
  marginTop: "24px",
  padding: "24px",
  borderRadius: "14px",
  background: "#f9fafb",
  color: "#4b5563",
  border: "1px dashed #d1d5db",
};

const errorStyle: CSSProperties = {
  marginTop: "16px",
  padding: "12px 14px",
  borderRadius: "10px",
  background: "#fef2f2",
  color: "#b91c1c",
  border: "1px solid #fecaca",
};
