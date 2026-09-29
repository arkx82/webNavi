import { test } from "node:test";
import assert from "node:assert/strict";
import { fromKatec, toKatec } from "./katec.js";
import { parseTariffs, priceFor, stationsOf } from "./ev.js";
import { finer } from "./kakao.js";
import { metresBetween } from "./util.js";

test("KATEC puts Opinet's own example station on 역삼로, and comes back", () => {
  // SK서광주유소, 서울 강남구 역삼로 142, as Opinet's detail call gives it.
  const at = fromKatec([314871.8, 544012.0]);
  assert.ok(metresBetween(at, [127.0351, 37.4943]) < 50, `landed at ${at}`);
  const [x, y] = toKatec(at);
  assert.ok(Math.abs(x - 314871.8) < 0.01 && Math.abs(y - 544012.0) < 0.01);
});

test("the public tariff steps by the charger's output", () => {
  assert.equal(priceFor("ME", "환경부", 7, [])?.won, 295.0);
  assert.equal(priceFor("ME", "환경부", 50, [])?.won, 325.6);
  assert.equal(priceFor("ME", "환경부", 100, [])?.won, 348.4);
  assert.equal(priceFor("ME", "환경부", 350, [])?.won, 393.1);
  assert.equal(priceFor("ME", "환경부", 100, [])?.label, "급속 100kW");
  // An operator nobody has typed a rate for has none.
  assert.equal(priceFor("GN", "지에스차지비", 100, []), undefined);
});

test("the owner's rates are matched by a word in the operator's name", () => {
  const owned = parseTariffs("차지비 385 280; 에버온 360\n엉터리");
  assert.deepEqual(owned, [{ match: "차지비", fast: 385, slow: 280 }, { match: "에버온", fast: 360, slow: undefined }]);
  assert.equal(priceFor("GN", "지에스차지비", 100, owned)?.won, 385);
  assert.equal(priceFor("GN", "지에스차지비", 7, owned)?.won, 280);
  assert.equal(priceFor("EV", "에버온", 7, owned)?.won, 360);
});

test("chargers become stations with free counts, private ones left out", () => {
  const row = { statNm: "선릉역 공영주차장", statId: "ME001", addr: "서울 강남구", lat: "37.5045", lng: "127.0489", busiId: "ME", busiNm: "환경부" };
  const out = stationsOf([
    { ...row, chgerId: "01", chgerType: "04", stat: "2", output: "100" },
    { ...row, chgerId: "02", chgerType: "04", stat: "3", output: "200" },
    { ...row, chgerId: "03", chgerType: "02", stat: "2", output: "7" },
    { ...row, statId: "APT1", statNm: "아파트", chgerId: "01", chgerType: "02", stat: "2", kindDetail: "H001" },
    { ...row, statId: "LIM1", statNm: "제한", chgerId: "01", chgerType: "04", stat: "2", limitYn: "Y" },
  ], []);
  assert.equal(out.length, 1);
  const c = out[0].chargers!;
  assert.deepEqual([c.fastFree, c.fastTotal, c.slowFree, c.slowTotal, c.maxKw], [1, 2, 1, 1, 200]);
  assert.equal(out[0].price?.won, 393.1);
});

test("Kakao's category path loses the part the button already says", () => {
  assert.equal(finer("음식점 > 한식 > 육류,고기"), "한식 · 육류,고기");
  assert.equal(finer("카페"), "카페");
});
