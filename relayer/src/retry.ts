import type { RelayRecord, RelayStore } from "./store";

export interface RetryManagerOptions {
  pollIntervalMs?: number;
  now?: () => number;
  processor?: (record: RelayRecord) => Promise<void>;
}

/**
 * Background processor for persisted pending/submitted relay work.
 */
export class RetryManager {
  private readonly now: () => number;
  private readonly pollIntervalMs: number;
  private readonly processor?: (record: RelayRecord) => Promise<void>;
  private interval: NodeJS.Timeout | null = null;
  private inFlight = false;

  constructor(
    private readonly store: Pick<RelayStore, "getProcessable">,
    options: RetryManagerOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.pollIntervalMs = options.pollIntervalMs ?? 5_000;
    this.processor = options.processor;
  }

  start(): void {
    if (this.interval) {
      return;
    }

    this.interval = setInterval(() => {
      void this.tick();
    }, this.pollIntervalMs);
    void this.tick();
  }

  stop(): void {
    if (!this.interval) {
      return;
    }

    clearInterval(this.interval);
    this.interval = null;
  }

  private async tick(): Promise<void> {
    if (this.inFlight || !this.processor) {
      return;
    }

    this.inFlight = true;
    try {
      for (const record of this.store.getProcessable(this.now())) {
        try {
          await this.processor(record);
        } catch {
          // The service already persists retry/failure state. Keep draining.
        }
      }
    } finally {
      this.inFlight = false;
    }
  }
}
