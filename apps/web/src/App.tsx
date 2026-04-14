import { useQuery } from "@tanstack/react-query";
import type { CSSProperties } from "react";
import { Link, Navigate, NavLink, Outlet, Route, Routes } from "react-router-dom";
import { authQueryKey, fetchCurrentUser } from "./api/client";
import ChainsPage from "./pages/ChainsPage";
import ExportPage from "./pages/ExportPage";
import ImportPage from "./pages/ImportPage";
import LoginPage from "./pages/LoginPage";
import RoutingPage from "./pages/RoutingPage";
import SettingsPage from "./pages/SettingsPage";
import VpnsPage from "./pages/VpnsPage";

const navItems = [
  { path: "/vpns", label: "VPNs" },
  { path: "/chains", label: "Chains" },
  { path: "/routing", label: "Routing" },
  { path: "/import", label: "Import" },
  { path: "/export", label: "Export" },
  { path: "/settings", label: "Settings" },
] as const;

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/vpns" element={<VpnsShell />} />
      <Route element={<ProtectedLayout />}>
        <Route index element={<Navigate to="/vpns" replace />} />
        <Route path="/chains" element={<ChainsPage />} />
        <Route path="/routing" element={<RoutingPage />} />
        <Route path="/import" element={<ImportPage />} />
        <Route path="/export" element={<ExportPage />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/vpns" replace />} />
    </Routes>
  );
}

function VpnsShell() {
  const sessionQuery = useQuery({
    queryKey: authQueryKey,
    queryFn: fetchCurrentUser,
    retry: false,
  });

  if (sessionQuery.isPending) {
    return <FullScreenMessage title="Checking session..." />;
  }

  if (sessionQuery.isError) {
    return (
      <FullScreenMessage
        title="Unable to load your session"
        message="Make sure the API server is running on http://localhost:3000."
      />
    );
  }

  const user = sessionQuery.data.user;

  return (
    <div style={shellStyle}>
      <aside style={sidebarStyle}>
        <div>
          <div style={eyebrowStyle}>VPN Manager</div>
          <h1 style={sidebarTitleStyle}>Control panel</h1>
          {user ? (
            <p style={sidebarCopyStyle}>Signed in as {user.username}</p>
          ) : (
            <p style={sidebarCopyStyle}>VPN profiles work without signing in.</p>
          )}
        </div>
        <nav style={navStyle}>
          <NavLink
            to="/vpns"
            end
            style={({ isActive }) => ({
              ...navLinkStyle,
              background: isActive ? "#111827" : "transparent",
              color: isActive ? "#ffffff" : "#111827",
            })}
          >
            VPNs
          </NavLink>
          {user ? (
            navItems
              .filter((item) => item.path !== "/vpns")
              .map((item) => (
                <NavLink
                  key={item.path}
                  to={item.path}
                  style={({ isActive }) => ({
                    ...navLinkStyle,
                    background: isActive ? "#111827" : "transparent",
                    color: isActive ? "#ffffff" : "#111827",
                  })}
                >
                  {item.label}
                </NavLink>
              ))
          ) : (
            <p style={guestNavHintStyle}>
              <Link style={guestSignInLinkStyle} to="/login">
                Sign in
              </Link>{" "}
              for chains, routing, import, export, and settings.
            </p>
          )}
        </nav>
      </aside>
      <main style={mainStyle}>
        <VpnsPage authUser={user} />
      </main>
    </div>
  );
}

function ProtectedLayout() {
  const sessionQuery = useQuery({
    queryKey: authQueryKey,
    queryFn: fetchCurrentUser,
    retry: false,
  });

  if (sessionQuery.isPending) {
    return <FullScreenMessage title="Checking session..." />;
  }

  if (sessionQuery.isError) {
    return (
      <FullScreenMessage
        title="Unable to load your session"
        message="Make sure the API server is running on http://localhost:3000."
      />
    );
  }

  if (!sessionQuery.data.user) {
    return <Navigate to="/login" replace />;
  }

  return (
    <div style={shellStyle}>
      <aside style={sidebarStyle}>
        <div>
          <div style={eyebrowStyle}>VPN Manager</div>
          <h1 style={sidebarTitleStyle}>Control panel</h1>
          <p style={sidebarCopyStyle}>Signed in as {sessionQuery.data.user.username}</p>
        </div>
        <nav style={navStyle}>
          {navItems.map((item) => (
            <NavLink
              key={item.path}
              to={item.path}
              style={({ isActive }) => ({
                ...navLinkStyle,
                background: isActive ? "#111827" : "transparent",
                color: isActive ? "#ffffff" : "#111827",
              })}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <main style={mainStyle}>
        <Outlet />
      </main>
    </div>
  );
}

function FullScreenMessage({
  title,
  message,
}: {
  title: string;
  message?: string;
}) {
  return (
    <div style={fullScreenStyle}>
      <section style={messageCardStyle}>
        <h1 style={pageTitleStyle}>{title}</h1>
        {message ? <p style={helperTextStyle}>{message}</p> : null}
      </section>
    </div>
  );
}

const fullScreenStyle: CSSProperties = {
  minHeight: "100vh",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "24px",
};

const shellStyle: CSSProperties = {
  minHeight: "100vh",
  display: "grid",
  gridTemplateColumns: "240px 1fr",
  background: "#e5e7eb",
};

const sidebarStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  justifyContent: "space-between",
  padding: "24px",
  background: "#f9fafb",
  borderRight: "1px solid #d1d5db",
};

const mainStyle: CSSProperties = {
  padding: "24px",
};

const navStyle: CSSProperties = {
  display: "grid",
  gap: "8px",
};

const navLinkStyle: CSSProperties = {
  padding: "10px 12px",
  borderRadius: "10px",
  textDecoration: "none",
  fontWeight: 600,
};

const messageCardStyle: CSSProperties = {
  width: "100%",
  maxWidth: "440px",
  padding: "24px",
  borderRadius: "16px",
  background: "#ffffff",
  boxShadow: "0 16px 40px rgba(15, 23, 42, 0.08)",
};

const sidebarTitleStyle: CSSProperties = {
  margin: "8px 0 0",
  fontSize: "1.5rem",
  color: "#111827",
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

const sidebarCopyStyle: CSSProperties = {
  margin: "12px 0 0",
  color: "#4b5563",
};

const helperTextStyle: CSSProperties = {
  margin: 0,
  color: "#4b5563",
  lineHeight: 1.5,
};

const guestNavHintStyle: CSSProperties = {
  margin: "4px 0 0",
  padding: "10px 12px",
  fontSize: "0.875rem",
  lineHeight: 1.45,
  color: "#4b5563",
};

const guestSignInLinkStyle: CSSProperties = {
  fontWeight: 600,
  color: "#111827",
};
