import { useQuery } from "@tanstack/react-query";
import type { CSSProperties } from "react";
import { useEffect, useMemo, useState } from "react";
import { ApiError, apiFetch } from "../api/client";

type Chain = {
  id: number;
  name: string;
};

function fetchChains() {
  return apiFetch<Chain[]>("/api/chains");
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

async function readError(response: Response) {
  const contentType = response.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string" && body.error !== "") {
      return body.error;
    }
  } else {
    const body = await response.text();
    if (body.trim() !== "") {
      return body;
    }
  }

  return response.statusText || "Request failed";
}

async function fetchExportText(chainId: number, signal?: AbortSignal) {
  const response = await fetch(`/api/chains/${chainId}/export`, {
    credentials: "include",
    signal,
  });

  if (!response.ok) {
    throw new Error(await readError(response));
  }

  const rawText = await response.text();
  const parsed = JSON.parse(rawText) as unknown;
  return JSON.stringify(parsed, null, 2);
}

async function downloadExport(chainId: number) {
  const response = await fetch(`/api/chains/${chainId}/export`, {
    credentials: "include",
  });

  if (!response.ok) {
    throw new Error(await readError(response));
  }

  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);

  try {
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = "vpn-manager.routing.v1.json";
    anchor.click();
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export default function ExportPage() {
  const chainsQuery = useQuery({
    queryKey: ["chains"],
    queryFn: fetchChains,
  });

  const chains = chainsQuery.data ?? [];
  const [selectedChainId, setSelectedChainId] = useState<string>("");
  const [previewText, setPreviewText] = useState("");
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [isDownloading, setIsDownloading] = useState(false);

  useEffect(() => {
    if (!chainsQuery.isSuccess) {
      return;
    }

    if (chains.length === 0) {
      setSelectedChainId("");
      return;
    }

    setSelectedChainId((current) =>
      chains.some((chain) => String(chain.id) === current) ? current : String(chains[0].id),
    );
  }, [chains, chainsQuery.isSuccess]);

  const selectedChain = useMemo(
    () => chains.find((chain) => String(chain.id) === selectedChainId) ?? null,
    [chains, selectedChainId],
  );

  useEffect(() => {
    if (!selectedChain) {
      setPreviewText("");
      setPreviewError(null);
      setIsPreviewLoading(false);
      return;
    }

    const controller = new AbortController();
    setIsPreviewLoading(true);
    setPreviewError(null);

    fetchExportText(selectedChain.id, controller.signal)
      .then((text) => {
        setPreviewText(text);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) {
          return;
        }
        setPreviewText("");
        setPreviewError(getErrorMessage(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setIsPreviewLoading(false);
        }
      });

    return () => controller.abort();
  }, [selectedChain]);

  async function handleDownload() {
    if (!selectedChain) {
      return;
    }

    setIsDownloading(true);
    setDownloadError(null);

    try {
      await downloadExport(selectedChain.id);
    } catch (error) {
      setDownloadError(getErrorMessage(error));
    } finally {
      setIsDownloading(false);
    }
  }

  return (
    <section style={cardStyle}>
      <div style={headerRowStyle}>
        <div>
          <div style={eyebrowStyle}>Export</div>
          <h2 style={pageTitleStyle}>Chain export</h2>
          <p style={helperTextStyle}>
            Select a chain, preview its production export payload, and download the JSON file
            used by downstream routing consumers.
          </p>
        </div>
        <button
          disabled={!selectedChain || isDownloading || chainsQuery.isPending}
          onClick={() => void handleDownload()}
          style={primaryButtonStyle}
          type="button"
        >
          {isDownloading ? "Downloading..." : "Download"}
        </button>
      </div>

      {chainsQuery.isPending ? (
        <div style={emptyStateStyle}>Loading chains...</div>
      ) : chainsQuery.isError ? (
        <div style={errorStyle}>{getErrorMessage(chainsQuery.error)}</div>
      ) : chains.length === 0 ? (
        <div style={emptyStateStyle}>No chains available yet. Create one before exporting.</div>
      ) : (
        <div style={contentStyle}>
          <label style={labelStyle}>
            Chain
            <select
              onChange={(event) => {
                setSelectedChainId(event.target.value);
                setDownloadError(null);
              }}
              style={inputStyle}
              value={selectedChainId}
            >
              {chains.map((chain) => (
                <option key={chain.id} value={String(chain.id)}>
                  #{chain.id} {chain.name}
                </option>
              ))}
            </select>
          </label>

          {downloadError ? <div style={errorStyle}>{downloadError}</div> : null}

          <div style={sectionHeaderStyle}>
            <div>
              <h3 style={sectionTitleStyle}>Preview</h3>
              <p style={helperTextStyle}>
                This preview is fetched directly from the export endpoint and pretty-printed
                before download.
              </p>
            </div>
          </div>

          {isPreviewLoading ? (
            <div style={emptyStateStyle}>Loading export preview...</div>
          ) : previewError ? (
            <div style={errorStyle}>{previewError}</div>
          ) : (
            <pre style={previewStyle}>{previewText}</pre>
          )}
        </div>
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

const contentStyle: CSSProperties = {
  marginTop: "24px",
  display: "grid",
  gap: "20px",
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

const sectionHeaderStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: "16px",
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

const previewStyle: CSSProperties = {
  margin: 0,
  padding: "16px",
  borderRadius: "14px",
  background: "#111827",
  color: "#e5e7eb",
  overflowX: "auto",
  overflowY: "auto",
  maxHeight: "60vh",
  fontSize: "0.9rem",
  lineHeight: 1.5,
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
