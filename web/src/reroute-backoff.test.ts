import { test } from "node:test";
import assert from "node:assert/strict";
import { ON_ROUTE_RESET_MS, RerouteBackoff } from "./reroute-backoff";

test("re-routes in a row wait 0, 5, 15, 45 s, then 45 s each; half a minute on the route makes the next quick again", () => {
  const b = new RerouteBackoff();
  assert.equal(b.ask(0), 0);
  assert.ok(b.ask(2000) > 0, "5 s owed");
  assert.equal(b.ask(5000), 0);
  assert.ok(b.ask(15_000) > 0, "15 s owed");
  assert.equal(b.ask(20_000), 0);
  assert.equal(b.ask(65_000), 0);
  assert.ok(b.ask(100_000) > 0, "capped at 45 s");
  assert.equal(b.ask(110_000), 0);
  // On the route 20 s: still owed; 30 s: the count is over.
  b.seen(true, 111_000);
  b.seen(true, 131_000);
  assert.ok(b.ask(131_000) > 0);
  b.seen(true, 111_000 + ON_ROUTE_RESET_MS);
  assert.equal(b.ask(141_000), 0);
  // Off the route in between starts the on-route clock over: the second and third tries are still owed their waits.
  b.seen(true, 150_000);
  b.seen(false, 160_000);
  b.seen(true, 161_000);
  b.seen(true, 185_000);
  assert.equal(b.ask(185_000), 0);
  assert.ok(b.ask(186_000) > 0);
  b.reset();
  assert.equal(b.ask(186_000), 0);
});
