/** The longest delay one Node timer holds; a longer one fires after 1 ms instead. */
export const LONGEST_TIMER_MS = 2 ** 31 - 1;

type Schedule = (fn: () => void, ms: number) => unknown;

/** Calls `fn` once `ms` have passed, in steps no timer overflows, on timers that do not keep the process alive. */
export function after(ms: number, fn: () => void, schedule: Schedule = (step, wait) => setTimeout(step, wait).unref()): void {
  const step = Math.min(ms, LONGEST_TIMER_MS);
  schedule(() => (ms > step ? after(ms - step, fn, schedule) : fn()), step);
}
