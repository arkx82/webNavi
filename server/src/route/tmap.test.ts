import { test } from "node:test";
import assert from "node:assert/strict";
import { facilityText } from "./tmap.js";

test("TMAP's 지하차도 and 터널 guides read as an action, not the thing twice", () => {
  assert.equal(facilityText("미사 지하차도에서 광주,양평 방면으로 지하차도 후 미사대로를 따라 1155m 이동", 119), "미사 지하차도에서 광주,양평 방면으로 지하차도 진입 후 미사대로를 따라 1155m 이동");
  assert.equal(facilityText("터널에서 터널 후 올림픽대로를 따라 4101m 이동", 121), "터널 진입 후 올림픽대로를 따라 4101m 이동");
  assert.equal(facilityText("OO교차로에서 고가도로옆 후 X로를 따라 3m 이동", 124), "OO교차로에서 고가차도 옆길 후 X로를 따라 3m 이동");
  assert.equal(facilityText("센터필드 교차로에서 좌회전 후 언주로를 따라 4317m 이동", 12), "센터필드 교차로에서 좌회전 후 언주로를 따라 4317m 이동");
});
