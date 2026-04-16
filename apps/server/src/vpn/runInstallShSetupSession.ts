import { isPublicIpLiteral } from "../net/panelAddress";
import { createInstallShPromptRules, runPromptDriver } from "./installShPromptDriver";
import { createPtyPlaintextBuffer } from "./ptyPlaintext";
import { parseInstallShCredentials } from "./installShTranscriptParser";

const DEFAULT_INSTALL_COMMAND =
  "bash <(curl -fsSL https://raw.githubusercontent.com/MHSanaei/3x-ui/master/install.sh)";

export type InstallShSetupResult =
  | {
      outcome: "success";
      adminUsername: string;
      adminPassword: string;
      webBasePath: string;
      plainTranscript: string;
    }
  | { outcome: "failed"; reason: string; plainTranscript: string };

export async function runInstallShSetupSession(options: {
  write: (data: string | Uint8Array) => void;
  subscribePtyData: (handler: (chunk: Uint8Array) => void) => () => void;
  panelHostname: string;
  signal: AbortSignal;
  installCommand?: string;
  /** Upper bound for install.sh + SSL (default 90 * 60 * 1000). */
  globalTimeoutMs?: number;
}): Promise<InstallShSetupResult> {
  const {
    write,
    subscribePtyData,
    panelHostname,
    signal,
    installCommand = DEFAULT_INSTALL_COMMAND,
    globalTimeoutMs,
  } = options;

  const trim = panelHostname.trim();
  const buffer = createPtyPlaintextBuffer();
  const rules = createInstallShPromptRules({
    panelHostname: trim,
    isPanelIp: isPublicIpLiteral(trim),
  });

  write(installCommand + "\n");

  const driverResult = await runPromptDriver({
    write: (s) => write(s),
    subscribeData: subscribePtyData,
    rules,
    plaintext: buffer,
    globalTimeoutMs: globalTimeoutMs ?? 90 * 60 * 1000,
    signal,
    completionIncludes: "Panel Installation Complete",
  });

  const plainTranscript = buffer.getPlaintext();

  if (driverResult.status === "timeout") {
    return {
      outcome: "failed",
      reason: "install.sh setup timed out",
      plainTranscript,
    };
  }
  if (driverResult.status === "aborted") {
    return {
      outcome: "failed",
      reason: "install.sh setup aborted",
      plainTranscript,
    };
  }

  const parsed = parseInstallShCredentials(plainTranscript, trim);
  if (!parsed) {
    return {
      outcome: "failed",
      reason: "could not parse install credentials from transcript",
      plainTranscript,
    };
  }

  return {
    outcome: "success",
    adminUsername: parsed.adminUsername,
    adminPassword: parsed.adminPassword,
    webBasePath: parsed.webBasePath,
    plainTranscript,
  };
}
