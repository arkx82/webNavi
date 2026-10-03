/**
 * A drive on the road played again at a desk: the .trace the page sent
 * beside its 진단 log (web/src/drive-trace.ts), through today's tracker.
 *
 *   npx tsx tools/replay-trace.ts /mnt/data/webnavi/client-logs/june-2026-10-04.trace [HH:MM-HH:MM]
 *
 * Says where the marker was far from a good fix, leapt, missed coming out
 * of a reckoning, or the drive was called off the route — and how the car's
 * browser spaced its fixes. The window (KST) keeps to one stretch.
 */
import { readFileSync } from "node:fs";
import { parseTrace, replayTrace } from "../web/src/trace-replay.ts";

const [file, window] = process.argv.slice(2);
if (!file) {
  console.error("npx tsx tools/replay-trace.ts <file.trace> [HH:MM-HH:MM]");
  process.exit(1);
}
let rows = parseTrace(readFileSync(file, "utf8"));
if (window) {
  const kst = (t: number) => new Date(t + 9 * 3600_000).toISOString().slice(11, 16);
  const [from, to] = window.split("-");
  // The route set before the window is the one driven in it: kept.
  const inside = rows.filter((r) => kst(r.at) >= from && kst(r.at) <= to);
  const first = inside[0]?.at ?? 0;
  const lastRoute = rows.filter((r) => r.kind === "r" && r.at < first).pop();
  rows = lastRoute ? [lastRoute, ...inside] : inside;
}
const report = replayTrace(rows);
console.log(`fix ${report.fixes}개 · 간격 중앙값 ${report.gaps.median.toFixed(1)}s · 90% ${report.gaps.p90.toFixed(1)}s · 최대 ${report.gaps.max.toFixed(1)}s`);
if (report.againstRoad) console.log(`도로에서 그려진 표시와 지금 코드의 표시 차이: 중앙값 ${report.againstRoad.median.toFixed(0)} m · 최대 ${report.againstRoad.max.toFixed(0)} m`);
if (report.battery) console.log(`배터리 ${report.battery.from}% → ${report.battery.to}% · 주행 ${report.battery.km.toFixed(1)} km`);
for (const e of report.events) console.log(`${e.text}${e.at ? ` @${e.at[0].toFixed(5)},${e.at[1].toFixed(5)}` : ""}`);
