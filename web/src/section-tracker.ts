/**
 * 구간 단속 누적 평균 속도 추적기 (Section Speed Tracker)
 *
 * 고속도로 구간 단속 및 터널 통과(GPS 음영) 시에도:
 * 1. 시스템 시계(Date.now())로 경과 시간 ΔT 측정
 * 2. 경로 매칭·추측 항법이 주는 경로상 위치(alongM)로 주행 거리 ΔD 적분
 * 3. 실시간 누적 평균속도(V_avg = ΔD / ΔT × 3.6), 남은 거리, 제한속도 대비 초과 여부 계산
 *
 * The section's bounds are taken afresh on every call: the end camera is
 * often learned of only after the car is inside (the features come from a
 * radius round the car), and a re-route measures the same section along a
 * new line. A moment without a section — a watch made again for a new line,
 * its features not yet back — is held through, not taken for the exit: the
 * exit is passing the end, or no section for longer than GRACE_MS.
 */

export interface ActiveSectionInfo {
  id: string;
  limit: number;
  startAlongM: number;
  endAlongM: number;
  totalM: number;
  elapsedS: number;
  drivenM: number;
  remainM: number;
  avgKmh: number;
  /** The speed that would bring the average to the limit at the end, or null where there is no sane one. */
  targetKmh: number | null;
  over: boolean;
}

export interface SectionBounds { id: string; limit: number; startAlongM: number; endAlongM: number }

/** How long a section is kept once no section is reported, before the car is taken to have left it. */
export const GRACE_MS = 8_000;
/** Past the end by this much, the car is out whatever is reported. */
const PAST_END_M = 30;
/** No target is shown below the limit by more than this: "권장 10" on a motorway is not advice. */
const TARGET_BELOW_LIMIT_MAX = 40;

export class SectionTracker {
  private activeId: string | null = null;
  private limit = 0;
  private startAlongM = 0;
  private endAlongM = 0;
  private startTime = 0;
  /** When a section was last reported: a gap shorter than GRACE_MS is held through. */
  private seenAt = 0;
  private lastAvgKmh = 0;
  /**
   * The most driven of it so far: it never goes back. Held through a re-route whose line no longer has the section
   * (its start behind the new route's), the metres along the new line read as none driven, and the drive left the
   * stretch "최종 평균 0km/h" (2026-10-04).
   */
  private drivenM = 0;

  /**
   * Update tracker state with current vehicle progress.
   * @param alongM Current distance along route in metres (derived from GPS or tunnel DR).
   * @param currentSpeedKmh Current instantaneous vehicle speed in km/h.
   * @param section Active section from warnings.currentSection(alongM) or null.
   * @param overspeedBy Driver threshold offset in km/h (e.g. 0, +5, +10).
   */
  update(
    alongM: number,
    currentSpeedKmh: number,
    section: SectionBounds | null,
    overspeedBy = 0,
    now = Date.now(),
  ): { current: ActiveSectionInfo | null; justEntered: boolean; justExited: { id: string; limit: number; avgKmh: number } | null } {
    let justEntered = false;
    let justExited: { id: string; limit: number; avgKmh: number } | null = null;

    if (!section) {
      if (!this.activeId) return { current: null, justEntered: false, justExited: null };
      const out = alongM > this.endAlongM + PAST_END_M || now - this.seenAt > GRACE_MS;
      if (out) {
        justExited = { id: this.activeId, limit: this.limit, avgKmh: this.lastAvgKmh };
        this.reset();
        return { current: null, justEntered: false, justExited };
      }
      // Held through the gap on what was last known.
      return { current: this.measure(alongM, now, overspeedBy), justEntered: false, justExited: null };
    }

    this.seenAt = now;
    if (this.activeId !== section.id) {
      if (this.activeId) {
        justExited = { id: this.activeId, limit: this.limit, avgKmh: this.lastAvgKmh };
      }
      this.activeId = section.id;
      this.drivenM = 0;
      // If entered past the start point (e.g. 300 km/h fast simulation or GPS leap),
      // back-calculate the exact start timestamp so driven distance and elapsed time match
      const offsetM = Math.max(0, alongM - section.startAlongM);
      const speedMps = currentSpeedKmh > 5 ? currentSpeedKmh / 3.6 : section.limit / 3.6;
      const backS = offsetM / speedMps;
      this.startTime = now - backS * 1000;
      justEntered = true;
    }
    // The bounds as now known, every call (see the file's note); the start time stays.
    this.limit = section.limit;
    this.startAlongM = section.startAlongM;
    this.endAlongM = section.endAlongM;

    return { current: this.measure(alongM, now, overspeedBy), justEntered, justExited };
  }

  private measure(alongM: number, now: number, overspeedBy: number): ActiveSectionInfo {
    const elapsedS = Math.max(0.05, (now - this.startTime) / 1000);
    const totalM = Math.max(10, this.endAlongM - this.startAlongM);
    const drivenM = Math.max(this.drivenM, Math.max(0, Math.min(totalM, alongM - this.startAlongM)));
    this.drivenM = drivenM;
    const remainM = Math.max(0, this.endAlongM - alongM);

    const rawAvg = (drivenM / elapsedS) * 3.6;
    // Accurate average speed supporting high simulation speeds (up to 450 km/h)
    const avgKmh = Math.max(0, Math.min(450, Math.round(rawAvg)));
    this.lastAvgKmh = avgKmh;

    // Target speed needed for the remainder of the section to finish right at the limit
    let targetKmh: number | null = null;
    const totalAllowedS = totalM / (this.limit / 3.6);
    const remainAllowedS = totalAllowedS - elapsedS;
    if (remainM > 80 && remainAllowedS > 0.5) {
      const neededSpeed = Math.round((remainM / remainAllowedS) * 3.6);
      // Not below the limit by more than can be driven sensibly where the limit applies, nor above what is possible.
      if (neededSpeed >= this.limit - TARGET_BELOW_LIMIT_MAX) targetKmh = Math.min(350, neededSpeed);
    }

    const over = avgKmh > this.limit + overspeedBy;

    return {
      id: this.activeId!,
      limit: this.limit,
      startAlongM: this.startAlongM,
      endAlongM: this.endAlongM,
      totalM,
      elapsedS,
      drivenM,
      remainM,
      avgKmh,
      targetKmh,
      over,
    };
  }

  reset() {
    this.activeId = null;
    this.limit = 0;
    this.startAlongM = 0;
    this.endAlongM = 0;
    this.startTime = 0;
    this.seenAt = 0;
    this.lastAvgKmh = 0;
    this.drivenM = 0;
  }
}
