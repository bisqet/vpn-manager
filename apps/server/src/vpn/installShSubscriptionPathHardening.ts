import type { RecoverSecretsOptions } from "./installShExistingPanelRecover";
import { runPromptDriver } from "./installShPromptDriver";
import {
  bashPersistSubscriptionPathsToSqlite,
  XUI_PANEL_SETTINGS_DB,
} from "./xuiSubscriptionPaths";

export const VPNMGR_SUB_PATH_HARDEN_OK = "__VPNMGR_SUB_PATH_HARDEN_OK__";
export { XUI_PANEL_SETTINGS_DB };

export type RunSubscriptionPathHardeningOnPtyOptions = RecoverSecretsOptions & {
  subPathDb: string;
  subJsonPathDb: string;
};

/**
 * Runs stop → sqlite3 UPDATE subPath + subJsonPath → start on the live PTY.
 * Paths must be shell-safe (implementation uses alphanumeric segments + slashes only).
 */
export async function runSubscriptionPathHardeningOnPty(
  options: RunSubscriptionPathHardeningOnPtyOptions,
): Promise<boolean> {
  const { write, subscribePtyData, plaintext, signal, subPathDb, subJsonPathDb } = options;

  const driver = await runPromptDriver({
    write: (s) => write(s),
    subscribeData: subscribePtyData,
    rules: [],
    plaintext,
    globalTimeoutMs: 120_000,
    signal,
    completionIncludes: VPNMGR_SUB_PATH_HARDEN_OK,
    tailDrainAfterCompleteMs: 400,
    afterSubscribe: () => {
      const sqliteBlock = bashPersistSubscriptionPathsToSqlite(
        XUI_PANEL_SETTINGS_DB,
        subPathDb,
        subJsonPathDb,
      );
      write(`\nset -euo pipefail
systemctl stop x-ui
${sqliteBlock}
systemctl start x-ui
sleep 2
systemctl is-active --quiet x-ui
echo '${VPNMGR_SUB_PATH_HARDEN_OK}'
`);
    },
  });

  return driver.status === "completed";
}
