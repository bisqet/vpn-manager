import { describe, expect, test } from "bun:test";
import {
  bashPersistSubscriptionPathsToSqlite,
  makeDistinctSubscriptionPathDbValues,
} from "./xuiSubscriptionPaths";

describe("makeDistinctSubscriptionPathDbValues", () => {
  test("returns distinct paths with slashes and not defaults", () => {
    const wb = "webpath123456789012";
    const got = makeDistinctSubscriptionPathDbValues(wb);
    expect(got.subPathDb).not.toBe("/sub/");
    expect(got.subJsonPathDb).not.toBe("/json/");
    expect(got.subPathDb).not.toBe(got.subJsonPathDb);
    expect(got.subPathDb.startsWith("/")).toBe(true);
    expect(got.subPathDb.endsWith("/")).toBe(true);
    expect(got.subJsonPathDb.startsWith("/")).toBe(true);
    expect(got.subJsonPathDb.endsWith("/")).toBe(true);
  });

  test("bash sqlite fragment uses delete+insert for missing rows", () => {
    const sh = bashPersistSubscriptionPathsToSqlite("/etc/x-ui/x-ui.db", "/Aa1/", "/Bb2/");
    expect(sh).toContain("DELETE FROM settings WHERE key='subPath'");
    expect(sh).toContain("INSERT INTO settings (key, value) VALUES ('subPath', '/Aa1/')");
    expect(sh).toContain("test \"$sub_v\" = '/Aa1/'");
  });

  test("segments are not equal to stripped webBasePath", () => {
    const wb = "aaaaaaaaaaaaaaaaaa";
    for (let i = 0; i < 30; i++) {
      const got = makeDistinctSubscriptionPathDbValues(wb);
      const s1 = got.subPathDb.slice(1, -1);
      const s2 = got.subJsonPathDb.slice(1, -1);
      expect(s1).not.toBe(wb);
      expect(s2).not.toBe(wb);
    }
  });
});
