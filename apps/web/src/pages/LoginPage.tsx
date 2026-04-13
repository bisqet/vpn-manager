import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { CSSProperties, FormEvent } from "react";
import { useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import {
  authQueryKey,
  fetchCurrentUser,
  login,
  type AuthResponse,
} from "../api/client";

const INVALID_CREDENTIALS = "Invalid username or password";

export default function LoginPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const sessionQuery = useQuery({
    queryKey: authQueryKey,
    queryFn: fetchCurrentUser,
    retry: false,
  });

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (sessionQuery.isPending) {
    return (
      <div style={pageStyle}>
        <section style={cardStyle}>
          <h1 style={titleStyle}>Checking session...</h1>
        </section>
      </div>
    );
  }

  if (sessionQuery.data?.user) {
    return <Navigate to="/vpns" replace />;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      const response = await login(username, password);
      queryClient.setQueryData<AuthResponse>(authQueryKey, { user: response.user });
      navigate("/vpns", { replace: true });
    } catch {
      setError(INVALID_CREDENTIALS);
    } finally {
      setIsSubmitting(false);
    }
  }

  const isSubmitDisabled = isSubmitting || username.trim() === "" || password.trim() === "";

  return (
    <div style={pageStyle}>
      <section style={cardStyle}>
        <div style={eyebrowStyle}>VPN Manager</div>
        <h1 style={titleStyle}>Sign in</h1>
        <p style={copyStyle}>Use your local admin credentials to access VPN profiles and routing.</p>

        <form onSubmit={handleSubmit} style={formStyle}>
          <label style={labelStyle}>
            Username
            <input
              autoComplete="username"
              name="username"
              onChange={(event) => setUsername(event.target.value)}
              style={inputStyle}
              value={username}
            />
          </label>

          <label style={labelStyle}>
            Password
            <input
              autoComplete="current-password"
              name="password"
              onChange={(event) => setPassword(event.target.value)}
              style={inputStyle}
              type="password"
              value={password}
            />
          </label>

          {error ? <div style={errorStyle}>{error}</div> : null}

          <button disabled={isSubmitDisabled} style={buttonStyle} type="submit">
            {isSubmitting ? "Signing in..." : "Sign in"}
          </button>
        </form>
      </section>
    </div>
  );
}

const pageStyle: CSSProperties = {
  minHeight: "100vh",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "24px",
};

const cardStyle: CSSProperties = {
  width: "100%",
  maxWidth: "420px",
  padding: "32px",
  borderRadius: "18px",
  background: "#ffffff",
  boxShadow: "0 20px 45px rgba(15, 23, 42, 0.12)",
};

const eyebrowStyle: CSSProperties = {
  fontSize: "0.75rem",
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  color: "#6b7280",
};

const titleStyle: CSSProperties = {
  margin: "8px 0 12px",
  fontSize: "2rem",
  color: "#111827",
};

const copyStyle: CSSProperties = {
  margin: 0,
  color: "#4b5563",
  lineHeight: 1.5,
};

const formStyle: CSSProperties = {
  display: "grid",
  gap: "16px",
  marginTop: "24px",
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

const errorStyle: CSSProperties = {
  padding: "12px 14px",
  borderRadius: "10px",
  background: "#fef2f2",
  color: "#b91c1c",
  border: "1px solid #fecaca",
};

const buttonStyle: CSSProperties = {
  padding: "12px 16px",
  border: "none",
  borderRadius: "10px",
  background: "#111827",
  color: "#ffffff",
  fontSize: "1rem",
  fontWeight: 600,
  cursor: "pointer",
};
