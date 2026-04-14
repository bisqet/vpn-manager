import type { CSSProperties } from "react";

export const chainsPageRootStackStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr)",
  gap: "24px",
  alignItems: "start",
};

export const chainRailStyle: CSSProperties = {
  display: "flex",
  flexWrap: "nowrap",
  gap: "12px",
  overflowX: "auto",
  paddingBottom: "4px",
};
