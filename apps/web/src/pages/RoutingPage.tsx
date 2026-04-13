import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CSSProperties, FormEvent, MutableRefObject } from "react";
import { useEffect, useRef, useState } from "react";
import { ApiError, apiFetch } from "../api/client";

const chainsQueryKey = ["chains"] as const;

type ChainHop = {
  id: number;
  position: number;
  vpnProfileId: number;
  label: string;
};

type Chain = {
  id: number;
  name: string;
  hops: ChainHop[];
};

type DefaultAction = "use_chain" | "direct";
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

type RoutingRuleInput = {
  matchKind: MatchKind;
  matchValue: string;
  action: RuleAction;
};

type RoutingPatchPayload = {
  defaultAction: DefaultAction;
  rules: RoutingRuleInput[];
};

type RuleRow = {
  key: number;
  matchKind: MatchKind;
  matchValue: string;
  action: RuleAction;
};

function routingProfileQueryKey(chainHopId: number) {
  return ["routing", "by-hop", chainHopId] as const;
}

function fetchChains() {
  return apiFetch<Chain[]>("/api/chains");
}

function fetchRoutingProfileByHop(chainHopId: number) {
  return apiFetch<RoutingProfile>(`/api/routing/by-hop/${chainHopId}`);
}

function updateRoutingProfile(routingProfileId: number, payload: RoutingPatchPayload) {
  return apiFetch<RoutingProfile>(`/api/routing/${routingProfileId}`, {
    method: "PATCH",
    body: payload,
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

function validateRoutingForm(
  defaultAction: DefaultAction,
  ruleRows: RuleRow[],
): { payload: RoutingPatchPayload } | { error: string } {
  const rules = ruleRows.map((rule) => ({
    matchKind: rule.matchKind,
    matchValue: rule.matchValue.trim(),
    action: rule.action,
  }));

  if (rules.some((rule) => rule.matchValue === "")) {
    return { error: "Each rule must include a match value." };
  }

  return {
    payload: {
      defaultAction,
      rules,
    },
  };
}

function hasValidationError(
  result: ReturnType<typeof validateRoutingForm>,
): result is { error: string } {
  return "error" in result;
}

function profileToRuleRows(profile: RoutingProfile, nextRuleKeyRef: MutableRefObject<number>) {
  return profile.rules.map((rule) => ({
    key: nextRuleKeyRef.current++,
    matchKind: rule.matchKind,
    matchValue: rule.matchValue,
    action: rule.action,
  }));
}

export default function RoutingPage() {
  const queryClient = useQueryClient();
  const nextRuleKeyRef = useRef(0);
  const prevSelectedChainIdRef = useRef<number | null>(null);

  const chainsQuery = useQuery({
    queryKey: chainsQueryKey,
    queryFn: fetchChains,
  });

  const [selectedChainId, setSelectedChainId] = useState<number | null>(null);
  const [selectedChainHopId, setSelectedChainHopId] = useState<number | null>(null);
  const [routingProfileId, setRoutingProfileId] = useState<number | null>(null);
  const [defaultAction, setDefaultAction] = useState<DefaultAction>("use_chain");
  const [ruleRows, setRuleRows] = useState<RuleRow[]>([]);
  const [formError, setFormError] = useState<string | null>(null);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  const chains = chainsQuery.data ?? [];
  const selectedChain = chains.find((chain) => chain.id === selectedChainId) ?? null;

  useEffect(() => {
    if (!chainsQuery.isSuccess) {
      return;
    }

    if (chains.length === 0) {
      setSelectedChainId(null);
      setSelectedChainHopId(null);
      setRoutingProfileId(null);
      setDefaultAction("use_chain");
      setRuleRows([]);
      return;
    }

    setSelectedChainId((current) => {
      if (current !== null && chains.some((chain) => chain.id === current)) {
        return current;
      }

      return chains[0].id;
    });
  }, [chains, chainsQuery.isSuccess]);

  useEffect(() => {
    if (prevSelectedChainIdRef.current === selectedChainId) {
      return;
    }
    prevSelectedChainIdRef.current = selectedChainId;

    if (selectedChainId === null) {
      setSelectedChainHopId(null);
      return;
    }

    const chain = chains.find((c) => c.id === selectedChainId);
    const firstHop = chain?.hops[0];
    setSelectedChainHopId(firstHop?.id ?? null);
  }, [selectedChainId, chains]);

  const routingProfileQuery = useQuery({
    queryKey:
      selectedChainHopId === null ? (["routing", "by-hop", "none"] as const) : routingProfileQueryKey(selectedChainHopId),
    queryFn: () => fetchRoutingProfileByHop(selectedChainHopId!),
    enabled: selectedChainHopId !== null,
  });

  useEffect(() => {
    if (!routingProfileQuery.data) {
      return;
    }

    setRoutingProfileId(routingProfileQuery.data.id);
    setDefaultAction(routingProfileQuery.data.defaultAction);
    setRuleRows(profileToRuleRows(routingProfileQuery.data, nextRuleKeyRef));
    setFormError(null);
  }, [routingProfileQuery.data]);

  const saveMutation = useMutation({
    mutationFn: ({ id, payload }: { id: number; payload: RoutingPatchPayload }) =>
      updateRoutingProfile(id, payload),
    onSuccess: async (profile) => {
      queryClient.setQueryData(routingProfileQueryKey(profile.chainHopId), profile);
      await queryClient.invalidateQueries({ queryKey: routingProfileQueryKey(profile.chainHopId) });
      setRoutingProfileId(profile.id);
      setDefaultAction(profile.defaultAction);
      setRuleRows(profileToRuleRows(profile, nextRuleKeyRef));
      setSaveMessage("Routing rules saved.");
    },
  });

  function makeRuleRow(): RuleRow {
    return {
      key: nextRuleKeyRef.current++,
      matchKind: "domain",
      matchValue: "",
      action: "use_chain",
    };
  }

  function clearFeedback() {
    setFormError(null);
    setSaveMessage(null);
  }

  function handleChainChange(chainId: string) {
    const nextChainId = Number(chainId);
    const resolved =
      Number.isInteger(nextChainId) && nextChainId > 0 ? nextChainId : null;
    setSelectedChainId(resolved);
    const chain = resolved !== null ? chains.find((c) => c.id === resolved) : null;
    setSelectedChainHopId(chain?.hops[0]?.id ?? null);
    setRoutingProfileId(null);
    setDefaultAction("use_chain");
    setRuleRows([]);
    clearFeedback();
  }

  function handleHopChange(chainHopId: string) {
    const nextHopId = Number(chainHopId);
    setSelectedChainHopId(Number.isInteger(nextHopId) && nextHopId > 0 ? nextHopId : null);
    setRoutingProfileId(null);
    setDefaultAction("use_chain");
    setRuleRows([]);
    clearFeedback();
  }

  function handleAddRule() {
    setRuleRows((current) => [...current, makeRuleRow()]);
    clearFeedback();
  }

  function handleRemoveRule(key: number) {
    setRuleRows((current) => current.filter((row) => row.key !== key));
    clearFeedback();
  }

  function handleMoveRule(index: number, direction: -1 | 1) {
    setRuleRows((current) => {
      const nextIndex = index + direction;
      if (nextIndex < 0 || nextIndex >= current.length) {
        return current;
      }

      const next = [...current];
      const [moved] = next.splice(index, 1);
      next.splice(nextIndex, 0, moved);
      return next;
    });
    clearFeedback();
  }

  function handleRuleChange(key: number, patch: Partial<Omit<RuleRow, "key">>) {
    setRuleRows((current) =>
      current.map((row) => (row.key === key ? { ...row, ...patch } : row)),
    );
    clearFeedback();
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    clearFeedback();

    if (routingProfileId === null) {
      setFormError("Select a chain hop with a routing profile before saving.");
      return;
    }

    const result = validateRoutingForm(defaultAction, ruleRows);
    if (hasValidationError(result)) {
      setFormError(result.error);
      return;
    }

    await saveMutation.mutateAsync({
      id: routingProfileId,
      payload: result.payload,
    });
  }

  const mutationError = saveMutation.error;
  const isSaving = saveMutation.isPending;

  return (
    <section style={cardStyle}>
      <div style={headerRowStyle}>
        <div>
          <div style={eyebrowStyle}>Routing</div>
          <h2 style={pageTitleStyle}>Routing rules editor</h2>
          <p style={helperTextStyle}>
            Choose a chain and hop, define default handling for that hop, and add ordered domain
            or CIDR overrides.
          </p>
        </div>
        <button
          disabled={isSaving || selectedChainHopId === null}
          onClick={handleAddRule}
          style={secondaryButtonStyle}
          type="button"
        >
          Add rule
        </button>
      </div>

      {chainsQuery.isPending ? (
        <div style={emptyStateStyle}>Loading chains...</div>
      ) : chainsQuery.isError ? (
        <div style={errorStyle}>{getErrorMessage(chainsQuery.error)}</div>
      ) : chains.length === 0 ? (
        <div style={emptyStateStyle}>
          No chains available yet. Create a chain with hops before editing routing rules.
        </div>
      ) : (
        <form onSubmit={(event) => void handleSubmit(event)} style={formStyle}>
          <label style={labelStyle}>
            Chain
            <select
              onChange={(event) => handleChainChange(event.target.value)}
              style={inputStyle}
              value={selectedChainId === null ? "" : String(selectedChainId)}
            >
              {chains.map((chain) => (
                <option key={chain.id} value={String(chain.id)}>
                  #{chain.id} {chain.name}
                </option>
              ))}
            </select>
          </label>

          {selectedChain && selectedChain.hops.length > 0 ? (
            <label style={labelStyle}>
              Hop
              <select
                onChange={(event) => handleHopChange(event.target.value)}
                style={inputStyle}
                value={selectedChainHopId === null ? "" : String(selectedChainHopId)}
              >
                {selectedChain.hops.map((hop) => (
                  <option key={hop.id} value={String(hop.id)}>
                    #{hop.position + 1} — {hop.label}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          {selectedChain ? (
            <div style={summaryCardStyle}>
              <div style={summaryLabelStyle}>Selected chain</div>
              <div style={summaryValueStyle}>{selectedChain.name}</div>
              <div style={summaryMetaStyle}>
                {selectedChainHopId === null
                  ? selectedChain.hops.length === 0
                    ? "This chain has no hops yet."
                    : "Select a hop to load its routing profile."
                  : (routingProfileQuery.data?.name ?? "Loading routing profile...")}
              </div>
            </div>
          ) : null}

          {selectedChain && selectedChain.hops.length === 0 ? (
            <div style={emptyStateStyle}>
              This chain has no hops yet. Add hops on the Chains page, then return here to edit
              routing per hop.
            </div>
          ) : routingProfileQuery.isPending ? (
            <div style={emptyStateStyle}>Loading routing profile...</div>
          ) : selectedChainHopId === null ? (
            <div style={emptyStateStyle}>Select a hop to edit routing rules.</div>
          ) : routingProfileQuery.isError ? (
            <div style={errorStyle}>{getErrorMessage(routingProfileQuery.error)}</div>
          ) : (
            <>
              <fieldset style={fieldsetStyle}>
                <legend style={legendStyle}>Default action</legend>
                <div style={radioRowStyle}>
                  <label style={radioLabelStyle}>
                    <input
                      checked={defaultAction === "use_chain"}
                      name="defaultAction"
                      onChange={() => {
                        setDefaultAction("use_chain");
                        clearFeedback();
                      }}
                      type="radio"
                    />
                    Use chain
                  </label>
                  <label style={radioLabelStyle}>
                    <input
                      checked={defaultAction === "direct"}
                      name="defaultAction"
                      onChange={() => {
                        setDefaultAction("direct");
                        clearFeedback();
                      }}
                      type="radio"
                    />
                    Direct
                  </label>
                </div>
              </fieldset>

              <div style={sectionHeaderStyle}>
                <div>
                  <h3 style={sectionTitleStyle}>Rules</h3>
                  <p style={helperTextStyle}>
                    Earlier rows run first. Use domain rules for suffix matching and CIDR rules
                    for network ranges.
                  </p>
                </div>
              </div>

              {ruleRows.length === 0 ? (
                <div style={emptyStateStyle}>
                  No custom rules yet. Add one to override the default action.
                </div>
              ) : (
                <div style={tableWrapperStyle}>
                  <table style={tableStyle}>
                    <thead>
                      <tr>
                        <th style={tableHeadCellStyle}>Match kind</th>
                        <th style={tableHeadCellStyle}>Match value</th>
                        <th style={tableHeadCellStyle}>Action</th>
                        <th style={tableHeadCellStyle}>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {ruleRows.map((row, index) => (
                        <tr key={row.key}>
                          <td style={tableBodyCellStyle}>
                            <select
                              onChange={(event) =>
                                handleRuleChange(row.key, {
                                  matchKind: event.target.value as MatchKind,
                                })
                              }
                              style={cellInputStyle}
                              value={row.matchKind}
                            >
                              <option value="domain">domain</option>
                              <option value="cidr">cidr</option>
                            </select>
                          </td>
                          <td style={tableBodyCellStyle}>
                            <input
                              onChange={(event) =>
                                handleRuleChange(row.key, { matchValue: event.target.value })
                              }
                              placeholder={row.matchKind === "domain" ? ".example.com" : "10.0.0.0/8"}
                              style={cellInputStyle}
                              value={row.matchValue}
                            />
                          </td>
                          <td style={tableBodyCellStyle}>
                            <select
                              onChange={(event) =>
                                handleRuleChange(row.key, {
                                  action: event.target.value as RuleAction,
                                })
                              }
                              style={cellInputStyle}
                              value={row.action}
                            >
                              <option value="use_chain">use_chain</option>
                              <option value="direct">direct</option>
                              <option value="block">block</option>
                            </select>
                          </td>
                          <td style={tableBodyCellStyle}>
                            <div style={actionRowStyle}>
                              <button
                                disabled={index === 0}
                                onClick={() => handleMoveRule(index, -1)}
                                style={secondaryButtonStyle}
                                type="button"
                              >
                                Up
                              </button>
                              <button
                                disabled={index === ruleRows.length - 1}
                                onClick={() => handleMoveRule(index, 1)}
                                style={secondaryButtonStyle}
                                type="button"
                              >
                                Down
                              </button>
                              <button
                                onClick={() => handleRemoveRule(row.key)}
                                style={dangerButtonStyle}
                                type="button"
                              >
                                Remove
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}

          {formError ? <div style={errorStyle}>{formError}</div> : null}
          {mutationError ? <div style={errorStyle}>{getErrorMessage(mutationError)}</div> : null}
          {saveMessage ? <div style={successStyle}>{saveMessage}</div> : null}

          <div style={editorActionsStyle}>
            <button
              disabled={
                isSaving ||
                selectedChainHopId === null ||
                routingProfileQuery.isPending ||
                routingProfileQuery.isError
              }
              style={primaryButtonStyle}
              type="submit"
            >
              {isSaving ? "Saving..." : "Save changes"}
            </button>
          </div>
        </form>
      )}
    </section>
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

const pageTitleStyle: CSSProperties = {
  margin: "8px 0 12px",
  fontSize: "1.75rem",
  color: "#111827",
};

const sectionTitleStyle: CSSProperties = {
  margin: 0,
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

const formStyle: CSSProperties = {
  marginTop: "24px",
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
  background: "#ffffff",
};

const cellInputStyle: CSSProperties = {
  ...inputStyle,
  minWidth: 0,
};

const summaryCardStyle: CSSProperties = {
  padding: "16px",
  borderRadius: "14px",
  border: "1px solid #e5e7eb",
  background: "#f9fafb",
};

const summaryLabelStyle: CSSProperties = {
  fontSize: "0.75rem",
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  color: "#6b7280",
};

const summaryValueStyle: CSSProperties = {
  marginTop: "8px",
  fontSize: "1.1rem",
  fontWeight: 700,
  color: "#111827",
};

const summaryMetaStyle: CSSProperties = {
  marginTop: "6px",
  color: "#4b5563",
};

const fieldsetStyle: CSSProperties = {
  margin: 0,
  padding: "16px",
  borderRadius: "14px",
  border: "1px solid #e5e7eb",
};

const legendStyle: CSSProperties = {
  padding: "0 6px",
  fontWeight: 700,
  color: "#111827",
};

const radioRowStyle: CSSProperties = {
  display: "flex",
  gap: "20px",
  flexWrap: "wrap",
};

const radioLabelStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "8px",
  color: "#111827",
};

const sectionHeaderStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: "16px",
};

const tableWrapperStyle: CSSProperties = {
  overflowX: "auto",
  border: "1px solid #e5e7eb",
  borderRadius: "14px",
};

const tableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
};

const tableHeadCellStyle: CSSProperties = {
  padding: "14px 16px",
  textAlign: "left",
  fontSize: "0.875rem",
  color: "#374151",
  background: "#f9fafb",
  borderBottom: "1px solid #e5e7eb",
};

const tableBodyCellStyle: CSSProperties = {
  padding: "14px 16px",
  color: "#111827",
  borderBottom: "1px solid #e5e7eb",
  verticalAlign: "middle",
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

const dangerButtonStyle: CSSProperties = {
  ...baseButtonStyle,
  background: "#fef2f2",
  color: "#b91c1c",
  borderColor: "#fecaca",
};

const editorActionsStyle: CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
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
  padding: "12px 14px",
  borderRadius: "10px",
  background: "#fef2f2",
  color: "#b91c1c",
  border: "1px solid #fecaca",
};

const successStyle: CSSProperties = {
  padding: "12px 14px",
  borderRadius: "10px",
  background: "#ecfdf5",
  color: "#047857",
  border: "1px solid #a7f3d0",
};
