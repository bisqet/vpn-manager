import { beforeEach, describe, expect, test } from "bun:test";
import { createProfileSshWebSocketHandlers } from "./profileSshBridge";
import type { WSContext } from "hono/ws";

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

  write(data: Buffer) {
    this.writtenBuffers.push(data);
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

  /** When set, `connect` emits `error` instead of `ready` (for failure-path tests). */
  static emitConnectError: Error | null = null;

  connect(config: unknown) {
    this.connectConfig = config;
    const err = FakeClient.emitConnectError;
    if (err) {
      for (const cb of this.eventHandlers.get("error") ?? []) cb(err);
      return;
    }
    // Immediately emit "ready" so onOpen can proceed synchronously in tests
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
// Helpers
// ---------------------------------------------------------------------------

const ROW = { host: "10.0.0.1", ssh_port: 22, ssh_user: "root" };

/**
 * Creates handlers with FakeClient injected, then calls onOpen so the SSH
 * "ready" + shell sequence runs synchronously.  Returns both the handlers and
 * the FakeClient instance that was constructed internally.
 */
function openHandlers(ws: FakeWs): {
  handlers: ReturnType<typeof createProfileSshWebSocketHandlers>;
  client: FakeClient;
} {
  FakeClient.lastInstance = null;
  const handlers = createProfileSshWebSocketHandlers({
    row: ROW,
    sshPassword: "hunter2",
    env: {},
    // Cast needed because FakeClient doesn't exactly satisfy typeof Client
    ClientImpl: FakeClient as unknown as typeof import("ssh2").Client,
  });
  handlers.onOpen(new Event("open"), ws as unknown as WSContext);
  // By now FakeClient.lastInstance is the instance created inside onOpen
  const client = FakeClient.lastInstance!;
  return { handlers, client };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createProfileSshWebSocketHandlers", () => {
  beforeEach(() => {
    FakeClient.emitConnectError = null;
  });

  test("binary data from stream stdout is forwarded to ws.send as Uint8Array", () => {
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
    const msgEvt = { data: resizeMsg } as MessageEvent;
    handlers.onMessage(msgEvt, ws as unknown as WSContext);

    expect(client.stream!.setWindowCalls.length).toBe(1);
    expect(client.stream!.setWindowCalls[0]).toEqual([40, 120, 0, 0]);
  });

  test("binary ArrayBuffer input is written to stream", () => {
    const ws = makeFakeWs();
    const { handlers, client } = openHandlers(ws);

    const ab = new Uint8Array([65, 66, 67]).buffer;
    const msgEvt = { data: ab } as MessageEvent;
    handlers.onMessage(msgEvt, ws as unknown as WSContext);

    expect(client.stream!.writtenBuffers.length).toBe(1);
    expect(Array.from(client.stream!.writtenBuffers[0])).toEqual([65, 66, 67]);
  });

  test("onClose ends the ssh connection", () => {
    const ws = makeFakeWs();
    const { handlers, client } = openHandlers(ws);

    handlers.onClose(new CloseEvent("close"), ws as unknown as WSContext);

    expect(client.ended).toBe(true);
  });

  test("stream close event closes the ws with code 1000", () => {
    const ws = makeFakeWs();
    const { client } = openHandlers(ws);

    client.stream!.end();

    expect(ws.closed).toBe(true);
    expect(ws.closeCode).toBe(1000);
  });

  test("connect is called with correct host/port/user", () => {
    const ws = makeFakeWs();
    const { client } = openHandlers(ws);

    const cfg = client.connectConfig as Record<string, unknown>;
    expect(cfg.host).toBe(ROW.host);
    expect(cfg.port).toBe(ROW.ssh_port);
    expect(cfg.username).toBe(ROW.ssh_user);
    expect(cfg.password).toBe("hunter2");
  });

  test("ssh2 connection error closes WebSocket 1011 with truncated ssh2 message", () => {
    FakeClient.emitConnectError = new Error("connect ETIMEDOUT 10.0.0.1:22");
    const ws = makeFakeWs();
    openHandlers(ws);
    expect(ws.closed).toBe(true);
    expect(ws.closeCode).toBe(1011);
    expect(ws.closeReason).toBe("connect ETIMEDOUT 10.0.0.1:22");
  });
});
