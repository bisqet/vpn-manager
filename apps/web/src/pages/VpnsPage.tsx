import "@xterm/xterm/css/xterm.css";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CSSProperties, FormEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError, type AuthUser, apiFetch } from "../api/client";
import { isFqdnPanel, isPublicIpLiteral } from "../lib/panelAddress";

const profilesQueryKey = ["profiles"] as const;

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

type SetupPhaseDto = {
  id: string;
  title: string;
  script: string;
  stdout?: string;
  stderr?: string;
  code?: number;
};

type SetupResponse = {
  profile: VpnProfile;
  setup: { mode: "dry-run" | "live"; phases: SetupPhaseDto[] };
};

type ProfileFormValues = {
  label: string;
  host: string;
  sshPort: string;
  sshUser: string;
  panelHostname: string;
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
  panelHostname: "",
  sshPassword: "",
};

const PROFILE_IN_USE_ERROR = "Profile is in use by one or more chain hops";

function fetchProfiles() {
  return apiFetch<VpnProfile[]>("/api/profiles");
}

function createProfile(payload: {
  label: string;
  host: string;
  sshPort: number;
  sshUser: string;
  /** Omitted when SSH host is a public IP and panel is left empty (server derives). */
  panelHostname?: string;
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
    panelHostname?: string;
    sshPassword?: string;
  },
) {
  return apiFetch<VpnProfile>(`/api/profiles/${id}`, {
    method: "PATCH",
    body: payload,
  });
}

function deleteProfile(id: number, options?: { force?: boolean }) {
  const q = options?.force ? "?force=true" : "";
  return apiFetch<{ ok: true }>(`/api/profiles/${id}${q}`, {
    method: "DELETE",
  });
}

function setupProfile(id: number) {
  return apiFetch<SetupResponse>(`/api/profiles/${id}/setup`, {
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
    panelHostname: modalState.profile.panelHostname,
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

function validateFormValues(
  values: ProfileFormValues,
  requirePassword: boolean,
  formMode: "create" | "edit",
) {
  const label = values.label.trim();
  const host = values.host.trim();
  const sshUser = values.sshUser.trim();
  const panelHostname = values.panelHostname.trim();
  const sshPassword = values.sshPassword.trim();
  const sshPort = Number(values.sshPort);

  if (!label || !host || !sshUser) {
    return { error: "Label, IP or Host, and SSH user are required." };
  }

  if (panelHostname !== "") {
    if (!isPublicIpLiteral(panelHostname) && !isFqdnPanel(panelHostname)) {
      return {
        error: "Panel address must be a valid FQDN (e.g. panel.example.com) or a public IP address.",
      };
    }
  } else if (!isPublicIpLiteral(host)) {
    return {
      error: "Panel address is required unless IP or Host is entered as a public IP address.",
    };
  }

  if (!Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65535) {
    return { error: "SSH port must be an integer between 1 and 65535." };
  }

  if (requirePassword && sshPassword === "") {
    return { error: "SSH password is required for new profiles." };
  }

  const base = { label, host, sshPort, sshUser, sshPassword };
  if (panelHostname !== "") {
    return { payload: { ...base, panelHostname } };
  }
  if (formMode === "edit") {
    return { payload: { ...base, panelHostname: "" } };
  }
  return { payload: { ...base } };
}

function hasValidationError(
  result: ReturnType<typeof validateFormValues>,
): result is { error: string } {
  return "error" in result;
}

type SetupSheetProps = {
  profile: VpnProfile;
  setup: SetupResponse["setup"];
  onClose: () => void;
};

function SetupOutputSheet({ profile, setup, onClose }: SetupSheetProps) {
  const titleId = "setup-sheet-title";

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

  return (
    <div style={sshBackdropStyle} role="presentation" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        style={{ ...sshSheetStyle, maxHeight: "min(72vh, 720px)", height: "auto" }}
        onClick={(event) => event.stopPropagation()}
      >
        <div style={sshSheetHeaderStyle}>
          <h3 id={titleId} style={sshSheetTitleStyle}>
            Setup — {profile.label} ({setup.mode === "dry-run" ? "dry-run" : "live"})
          </h3>
          <button onClick={onClose} style={modalCloseButtonStyle} type="button">
            Close
          </button>
        </div>
        <div style={{ ...sshTerminalStyle, height: "min(60vh, 560px)", cursor: "default" }} tabIndex={0}>
          <div style={{ ...sshTerminalLineStyle, marginBottom: "12px", opacity: 0.85 }}>
            # Output from the VPN Manager API. This is not an interactive SSH session in your browser.
          </div>
          {setup.phases.map((phase) => (
            <div key={phase.id} style={{ marginBottom: "20px" }}>
              <div style={{ ...sshTerminalLineStyle, color: "#94a3b8" }}># {phase.title}</div>
              <pre style={{ ...sshTerminalLineStyle, margin: "6px 0 0", whiteSpace: "pre-wrap" }}>{phase.script}</pre>
              {phase.stdout !== undefined && phase.stdout !== "" ? (
                <pre style={{ ...sshTerminalLineStyle, marginTop: "8px", color: "#86efac", whiteSpace: "pre-wrap" }}>
                  {phase.stdout}
                </pre>
              ) : null}
              {phase.stderr !== undefined && phase.stderr !== "" ? (
                <pre style={{ ...sshTerminalLineStyle, marginTop: "8px", color: "#fca5a5", whiteSpace: "pre-wrap" }}>
                  {phase.stderr}
                </pre>
              ) : null}
              {phase.code !== undefined ? (
                <div style={{ ...sshTerminalLineStyle, marginTop: "4px", color: "#cbd5e1" }}>
                  exit: {phase.code}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

type SshTerminalSheetProps = {
  profile: VpnProfile;
  onClose: () => void;
};

function SshTerminalSheet({ profile, onClose }: SshTerminalSheetProps) {
  const titleId = "ssh-sheet-title";
  const terminalContainerRef = useRef<HTMLDivElement>(null);
  const [sessionKey, setSessionKey] = useState(0);
  const [disconnected, setDisconnected] = useState(false);
  const [disconnectHint, setDisconnectHint] = useState<string | null>(null);

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
        if (terminalContainerRef.current?.contains(e.target as Node)) {
          return;
        }
        onClose();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  useEffect(() => {
    const container = terminalContainerRef.current;
    if (!container) return;

    setDisconnected(false);
    setDisconnectHint(null);

    let cancelled = false;
    let ws: WebSocket | undefined;
    let terminal: Terminal | undefined;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    let resizeObserver: ResizeObserver | undefined;

    void (async () => {
      const preRes = await fetch("/api/profiles/ssh-terminal/preflight", {
        credentials: "include",
      });
      const preBody = (await preRes.json().catch(() => null)) as {
        sshTerminalEnabled?: boolean;
        error?: string;
      } | null;

      if (cancelled) return;

      if (!preRes.ok || !preBody) {
        const hint =
          preRes.status === 401
            ? "Sign in to use the browser SSH terminal."
            : typeof preBody?.error === "string"
              ? preBody.error
              : `Could not reach the API (HTTP ${preRes.status}). For dev, run the API on port 3000.`;
        setDisconnectHint(hint);
        setDisconnected(true);
        return;
      }

      if (!preBody.sshTerminalEnabled) {
        setDisconnectHint(
          "SSH is disabled on this server. Set VPN_SSH_ENABLED=true in apps/server/.env and restart the API.",
        );
        setDisconnected(true);
        return;
      }

      const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const wsUrl = `${wsProtocol}//${window.location.host}/api/profiles/${profile.id}/ssh`;
      const socket = new WebSocket(wsUrl);
      ws = socket;
      socket.binaryType = "arraybuffer";

      const term = new Terminal({ cursorBlink: true });
      terminal = term;
      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.open(container);
      fitAddon.fit();

      const encoder = new TextEncoder();
      term.onData((data) => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(encoder.encode(data));
        }
      });

      socket.onmessage = (event) => {
        if (typeof event.data === "string") {
          try {
            JSON.parse(event.data);
          } catch {
            // not a JSON control message — ignore
          }
        } else {
          term.write(new Uint8Array(event.data as ArrayBuffer));
        }
      };

      socket.onclose = (ev) => {
        if (ev.code !== 1000) {
          const reason = (ev.reason ?? "").trim();
          if (reason) {
            setDisconnectHint(
              ev.code === 1011
                ? `The API could not complete SSH to this profile's host: ${reason}`
                : reason,
            );
          } else {
            setDisconnectHint(
              "Connection closed before the terminal started. For dev: run the API on port 3000 and ensure Vite proxies WebSockets. On the server: set VPN_SSH_ENABLED=true in apps/server/.env and restart.",
            );
          }
        }
        setDisconnected(true);
      };
      socket.onerror = () => {
        setDisconnectHint(
          "WebSocket error (often the API is down, VPN_SSH_ENABLED is false, or the dev proxy is not upgrading WS). Check the browser network tab.",
        );
        setDisconnected(true);
      };

      term.onResize(({ cols, rows }) => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: "resize", cols, rows }));
          }
        }, 100);
      });

      resizeObserver = new ResizeObserver(() => {
        fitAddon.fit();
      });
      resizeObserver.observe(container);
    })();

    return () => {
      cancelled = true;
      clearTimeout(resizeTimer);
      resizeObserver?.disconnect();
      ws?.close();
      terminal?.dispose();
    };
  }, [profile.id, sessionKey]);

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
        <div style={sshTerminalWrapperStyle}>
          <div ref={terminalContainerRef} style={sshXtermContainerStyle} />
          {disconnected ? (
            <div style={sshDisconnectedOverlayStyle}>
              <span>Disconnected</span>
              {disconnectHint ? (
                <p style={{ margin: "8px 0 0", maxWidth: "420px", fontSize: "13px", lineHeight: 1.45, opacity: 0.9 }}>
                  {disconnectHint}
                </p>
              ) : null}
              <button
                onClick={() => setSessionKey((k) => k + 1)}
                style={primaryButtonStyle}
                type="button"
              >
                Reconnect
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export default function VpnsPage({ authUser }: { authUser: AuthUser | null }) {
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
  const [setupSheet, setSetupSheet] = useState<{ profile: VpnProfile; setup: SetupResponse["setup"] } | null>(null);
  const [pendingForceDeleteId, setPendingForceDeleteId] = useState<number | null>(null);

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
    mutationFn: (variables: { id: number; force?: boolean }) =>
      deleteProfile(variables.id, { force: variables.force }),
    onSuccess: async (_, variables) => {
      await queryClient.invalidateQueries({ queryKey: profilesQueryKey });
      setSshProfile((current) => (current?.id === variables.id ? null : current));
      setSetupSheet((current) => (current?.profile.id === variables.id ? null : current));
      setPendingForceDeleteId(null);
    },
  });

  const setupMutation = useMutation({
    mutationFn: setupProfile,
    onSuccess: async (data) => {
      await queryClient.invalidateQueries({ queryKey: profilesQueryKey });
      setSetupSheet({ profile: data.profile, setup: data.setup });
    },
  });

  const mutationError = useMemo(() => {
    return createMutation.error ?? updateMutation.error ?? deleteMutation.error ?? null;
  }, [createMutation.error, deleteMutation.error, updateMutation.error]);

  const isSaving = createMutation.isPending || updateMutation.isPending;
  const isDeleting = deleteMutation.isPending;

  const profiles = profilesQuery.data ?? [];

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!modalState) {
      return;
    }

    setFormError(null);

    const requirePassword = modalState.mode === "create";
    const result = validateFormValues(
      formValues,
      requirePassword,
      modalState.mode === "edit" ? "edit" : "create",
    );
    if (hasValidationError(result)) {
      setFormError(result.error);
      return;
    }

    if (modalState?.mode === "create") {
      await createMutation.mutateAsync(result.payload);
      return;
    }

    if (modalState?.mode === "edit") {
      const pl = result.payload;
      const payload: Parameters<typeof updateProfile>[1] = {
        label: pl.label,
        host: pl.host,
        sshPort: pl.sshPort,
        sshUser: pl.sshUser,
        panelHostname: "panelHostname" in pl ? pl.panelHostname : "",
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

    setPendingForceDeleteId(null);
    try {
      await deleteMutation.mutateAsync({ id: profile.id });
    } catch (error) {
      if (
        error instanceof ApiError &&
        error.status === 409 &&
        error.message === PROFILE_IN_USE_ERROR
      ) {
        setPendingForceDeleteId(profile.id);
      }
      throw error;
    }
  }

  async function handleForceDelete(profile: VpnProfile) {
    if (
      !window.confirm(
        `Delete "${profile.label}" anyway?\n\nThis removes every chain hop that uses this profile (routing rules on those hops are lost), deletes chains that would have no hops left, then deletes the profile. This cannot be undone.`,
      )
    ) {
      return;
    }

    setPendingForceDeleteId(null);
    await deleteMutation.mutateAsync({ id: profile.id, force: true });
  }

  async function handleSetup(profile: VpnProfile) {
    setSetupActionError(null);
    try {
      await setupMutation.mutateAsync(profile.id);
    } catch (error) {
      if (error instanceof ApiError && error.status === 500) {
        const body = error.body as { profile?: VpnProfile; setup?: SetupResponse["setup"] };
        if (body?.profile && body?.setup) {
          setSetupSheet({ profile: body.profile, setup: body.setup });
          await queryClient.invalidateQueries({ queryKey: profilesQueryKey });
          setSetupActionError(null);
          return;
        }
      }
      setSetupActionError(getErrorMessage(error));
    }
  }

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

        {mutationError ? (
          <div style={errorStyle}>
            <div>{getErrorMessage(mutationError)}</div>
            {pendingForceDeleteId !== null ? (
              <div style={{ marginTop: 8 }}>
                <button
                  disabled={isDeleting}
                  onClick={() => {
                    const p = profiles.find((x) => x.id === pendingForceDeleteId);
                    if (p) void handleForceDelete(p);
                  }}
                  style={dangerButtonStyle}
                  type="button"
                >
                  {isDeleting ? "Deleting..." : "Delete anyway"}
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
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
                  <th style={tableHeadCellStyle}>IP or Host</th>
                  <th style={tableHeadCellStyle}>SSH port</th>
                  <th style={tableHeadCellStyle}>User</th>
                  <th style={tableHeadCellStyle}>Status</th>
                  <th style={tableHeadCellStyle}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {profiles.map((profile) => {
                  const deleteDisabled = isDeleting && deleteMutation.variables?.id === profile.id;
                  const editDisabled =
                    isSaving || (isDeleting && deleteMutation.variables?.id === profile.id);
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
                            disabled={editDisabled || !authUser}
                            onClick={() => setSshProfile(profile)}
                            style={secondaryButtonStyle}
                            type="button"
                          >
                            SSH
                          </button>
                          {!authUser ? (
                            <span style={guestSshHintStyle}>Sign in to SSH</span>
                          ) : null}
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
                IP or Host
                <input
                  onChange={(event) =>
                    setFormValues((current) => ({ ...current, host: event.target.value }))
                  }
                  style={inputStyle}
                  value={formValues.host}
                />
              </label>

              <label style={labelStyle}>
                Panel address (FQDN or public IP)
                <input
                  onChange={(event) =>
                    setFormValues((current) => ({ ...current, panelHostname: event.target.value }))
                  }
                  placeholder="panel.example.com or 203.0.113.10"
                  style={inputStyle}
                  value={formValues.panelHostname}
                />
                <span style={fieldHintStyle}>
                  Required for HTTPS unless IP or Host is a public IP (then you may leave this empty).
                </span>
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

      {setupSheet ? (
        <SetupOutputSheet
          profile={setupSheet.profile}
          setup={setupSheet.setup}
          onClose={() => setSetupSheet(null)}
        />
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

const sshTerminalWrapperStyle: CSSProperties = {
  flex: 1,
  position: "relative",
  background: "#0f172a",
  overflow: "hidden",
};

const sshXtermContainerStyle: CSSProperties = {
  width: "100%",
  height: "100%",
  padding: "8px",
  boxSizing: "border-box",
};

const sshDisconnectedOverlayStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: "16px",
  background: "rgba(15, 23, 42, 0.85)",
  color: "#e2e8f0",
  fontSize: "1rem",
  fontWeight: 600,
};

const guestSshHintStyle: CSSProperties = {
  fontSize: "0.8rem",
  color: "#6b7280",
  alignSelf: "center",
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

const fieldHintStyle: CSSProperties = {
  fontWeight: 400,
  fontSize: "0.85rem",
  color: "#6b7280",
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
