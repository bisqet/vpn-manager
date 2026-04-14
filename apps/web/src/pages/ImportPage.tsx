import type { CSSProperties, DragEvent } from "react";
import { useRef, useState } from "react";
import { ApiError } from "../api/client";
import { mergeParsedRootsToImportJson } from "../import/mergeImportSources";

type FileEntry = {
  name: string;
  text: string;
  parseError: string | null;
};

type PreviewResult = {
  canApply: boolean;
  errors: string[];
  warnings: string[];
  plan: unknown;
  passwordKeys: string[];
  panelHostnameKeys: string[];
};

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

function tryParseJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Invalid JSON" };
  }
}

export default function ImportPage() {
  const [textareaRaw, setTextareaRaw] = useState("");
  const [clipboardRoot, setClipboardRoot] = useState<{ value: unknown; raw: string } | null>(null);
  const [clipboardError, setClipboardError] = useState<string | null>(null);
  const [fileEntries, setFileEntries] = useState<FileEntry[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);

  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);

  const [passwords, setPasswords] = useState<Record<string, string>>({});
  const [panelHostnames, setPanelHostnames] = useState<Record<string, string>>({});

  const [applyResult, setApplyResult] = useState<unknown>(null);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [isApplyLoading, setIsApplyLoading] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  function addFiles(files: File[]) {
    const jsonFiles = files.filter(
      (f) => f.name.endsWith(".json") || f.type === "application/json",
    );
    jsonFiles.forEach((file) => {
      const reader = new FileReader();
      reader.onload = () => {
        const text = reader.result as string;
        const parsed = tryParseJson(text);
        setFileEntries((prev) => [
          ...prev,
          {
            name: file.name,
            text,
            parseError: parsed.ok ? null : parsed.error,
          },
        ]);
      };
      reader.readAsText(file);
    });
  }

  function removeFile(index: number) {
    setFileEntries((prev) => prev.filter((_, i) => i !== index));
  }

  function handleDragOver(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setIsDragOver(true);
  }

  function handleDragLeave() {
    setIsDragOver(false);
  }

  function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setIsDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    addFiles(files);
  }

  async function handlePasteClipboard() {
    setClipboardError(null);
    try {
      const text = await navigator.clipboard.readText();
      const trimmed = text.trim();
      if (!trimmed) {
        setClipboardError("Clipboard is empty.");
        return;
      }
      const parsed = tryParseJson(trimmed);
      if (!parsed.ok) {
        setClipboardError(`Clipboard JSON parse error: ${parsed.error}`);
        return;
      }
      setClipboardRoot({ value: parsed.value, raw: trimmed });
    } catch (e) {
      setClipboardError(getErrorMessage(e));
    }
  }

  function buildRoots(): { ok: true; roots: unknown[] } | { ok: false; error: string } {
    const roots: unknown[] = [];

    const trimmedTextarea = textareaRaw.trim();
    if (trimmedTextarea) {
      const parsed = tryParseJson(trimmedTextarea);
      if (!parsed.ok) {
        return { ok: false, error: `Textarea JSON parse error: ${parsed.error}` };
      }
      roots.push(parsed.value);
    }

    if (clipboardRoot) {
      roots.push(clipboardRoot.value);
    }

    for (const entry of fileEntries) {
      if (entry.parseError) {
        return { ok: false, error: `File "${entry.name}": ${entry.parseError}` };
      }
      const parsed = tryParseJson(entry.text);
      if (!parsed.ok) {
        return { ok: false, error: `File "${entry.name}": ${parsed.error}` };
      }
      roots.push(parsed.value);
    }

    return { ok: true, roots };
  }

  async function handlePreview() {
    setPreviewError(null);
    setPreview(null);
    setApplyResult(null);
    setApplyError(null);
    setPasswords({});
    setPanelHostnames({});

    const rootsResult = buildRoots();
    if (!rootsResult.ok) {
      setPreviewError(rootsResult.error);
      return;
    }

    if (rootsResult.roots.length === 0) {
      setPreviewError("Please provide at least one import source (textarea, clipboard, or file).");
      return;
    }

    const merged = mergeParsedRootsToImportJson(rootsResult.roots);
    if (!merged.ok) {
      setPreviewError(merged.errors.join("\n"));
      return;
    }

    setIsPreviewLoading(true);
    try {
      const response = await fetch("/api/import/preview", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(merged.json),
      });

      if (!response.ok) {
        throw new Error(await readError(response));
      }

      const data = (await response.json()) as PreviewResult;
      setPreview(data);

      const initialPasswords: Record<string, string> = {};
      for (const key of data.passwordKeys ?? []) {
        initialPasswords[key] = "";
      }
      setPasswords(initialPasswords);

      const initialPanelHostnames: Record<string, string> = {};
      for (const key of data.panelHostnameKeys ?? []) {
        initialPanelHostnames[key] = "";
      }
      setPanelHostnames(initialPanelHostnames);
    } catch (error) {
      setPreviewError(getErrorMessage(error));
    } finally {
      setIsPreviewLoading(false);
    }
  }

  async function handleApply() {
    setApplyError(null);
    setApplyResult(null);

    const rootsResult = buildRoots();
    if (!rootsResult.ok) {
      setApplyError(rootsResult.error);
      return;
    }

    const merged = mergeParsedRootsToImportJson(rootsResult.roots);
    if (!merged.ok) {
      setApplyError(merged.errors.join("\n"));
      return;
    }

    setIsApplyLoading(true);
    try {
      const body: Record<string, unknown> = {
        import: merged.json,
        passwords,
      };
      if (Object.keys(panelHostnames).length > 0) {
        body.panelHostnames = panelHostnames;
      }

      const response = await fetch("/api/import/apply", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        throw new Error(await readError(response));
      }

      setApplyResult(await response.json());
    } catch (error) {
      setApplyError(getErrorMessage(error));
    } finally {
      setIsApplyLoading(false);
    }
  }

  const canApply =
    preview?.canApply === true &&
    Object.values(passwords).every((v) => v.trim() !== "") &&
    Object.values(panelHostnames).every((v) => v.trim() !== "");

  const hasAnySource =
    textareaRaw.trim() !== "" || clipboardRoot !== null || fileEntries.length > 0;

  return (
    <section style={cardStyle}>
      <div style={headerRowStyle}>
        <div>
          <div style={eyebrowStyle}>Import</div>
          <h2 style={pageTitleStyle}>Import configuration</h2>
          <p style={helperTextStyle}>
            Paste JSON, upload files, or use clipboard to import VPN chains and profiles into the
            manager.
          </p>
        </div>
        <div style={headerButtonGroupStyle}>
          <button
            disabled={!hasAnySource || isPreviewLoading}
            onClick={() => void handlePreview()}
            style={secondaryButtonStyle}
            type="button"
          >
            {isPreviewLoading ? "Loading..." : "Preview"}
          </button>
          <button
            disabled={!canApply || isApplyLoading}
            onClick={() => void handleApply()}
            style={primaryButtonStyle}
            type="button"
          >
            {isApplyLoading ? "Applying..." : "Apply"}
          </button>
        </div>
      </div>

      <div style={contentStyle}>
        {/* Textarea */}
        <label style={labelStyle}>
          Paste JSON
          <textarea
            onChange={(e) => setTextareaRaw(e.target.value)}
            placeholder='Paste a v2 export, v3 bundle, or bare VPN object ({"host":"...", ...})'
            style={textareaStyle}
            value={textareaRaw}
          />
        </label>

        {/* Clipboard */}
        <div style={rowStyle}>
          <button onClick={() => void handlePasteClipboard()} style={secondaryButtonStyle} type="button">
            Paste from clipboard
          </button>
          {clipboardRoot ? (
            <span style={successBadgeStyle}>
              Clipboard document loaded
              <button
                onClick={() => setClipboardRoot(null)}
                style={removeBtnStyle}
                type="button"
              >
                ✕
              </button>
            </span>
          ) : null}
          {clipboardError ? <span style={inlineErrorStyle}>{clipboardError}</span> : null}
        </div>

        {/* File drop zone */}
        <div>
          <div style={labelStyle as CSSProperties}>Upload JSON files</div>
          <div
            onClick={() => fileInputRef.current?.click()}
            onDragLeave={handleDragLeave}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
            style={{
              ...dropZoneStyle,
              ...(isDragOver ? dropZoneActiveStyle : {}),
            }}
          >
            <p style={{ margin: 0, color: "#6b7280" }}>
              Drag &amp; drop <code>.json</code> files here, or click to browse
            </p>
            <input
              accept=".json,application/json"
              multiple
              onChange={(e) => {
                addFiles(Array.from(e.target.files ?? []));
                e.target.value = "";
              }}
              ref={fileInputRef}
              style={{ display: "none" }}
              type="file"
            />
          </div>

          {fileEntries.length > 0 ? (
            <ul style={fileListStyle}>
              {fileEntries.map((entry, i) => (
                <li key={i} style={fileItemStyle}>
                  <span style={entry.parseError ? { color: "#b91c1c" } : { color: "#111827" }}>
                    {entry.name}
                    {entry.parseError ? ` — ${entry.parseError}` : ""}
                  </span>
                  <button
                    onClick={() => removeFile(i)}
                    style={removeBtnStyle}
                    type="button"
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        {/* Preview errors/result */}
        {previewError ? (
          <div style={errorStyle}>
            <strong>Preview error:</strong>
            <pre style={inlinePreStyle}>{previewError}</pre>
          </div>
        ) : null}

        {preview ? (
          <div style={previewSectionStyle}>
            <div style={sectionHeaderStyle}>
              <h3 style={sectionTitleStyle}>Preview result</h3>
              <span
                style={preview.canApply ? canApplyBadgeStyle : cannotApplyBadgeStyle}
              >
                {preview.canApply ? "Can apply" : "Cannot apply"}
              </span>
            </div>

            {preview.errors.length > 0 ? (
              <div style={errorStyle}>
                <strong>Errors:</strong>
                <ul style={listStyle}>
                  {preview.errors.map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            {preview.warnings.length > 0 ? (
              <div style={warningStyle}>
                <strong>Warnings:</strong>
                <ul style={listStyle}>
                  {preview.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            {preview.plan !== null && preview.plan !== undefined ? (
              <div>
                <h4 style={subSectionTitleStyle}>Import plan</h4>
                <pre style={previewStyle}>{JSON.stringify(preview.plan, null, 2)}</pre>
              </div>
            ) : null}

            {/* Credential inputs */}
            {(preview.passwordKeys?.length > 0 || preview.panelHostnameKeys?.length > 0) ? (
              <div>
                <h4 style={subSectionTitleStyle}>Required credentials</h4>
                <p style={helperTextStyle}>
                  These credentials are needed to complete the import.
                </p>
                <div style={credentialGridStyle}>
                  {preview.passwordKeys?.map((key) => (
                    <label key={key} style={labelStyle}>
                      Password — <code>{key}</code>
                      <input
                        onChange={(e) =>
                          setPasswords((prev) => ({ ...prev, [key]: e.target.value }))
                        }
                        placeholder="SSH password"
                        style={inputStyle}
                        type="password"
                        value={passwords[key] ?? ""}
                      />
                    </label>
                  ))}
                  {preview.panelHostnameKeys?.map((key) => (
                    <label key={key} style={labelStyle}>
                      Panel hostname — <code>{key}</code>
                      <input
                        onChange={(e) =>
                          setPanelHostnames((prev) => ({ ...prev, [key]: e.target.value }))
                        }
                        placeholder="panel.example.com"
                        style={inputStyle}
                        type="text"
                        value={panelHostnames[key] ?? ""}
                      />
                    </label>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        {applyError ? <div style={errorStyle}>{applyError}</div> : null}

        {applyResult ? (
          <div style={successStyle}>
            <strong>Import applied successfully.</strong>
            <pre style={inlinePreStyle}>{JSON.stringify(applyResult, null, 2)}</pre>
          </div>
        ) : null}
      </div>
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

const headerButtonGroupStyle: CSSProperties = {
  display: "flex",
  gap: "8px",
  flexShrink: 0,
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

const subSectionTitleStyle: CSSProperties = {
  margin: "0 0 8px",
  fontSize: "1rem",
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

const textareaStyle: CSSProperties = {
  ...inputStyle,
  minHeight: "40vh",
  resize: "vertical",
  fontFamily: "monospace",
  fontSize: "0.9rem",
};

const sectionHeaderStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: "16px",
  marginBottom: "12px",
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
  border: "1px solid #d1d5db",
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

const errorStyle: CSSProperties = {
  padding: "12px 14px",
  borderRadius: "10px",
  background: "#fef2f2",
  color: "#b91c1c",
  border: "1px solid #fecaca",
};

const warningStyle: CSSProperties = {
  padding: "12px 14px",
  borderRadius: "10px",
  background: "#fffbeb",
  color: "#92400e",
  border: "1px solid #fde68a",
};

const successStyle: CSSProperties = {
  padding: "12px 14px",
  borderRadius: "10px",
  background: "#f0fdf4",
  color: "#166534",
  border: "1px solid #bbf7d0",
};

const dropZoneStyle: CSSProperties = {
  padding: "32px 24px",
  borderRadius: "14px",
  border: "2px dashed #d1d5db",
  background: "#f9fafb",
  textAlign: "center",
  cursor: "pointer",
  transition: "background 0.15s, border-color 0.15s",
};

const dropZoneActiveStyle: CSSProperties = {
  background: "#eff6ff",
  borderColor: "#3b82f6",
};

const fileListStyle: CSSProperties = {
  listStyle: "none",
  margin: "8px 0 0",
  padding: 0,
  display: "grid",
  gap: "6px",
};

const fileItemStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  padding: "8px 12px",
  borderRadius: "8px",
  background: "#f9fafb",
  border: "1px solid #e5e7eb",
  fontSize: "0.9rem",
};

const removeBtnStyle: CSSProperties = {
  padding: "2px 6px",
  borderRadius: "6px",
  border: "none",
  background: "transparent",
  cursor: "pointer",
  color: "#6b7280",
  fontSize: "0.85rem",
  flexShrink: 0,
  marginLeft: "8px",
};

const rowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "12px",
  flexWrap: "wrap",
};

const successBadgeStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  padding: "4px 10px",
  borderRadius: "20px",
  background: "#f0fdf4",
  color: "#166534",
  border: "1px solid #bbf7d0",
  fontSize: "0.85rem",
  fontWeight: 600,
};

const canApplyBadgeStyle: CSSProperties = {
  display: "inline-block",
  padding: "4px 10px",
  borderRadius: "20px",
  background: "#f0fdf4",
  color: "#166534",
  border: "1px solid #bbf7d0",
  fontSize: "0.85rem",
  fontWeight: 600,
};

const cannotApplyBadgeStyle: CSSProperties = {
  display: "inline-block",
  padding: "4px 10px",
  borderRadius: "20px",
  background: "#fef2f2",
  color: "#b91c1c",
  border: "1px solid #fecaca",
  fontSize: "0.85rem",
  fontWeight: 600,
};

const inlineErrorStyle: CSSProperties = {
  color: "#b91c1c",
  fontSize: "0.9rem",
};

const inlinePreStyle: CSSProperties = {
  margin: "8px 0 0",
  fontSize: "0.85rem",
  whiteSpace: "pre-wrap",
  wordBreak: "break-all",
};

const listStyle: CSSProperties = {
  margin: "6px 0 0",
  paddingLeft: "20px",
};

const previewSectionStyle: CSSProperties = {
  display: "grid",
  gap: "16px",
  padding: "20px",
  borderRadius: "14px",
  background: "#f9fafb",
  border: "1px solid #e5e7eb",
};

const credentialGridStyle: CSSProperties = {
  display: "grid",
  gap: "16px",
  marginTop: "12px",
};
