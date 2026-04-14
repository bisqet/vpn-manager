import { describe, expect, test } from "bun:test";
import { trafficDiagramKey } from "./trafficDiagramKey";

describe("trafficDiagramKey", () => {
  test("edit mode encodes chain id and hop ids in position order", () => {
    expect(
      trafficDiagramKey({
        mode: "edit",
        chainId: 5,
        hopIdsInOrder: [10, 11],
      }),
    ).toBe("edit:5:10,11");
  });

  test("create mode encodes draft vpn profile id order", () => {
    expect(
      trafficDiagramKey({
        mode: "create",
        draftVpnProfileIdsInOrder: ["3", "7", "3"],
      }),
    ).toBe("create:3,7,3");
  });

  test("create mode normalizes empty draft list", () => {
    expect(
      trafficDiagramKey({
        mode: "create",
        draftVpnProfileIdsInOrder: [],
      }),
    ).toBe("create:");
  });
});
