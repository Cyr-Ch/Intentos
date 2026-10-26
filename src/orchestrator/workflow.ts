export const RUN_STATES = [
  "CREATED",
  "INDEXED",
  "CONTEXT_RETRIEVED",
  "CONTRACT_PROPOSED",
  "CONTRACT_VALIDATED",
  "CLARIFICATION_REQUIRED",
  "ABSTAINED",
  "APPROVED",
  "IMPLEMENTING",
  "VERIFYING",
  "REPAIRING",
  "REVIEW_READY",
  "HUMAN_REVIEW",
  "FAILED",
] as const;
export type RunState = (typeof RUN_STATES)[number];

const TRANSITIONS: Record<RunState, RunState[]> = {
  CREATED: ["INDEXED", "FAILED"],
  INDEXED: ["CONTEXT_RETRIEVED", "FAILED"],
  CONTEXT_RETRIEVED: ["CONTRACT_PROPOSED", "FAILED"],
  CONTRACT_PROPOSED: ["CONTRACT_VALIDATED", "CONTRACT_PROPOSED", "FAILED"],
  CONTRACT_VALIDATED: ["CLARIFICATION_REQUIRED", "ABSTAINED", "APPROVED", "FAILED"],
  CLARIFICATION_REQUIRED: [],
  ABSTAINED: [],
  APPROVED: ["IMPLEMENTING", "FAILED"],
  IMPLEMENTING: ["VERIFYING", "FAILED"],
  VERIFYING: ["REVIEW_READY", "REPAIRING", "HUMAN_REVIEW", "FAILED"],
  REPAIRING: ["VERIFYING", "FAILED"],
  // Review outcomes can be revoked by an independent re-verification (`intentos verify`), never upgraded.
  REVIEW_READY: ["HUMAN_REVIEW", "FAILED"],
  HUMAN_REVIEW: ["FAILED"],
  FAILED: [],
};

export const TERMINAL_STATES: ReadonlySet<RunState> = new Set(["CLARIFICATION_REQUIRED", "ABSTAINED", "REVIEW_READY", "HUMAN_REVIEW", "FAILED"]);

export class InvalidTransitionError extends Error {
  readonly from: RunState;
  readonly to: RunState;
  constructor(from: RunState, to: RunState) {
    super(`invalid run state transition ${from} -> ${to}`);
    this.from = from;
    this.to = to;
  }
}

export function canTransition(from: RunState, to: RunState): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransition(from: RunState, to: RunState): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

export function isRunState(value: string): value is RunState {
  return (RUN_STATES as readonly string[]).includes(value);
}

/** States from which `resume` may continue work (non-terminal). */
export function isResumable(state: RunState): boolean {
  return !TERMINAL_STATES.has(state);
}
