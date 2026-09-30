import * as Y from "yjs";

export type CollabStatus = "offline" | "connecting" | "syncing" | "connected";

const DEFAULT_URL = "ws://127.0.0.1:8000/api/projects/poc/collaboration";
const PROTOCOL_VERSION = 1;
const REMOTE_ORIGIN = "remote";

/**
 * Yjs client over the PoC collaboration WebSocket.
 * Text JSON = hello/ready/ping/pong; binary = opaque Yjs updates.
 */
export class CollaborationClient {
  readonly doc = new Y.Doc();
  readonly ytext: Y.Text;
  private ws: WebSocket | undefined;
  private status: CollabStatus = "offline";
  private unsubUpdate: (() => void) | undefined;

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
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return Promise.resolve();
    }
    this.setStatus("connecting");
    return new Promise((resolve, reject) => {
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
            this.setStatus("connected");
            this.wireOutgoing();
            this.onReady?.();
            resolve();
          } else if (msg.type === "pong") {
            // ignore
          } else if (msg.type === "error") {
            reject(new Error(ev.data));
          }
          return;
        }
        const buf = ev.data instanceof ArrayBuffer ? new Uint8Array(ev.data) : new Uint8Array(ev.data as ArrayBuffer);
        Y.applyUpdate(this.doc, buf, REMOTE_ORIGIN);
      };

      ws.onerror = () => {
        this.setStatus("offline");
        reject(new Error(`WebSocket error connecting to ${this.url}`));
      };

      ws.onclose = () => {
        this.unsubUpdate?.();
        this.unsubUpdate = undefined;
        this.ws = undefined;
        this.setStatus("offline");
      };
    });
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

  ping(): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "ping" }));
    }
  }

  disconnect(): void {
    this.unsubUpdate?.();
    this.unsubUpdate = undefined;
    this.ws?.close();
    this.ws = undefined;
    this.setStatus("offline");
  }
}
