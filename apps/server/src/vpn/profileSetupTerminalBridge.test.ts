import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createProfileSetupTerminalWebSocketHandlers } from "./profileSetupTerminalBridge";
import type { WSContext } from "hono/ws";
import { beginSetupRun, endSetupRun } from "./setupRunRegistry";

// ---------------------------------------------------------------------------
// Fake ssh2 stream
// ---------------------------------------------------------------------------

type DataListener = (data: unknown) => void;

class FakeStream {
  private listeners: Map<string, DataListener[]> = new Map();
  stderr = {
    _listeners: new Map<string, DataListener[]>(),
    on(event: string, cb: DataListener) {
      const arr = this._listeners.get(event) ?? [];
      arr.push(cb);
      this._listeners.set(event, arr);
    },
    emit(event: string, data: unknown) {
      for (const cb of this._listeners.get(event) ?? []) cb(data);
    },
  };

  setWindowCalls: Array<[number, number, number, number]> = [];
  writtenBuffers: Buffer[] = [];
  ended = false;

  on(event: string, cb: DataListener) {
    const arr = this.listeners.get(event) ?? [];
    arr.push(cb);
    this.listeners.set(event, arr);
  }

  emit(event: string, data: unknown) {
    for (const cb of this.listeners.get(event) ?? []) cb(data);
  }

  setWindow(rows: number, cols: number, height: number, width: number) {
    this.setWindowCalls.push([rows, cols, height, width]);
  }

  write(data: Buffer | string) {
    const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    this.writtenBuffers.push(buf);
  }

  end() {
    this.ended = true;
    this.emit("close", undefined);
  }
}

// ---------------------------------------------------------------------------
// Fake ssh2 Client
// ---------------------------------------------------------------------------

type EventHandler = (...args: unknown[]) => void;

class FakeClient {
  /** Last instance created — captured so tests can inspect it. */
  static lastInstance: FakeClient | null = null;
  /** When set, `connect` emits `error` instead of `ready`. */
  static emitConnectError: Error | null = null;

  private eventHandlers: Map<string, EventHandler[]> = new Map();
  stream: FakeStream | null = null;
  connectConfig: unknown = null;
  ended = false;

  constructor() {
    FakeClient.lastInstance = this;
  }

  on(event: string, cb: EventHandler) {
    const arr = this.eventHandlers.get(event) ?? [];
    arr.push(cb);
    this.eventHandlers.set(event, arr);
    return this;
  }

  connect(config: unknown) {
    this.connectConfig = config;
    const err = FakeClient.emitConnectError;
    if (err) {
      for (const cb of this.eventHandlers.get("error") ?? []) cb(err);
      return;
    }
    for (const cb of this.eventHandlers.get("ready") ?? []) cb();
  }

  shell(
    _options: { term: string; cols: number; rows: number },
    cb: (err: Error | undefined, stream: FakeStream) => void,
  ) {
    this.stream = new FakeStream();
    cb(undefined, this.stream);
  }

  end() {
    this.ended = true;
  }
}

// ---------------------------------------------------------------------------
// Fake WSContext
// ---------------------------------------------------------------------------

type FakeWs = {
  sent: unknown[];
  closed: boolean;
  closeCode: number | undefined;
  closeReason: string | undefined;
  send(data: unknown): void;
  close(code?: number, reason?: string): void;
};

function makeFakeWs(): FakeWs {
  return {
    sent: [],
    closed: false,
    closeCode: undefined,
    closeReason: undefined,
    send(data: unknown) {
      this.sent.push(data);
    },
    close(code?: number, reason?: string) {
      this.closed = true;
      this.closeCode = code;
      this.closeReason = reason;
    },
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROFILE_ID = 42;

const ROW = {
  id: PROFILE_ID,
  host: "10.0.0.1",
  ssh_port: 22,
  ssh_user: "root",
  operational_status: "pending",
  panel_hostname: "vpn.example.com",
  ssh_password_ciphertext: new Uint8Array(32),
  ssh_password_nonce: new Uint8Array(12),
};

const FAKE_DB = {} as never;
const FAKE_ENV = { masterKey: new Uint8Array(32) };
const FAKE_APP_SETTINGS = {
  acmeEmail: "",
  vpnSshEnabled: true,
  sshKnownHostsFile: null,
  updatedAt: "",
};

/**
 * Never-resolving mock for runLiveSetupPhases.
 * Ensures driver doesn't complete during synchronous tests, avoiding
 * registry races between test cases.
 */
const hangingRunLiveSetupPhases = () =>
  new Promise<{ outcome: "live-success" | "live-failed"; phases: [] }>(() => {});

/**
 * Creates handlers with FakeClient injected, calls onOpen so the SSH
 * ready + shell sequence runs synchronously, and returns both objects.
 */
function openHandlers(
  ws: FakeWs,
  runLiveSetupPhasesImpl = hangingRunLiveSetupPhases,
): {
  handlers: ReturnType<typeof createProfileSetupTerminalWebSocketHandlers>;
  client: FakeClient;
} {
  FakeClient.lastInstance = null;
  const handlers = createProfileSetupTerminalWebSocketHandlers({
    db: FAKE_DB,
    env: FAKE_ENV,
    profileId: PROFILE_ID,
    row: ROW,
    sshPassword: "hunter2",
    getAppSettings: () => FAKE_APP_SETTINGS,
    ClientImpl: FakeClient as unknown as typeof import("ssh2").Client,
    _runLiveSetupPhases: runLiveSetupPhasesImpl,
  });
  handlers.onOpen(new Event("open"), ws as unknown as WSContext);
  const client = FakeClient.lastInstance!;
  return { handlers, client };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createProfileSetupTerminalWebSocketHandlers", () => {
  beforeEach(() => {
    FakeClient.emitConnectError = null;
    FakeClient.lastInstance = null;
  });

  afterEach(() => {
    // Safety cleanup: remove any registry entry left by hanging drivers.
    endSetupRun(PROFILE_ID);
  });

  test("binary data from stream is forwarded to ws.send as Uint8Array", () => {
    const ws = makeFakeWs();
    const { client } = openHandlers(ws);

    const payload = Buffer.from([1, 2, 3, 4]);
    client.stream!.emit("data", payload);

    expect(ws.sent.length).toBe(1);
    expect(ws.sent[0]).toBeInstanceOf(Uint8Array);
    expect(Array.from(ws.sent[0] as Uint8Array)).toEqual([1, 2, 3, 4]);
  });

  test("binary data from stream stderr is forwarded to ws.send as Uint8Array", () => {
    const ws = makeFakeWs();
    const { client } = openHandlers(ws);

    const payload = Buffer.from([9, 8, 7]);
    client.stream!.stderr.emit("data", payload);

    expect(ws.sent.length).toBe(1);
    expect(ws.sent[0]).toBeInstanceOf(Uint8Array);
    expect(Array.from(ws.sent[0] as Uint8Array)).toEqual([9, 8, 7]);
  });

  test("JSON resize message calls stream.setWindow(rows, cols, 0, 0)", () => {
    const ws = makeFakeWs();
    const { handlers, client } = openHandlers(ws);

    const resizeMsg = JSON.stringify({ type: "resize", cols: 120, rows: 40 });
    handlers.onMessage({ data: resizeMsg } as MessageEvent, ws as unknown as WSContext);

    expect(client.stream!.setWindowCalls.length).toBe(1);
    expect(client.stream!.setWindowCalls[0]).toEqual([40, 120, 0, 0]);
  });

  test("non-resize JSON text is NOT written to the stream", () => {
    const ws = makeFakeWs();
    const { handlers, client } = openHandlers(ws);

    handlers.onMessage(
      { data: JSON.stringify({ type: "keypress", key: "a" }) } as MessageEvent,
      ws as unknown as WSContext,
    );

    expect(client.stream!.writtenBuffers.length).toBe(0);
  });

  test("raw (non-JSON) text is NOT written to the stream", () => {
    const ws = makeFakeWs();
    const { handlers, client } = openHandlers(ws);

    handlers.onMessage(
      { data: "ls -la\n" } as MessageEvent,
      ws as unknown as WSContext,
    );

    expect(client.stream!.writtenBuffers.length).toBe(0);
  });

  test("binary ArrayBuffer input is NOT written to the stream", () => {
    const ws = makeFakeWs();
    const { handlers, client } = openHandlers(ws);

    const ab = new Uint8Array([65, 66, 67]).buffer;
    handlers.onMessage({ data: ab } as MessageEvent, ws as unknown as WSContext);

    expect(client.stream!.writtenBuffers.length).toBe(0);
  });

  test("onClose with code 4401 (detach) does NOT end stream or conn synchronously", () => {
    const ws = makeFakeWs();
    const { handlers, client } = openHandlers(ws);

    handlers.onClose({ code: 4401 } as CloseEvent, ws as unknown as WSContext);

    expect(client.stream!.ended).toBe(false);
    expect(client.ended).toBe(false);
  });

  test("onClose with code 4400 (stop) ends the ssh connection", () => {
    const ws = makeFakeWs();
    const { handlers, client } = openHandlers(ws);

    handlers.onClose({ code: 4400 } as CloseEvent, ws as unknown as WSContext);

    expect(client.ended).toBe(true);
  });

  test("onClose with normal code 1000 ends the ssh connection", () => {
    const ws = makeFakeWs();
    const { handlers, client } = openHandlers(ws);

    handlers.onClose(new CloseEvent("close", { code: 1000 }), ws as unknown as WSContext);

    expect(client.ended).toBe(true);
  });

  test("beginSetupRun already active closes ws with 1011 and 'setup already running'", () => {
    const ws = makeFakeWs();
    // Pre-register profileId so the bridge's beginSetupRun returns { ok: false }.
    beginSetupRun(PROFILE_ID);

    FakeClient.lastInstance = null;
    const handlers = createProfileSetupTerminalWebSocketHandlers({
      db: FAKE_DB,
      env: FAKE_ENV,
      profileId: PROFILE_ID,
      row: ROW,
      sshPassword: "hunter2",
      getAppSettings: () => FAKE_APP_SETTINGS,
      ClientImpl: FakeClient as unknown as typeof import("ssh2").Client,
      _runLiveSetupPhases: hangingRunLiveSetupPhases,
    });
    handlers.onOpen(new Event("open"), ws as unknown as WSContext);

    expect(ws.closed).toBe(true);
    expect(ws.closeCode).toBe(1011);
    expect(ws.closeReason).toBe("setup already running");
    // No FakeClient was constructed (onOpen returned before new SshClient()).
    expect(FakeClient.lastInstance).toBeNull();
  });

  test("ssh2 connection error closes WebSocket 1011 with truncated ssh2 message", () => {
    FakeClient.emitConnectError = new Error("connect ETIMEDOUT 10.0.0.1:22");
    const ws = makeFakeWs();
    openHandlers(ws);

    expect(ws.closed).toBe(true);
    expect(ws.closeCode).toBe(1011);
    expect(ws.closeReason).toBe("connect ETIMEDOUT 10.0.0.1:22");
  });

  test("connect is called with correct host/port/user/password", () => {
    const ws = makeFakeWs();
    const { client } = openHandlers(ws);

    const cfg = client.connectConfig as Record<string, unknown>;
    expect(cfg.host).toBe(ROW.host);
    expect(cfg.port).toBe(ROW.ssh_port);
    expect(cfg.username).toBe(ROW.ssh_user);
    expect(cfg.password).toBe("hunter2");
  });

  test("driver sends setupComplete JSON and closes ws when run succeeds", async () => {
    const completingMock = async () =>
      ({ outcome: "live-success" as const, phases: [] });

    const ws = makeFakeWs();
    openHandlers(ws, completingMock);

    // Allow microtasks to flush so the driver's .then fires.
    await Promise.resolve();
    await Promise.resolve();

    const textFrames = ws.sent.filter((s) => typeof s === "string");
    expect(textFrames.length).toBeGreaterThan(0);
    const completionFrame = JSON.parse(textFrames[textFrames.length - 1] as string);
    expect(completionFrame).toEqual({ type: "setupComplete", outcome: "success" });
    expect(ws.closed).toBe(true);
    expect(ws.closeCode).toBe(1000);
    expect(ws.closeReason).toBe("done");
  });

  test("driver sends setupComplete failed when run returns live-failed", async () => {
    const failingMock = async () =>
      ({ outcome: "live-failed" as const, phases: [] });

    const ws = makeFakeWs();
    openHandlers(ws, failingMock);

    await Promise.resolve();
    await Promise.resolve();

    const textFrames = ws.sent.filter((s) => typeof s === "string");
    const completionFrame = JSON.parse(textFrames[textFrames.length - 1] as string);
    expect(completionFrame).toEqual({ type: "setupComplete", outcome: "failed" });
    expect(ws.closeCode).toBe(1000);
  });
});
