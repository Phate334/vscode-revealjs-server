import * as Y from "yjs";

export type CollabStatus = "offline" | "connecting" | "syncing" | "connected";

const DEFAULT_URL = "ws://127.0.0.1:8000/api/projects/poc/collaboration";
const PROTOCOL_VERSION = 1;
const REMOTE_ORIGIN = "remote";
// ponytail: exp backoff capped at 30s; upgrade to jittered shared retry policy if many clients stampede.
const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];

/**
 * Yjs client over the PoC collaboration WebSocket.
 * Text JSON = hello/ready/ping/pong; binary = opaque Yjs updates.
 * Dropped sockets auto-reconnect with backoff; hello again + merge on ready.
 */
export class CollaborationClient {
  readonly doc = new Y.Doc();
  readonly ytext: Y.Text;
  private ws: WebSocket | undefined;
  private status: CollabStatus = "offline";
  private unsubUpdate: (() => void) | undefined;
  private intentionalClose = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectAttempt = 0;
  private connectWaiters: {
    resolve: () => void;
    reject: (e: Error) => void;
  }[] = [];

  onStatus: ((s: CollabStatus) => void) | undefined;
  onReady: (() => void) | undefined;

  constructor(
    readonly clientId: string,
    readonly url: string = DEFAULT_URL,
  ) {
    // Match server/pycrdt key used in tests: Doc.get("content", type=Text)
    this.ytext = this.doc.getText("content");
  }

  getStatus(): CollabStatus {
    return this.status;
  }

  private setStatus(s: CollabStatus): void {
    this.status = s;
    this.onStatus?.(s);
  }

  connect(): Promise<void> {
    this.intentionalClose = false;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      if (this.status === "connected") return Promise.resolve();
      return new Promise((resolve, reject) => {
        this.connectWaiters.push({ resolve, reject });
      });
    }
    return new Promise((resolve, reject) => {
      this.connectWaiters.push({ resolve, reject });
      this.openSocket();
    });
  }

  private settleConnect(err?: Error): void {
    const waiters = this.connectWaiters;
    this.connectWaiters = [];
    for (const w of waiters) {
      if (err) w.reject(err);
      else w.resolve();
    }
  }

  private openSocket(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.setStatus(this.reconnectAttempt > 0 ? "syncing" : "connecting");
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.binaryType = "arraybuffer";

    ws.onopen = () => {
      this.setStatus("syncing");
      ws.send(
        JSON.stringify({
          type: "hello",
          client_id: this.clientId,
          protocol_version: PROTOCOL_VERSION,
        }),
      );
    };

    ws.onmessage = (ev) => {
      if (typeof ev.data === "string") {
        let msg: { type?: string };
        try {
          msg = JSON.parse(ev.data) as { type?: string };
        } catch {
          return;
        }
        if (msg.type === "ready") {
          this.reconnectAttempt = 0;
          this.setStatus("connected");
          this.wireOutgoing();
          // Snapshot binary follows ready; push local state after it merges.
          queueMicrotask(() => this.pushFullState());
          this.onReady?.();
          this.settleConnect();
        } else if (msg.type === "pong") {
          // ignore
        } else if (msg.type === "error") {
          this.settleConnect(new Error(ev.data));
        }
        return;
      }
      const buf = ev.data instanceof ArrayBuffer ? new Uint8Array(ev.data) : new Uint8Array(ev.data as ArrayBuffer);
      Y.applyUpdate(this.doc, buf, REMOTE_ORIGIN);
    };

    ws.onerror = () => {
      // onclose handles retry; reject only if this was the initial connect wait.
      if (this.status === "connecting" || this.status === "syncing") {
        // leave settle to onclose / ready
      }
    };

    ws.onclose = () => {
      this.unsubUpdate?.();
      this.unsubUpdate = undefined;
      this.ws = undefined;
      this.setStatus("offline");
      if (this.intentionalClose) {
        this.settleConnect(new Error("disconnected"));
        return;
      }
      // Initial connect failed before ready: reject waiters, still retry.
      if (this.connectWaiters.length > 0 && this.reconnectAttempt === 0) {
        this.settleConnect(new Error(`WebSocket closed connecting to ${this.url}`));
      }
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.intentionalClose || this.reconnectTimer) return;
    const delay = BACKOFF_MS[Math.min(this.reconnectAttempt, BACKOFF_MS.length - 1)];
    this.reconnectAttempt++;
    // Stay offline during backoff; openSocket sets syncing/connecting on retry.
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.intentionalClose) return;
      this.openSocket();
    }, delay);
  }

  private wireOutgoing(): void {
    this.unsubUpdate?.();
    const handler = (update: Uint8Array, origin: unknown) => {
      if (origin === REMOTE_ORIGIN) return;
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      this.ws.send(update);
    };
    this.doc.on("update", handler);
    this.unsubUpdate = () => this.doc.off("update", handler);
  }

  /** Send full local Yjs state so server merges offline edits after reconnect. */
  private pushFullState(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const update = Y.encodeStateAsUpdate(this.doc);
    if (update.byteLength <= 2) return;
    this.ws.send(update);
  }

  ping(): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "ping" }));
    }
  }

  disconnect(): void {
    this.intentionalClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.unsubUpdate?.();
    this.unsubUpdate = undefined;
    this.ws?.close();
    this.ws = undefined;
    this.reconnectAttempt = 0;
    this.setStatus("offline");
  }
}
