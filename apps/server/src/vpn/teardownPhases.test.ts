import { describe, expect, test } from "bun:test";
import { buildTeardownPhases } from "./teardownPhases";

describe("buildTeardownPhases", () => {
  test("returns a single x-ui uninstall phase", () => {
    const phases = buildTeardownPhases();
    expect(phases.map((p) => p.id)).toEqual(["x_ui_uninstall"]);
    const script = phases[0]!.script;
    expect(script).toContain("/usr/bin/x-ui");
    expect(script).toContain("uninstall");
    expect(script).toContain("Uninstalled Successfully");
  });
});
