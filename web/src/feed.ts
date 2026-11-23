import { decodeBatch, decodeLease, MAX_BATCH_BYTES, MAX_SESSION_BYTES, readBytes, type Cursor, type TerrainBatch } from "./wire.js";

export type FeedStatus = TerrainBatch["status"] |
  "detached" | "pairing" | "loading" | "rate-limited" | "expired" | "offline" | "rejected";

interface FeedEvents {
  apply(batch: TerrainBatch): void;
  reset(): void;
  status(status: FeedStatus): void;
}

type Authorization = { kind: "pairing" | "lease"; token: string };
const authFailures = [401, 403, 404, 410];
const visibleInterval = 60;
const hiddenInterval = 1000;
const requestTimeout = 6000;

function retryDelay(response: Response): number {
  const header = response.headers.get("Retry-After");
  if (!header) return 500;
  const delay = /^\d+$/.test(header) ? Number(header) * 1000 : Date.parse(header) - Date.now();
  return Number.isNaN(delay) ? 500 : Math.max(250, Math.min(15_000, delay));
}

export class ViewerFeed {
  private auth: Authorization | null = null;
  private cursor: Cursor = { epoch: 0, seq: 0 };
  private stableStatus: TerrainBatch["status"] | "loading" = "loading";
  private timer: number | null = null;
  private pending: AbortController | null = null;
  private lastStart = -Infinity;
  private retryAt = 0;
  private failures = 0;
  private hidden = false;

  constructor(private readonly events: FeedEvents, private readonly request: typeof fetch = (input, init) => fetch(input, init)) {}

  attach(secret: string): void {
    if (!/^[0-9a-f]{64}$/i.test(secret)) throw new Error("Invalid pairing secret");
    this.stop();
    this.auth = { kind: "pairing", token: secret };
    this.events.status("pairing");
    this.schedule();
  }

  detach(): void {
    this.disconnect("detached");
  }

  setHidden(hidden: boolean): void {
    if (hidden === this.hidden) return;
    this.hidden = hidden;
    this.cancelTimer();
    this.schedule();
  }

  private clearCursor(): void {
    this.cursor = { epoch: 0, seq: 0 };
    this.stableStatus = "loading";
    this.events.reset();
  }

  private cancelTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private stop(): void {
    this.auth = null;
    this.retryAt = this.failures = 0;
    this.cancelTimer();
    this.pending?.abort();
    this.clearCursor();
  }

  private disconnect(status: FeedStatus): void {
    this.stop();
    this.events.status(status);
  }

  private schedule(): void {
    if (!this.auth || this.pending || this.timer !== null) return;
    const interval = this.hidden ? hiddenInterval : visibleInterval;
    const start = Math.max(this.retryAt, this.lastStart + interval);
    this.timer = setTimeout(() => { void this.pull(); }, Math.max(0, Math.ceil(start - performance.now())));
  }

  private async pull(): Promise<void> {
    this.timer = null;
    const auth = this.auth;
    if (!auth || this.pending) return;
    const active = new AbortController();
    const timeout = setTimeout(() => active.abort(), requestTimeout);
    this.pending = active;
    this.lastStart = performance.now();
    const pairing = auth.kind === "pairing";

    try {
      const headers: Record<string, string> = { Authorization: `Bearer ${auth.token}` };
      if (!pairing) headers["Content-Type"] = "application/json";
      const result = await this.request(pairing ? "/session" : "/next", {
        method: "POST", headers, body: pairing ? undefined : JSON.stringify(this.cursor),
        credentials: "omit", cache: "no-store", mode: "same-origin", redirect: "error",
        referrerPolicy: "same-origin", signal: active.signal,
      });
      if (this.auth !== auth) {
        await result.body?.cancel();
        return;
      }

      if (!result.ok) {
        await result.body?.cancel();
        if (this.auth !== auth) return;
        if (result.status === 429) {
          this.retryAt = performance.now() + retryDelay(result);
          this.events.status("rate-limited");
          return;
        }
        if (authFailures.includes(result.status)) {
          this.disconnect(pairing ? "rejected" : "expired");
          return;
        }
        throw new Error("Viewer request failed");
      }

      if (pairing) {
        const lease = decodeLease(await readBytes(result, MAX_SESSION_BYTES));
        if (this.auth !== auth) return;
        if (active.signal.aborted) throw new Error("Viewer request timed out");
        this.auth = { kind: "lease", token: lease };
        this.events.status("loading");
      } else if (result.status === 204) {
        if (active.signal.aborted) throw new Error("Viewer request timed out");
        this.events.status(this.stableStatus);
      } else {
        const batch = decodeBatch(await readBytes(result, MAX_BATCH_BYTES));
        if (this.auth !== auth) return;
        if (active.signal.aborted) throw new Error("Viewer request timed out");
        if (batch.epoch === this.cursor.epoch && batch.seq < this.cursor.seq) throw new Error("Viewer cursor regressed");
        this.events.apply(batch);
        this.cursor = { epoch: batch.epoch, seq: batch.seq };
        this.stableStatus = batch.status;
        this.events.status(batch.status);
      }
      this.retryAt = this.failures = 0;
    } catch {
      if (this.auth !== auth) return;
      if (pairing || ++this.failures >= 3) {
        this.disconnect("offline");
      } else {
        this.clearCursor();
        this.retryAt = performance.now() + this.failures * 250;
        this.events.status("loading");
      }
    } finally {
      clearTimeout(timeout);
      this.pending = null;
      this.schedule();
    }
  }
}
