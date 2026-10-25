export interface RunLimits {
  maxWallMs: number;
  maxRepairs: number;
  maxPlannerRetries: number;
}

export function defaultLimits(): RunLimits {
  return {
    maxWallMs: Number(process.env.INTENTOS_RUN_TIMEOUT_MS ?? 60 * 60 * 1000),
    maxRepairs: 2,
    maxPlannerRetries: 1,
  };
}

export class BudgetExceededError extends Error {}

export class RunBudget {
  readonly startedAt: number;
  readonly limits: RunLimits;
  constructor(limits: RunLimits, startedAt = Date.now()) {
    this.limits = limits;
    this.startedAt = startedAt;
  }
  elapsedMs(): number {
    return Date.now() - this.startedAt;
  }
  /** Throws when the wall-clock budget is spent; call before every expensive step. */
  check(step: string): void {
    if (this.elapsedMs() > this.limits.maxWallMs) throw new BudgetExceededError(`run time budget (${this.limits.maxWallMs} ms) exceeded before ${step}`);
  }
  /** Repairs are bounded by both the limits and the contract (0–2). */
  repairsAllowed(contractMax: number): number {
    return Math.max(0, Math.min(this.limits.maxRepairs, contractMax, 2));
  }
}
