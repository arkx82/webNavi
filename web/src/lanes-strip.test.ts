import { test } from "node:test";
import assert from "node:assert/strict";
import { drawLaneCard, laneWords, type CardBox, type LaneCard } from "./lanes-strip";

const lanes = (best: boolean[]) => best.map((b) => ({ turns: ["straight" as const], best: b }));

test("the lanes to be in are named from the left, as Korean roads count them", () => {
  assert.equal(laneWords(lanes([false, true])), "2차로");
  assert.equal(laneWords(lanes([true, true, false, false])), "1·2차로");
  assert.equal(laneWords(lanes([false, false, true, true, true])), "3~5차로");
  assert.equal(laneWords(lanes([true, false, true])), "1·3차로");
  // All of them, or none: nothing to choose, so nothing said.
  assert.equal(laneWords(lanes([true, true])), null);
  assert.equal(laneWords(lanes([false, false])), null);
});

test("the lanes that cannot go the route's way are named with what they are for", async () => {
  const { onlyWords } = await import("./lanes-strip");
  const lanes = [
    { turns: ["left" as const], best: false },
    { turns: ["straight" as const], best: true },
    { turns: ["straight" as const, "right" as const], best: true },
    { turns: ["right" as const], best: false },
  ];
  assert.equal(onlyWords(lanes, "straight"), "1차로 좌회전 전용 · 4차로 우회전 전용");
  assert.equal(onlyWords([{ turns: ["uturn", "left"], best: false }, { turns: ["straight"], best: true }], "straight"), "1차로 유턴·좌회전 전용");
  assert.equal(onlyWords([{ turns: ["straight"], best: true }, { turns: ["straight"], best: true }], "straight"), null);
});

/** A card's element as drawLaneCard sees it, counting how often its whole markup is set. */
class FakeBox implements CardBox {
  hidden = false;
  textContent: string | null = "";
  style = { color: "" };
  sets = 0;
  cleared = 0;
  private html = "";
  private parts = new Map<string, FakeBox>();
  get innerHTML() { return this.html; }
  set innerHTML(v: string) { this.html = v; this.sets++; }
  replaceChildren() { this.cleared++; this.html = ""; }
  querySelector(selector: string) {
    let part = this.parts.get(selector);
    if (!part) { part = new FakeBox(); this.parts.set(selector, part); }
    return part;
  }
}

test("a card whose distance alone changed updates the number, not the whole card", () => {
  const box = new FakeBox();
  const el = box as unknown as HTMLElement;
  const card: LaneCard = {
    arrow: "<svg/>", inText: "300 m", what: "우회전", side: null, way: "right",
    lanes: { lanes: [{ turns: ["left"], best: false }, { turns: ["straight", "right"], best: true }] },
  };
  drawLaneCard(el, card);
  assert.equal(box.sets, 1);
  assert.equal(box.hidden, false);
  assert.equal(box.querySelector(".lc-in")!.textContent, "300 m");
  assert.match(box.querySelector(".lc-lanes")!.innerHTML, /class="lane only".*class="lane best"/);
  // Ten metres on: only the number.
  drawLaneCard(el, { ...card, inText: "290 m" });
  drawLaneCard(el, { ...card, inText: "280 m" });
  assert.equal(box.sets, 1);
  assert.equal(box.querySelector(".lc-in")!.textContent, "280 m");
  // The same again: nothing touched.
  const inBefore = (box.querySelector(".lc-in") as FakeBox).sets;
  drawLaneCard(el, { ...card, inText: "280 m" });
  assert.equal((box.querySelector(".lc-in") as FakeBox).sets, inBefore);
  // The turn itself changed: drawn afresh.
  drawLaneCard(el, { ...card, inText: "270 m", what: "좌회전" });
  assert.equal(box.sets, 2);
  assert.equal(box.querySelector(".lc-in")!.textContent, "270 m");
  // No turn ahead: emptied and hidden.
  drawLaneCard(el, null);
  assert.equal(box.hidden, true);
  assert.equal(box.cleared, 1);
  assert.equal(box.sets, 2);
});
