import test from "node:test";
import assert from "node:assert/strict";
import { GRACE_MS, SectionTracker } from "./section-tracker";

test("SectionTracker calculates accumulated average speed and remaining distance", () => {
  const tracker = new SectionTracker();
  const section = { id: "sec1", limit: 100, startAlongM: 1000, endAlongM: 6000 };

  // 1. Initial entry at t=0
  const t0 = 1000000;
  const res0 = tracker.update(1000, 100, section, 0, t0);
  assert.equal(res0.justEntered, true);
  assert.ok(res0.current);
  assert.equal(res0.current.limit, 100);
  assert.equal(res0.current.totalM, 5000);
  assert.equal(res0.current.remainM, 5000);

  // 2. Driven 2500m in 90 seconds (2500 / 90 * 3.6 = 100 km/h)
  const t1 = t0 + 90_000;
  const res1 = tracker.update(3500, 100, section, 0, t1);
  assert.equal(res1.justEntered, false);
  assert.ok(res1.current);
  assert.equal(res1.current.drivenM, 2500);
  assert.equal(res1.current.remainM, 2500);
  assert.equal(res1.current.avgKmh, 100);
  assert.equal(res1.current.over, false);

  // 3. Sped up: driven 4000m in 120 seconds (4000 / 120 * 3.6 = 120 km/h)
  const t2 = t0 + 120_000;
  const res2 = tracker.update(5000, 120, section, 0, t2);
  assert.ok(res2.current);
  assert.equal(res2.current.avgKmh, 120);
  assert.equal(res2.current.over, true); // 120 > 100 + 0

  // 4. Over by 5 threshold: with overspeedBy=10, 105 is not over
  const res2Tolerance = tracker.update(5000, 120, section, 25, t2);
  assert.ok(res2Tolerance.current);
  assert.equal(res2Tolerance.current.over, false); // 120 <= 100 + 25

  // 5. Exited section (section becomes null, and the car is past the end)
  const t3 = t0 + 180_000;
  const res3 = tracker.update(6100, 90, null, 0, t3);
  assert.equal(res3.current, null);
  assert.ok(res3.justExited);
  assert.equal(res3.justExited.id, "sec1");
  assert.equal(res3.justExited.limit, 100);
});

test("SectionTracker handles high simulation speeds (300 km/h) accurately", () => {
  const tracker = new SectionTracker();
  const section = { id: "sec_high", limit: 100, startAlongM: 2000, endAlongM: 10000 };
  const t0 = 2000000;

  // Jump into section at 300 km/h (83.33 m/s) with offset (e.g. at 2100m, 1.2s past start)
  const res0 = tracker.update(2100, 300, section, 0, t0);
  assert.equal(res0.justEntered, true);
  assert.ok(res0.current);
  assert.equal(res0.current.avgKmh, 300);
  assert.equal(res0.current.over, true);

  // After 10 seconds of 300 km/h driving: driven 10s * 83.33m/s = 833.3m + 100m = 933.3m driven
  const t1 = t0 + 10_000;
  const res1 = tracker.update(2933, 300, section, 0, t1);
  assert.ok(res1.current);
  assert.equal(Math.round(res1.current.avgKmh), 300);
  assert.equal(res1.current.over, true);
});

test("the end camera learned of later moves the end; the start time stays", () => {
  const tracker = new SectionTracker();
  const t0 = 3_000_000;
  // Entered with the end not yet known: the watch says the section runs on for 25 km.
  const open = { id: "s", limit: 100, startAlongM: 1000, endAlongM: 26_000 };
  const r0 = tracker.update(1000, 100, open, 0, t0);
  assert.equal(r0.current?.remainM, 25_000);
  // 36 s on, 1 km in, the end camera is in: 5 km long.
  const closed = { ...open, endAlongM: 6000 };
  const r1 = tracker.update(2000, 100, closed, 0, t0 + 36_000);
  assert.equal(r1.justEntered, false);
  assert.equal(r1.current?.remainM, 4000);
  assert.equal(r1.current?.totalM, 5000);
  assert.equal(r1.current?.avgKmh, 100);
});

test("a moment without a section is held through; longer than the grace, or past the end, is the exit", () => {
  const tracker = new SectionTracker();
  const t0 = 4_000_000;
  const section = { id: "s", limit: 80, startAlongM: 0, endAlongM: 5000 };
  tracker.update(0, 80, section, 0, t0);
  tracker.update(978, 80, section, 0, t0 + 44_000);
  // The watch made again for a new line, its features not yet back: no section for a second.
  const held = tracker.update(1000, 80, null, 0, t0 + 45_000);
  assert.ok(held.current, "held through the gap");
  assert.equal(held.current.avgKmh, 80);
  assert.equal(held.justExited, null);
  // Back, as the same section.
  const back = tracker.update(1050, 80, section, 0, t0 + 47_000);
  assert.equal(back.justEntered, false);
  assert.equal(back.justExited, null);
  // Gone for longer than the grace: out.
  const gone = tracker.update(1500, 80, null, 0, t0 + 47_000 + GRACE_MS + 1);
  assert.equal(gone.current, null);
  assert.equal(gone.justExited?.id, "s");
  // Past the end with none reported: out at once.
  tracker.update(0, 80, section, 0, t0);
  const past = tracker.update(5100, 80, null, 0, t0 + 1000);
  assert.equal(past.current, null);
  assert.ok(past.justExited);
});

test("no target is suggested far below the limit, nor at all once the section is nearly done", () => {
  const tracker = new SectionTracker();
  const t0 = 5_000_000;
  const section = { id: "s", limit: 100, startAlongM: 0, endAlongM: 10_000 };
  tracker.update(0, 100, section, 0, t0);
  // Half way, 138 s of the 360 s allowed used: the rest at 81 would end on the limit (shown: 60 and up).
  const r1 = tracker.update(5000, 130, section, 0, t0 + 138_462);
  assert.equal(r1.current?.targetKmh, 81);
  // So fast that the rest would have to be crawled: no target.
  const r2 = tracker.update(8000, 200, section, 0, t0 + 144_000);
  assert.equal(r2.current?.targetKmh, null);
  // Within 80 m of the end: no target.
  const r3 = tracker.update(9950, 100, section, 0, t0 + 358_200);
  assert.equal(r3.current?.targetKmh, null);
});
