import type { RecoverSecretsOptions } from "./installShExistingPanelRecover";
import { runPromptDriver } from "./installShPromptDriver";

export const VPNMGR_SUB_PATH_HARDEN_OK = "__VPNMGR_SUB_PATH_HARDEN_OK__";
export const XUI_PANEL_SETTINGS_DB = "/etc/x-ui/x-ui.db";

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
      write(`\nset -euo pipefail
XUI_DB='${XUI_PANEL_SETTINGS_DB}'
test -f "$XUI_DB"
command -v sqlite3 >/dev/null || { export DEBIAN_FRONTEND=noninteractive; apt-get update -qq; apt-get install -y -qq sqlite3; }
systemctl stop x-ui
sub_changes=$(sqlite3 "$XUI_DB" "UPDATE settings SET value='${subPathDb}' WHERE key='subPath'; SELECT changes();")
json_changes=$(sqlite3 "$XUI_DB" "UPDATE settings SET value='${subJsonPathDb}' WHERE key='subJsonPath'; SELECT changes();")
test "$sub_changes" = "1"
test "$json_changes" = "1"
systemctl start x-ui
sleep 2
systemctl is-active --quiet x-ui
echo '${VPNMGR_SUB_PATH_HARDEN_OK}'
`);
    },
  });

  return driver.status === "completed";
}
