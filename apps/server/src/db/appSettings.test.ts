import { expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "./migrate";
import { getAppSettings, patchAppSettings, putTestAppSettings } from "./appSettings";

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
});

test("getAppSettings bootstraps from env when row missing", () => {
  process.env.ACME_EMAIL = "  seed@example.com  ";
  process.env.VPN_SSH_ENABLED = "true";
  process.env.SSH_KNOWN_HOSTS_FILE = "/tmp/kh";
  const s = getAppSettings(db);
  expect(s.acmeEmail).toBe("seed@example.com");
  expect(s.vpnSshEnabled).toBe(true);
  expect(s.sshKnownHostsFile).toBe("/tmp/kh");
  delete process.env.ACME_EMAIL;
  delete process.env.VPN_SSH_ENABLED;
  delete process.env.SSH_KNOWN_HOSTS_FILE;
});

test("patchAppSettings rejects live SSH without ACME email", () => {
  putTestAppSettings(db, { acmeEmail: "", vpnSshEnabled: false, sshKnownHostsFile: null });
  expect(() => patchAppSettings(db, { vpnSshEnabled: true })).toThrow();
});

test("patchAppSettings happy path updates a field and updatedAt changes", async () => {
  putTestAppSettings(db, {
    acmeEmail: "a@b.co",
    vpnSshEnabled: false,
    sshKnownHostsFile: null,
  });
  const before = getAppSettings(db);
  await Bun.sleep(5);
  const after = patchAppSettings(db, { acmeEmail: "  new@example.com  " });
  expect(after.acmeEmail).toBe("new@example.com");
  expect(after.updatedAt).not.toBe(before.updatedAt);
});
