import * as Y from "yjs";
import { REMOTE_SYNC } from "./origins";

export type CollabStatus = "offline" | "connecting" | "syncing" | "connected";
export type FsOperation = {
  id: string;
  kind: "create" | "delete" | "rename" | "move" | "mkdir" | "write";
  path?: string;
  from?: string;
  to?: string;
  content?: string;
};
export type OperationResult = { operation: FsOperation; structure_revision: number };
export type OperationsResult = {
  structure_revision: number;
  results: OperationResult[];
  failed?: { index: number; message: string };
};

const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];

/** HTTP owns durable commands. This socket only carries CRDT updates and notifications. */
export class CollaborationClient {
  readonly doc = new Y.Doc();
  readonly documents = this.doc.getMap<Y.Text>("documents");
  canWrite = false;
  lastKnownStructureRevision: number;
  structureRevision: number;
  onStatus?: (status: CollabStatus) => void;
  onReady?: () => void;
  onRemoteStructure?: (revision: number) => void;
  onError?: (error: unknown) => void;
  onReplacedText?: (path: string, content: string) => void;
  private ws?: WebSocket;
  private status: CollabStatus = "offline";
  private intentionalClose = false;
  private reconnectAttempt = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private awaitingSnapshot = false;
  private readyFlushed = false;
  private barriers = new Map<string, { resolve: () => void; reject: (err: Error) => void }>();
  private readonly outgoing = (update: Uint8Array, origin: unknown) => {
    if (origin !== REMOTE_SYNC && this.readyFlushed && this.canWrite && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(update);
    }
  };

  constructor(readonly clientId: string, private readonly socketUrl: () => Promise<string>, revision = 0) {
    this.lastKnownStructureRevision = revision;
    this.structureRevision = revision;
    this.doc.on("update", this.outgoing);
  }

  getText(path: string): Y.Text {
    let text = this.documents.get(path);
    if (!text) { text = new Y.Text(); this.documents.set(path, text); }
    return text;
  }

  mergeRemote(update: Uint8Array): void {
    const before = new Map([...this.documents].map(([rel, text]) => [rel, { text, content: text.toString() }]));
    Y.applyUpdate(this.doc, update, REMOTE_SYNC);
    for (const [rel, old] of before) {
      if (this.documents.get(rel) !== old.text && this.documents.get(rel)?.toString() !== old.content) {
        this.onReplacedText?.(rel, old.content);
      }
    }
  }

  getStatus(): CollabStatus { return this.status; }
  private setStatus(status: CollabStatus): void { this.status = status; this.onStatus?.(status); }

  async connect(): Promise<void> {
    this.intentionalClose = false;
    if (this.ws || this.status === "connecting") return;
    this.setStatus("connecting");
    try {
      const url = await this.socketUrl();
      if (this.intentionalClose) return;
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.binaryType = "arraybuffer";
      ws.onopen = () => {
        this.setStatus("syncing");
        ws.send(JSON.stringify({ type: "hello", protocol_version: 2, client_id: this.clientId,
          last_known_structure_revision: this.lastKnownStructureRevision }));
      };
      ws.onmessage = (event) => {
        if (this.ws !== ws) return;
        try {
          if (typeof event.data !== "string") {
            this.mergeRemote(new Uint8Array(event.data as ArrayBuffer));
            if (this.awaitingSnapshot) this.flushReady();
            return;
          }
          const msg = JSON.parse(event.data);
          if (msg.type === "ready") {
            if (msg.protocol_version !== 2) throw new Error("Server protocol upgrade required");
            this.structureRevision = msg.structure_revision;
            this.canWrite = msg.can_write === true;
            this.awaitingSnapshot = msg.has_snapshot === true;
            if (!this.awaitingSnapshot) this.flushReady();
          } else if (["workspace.operations", "asset.changed", "reconcile_required"].includes(msg.type)) {
            this.structureRevision = Math.max(this.structureRevision, msg.structure_revision);
            this.onRemoteStructure?.(msg.structure_revision);
          } else if (msg.type === "pong") {
            this.barriers.get(msg.id)?.resolve();
            this.barriers.delete(msg.id);
          } else if (msg.type === "error") {
            this.onError?.(new Error(msg.message));
            if (msg.code === "protocol_version" || msg.code === "forbidden") this.disconnect();
          }
        } catch (error) { this.onError?.(error); this.disconnect(); }
      };
      ws.onerror = () => { /* onclose schedules retry; URLs may contain credentials. */ };
      ws.onclose = () => {
        if (this.ws !== ws) return;
        this.ws = undefined;
        this.readyFlushed = false;
        this.awaitingSnapshot = false;
        for (const barrier of this.barriers.values()) barrier.reject(new Error("Connection closed"));
        this.barriers.clear();
        this.setStatus("offline");
        this.scheduleReconnect();
      };
    } catch (error) {
      this.setStatus("offline");
      this.onError?.(error);
      this.scheduleReconnect();
    }
  }

  private flushReady(): void {
    this.awaitingSnapshot = false;
    this.readyFlushed = true;
    this.reconnectAttempt = 0;
    if (this.canWrite) this.ws?.send(Y.encodeStateAsUpdate(this.doc));
    this.setStatus("connected");
    this.onReady?.();
  }

  /** Ping is an ordered stream barrier before Snapshot/Publish commands, not an FS RPC. */
  flushText(): Promise<void> {
    if (!this.readyFlushed || this.ws?.readyState !== WebSocket.OPEN) return Promise.reject(new Error("Presentation is offline"));
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.barriers.delete(id); reject(new Error("Sync interrupted")); }, 15000);
      this.barriers.set(id, {
        resolve: () => { clearTimeout(timer); resolve(); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });
      this.ws!.send(JSON.stringify({ type: "ping", id }));
    });
  }

  private scheduleReconnect(): void {
    if (this.intentionalClose || this.reconnectTimer) return;
    const delay = BACKOFF_MS[Math.min(this.reconnectAttempt++, BACKOFF_MS.length - 1)];
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = undefined; void this.connect(); }, delay);
  }

  disconnect(): void {
    this.intentionalClose = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.readyFlushed = false;
    this.ws?.close();
    this.ws = undefined;
    for (const barrier of this.barriers.values()) barrier.reject(new Error("Disconnected"));
    this.barriers.clear();
    this.setStatus("offline");
  }

  dispose(): void { this.disconnect(); this.doc.off("update", this.outgoing); this.doc.destroy(); }
}
