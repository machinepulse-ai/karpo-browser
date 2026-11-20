/**
 * A Chrome DevTools Protocol connection over a WebSocket: commands answered by id, on the browser's own session or
 * one of its targets' (flat sessions), and the browser's events.
 */
import { Timings } from "./timings.ts";

/** How long one command waits for its answer. */
const CALL_TIMEOUT_MS = 15_000;
/** How long connecting to the browser may take. */
const CONNECT_TIMEOUT_MS = 15_000;
const CLOSED = "the connection to the browser is closed";

/** Chrome answered a command with an error, or the command could not be sent. */
export class CdpError extends Error {}

/** The connection cannot deliver a command: it closed. Nothing says whether the browser is still there. */
export class CdpClosed extends CdpError {}

/**
 * A command was not answered in time. A timeout does not prove the connection is broken, nor that the command had no
 * effect.
 */
export class CdpTimeout extends CdpError {}

/** What a command's wait is bounded by besides the connection's own limit. */
export interface CallOptions {
  /** The moment (epoch ms) past which the command is no longer waited for. */
  until?: number | undefined;
}

type Listener = (method: string, params: unknown, sessionId: string | undefined) => void;

interface Pending {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class Connection {
  /** Where the browser's time went (settles, captures), every tab's together. */
  readonly timings = new Timings();
  private readonly socket: WebSocket;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<Listener>();
  private nextId = 1;
  private open = true;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener("message", (event) => this.receive(String(event.data)));
    socket.addEventListener("close", () => this.finish());
    socket.addEventListener("error", () => this.finish());
  }

  /** Connects to a browser's DevTools WebSocket (`ws://…/devtools/browser/…`). */
  static connect(url: string): Promise<Connection> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      const timer = setTimeout(() => {
        socket.close();
        reject(new CdpTimeout("connecting to the browser timed out"));
      }, CONNECT_TIMEOUT_MS);
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve(new Connection(socket));
      });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new CdpClosed("the browser could not be reached"));
      });
    });
  }

  /** Whether the connection has closed. */
  get closed(): boolean {
    return !this.open;
  }

  /** Sends one command (on `sessionId`, or the browser's own session) and returns its answer. */
  send(method: string, params: object = {}, sessionId?: string, options: CallOptions = {}): Promise<unknown> {
    if (!this.open) return Promise.reject(new CdpClosed(CLOSED));
    const wait = Math.min(CALL_TIMEOUT_MS, (options.until ?? Number.POSITIVE_INFINITY) - Date.now());
    if (wait <= 0) return Promise.reject(new CdpTimeout(`${method} timed out`));
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpTimeout(`${method} timed out`));
      }, wait);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  /** Hears every event of the browser; the returned function stops it. */
  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Waits `ms`; fails when the connection has closed by then. */
  async wait(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, Math.max(ms, 0)));
    if (!this.open) throw new CdpClosed(CLOSED);
  }

  close(): void {
    this.socket.close();
    this.finish();
  }

  private receive(text: string): void {
    let message: {
      id?: number;
      result?: unknown;
      error?: { message?: string };
      method?: string;
      params?: unknown;
      sessionId?: string;
    };
    try {
      message = JSON.parse(text);
    } catch {
      // A frame that is no JSON says nothing: passed over.
      return;
    }
    if (message.id === undefined) {
      if (message.method !== undefined) {
        for (const listener of this.listeners) listener(message.method, message.params ?? {}, message.sessionId);
      }
      return;
    }
    const call = this.pending.get(message.id);
    if (!call) return;
    this.pending.delete(message.id);
    clearTimeout(call.timer);
    if (message.error) call.reject(new CdpError(message.error.message ?? "CDP error"));
    else call.resolve(message.result ?? {});
  }

  private finish(): void {
    if (!this.open) return;
    this.open = false;
    for (const call of this.pending.values()) {
      clearTimeout(call.timer);
      call.reject(new CdpClosed(CLOSED));
    }
    this.pending.clear();
  }
}
