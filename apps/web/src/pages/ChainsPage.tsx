import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CSSProperties, FormEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { ApiError, apiFetch } from "../api/client";

const chainsQueryKey = ["chains"] as const;
const profilesQueryKey = ["profiles"] as const;

type Chain = {
  id: number;
  name: string;
  vpnProfileIds: number[];
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
      setHopRows(
        chain.vpnProfileIds.map((vpnProfileId) => ({
          key: nextHopKeyRef.current++,
          vpnProfileId: String(vpnProfileId),
        })),
      );
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

  function makeHopRow() {
    return {
      key: nextHopKeyRef.current++,
      vpnProfileId: String(profiles[0]?.id ?? ""),
    };
  }

  function loadChainIntoEditor(chain: Chain) {
    setEditorState({ mode: "edit", chainId: chain.id });
    setChainName(chain.name);
    setHopRows(
      chain.vpnProfileIds.map((vpnProfileId) => ({
        key: nextHopKeyRef.current++,
        vpnProfileId: String(vpnProfileId),
      })),
    );
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
    <div style={pageGridStyle}>
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
          <div style={listStyle}>
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
    </div>
  );
}

const pageGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(280px, 360px) minmax(0, 1fr)",
  gap: "24px",
  alignItems: "start",
};

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

const listStyle: CSSProperties = {
  marginTop: "24px",
  display: "grid",
  gap: "12px",
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
