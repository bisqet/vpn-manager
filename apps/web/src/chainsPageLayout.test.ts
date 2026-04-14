import { describe, expect, test } from "bun:test";
import {
  chainsPageRootStackStyle,
  chainRailStyle,
} from "./chainsPageLayout";

describe("chains page layout tokens", () => {
  test("root stack is a single-column grid (no fixed sidebar track)", () => {
    expect(chainsPageRootStackStyle.display).toBe("grid");
    expect(chainsPageRootStackStyle.gridTemplateColumns).toBe("minmax(0, 1fr)");
    expect(String(chainsPageRootStackStyle.gridTemplateColumns)).not.toContain("280px");
  });

  test("chain rail scrolls horizontally when content overflows", () => {
    expect(chainRailStyle.display).toBe("flex");
    expect(chainRailStyle.flexWrap).toBe("nowrap");
    expect(chainRailStyle.overflowX).toBe("auto");
  });
});
