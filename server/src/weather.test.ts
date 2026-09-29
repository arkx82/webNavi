import { test } from "node:test";
import assert from "node:assert/strict";
import { assemble, grid, midBase, nearestCity, ncstBase, skyOf, skyOfWords, vilageBase } from "./weather.js";

test("places land on 기상청's grid as KMA's own table has them", () => {
  assert.deepEqual(grid(37.5665, 126.978), { nx: 60, ny: 127 }); // 서울시청
  assert.deepEqual(grid(37.5006, 127.0363), { nx: 61, ny: 125 }); // 강남구 역삼동
  assert.deepEqual(grid(35.1796, 129.0756), { nx: 98, ny: 76 }); // 부산시청
});

test("the forecast runs asked for are the latest already out, in Korean time", () => {
  const at = (iso: string) => Date.parse(iso); // given in KST
  assert.deepEqual(vilageBase(at("2026-09-29T05:20:00+09:00")), { date: "20260929", time: "0500" });
  assert.deepEqual(vilageBase(at("2026-09-29T05:05:00+09:00")), { date: "20260929", time: "0200" });
  assert.deepEqual(vilageBase(at("2026-09-29T01:30:00+09:00")), { date: "20260928", time: "2300" });
  assert.deepEqual(ncstBase(at("2026-09-29T20:30:00+09:00")), { date: "20260929", time: "1900" });
  assert.equal(midBase(at("2026-09-29T05:00:00+09:00")), "202609281800");
  assert.equal(midBase(at("2026-09-29T19:00:00+09:00")), "202609291800");
});

test("codes and words become one sky; the nearest city speaks for the days after", () => {
  assert.equal(skyOf("3", "0"), "partly");
  assert.equal(skyOf("4", "1"), "rain");
  assert.equal(skyOfWords("흐리고 비"), "rain");
  assert.equal(skyOfWords("구름많고 눈/비"), "sleet");
  assert.equal(nearestCity([127.0276, 37.4979]).name, "서울");
  assert.equal(nearestCity([129.1, 35.2]).name, "부산");
});

test("the short-term forecast's last day, only a few hours long, gives way to 중기예보", () => {
  const fcst = [
    { category: "TMP", fcstDate: "20261004", fcstTime: "0000", fcstValue: "16" },
    { category: "SKY", fcstDate: "20261004", fcstTime: "0000", fcstValue: "1" },
  ];
  const mid = { base: "202609291800", land: { wf5Am: "흐림", wf5Pm: "흐리고 비", rnSt5Pm: 60 }, ta: { taMin5: 13, taMax5: 22 } };
  const w = assemble("서울", [], fcst, mid, Date.parse("2026-10-03T23:30:00+09:00"));
  const d = w.days.find((x) => x.date === "2026-10-04")!;
  assert.deepEqual([d.min, d.max, d.am, d.pm, d.pop], [13, 22, "cloudy", "rain", 60]);
});

test("rows into now, hours and ten days", () => {
  const now = [{ category: "T1H", obsrValue: "22.8" }, { category: "PTY", obsrValue: "0" }, { category: "REH", obsrValue: "53" }];
  const fcst = [
    { category: "TMP", fcstDate: "20260929", fcstTime: "2100", fcstValue: "21" },
    { category: "SKY", fcstDate: "20260929", fcstTime: "2100", fcstValue: "3" },
    { category: "PTY", fcstDate: "20260929", fcstTime: "2100", fcstValue: "0" },
    { category: "POP", fcstDate: "20260929", fcstTime: "2100", fcstValue: "20" },
    { category: "TMX", fcstDate: "20260930", fcstTime: "1500", fcstValue: "25" },
    { category: "PTY", fcstDate: "20260930", fcstTime: "1500", fcstValue: "1" },
  ];
  const mid = { base: "202609291800", land: { wf5Am: "맑음", wf5Pm: "흐리고 비", rnSt5Am: 10, rnSt5Pm: 60 }, ta: { taMin5: 13, taMax5: 22 } };
  const w = assemble("서울", now, fcst, mid, Date.parse("2026-09-29T20:30:00+09:00"));
  assert.equal(w.now?.temp, 22.8);
  assert.equal(w.now?.sky, "partly");
  assert.equal(w.hours[0].t, "2026-09-29T21:00");
  assert.deepEqual(w.days.map((d) => d.date), ["2026-09-29", "2026-09-30", "2026-10-04"]);
  assert.equal(w.days[1].pm, "rain");
  assert.deepEqual([w.days[2].min, w.days[2].max, w.days[2].pm, w.days[2].pop], [13, 22, "rain", 60]);
});
