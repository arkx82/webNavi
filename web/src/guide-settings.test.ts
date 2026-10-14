import { test } from "node:test";
import assert from "node:assert/strict";

test("the site's defaults under what the account set itself: a key it set stays its own, the rest follow the site", async () => {
  const { settingsOf, DEFAULTS, ownKeys } = await import("./guide-settings");
  const site = { volume: 1.5, cameraFromM: 1000, layout: "mini", carData: "off", rev: 1 };
  // Never saved anything: the site's, at the current revision; 차량 데이터 stays the device's.
  const fresh = settingsOf({}, site, "auto");
  assert.equal(fresh.volume, 1.5);
  assert.equal(fresh.cameraFromM, 1000);
  assert.equal(fresh.carData, "auto");
  assert.equal(fresh.rev, DEFAULTS.rev);
  // Set the volume back to 1 itself: kept, though it is the built-in default.
  const mine = settingsOf({ ...DEFAULTS, volume: 1, own: ["volume"] }, site, "auto");
  assert.equal(mine.volume, 1);
  assert.equal(mine.cameraFromM, 1000, "the rest from the site");
  // Saved before own was kept: what differs from the built-in defaults is its own.
  assert.deepEqual(ownKeys({ ...DEFAULTS, layout: "mini", volume: 0.6 }).sort(), ["layout", "volume"]);
  const legacy = settingsOf({ ...DEFAULTS, volume: 0.6 }, site, "auto");
  assert.equal(legacy.volume, 0.6);
  assert.equal(legacy.layout, "mini");
});
