/**
 * The domain model: pure functions over plain data. No I/O, no clock, no randomness, and no imports
 * from outside this directory — not even a validation library, which is why `parseTask` is written
 * out. scripts/check-boundaries.mjs fails the build otherwise.
 *
 * The status rules are the same rules every task service enforces. They are repeated here rather than
 * imported across modules ([ADR-0004](../../../../docs/adr/0004-independent-modules.md)) so this
 * service can be deleted, or kept alone, without touching anything else. What they buy: a tool can
 * tell a model which moves are legal instead of letting it discover a 409 by trying.
 */

export const STATUSES = ["todo", "in_progress", "done"] as const;
export type Status = (typeof STATUSES)[number];

export interface Task {
  readonly id: string;
  readonly title: string;
  readonly status: Status;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export const MAX_TITLE_LENGTH = 200;

export type DomainErrorCode = "EMPTY_TITLE" | "TITLE_TOO_LONG" | "UNKNOWN_STATUS" | "INVALID_TRANSITION" | "NOT_FOUND" | "MALFORMED_TASK";

export class DomainError extends Error {
  readonly code: DomainErrorCode;

  constructor(code: DomainErrorCode, message: string) {
    super(message);
    this.name = "DomainError";
    this.code = code;
  }
}

/** Every legal move. Anything absent is refused, including staying put. */
const NEXT: Readonly<Record<Status, readonly Status[]>> = {
  todo: ["in_progress"],
  in_progress: ["todo", "done"],
  done: [],
};

export const nextStatuses = (status: Status): readonly Status[] => NEXT[status];

const isStatus = (value: unknown): value is Status => STATUSES.some((status) => status === value);

export function parseStatus(value: unknown): Status {
  if (isStatus(value)) return value;
  throw new DomainError("UNKNOWN_STATUS", `status must be one of ${STATUSES.join(", ")}`);
}

/** Refuses a title the API would refuse, so a bad one costs no request and gets a usable message. */
export function validateTitle(title: string): string {
  const trimmed = title.trim();
  if (trimmed === "") throw new DomainError("EMPTY_TITLE", "title must not be empty");
  // Counted in code points, not UTF-16 units, so the limit means the same as in api-go.
  if ([...trimmed].length > MAX_TITLE_LENGTH) {
    throw new DomainError("TITLE_TOO_LONG", `title must be at most ${MAX_TITLE_LENGTH} characters`);
  }
  return trimmed;
}

export function checkTransition(from: Status, to: Status): void {
  if (!NEXT[from].includes(to)) {
    const legal = NEXT[from].length === 0 ? "none" : NEXT[from].join(", ");
    throw new DomainError("INVALID_TRANSITION", `cannot move a task from ${from} to ${to}; legal moves from ${from}: ${legal}`);
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A task as it arrives from the API, validated before anything else reads it. A service that trusts
 * a response it did not check reports the remote system's bugs as its own.
 */
export function parseTask(value: unknown): Task {
  if (!isRecord(value)) throw new DomainError("MALFORMED_TASK", "expected a task object");
  const { id, title, status, createdAt, updatedAt } = value;
  for (const [field, raw] of Object.entries({ id, title, createdAt, updatedAt })) {
    if (typeof raw !== "string" || raw === "") throw new DomainError("MALFORMED_TASK", `task.${field} must be a non-empty string`);
  }
  return {
    id: id as string,
    title: title as string,
    status: parseStatus(status),
    createdAt: createdAt as string,
    updatedAt: updatedAt as string,
  };
}

export const parseTasks = (value: unknown): readonly Task[] => {
  if (!Array.isArray(value)) throw new DomainError("MALFORMED_TASK", "expected an array of tasks");
  return value.map(parseTask);
};
