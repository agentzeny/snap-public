import type { RelayStore } from "./store";

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_PER_IP_LIMIT = 10;
const DEFAULT_GLOBAL_LIMIT = 100;

export interface RateLimiterOptions {
  maxRequestsPerMinutePerIp?: number;
  maxRequestsPerMinuteGlobal?: number;
  windowMs?: number;
  now?: () => number;
  store: Pick<RelayStore, "getRateLimitSnapshot" | "reservePending">;
}

/**
 * SQLite-backed rate limiting derived from persisted relay requests.
 *
 * This survives relayer restarts as long as the relayer instances share
 * the same SQLite database.
 */
export class RateLimiter {
  private readonly now: () => number;
  private readonly windowMs: number;
  private readonly perIpLimit: number;
  private readonly globalLimit: number;
  private readonly store: Pick<RelayStore, "getRateLimitSnapshot" | "reservePending">;

  constructor(options: RateLimiterOptions) {
    this.store = options.store;
    this.now = options.now ?? Date.now;
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.perIpLimit = options.maxRequestsPerMinutePerIp ?? DEFAULT_PER_IP_LIMIT;
    this.globalLimit = options.maxRequestsPerMinuteGlobal ?? DEFAULT_GLOBAL_LIMIT;
  }

  check(ip: string): { allowed: boolean; retryAfter?: number } {
    const now = this.now();
    const snapshot = this.store.getRateLimitSnapshot(ip, now - this.windowMs);

    if (snapshot.ipCount >= this.perIpLimit && snapshot.ipOldest !== null) {
      return {
        allowed: false,
        retryAfter: Math.max(1, this.windowMs - (now - snapshot.ipOldest)),
      };
    }

    if (snapshot.globalCount >= this.globalLimit && snapshot.globalOldest !== null) {
      return {
        allowed: false,
        retryAfter: Math.max(1, this.windowMs - (now - snapshot.globalOldest)),
      };
    }

    return { allowed: true };
  }

  reserve(args: {
    clientIp: string;
    fee: number;
    nullifierHash: string;
    pool: string;
    requestJson: string;
  }): { allowed: boolean; recordId?: string; retryAfter?: number } {
    return this.store.reservePending(
      {
        clientIp: args.clientIp,
        fee: args.fee,
        nullifierHash: args.nullifierHash,
        pool: args.pool,
        receivedAt: this.now(),
        requestJson: args.requestJson,
      },
      {
        globalLimit: this.globalLimit,
        perIpLimit: this.perIpLimit,
        windowMs: this.windowMs,
      },
    );
  }
}
