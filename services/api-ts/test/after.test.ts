import assert from "node:assert/strict";
import { test } from "node:test";
import { after, LONGEST_TIMER_MS } from "../src/adapters/after.ts";

test("a delay longer than one timer can hold is waited out in steps, not fired at once", () => {
  // Node fires a longer setTimeout after 1 ms instead, which is how a 2562047h shutdown timeout ended in 1 ms.
  const scheduled: number[] = [];
  let fired = 0;
  const schedule = (fn: () => void, ms: number) => {
    scheduled.push(ms);
    fn();
  };
  after(LONGEST_TIMER_MS * 2 + 5, () => fired++, schedule);
  assert.deepEqual(scheduled, [LONGEST_TIMER_MS, LONGEST_TIMER_MS, 5]);
  assert.equal(fired, 1);
  scheduled.length = 0;
  after(1500, () => fired++, schedule);
  assert.deepEqual(scheduled, [1500]);
});
