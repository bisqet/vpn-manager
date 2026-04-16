import { isPublicIpLiteral } from "../net/panelAddress";
import { recoverPanelSecretsWhenNoInstallBanner } from "./installShExistingPanelRecover";
import { runSubscriptionPathHardeningOnPty } from "./installShSubscriptionPathHardening";
import { createInstallShPromptRules, runPromptDriver } from "./installShPromptDriver";
import { makeDistinctSubscriptionPathDbValues } from "./xuiSubscriptionPaths";
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
      /** Public HTTPS port for the panel (null = default 443 in panel URLs). */
      panelPort: number | null;
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
  /**
   * Keep reading PTY output this long after the install banner so credential lines in later
   * chunks are captured (default applied in {@link runPromptDriver}). Tests may pass 0.
   */
  tailDrainAfterCompleteMs?: number;
  /** Test hook: override subscription hardening (default: {@link runSubscriptionPathHardeningOnPty}). */
  runSubscriptionPathHardeningOnPtyImpl?: typeof runSubscriptionPathHardeningOnPty;
}): Promise<InstallShSetupResult> {
  const {
    write,
    subscribePtyData,
    panelHostname,
    signal,
    installCommand = DEFAULT_INSTALL_COMMAND,
    globalTimeoutMs,
    tailDrainAfterCompleteMs,
    runSubscriptionPathHardeningOnPtyImpl,
  } = options;

  const harden = runSubscriptionPathHardeningOnPtyImpl ?? runSubscriptionPathHardeningOnPty;

  const trim = panelHostname.trim();
  const buffer = createPtyPlaintextBuffer();
  const rules = createInstallShPromptRules({
    panelHostname: trim,
    isPanelIp: isPublicIpLiteral(trim),
  });

  const driverResult = await runPromptDriver({
    write: (s) => write(s),
    subscribeData: subscribePtyData,
    rules,
    plaintext: buffer,
    globalTimeoutMs: globalTimeoutMs ?? 90 * 60 * 1000,
    signal,
    completionIncludes: ["Panel Installation Complete", "installation finished, it is running now"],
    tailDrainAfterCompleteMs,
    afterSubscribe: () => {
      write(installCommand + "\n");
    },
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

  let credentials = parseInstallShCredentials(plainTranscript, trim);
  if (
    !credentials &&
    plainTranscript.includes("installation finished, it is running now") &&
    !plainTranscript.includes("Panel Installation Complete")
  ) {
    const recovered = await recoverPanelSecretsWhenNoInstallBanner({
      write,
      subscribePtyData,
      plaintext: buffer,
      signal,
    });
    if (recovered) {
      credentials = recovered;
    }
  }

  if (!credentials) {
    return {
      outcome: "failed",
      reason:
        "could not obtain panel credentials from install output or x-ui CLI (check transcript tail)",
      plainTranscript,
    };
  }

  const { subPathDb, subJsonPathDb } = makeDistinctSubscriptionPathDbValues(credentials.webBasePath);
  const hardened = await harden({
    write,
    subscribePtyData,
    plaintext: buffer,
    signal,
    subPathDb,
    subJsonPathDb,
  });
  if (!hardened) {
    return {
      outcome: "failed",
      reason:
        "subscription URI hardening failed (sqlite / systemd); panel may still use default /sub/ or /json/ paths — see transcript",
      plainTranscript: buffer.getPlaintext(),
    };
  }

  return {
    outcome: "success",
    adminUsername: credentials.adminUsername,
    adminPassword: credentials.adminPassword,
    webBasePath: credentials.webBasePath,
    panelPort: credentials.panelPort,
    plainTranscript,
  };
}
