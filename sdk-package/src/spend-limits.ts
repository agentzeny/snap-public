const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export interface SpendPolicy {
  maxPerTransaction: number;
  maxPerHour: number;
  maxPerDay: number;
  requireOwnerApproval: number;
  allowedPools: string[];
}

export class SpendLimiter {
  private history: Array<{ amount: number; timestamp: number }> = [];

  constructor(
    private readonly policy: SpendPolicy,
    private readonly nowProvider: () => number = () => Date.now(),
  ) {}

  check(amount: number, poolAddress?: string): { allowed: boolean; reason?: string } {
    if (!Number.isFinite(amount) || amount <= 0) {
      return { allowed: false, reason: "amount must be greater than zero" };
    }

    if (amount > this.policy.maxPerTransaction) {
      return {
        allowed: false,
        reason: `amount ${amount} exceeds maxPerTransaction ${this.policy.maxPerTransaction}`,
      };
    }

    if (
      this.policy.requireOwnerApproval > 0 &&
      amount > this.policy.requireOwnerApproval
    ) {
      return {
        allowed: false,
        reason: `owner approval required above ${this.policy.requireOwnerApproval}`,
      };
    }

    if (this.policy.allowedPools.length > 0) {
      if (!poolAddress) {
        return {
          allowed: false,
          reason: "pool allowlist is configured but no pool address was provided",
        };
      }

      if (!this.policy.allowedPools.includes(poolAddress)) {
        return {
          allowed: false,
          reason: `pool ${poolAddress} is not in the allowlist`,
        };
      }
    }

    const now = this.nowProvider();
    this.pruneHistory(now);

    const hourlyTotal = this.sumSince(now - HOUR_MS);
    if (hourlyTotal + amount > this.policy.maxPerHour) {
      return {
        allowed: false,
        reason: `hourly limit exceeded (${hourlyTotal + amount} > ${this.policy.maxPerHour})`,
      };
    }

    const dailyTotal = this.sumSince(now - DAY_MS);
    if (dailyTotal + amount > this.policy.maxPerDay) {
      return {
        allowed: false,
        reason: `daily limit exceeded (${dailyTotal + amount} > ${this.policy.maxPerDay})`,
      };
    }

    return { allowed: true };
  }

  record(amount: number): void {
    const now = this.nowProvider();
    this.pruneHistory(now);
    this.history.push({ amount, timestamp: now });
  }

  serialize(): string {
    return JSON.stringify({
      version: 1,
      history: this.history,
    });
  }

  static deserialize(
    data: string,
    policy: SpendPolicy,
    nowProvider?: () => number,
  ): SpendLimiter {
    const limiter = new SpendLimiter(policy, nowProvider);
    const parsed = JSON.parse(data) as {
      history?: Array<{ amount?: number; timestamp?: number }>;
    };

    limiter.history = Array.isArray(parsed.history)
      ? parsed.history
          .filter(
            (entry) =>
              typeof entry.amount === "number" &&
              Number.isFinite(entry.amount) &&
              typeof entry.timestamp === "number" &&
              Number.isFinite(entry.timestamp),
          )
          .map((entry) => ({
            amount: entry.amount as number,
            timestamp: entry.timestamp as number,
          }))
      : [];

    limiter.pruneHistory(limiter.nowProvider());
    return limiter;
  }

  private sumSince(cutoff: number): number {
    return this.history.reduce(
      (total, entry) => (entry.timestamp >= cutoff ? total + entry.amount : total),
      0,
    );
  }

  private pruneHistory(now: number): void {
    const cutoff = now - DAY_MS;
    this.history = this.history.filter((entry) => entry.timestamp >= cutoff);
  }
}
