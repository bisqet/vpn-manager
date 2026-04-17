export type TeardownPhaseId = "x_ui_uninstall";

export type TeardownPhase = {
  id: TeardownPhaseId;
  title: string;
  script: string;
};

/**
 * Clear-server runs the upstream 3x-ui admin CLI once. `install.sh` places it at `/usr/bin/x-ui`.
 * That script's `uninstall` path prompts for confirmation and ends with `exit 1` after removing
 * itself (`delete_script`); we pipe `y` and treat "Uninstalled Successfully" in the captured log
 * as success regardless of the trailing exit code.
 */
export function buildTeardownPhases(): TeardownPhase[] {
  const xUiUninstall: TeardownPhase = {
    id: "x_ui_uninstall",
    title: "Uninstall 3x-ui (upstream x-ui uninstall)",
    script: `set -u
X_UI_BIN=/usr/bin/x-ui
if ! [[ -x "$X_UI_BIN" ]]; then
  if [[ ! -e /usr/local/x-ui && ! -e /etc/systemd/system/x-ui.service ]]; then
    echo "VpnManager: panel already absent (no x-ui CLI and no install paths)." >&2
    exit 0
  fi
  echo "VpnManager: $X_UI_BIN is missing but install paths exist; cannot run uninstall." >&2
  exit 1
fi
set +e
LOG=$(mktemp)
trap 'rm -f "$LOG"' EXIT
echo y | "$X_UI_BIN" uninstall >"$LOG" 2>&1
code=$?
cat "$LOG"
if grep -Fq 'Uninstalled Successfully' "$LOG"; then
  exit 0
fi
exit "$code"
`,
  };

  return [xUiUninstall];
}
