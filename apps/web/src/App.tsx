import { useQuery } from "@tanstack/react-query";
import type { CSSProperties } from "react";
import { Navigate, NavLink, Outlet, Route, Routes } from "react-router-dom";
import { authQueryKey, fetchCurrentUser } from "./api/client";
import LoginPage from "./pages/LoginPage";

const navItems = [
  { path: "/vpns", label: "VPNs" },
  { path: "/chains", label: "Chains" },
  { path: "/routing", label: "Routing" },
  { path: "/export", label: "Export" },
] as const;

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<ProtectedLayout />}>
        <Route index element={<Navigate to="/vpns" replace />} />
        <Route path="/vpns" element={<PlaceholderPage title="VPNs" />} />
        <Route path="/chains" element={<PlaceholderPage title="Chains" />} />
        <Route path="/routing" element={<PlaceholderPage title="Routing" />} />
        <Route path="/export" element={<PlaceholderPage title="Export" />} />
      </Route>
      <Route path="*" element={<Navigate to="/vpns" replace />} />
    </Routes>
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

function PlaceholderPage({ title }: { title: string }) {
  return (
    <section style={cardStyle}>
      <div style={eyebrowStyle}>Protected route</div>
      <h2 style={pageTitleStyle}>{title}</h2>
      <div>Coming soon</div>
    </section>
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

const cardStyle: CSSProperties = {
  maxWidth: "720px",
  padding: "24px",
  borderRadius: "16px",
  background: "#ffffff",
  boxShadow: "0 16px 40px rgba(15, 23, 42, 0.08)",
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
