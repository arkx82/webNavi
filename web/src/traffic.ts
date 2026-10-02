import { Line } from "./geo";
import type { Route } from "./types";

/**
 * The route being driven, its colours made new: the same provider asked
 * again (the periodic recheck, main.ts) answers with the traffic as it is
 * now, but on a line of its own from where the car is. Each vertex of the
 * driven line still ahead takes the congestion of the fresh line where it
 * lies on it; one off it (the fresh route goes another way there) keeps its
 * own. Behind the car nothing changes.
 */
/** A vertex this close to the fresh line is on it. */
const ON_M = 20;
/** Fewer of the vertices ahead on the fresh line than this, and it is another way: the recheck's offer, not a repaint. */
const SAME_WAY = 0.7;

export interface Repaint { ahead: number; matched: number; changed: number; same: boolean }

export function repaint(cur: Route, fresh: Route, fromAlongM: number): Repaint {
  const n = cur.path.length;
  const out: Repaint = { ahead: 0, matched: 0, changed: 0, same: false };
  if (n < 2 || fresh.path.length < 2) return out;
  const line = new Line(cur.path);
  const freshLine = new Line(fresh.path);
  const level = (r: Route) => {
    const v = new Array<number>(r.path.length).fill(0);
    for (const s of r.segments) for (let i = s.from; i < Math.min(s.to, r.path.length); i++) v[i] = s.congestion;
    return v;
  };
  const was = level(cur), freshLevel = level(fresh);
  const now = was.slice();
  let seg = 0;
  for (let i = 0; i < n; i++) {
    if (line.along[i] < fromAlongM) continue;
    out.ahead++;
    // Forward along the fresh line, from where the last vertex lay on it.
    const p = freshLine.project(cur.path[i], seg, 80);
    if (p.offM > ON_M) continue;
    seg = p.segment;
    out.matched++;
    if (freshLevel[p.segment] !== was[i]) { now[i] = freshLevel[p.segment]; out.changed++; }
  }
  out.same = out.ahead > 0 && out.matched / out.ahead >= SAME_WAY;
  if (!out.same || out.changed === 0) return out;
  // Runs of one level, as the segments are kept.
  const segments: Route["segments"] = [];
  for (let i = 0; i < n; i++) {
    const last = segments[segments.length - 1];
    if (last && last.congestion === now[i] && last.to === i) last.to = i + 1;
    else segments.push({ from: i, to: i + 1, congestion: now[i] as Route["segments"][number]["congestion"] });
  }
  cur.segments = segments;
  return out;
}
