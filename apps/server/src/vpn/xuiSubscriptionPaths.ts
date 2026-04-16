import { randomXuiAlnum } from "./xuiRandom";

const SEG_LEN = 18;

function stripSlashes(s: string): string {
  return s.trim().replace(/^\/+/, "").replace(/\/+$/, "");
}

function toDbPath(segment: string): string {
  return `/${segment}/`;
}

/**
 * Random subscription paths for 3x-ui `settings` keys `subPath` and `subJsonPath`.
 * Avoids defaults `/sub/` and `/json/`, duplicate segments, and matching `webBasePath`.
 */
export function makeDistinctSubscriptionPathDbValues(webBasePath: string): {
  subPathDb: string;
  subJsonPathDb: string;
} {
  const wb = stripSlashes(webBasePath);
  for (let attempt = 0; attempt < 100; attempt++) {
    const seg1 = randomXuiAlnum(SEG_LEN);
    const seg2 = randomXuiAlnum(SEG_LEN);
    if (seg1 === seg2) continue;
    if (seg1 === wb || seg2 === wb) continue;
    if (seg1 === "sub" || seg2 === "sub" || seg1 === "json" || seg2 === "json") continue;
    const subPathDb = toDbPath(seg1);
    const subJsonPathDb = toDbPath(seg2);
    if (subPathDb === "/sub/" || subJsonPathDb === "/json/") continue;
    return { subPathDb, subJsonPathDb };
  }
  throw new Error("makeDistinctSubscriptionPathDbValues: exhausted retries");
}
