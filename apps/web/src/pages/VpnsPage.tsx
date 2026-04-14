import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CSSProperties, FormEvent, KeyboardEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError, apiFetch } from "../api/client";

const profilesQueryKey = ["profiles"] as const;

type VpnProfile = {
  id: number;
  label: string;
  host: string;
  sshPort: number;
  sshUser: string;
  operationalStatus: "pending" | "working";
  createdAt: string;
  updatedAt: string;
};

type ProfileFormValues = {
  label: string;
  host: string;
  sshPort: string;
  sshUser: string;
  sshPassword: string;
};

type ModalState =
  | { mode: "create" }
  | { mode: "edit"; profile: VpnProfile }
  | null;

const emptyFormValues: ProfileFormValues = {
  label: "",
  host: "",
  sshPort: "22",
  sshUser: "",
  sshPassword: "",
};

function fetchProfiles() {
  return apiFetch<VpnProfile[]>("/api/profiles");
}

function createProfile(payload: {
  label: string;
  host: string;
  sshPort: number;
  sshUser: string;
  sshPassword: string;
}) {
  return apiFetch<VpnProfile>("/api/profiles", {
    method: "POST",
    body: payload,
  });
}

function updateProfile(
  id: number,
  payload: {
    label: string;
    host: string;
    sshPort: number;
    sshUser: string;
    sshPassword?: string;
  },
) {
  return apiFetch<VpnProfile>(`/api/profiles/${id}`, {
    method: "PATCH",
    body: payload,
  });
}

function deleteProfile(id: number) {
  return apiFetch<{ ok: true }>(`/api/profiles/${id}`, {
    method: "DELETE",
  });
}

function setupProfile(id: number) {
  return apiFetch<VpnProfile>(`/api/profiles/${id}/setup`, {
    method: "POST",
  });
}

function getInitialValues(modalState: ModalState): ProfileFormValues {
  if (!modalState || modalState.mode === "create") {
    return emptyFormValues;
  }

  return {
    label: modalState.profile.label,
    host: modalState.profile.host,
    sshPort: String(modalState.profile.sshPort),
    sshUser: modalState.profile.sshUser,
    sshPassword: "",
  };
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

function validateFormValues(values: ProfileFormValues, requirePassword: boolean) {
  const label = values.label.trim();
  const host = values.host.trim();
  const sshUser = values.sshUser.trim();
  const sshPassword = values.sshPassword.trim();
  const sshPort = Number(values.sshPort);

  if (!label || !host || !sshUser) {
    return { error: "Label, host, and SSH user are required." };
  }

  if (!Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65535) {
    return { error: "SSH port must be an integer between 1 and 65535." };
  }

  if (requirePassword && sshPassword === "") {
    return { error: "SSH password is required for new profiles." };
  }

  return {
    payload: {
      label,
      host,
      sshPort,
      sshUser,
      sshPassword,
    },
  };
}

function hasValidationError(
  result: ReturnType<typeof validateFormValues>,
): result is { error: string } {
  return "error" in result;
}

type SshTerminalSheetProps = {
  profile: VpnProfile;
  onClose: () => void;
};

function SshTerminalSheet({ profile, onClose }: SshTerminalSheetProps) {
  const titleId = "ssh-sheet-title";
  const prompt = `${profile.sshUser}@${profile.host}:~$ `;
  const [lines, setLines] = useState<string[]>([
    "# Not a real SSH session — demo only. Type commands for your own notes.",
    "# Manual server prep — paste commands here (not executed).",
  ]);
  const [currentLine, setCurrentLine] = useState("");
  const terminalRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  useEffect(() => {
    function onKeyDown(e: globalThis.KeyboardEvent) {
      if (e.key === "Escape") {
        onClose();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  useEffect(() => {
    terminalRef.current?.focus();
  }, [profile.id]);

  function handleTerminalKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      setLines((prev) => [...prev, `${prompt}${currentLine}`]);
      setCurrentLine("");
      return;
    }
    if (e.key === "Backspace") {
      e.preventDefault();
      setCurrentLine((c) => c.slice(0, -1));
      return;
    }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      setCurrentLine((c) => c + e.key);
    }
  }

  return (
    <div style={sshBackdropStyle} role="presentation" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        style={sshSheetStyle}
        onClick={(event) => event.stopPropagation()}
      >
        <div style={sshSheetHeaderStyle}>
          <h3 id={titleId} style={sshSheetTitleStyle}>
            SSH — {profile.label}
          </h3>
          <button onClick={onClose} style={modalCloseButtonStyle} type="button">
            Close
          </button>
        </div>
        <div
          ref={terminalRef}
          tabIndex={0}
          style={sshTerminalStyle}
          onKeyDown={handleTerminalKeyDown}
        >
          {lines.map((line, i) => (
            <div key={i} style={sshTerminalLineStyle}>
              {line}
            </div>
          ))}
          <div style={sshTerminalLineStyle}>
            <span style={sshPromptStyle}>{prompt}</span>
            <span>{currentLine}</span>
            <span style={sshCaretStyle}>▍</span>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function VpnsPage() {
  const queryClient = useQueryClient();
  const profilesQuery = useQuery({
    queryKey: profilesQueryKey,
    queryFn: fetchProfiles,
  });

  const [modalState, setModalState] = useState<ModalState>(null);
  const [formValues, setFormValues] = useState<ProfileFormValues>(emptyFormValues);
  const [formError, setFormError] = useState<string | null>(null);
  const [setupActionError, setSetupActionError] = useState<string | null>(null);
  const [sshProfile, setSshProfile] = useState<VpnProfile | null>(null);

  useEffect(() => {
    setFormValues(getInitialValues(modalState));
    setFormError(null);
  }, [modalState]);

  const createMutation = useMutation({
    mutationFn: createProfile,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: profilesQueryKey });
      setModalState(null);
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, payload }: { id: number; payload: Parameters<typeof updateProfile>[1] }) =>
      updateProfile(id, payload),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: profilesQueryKey });
      setModalState(null);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: deleteProfile,
    onSuccess: async (_, deletedId) => {
      await queryClient.invalidateQueries({ queryKey: profilesQueryKey });
      setSshProfile((current) => (current?.id === deletedId ? null : current));
    },
  });

  const setupMutation = useMutation({
    mutationFn: setupProfile,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: profilesQueryKey });
    },
  });

  const mutationError = useMemo(() => {
    return createMutation.error ?? updateMutation.error ?? deleteMutation.error ?? null;
  }, [createMutation.error, deleteMutation.error, updateMutation.error]);

  const isSaving = createMutation.isPending || updateMutation.isPending;
  const isDeleting = deleteMutation.isPending;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);

    const requirePassword = modalState?.mode === "create";
    const result = validateFormValues(formValues, requirePassword);
    if (hasValidationError(result)) {
      setFormError(result.error);
      return;
    }

    if (modalState?.mode === "create") {
      await createMutation.mutateAsync(result.payload);
      return;
    }

    if (modalState?.mode === "edit") {
      const payload: Parameters<typeof updateProfile>[1] = {
        label: result.payload.label,
        host: result.payload.host,
        sshPort: result.payload.sshPort,
        sshUser: result.payload.sshUser,
      };

      if (result.payload.sshPassword !== "") {
        payload.sshPassword = result.payload.sshPassword;
      }

      await updateMutation.mutateAsync({
        id: modalState.profile.id,
        payload,
      });
    }
  }

  async function handleDelete(profile: VpnProfile) {
    if (!window.confirm(`Delete VPN profile "${profile.label}"?`)) {
      return;
    }

    await deleteMutation.mutateAsync(profile.id);
  }

  async function handleSetup(profile: VpnProfile) {
    setSetupActionError(null);
    try {
      await setupMutation.mutateAsync(profile.id);
    } catch (error) {
      setSetupActionError(getErrorMessage(error));
    }
  }

  const profiles = profilesQuery.data ?? [];
  const modalTitle = modalState?.mode === "edit" ? "Edit VPN profile" : "Add VPN profile";
  const saveLabel =
    modalState?.mode === "edit"
      ? isSaving
        ? "Saving..."
        : "Save changes"
      : isSaving
        ? "Creating..."
        : "Create profile";

  return (
    <>
      <section style={cardStyle}>
        <div style={headerRowStyle}>
          <div>
            <div style={eyebrowStyle}>Profiles</div>
            <h2 style={pageTitleStyle}>VPNs</h2>
            <p style={helperTextStyle}>
              Manage SSH-backed VPN profiles used by chains, routing, and export flows.
            </p>
          </div>
          <button onClick={() => setModalState({ mode: "create" })} style={primaryButtonStyle} type="button">
            Add profile
          </button>
        </div>

        {mutationError ? <div style={errorStyle}>{getErrorMessage(mutationError)}</div> : null}
        {setupActionError ? <div style={errorStyle}>{setupActionError}</div> : null}

        {profilesQuery.isPending ? (
          <div style={emptyStateStyle}>Loading profiles...</div>
        ) : profilesQuery.isError ? (
          <div style={errorStyle}>{getErrorMessage(profilesQuery.error)}</div>
        ) : profiles.length === 0 ? (
          <div style={emptyStateStyle}>No VPN profiles yet. Add one to get started.</div>
        ) : (
          <div style={tableWrapperStyle}>
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={tableHeadCellStyle}>Label</th>
                  <th style={tableHeadCellStyle}>Host</th>
                  <th style={tableHeadCellStyle}>SSH port</th>
                  <th style={tableHeadCellStyle}>User</th>
                  <th style={tableHeadCellStyle}>Status</th>
                  <th style={tableHeadCellStyle}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {profiles.map((profile) => {
                  const deleteDisabled = isDeleting && deleteMutation.variables === profile.id;
                  const editDisabled =
                    isSaving ||
                    (isDeleting && deleteMutation.variables !== undefined && deleteMutation.variables === profile.id);
                  const setupBusy = setupMutation.isPending && setupMutation.variables === profile.id;

                  return (
                    <tr key={profile.id}>
                      <td style={tableBodyCellStyle}>{profile.label}</td>
                      <td style={tableBodyCellStyle}>{profile.host}</td>
                      <td style={tableBodyCellStyle}>{profile.sshPort}</td>
                      <td style={tableBodyCellStyle}>{profile.sshUser}</td>
                      <td style={tableBodyCellStyle}>
                        {profile.operationalStatus === "working" ? (
                          <span style={statusWorkingStyle}>Working</span>
                        ) : (
                          <span style={statusPendingStyle}>Pending</span>
                        )}
                      </td>
                      <td style={tableBodyCellStyle}>
                        <div style={actionRowStyle}>
                          {profile.operationalStatus === "pending" ? (
                            <button
                              disabled={editDisabled || setupBusy}
                              onClick={() => void handleSetup(profile)}
                              style={primaryButtonStyle}
                              type="button"
                            >
                              {setupBusy ? "Setting up..." : "Setup"}
                            </button>
                          ) : null}
                          <button
                            disabled={editDisabled}
                            onClick={() => setSshProfile(profile)}
                            style={secondaryButtonStyle}
                            type="button"
                          >
                            SSH
                          </button>
                          <button
                            disabled={editDisabled}
                            onClick={() => setModalState({ mode: "edit", profile })}
                            style={secondaryButtonStyle}
                            type="button"
                          >
                            Edit
                          </button>
                          <button
                            disabled={deleteDisabled}
                            onClick={() => void handleDelete(profile)}
                            style={dangerButtonStyle}
                            type="button"
                          >
                            {deleteDisabled ? "Deleting..." : "Delete"}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {modalState ? (
        <div role="dialog" aria-modal="true" style={modalBackdropStyle}>
          <section style={modalCardStyle}>
            <div style={modalHeaderStyle}>
              <div>
                <div style={eyebrowStyle}>{modalState.mode === "edit" ? "Update profile" : "New profile"}</div>
                <h3 style={modalTitleStyle}>{modalTitle}</h3>
              </div>
              <button
                aria-label="Close profile modal"
                disabled={isSaving}
                onClick={() => setModalState(null)}
                style={modalCloseButtonStyle}
                type="button"
              >
                Close
              </button>
            </div>

            <form onSubmit={(event) => void handleSubmit(event)} style={formStyle}>
              <label style={labelStyle}>
                Label
                <input
                  autoFocus
                  onChange={(event) =>
                    setFormValues((current) => ({ ...current, label: event.target.value }))
                  }
                  style={inputStyle}
                  value={formValues.label}
                />
              </label>

              <label style={labelStyle}>
                Host
                <input
                  onChange={(event) =>
                    setFormValues((current) => ({ ...current, host: event.target.value }))
                  }
                  style={inputStyle}
                  value={formValues.host}
                />
              </label>

              <div style={formRowStyle}>
                <label style={labelStyle}>
                  SSH port
                  <input
                    inputMode="numeric"
                    onChange={(event) =>
                      setFormValues((current) => ({ ...current, sshPort: event.target.value }))
                    }
                    style={inputStyle}
                    value={formValues.sshPort}
                  />
                </label>

                <label style={labelStyle}>
                  SSH user
                  <input
                    onChange={(event) =>
                      setFormValues((current) => ({ ...current, sshUser: event.target.value }))
                    }
                    style={inputStyle}
                    value={formValues.sshUser}
                  />
                </label>
              </div>

              <label style={labelStyle}>
                SSH password {modalState.mode === "edit" ? "(optional)" : ""}
                <input
                  onChange={(event) =>
                    setFormValues((current) => ({ ...current, sshPassword: event.target.value }))
                  }
                  style={inputStyle}
                  type="password"
                  value={formValues.sshPassword}
                />
              </label>

              {formError ? <div style={errorStyle}>{formError}</div> : null}

              <div style={modalActionsStyle}>
                <button disabled={isSaving} onClick={() => setModalState(null)} style={ghostButtonStyle} type="button">
                  Cancel
                </button>
                <button disabled={isSaving} style={primaryButtonStyle} type="submit">
                  {saveLabel}
                </button>
              </div>
            </form>
          </section>
        </div>
      ) : null}

      {sshProfile ? <SshTerminalSheet profile={sshProfile} onClose={() => setSshProfile(null)} /> : null}
    </>
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

const tableWrapperStyle: CSSProperties = {
  marginTop: "24px",
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
  flexWrap: "wrap",
  gap: "8px",
};

const statusPendingStyle: CSSProperties = {
  display: "inline-block",
  padding: "4px 10px",
  borderRadius: "999px",
  fontSize: "0.8125rem",
  fontWeight: 600,
  background: "#fef3c7",
  color: "#92400e",
};

const statusWorkingStyle: CSSProperties = {
  display: "inline-block",
  padding: "4px 10px",
  borderRadius: "999px",
  fontSize: "0.8125rem",
  fontWeight: 600,
  background: "#d1fae5",
  color: "#065f46",
};

const sshBackdropStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 50,
  background: "rgba(17, 24, 39, 0.45)",
  display: "flex",
  alignItems: "flex-end",
  justifyContent: "center",
};

const sshSheetStyle: CSSProperties = {
  width: "100%",
  maxWidth: "960px",
  height: "50vh",
  maxHeight: "560px",
  background: "#ffffff",
  borderTopLeftRadius: "16px",
  borderTopRightRadius: "16px",
  boxShadow: "0 -12px 40px rgba(15, 23, 42, 0.18)",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
};

const sshSheetHeaderStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: "12px",
  padding: "16px 20px",
  borderBottom: "1px solid #e5e7eb",
};

const sshSheetTitleStyle: CSSProperties = {
  margin: 0,
  fontSize: "1.125rem",
  color: "#111827",
};

const sshTerminalStyle: CSSProperties = {
  flex: 1,
  overflow: "auto",
  padding: "16px 20px",
  background: "#0f172a",
  color: "#e2e8f0",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
  fontSize: "0.875rem",
  lineHeight: 1.5,
  outline: "none",
};

const sshTerminalLineStyle: CSSProperties = {
  whiteSpace: "pre-wrap",
  wordBreak: "break-all",
};

const sshPromptStyle: CSSProperties = {
  color: "#38bdf8",
};

const sshCaretStyle: CSSProperties = {
  color: "#94a3b8",
};

const formStyle: CSSProperties = {
  display: "grid",
  gap: "16px",
};

const formRowStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
  gap: "16px",
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

const modalBackdropStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(17, 24, 39, 0.45)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "24px",
};

const modalCardStyle: CSSProperties = {
  width: "100%",
  maxWidth: "560px",
  padding: "24px",
  borderRadius: "16px",
  background: "#ffffff",
  boxShadow: "0 20px 45px rgba(15, 23, 42, 0.2)",
};

const modalHeaderStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: "16px",
  marginBottom: "20px",
};

const modalTitleStyle: CSSProperties = {
  margin: "8px 0 0",
  fontSize: "1.5rem",
  color: "#111827",
};

const modalCloseButtonStyle: CSSProperties = {
  ...ghostButtonStyle,
  padding: "8px 12px",
};

const modalActionsStyle: CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: "12px",
};
