export type TrafficDiagramKeyInput =
  | {
      mode: "edit";
      chainId: number;
      hopIdsInOrder: number[];
    }
  | {
      mode: "create";
      draftVpnProfileIdsInOrder: string[];
    };

export function trafficDiagramKey(input: TrafficDiagramKeyInput): string {
  if (input.mode === "edit") {
    return `edit:${input.chainId}:${input.hopIdsInOrder.join(",")}`;
  }
  return `create:${input.draftVpnProfileIdsInOrder.join(",")}`;
}
