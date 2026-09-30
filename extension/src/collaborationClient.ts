import * as Y from "yjs";
import { REMOTE_SYNC } from "./origins";

export type CollabStatus = "offline" | "connecting" | "syncing" | "connected";

export type FsOperation = {
  kind: "create" | "delete" | "rename" | "move" | "mkdir";
  path?: string;
  from?: string;
  to?: string;
  content?: string;
};

export type FsOperationEvent = {
  operation_id: string;
  revision: number;
  operation: FsOperation;
};

export type FsOperationAck = {
  operation_id: string;
  revision: number;
};

export type AssetChangedEvent = {
  path: string;
  revision: number;
  content_hash: string;
  size: number;
};

export type ReconcileRequiredEvent = {
  revision: number;
  reason: string;
  last_known_revision?: number;
};

const PROTOCOL_VERSION = 1;
// ponytail: exp backoff capped at 30s; upgrade to jittered shared retry policy if many clients stampede.
const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];
const FS_ACK_TIMEOUT_MS = 10_000;

/**
 * Yjs client over the collaboration WebSocket.
 * Text JSON = hello/ready/ping/pong/fs ops/reconcile; binary = opaque Yjs updates.
 * Ready barrier: flush only after optional snapshot binary when ready.has_snapshot.
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
  /** True after ready (+ snapshot if has_snapshot) flushed for this handshake. */
  private readyFlushed = false;
  /** Expect one binary snapshot frame before flushReady (from ready.has_snapshot). */
  private awaitingSnapshot = false;
  private connectWaiters: {
    resolve: () => void;
    reject: (e: Error) => void;
  }[] = [];
  private fsAckWaiters = new Map<
    string,
    { resolve: (a: FsOperationAck) => void; reject: (e: Error) => void }
  >();
  private opSeq = 0;
  /** Last workspace topology revision from ready / ack / broadcast. */
  workspaceRevision = 0;

  onStatus: ((s: CollabStatus) => void) | undefined;
  onReady: (() => void) | undefined;
  onFsOperation: ((msg: FsOperationEvent) => void) | undefined;
  onWorkspaceRevision: ((revision: number) => void) | undefined;
  onAssetChanged: ((msg: AssetChangedEvent) => void) | undefined;

  /** Local last-known workspace topology revision (sent on hello for gap detect). */
  lastKnownRevision = 0;

  onReconcileRequired: ((msg: ReconcileRequiredEvent) => void) | undefined;

  constructor(
    readonly clientId: string,
    /** WS URL from .presentation/workspace.json (server + projectId). No /poc fallback. */
    readonly url: string,
    lastKnownRevision = 0,
  ) {
    // Match server/pycrdt key: Doc.get("content", type=Text)
    this.ytext = this.doc.getText("content");
    this.lastKnownRevision = lastKnownRevision;
    this.workspaceRevision = lastKnownRevision;
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
      if (this.status === "connected" && this.readyFlushed) return Promise.resolve();
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

  private flushReady(): void {
    if (this.readyFlushed) return;
    this.readyFlushed = true;
    this.awaitingSnapshot = false;
    this.pushFullState();
    this.onReady?.();
    this.settleConnect();
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
          last_known_revision: this.lastKnownRevision,
        }),
      );
    };

    ws.onmessage = (ev) => {
      if (typeof ev.data === "string") {
        let msg: {
          type?: string;
          revision?: number;
          has_snapshot?: boolean;
          operation_id?: string;
          operation?: FsOperation;
          path?: string;
          content_hash?: string;
          size?: number;
          code?: string;
          message?: string;
          reason?: string;
          last_known_revision?: number;
        };
        try {
          msg = JSON.parse(ev.data) as typeof msg;
        } catch {
          return;
        }
        if (msg.type === "ready") {
          this.reconnectAttempt = 0;
          this.readyFlushed = false;
          this.awaitingSnapshot = msg.has_snapshot === true;
          if (typeof msg.revision === "number") {
            this.workspaceRevision = msg.revision;
            this.onWorkspaceRevision?.(msg.revision);
          }
          this.setStatus("connected");
          this.wireOutgoing();
          // Deterministic barrier (H1): flush now if no snapshot follows; else wait for binary.
          if (!this.awaitingSnapshot) {
            this.flushReady();
          }
        } else if (msg.type === "pong") {
          // ignore
        } else if (msg.type === "fs.operation_ack") {
          const id = msg.operation_id;
          if (id && typeof msg.revision === "number") {
            const w = this.fsAckWaiters.get(id);
            if (w) {
              this.fsAckWaiters.delete(id);
              this.workspaceRevision = msg.revision;
              w.resolve({ operation_id: id, revision: msg.revision });
            }
          }
        } else if (msg.type === "fs.operation") {
          if (
            msg.operation_id &&
            typeof msg.revision === "number" &&
            msg.operation &&
            typeof msg.operation.kind === "string"
          ) {
            this.workspaceRevision = msg.revision;
            this.onFsOperation?.({
              operation_id: msg.operation_id,
              revision: msg.revision,
              operation: msg.operation,
            });
          }
        } else if (msg.type === "workspace.revision") {
          if (typeof msg.revision === "number") {
            this.workspaceRevision = msg.revision;
            this.onWorkspaceRevision?.(msg.revision);
          }
        } else if (msg.type === "asset.changed") {
          if (
            typeof msg.path === "string" &&
            typeof msg.revision === "number" &&
            typeof msg.content_hash === "string" &&
            typeof msg.size === "number"
          ) {
            this.workspaceRevision = msg.revision;
            this.onAssetChanged?.({
              path: msg.path,
              revision: msg.revision,
              content_hash: msg.content_hash,
              size: msg.size,
            });
          }
        } else if (msg.type === "workspace.reconcile_required") {
          if (typeof msg.revision === "number") {
            this.workspaceRevision = msg.revision;
            this.onReconcileRequired?.({
              revision: msg.revision,
              reason: typeof msg.reason === "string" ? msg.reason : "unknown",
              last_known_revision:
                typeof msg.last_known_revision === "number"
                  ? msg.last_known_revision
                  : undefined,
            });
          }
        } else if (msg.type === "error") {
          const code = msg.code ?? "";
          if (code === "fs_rejected" || code === "fs_error" || code === "bad_fs_op") {
            // Fail oldest waiter — ponytail: errors lack operation_id; single in-flight op assumed.
            const first = this.fsAckWaiters.keys().next().value;
            if (first) {
              const w = this.fsAckWaiters.get(first);
              this.fsAckWaiters.delete(first);
              w?.reject(new Error(msg.message ?? ev.data));
            }
          } else {
            this.settleConnect(new Error(ev.data));
          }
        }
        return;
      }
      const buf = ev.data instanceof ArrayBuffer ? new Uint8Array(ev.data) : new Uint8Array(ev.data as ArrayBuffer);
      // REMOTE_SYNC: not tracked by UndoManager (selective local undo).
      Y.applyUpdate(this.doc, buf, REMOTE_SYNC);
      if (!this.readyFlushed && this.awaitingSnapshot) {
        this.flushReady();
      }
    };

    ws.onerror = () => {
      // onclose handles retry; reject only if this was the initial connect wait.
      if (this.status === "connecting" || this.status === "syncing") {
        // leave settle to onclose / ready
      }
    };

    ws.onclose = () => {
      // ponytail: ignore close from a superseded socket so reconnect race
      // doesn't clear the live ws / stick status at offline (open decision #7 framing).
      if (this.ws !== ws) return;
      this.unsubUpdate?.();
      this.unsubUpdate = undefined;
      this.ws = undefined;
      this.awaitingSnapshot = false;
      this.setStatus("offline");
      for (const [id, w] of this.fsAckWaiters) {
        w.reject(new Error("websocket closed"));
        this.fsAckWaiters.delete(id);
      }
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
      if (origin === REMOTE_SYNC) return;
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

  /** Queue an authoritative fs.operation; resolves on fs.operation_ack. */
  sendFsOperation(
    operation: FsOperation,
    baseRevision?: number,
  ): Promise<FsOperationAck> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("not connected"));
    }
    this.opSeq += 1;
    const operation_id = `op_${this.clientId}_${this.opSeq}`;
    const base =
      typeof baseRevision === "number" ? baseRevision : this.workspaceRevision;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fsAckWaiters.delete(operation_id);
        reject(new Error(`fs.operation_ack timeout for ${operation_id}`));
      }, FS_ACK_TIMEOUT_MS);
      this.fsAckWaiters.set(operation_id, {
        resolve: (a) => {
          clearTimeout(timer);
          resolve(a);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.ws!.send(
        JSON.stringify({
          type: "fs.operation",
          operation_id,
          base_revision: base,
          operation,
        }),
      );
    });
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
    this.awaitingSnapshot = false;
    this.readyFlushed = false;
    this.unsubUpdate?.();
    this.unsubUpdate = undefined;
    for (const [id, w] of this.fsAckWaiters) {
      w.reject(new Error("disconnected"));
      this.fsAckWaiters.delete(id);
    }
    this.ws?.close();
    this.ws = undefined;
    this.reconnectAttempt = 0;
    this.setStatus("offline");
  }
}
