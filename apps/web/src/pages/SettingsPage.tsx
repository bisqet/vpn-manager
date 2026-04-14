import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CSSProperties, FormEvent } from "react";
import { useEffect, useState } from "react";
import {
  ApiError,
  fetchSettings,
  patchSettings,
  settingsQueryKey,
  type AppSettingsDto,
} from "../api/client";

function getErrorMessage(error: unknown) {
  if (error instanceof ApiError) {
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return "Something went wrong. Please try again.";
}

export default function SettingsPage() {
  const queryClient = useQueryClient();
  const settingsQuery = useQuery({
    queryKey: settingsQueryKey,
    queryFn: fetchSettings,
  });

  const [acmeEmail, setAcmeEmail] = useState("");
  const [vpnSshEnabled, setVpnSshEnabled] = useState(false);
  const [sshKnownHostsPath, setSshKnownHostsPath] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (!settingsQuery.data) return;
    const d = settingsQuery.data;
    setAcmeEmail(d.acmeEmail);
    setVpnSshEnabled(d.vpnSshEnabled);
    setSshKnownHostsPath(d.sshKnownHostsFile ?? "");
  }, [settingsQuery.data]);

  const saveMutation = useMutation({
    mutationFn: () =>
      patchSettings({
        acmeEmail,
        vpnSshEnabled,
        sshKnownHostsFile: sshKnownHostsPath.trim() === "" ? null : sshKnownHostsPath.trim(),
      }),
    onSuccess: () => {
      setSaveError(null);
      void queryClient.invalidateQueries({ queryKey: settingsQueryKey });
    },
    onError: (e) => {
      setSaveError(getErrorMessage(e));
    },
  });

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSaveError(null);
    saveMutation.mutate();
  }

  if (settingsQuery.isPending) {
    return (
      <div style={pageWrapStyle}>
        <p style={mutedStyle}>Loading settings…</p>
      </div>
    );
  }

  if (settingsQuery.isError) {
    return (
      <div style={pageWrapStyle}>
        <p style={errorStyle}>{getErrorMessage(settingsQuery.error)}</p>
      </div>
    );
  }

  const dto = settingsQuery.data as AppSettingsDto;

  return (
    <div style={pageWrapStyle}>
      <header style={headerStyle}>
        <h1 style={titleStyle}>Settings</h1>
        <p style={mutedStyle}>
          These values are stored in the server database and apply to future VPN setup and clear-server actions.
        </p>
      </header>

      <form onSubmit={handleSubmit} style={cardStyle}>
        <label style={labelStyle}>
          {"ACME contact email (Let's Encrypt / Caddy)"}
          <input
            type="email"
            value={acmeEmail}
            onChange={(ev) => setAcmeEmail(ev.target.value)}
            style={inputStyle}
            autoComplete="off"
          />
        </label>

        <label style={checkboxRowStyle}>
          <input
            type="checkbox"
            checked={vpnSshEnabled}
            onChange={(ev) => setVpnSshEnabled(ev.target.checked)}
          />
          <span>Enable live SSH (setup and clear-server open real SSH connections)</span>
        </label>

        <label style={labelStyle}>
          SSH known_hosts file path (optional, on the VPN Manager host)
          <input
            type="text"
            value={sshKnownHostsPath}
            onChange={(ev) => setSshKnownHostsPath(ev.target.value)}
            style={inputStyle}
            placeholder="Leave empty to use default host key handling"
            autoComplete="off"
          />
        </label>

        {saveError ? <p style={errorStyle}>{saveError}</p> : null}

        <div style={actionsStyle}>
          <button
            type="submit"
            disabled={saveMutation.isPending}
            style={saveButtonStyle}
          >
            {saveMutation.isPending ? "Saving…" : "Save"}
          </button>
          <span style={mutedStyle}>Last updated: {dto.updatedAt}</span>
        </div>
      </form>
    </div>
  );
}

const pageWrapStyle: CSSProperties = {
  maxWidth: "640px",
};

const headerStyle: CSSProperties = {
  marginBottom: "20px",
};

const titleStyle: CSSProperties = {
  margin: "0 0 8px",
  fontSize: "1.75rem",
  color: "#111827",
};

const mutedStyle: CSSProperties = {
  margin: 0,
  color: "#6b7280",
  fontSize: "0.9rem",
  lineHeight: 1.5,
};

const cardStyle: CSSProperties = {
  display: "grid",
  gap: "20px",
  padding: "24px",
  borderRadius: "16px",
  background: "#ffffff",
  boxShadow: "0 16px 40px rgba(15, 23, 42, 0.08)",
};

const labelStyle: CSSProperties = {
  display: "grid",
  gap: "8px",
  fontWeight: 600,
  fontSize: "0.9rem",
  color: "#374151",
};

const checkboxRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: "10px",
  fontWeight: 500,
  fontSize: "0.9rem",
  color: "#374151",
  cursor: "pointer",
};

const inputStyle: CSSProperties = {
  padding: "10px 12px",
  borderRadius: "10px",
  border: "1px solid #d1d5db",
  fontSize: "1rem",
};

const actionsStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "16px",
};

const saveButtonStyle: CSSProperties = {
  padding: "10px 20px",
  borderRadius: "10px",
  border: "none",
  background: "#111827",
  color: "#ffffff",
  fontWeight: 600,
  cursor: "pointer",
};

const errorStyle: CSSProperties = {
  margin: 0,
  color: "#b91c1c",
  fontSize: "0.9rem",
};
