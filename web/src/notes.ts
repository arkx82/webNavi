import { X } from "./icons";
import type { Ahead, RestInfo } from "./warnings";

/**
 * The cards at the map's top right: what is coming that is worth seeing
 * but need not be said — the next rest area and its prices, an incident
 * ahead, a school zone, a 기상특보 here. Each kind can be only shown
 * (안내 설정 → 표시만), so the voice is kept for what needs the ears.
 */
export interface Note {
  id: string;
  /** Sets the colour of the badge. */
  tone: "rest" | "incident" | "school" | "alert" | "warn";
  badge: string;
  title: string;
  /** "3.2 km", "이 지역" … */
  where?: string;
  lines: string[];
  chips?: string[];
}

const km = (m: number) => (m < 1000 ? `${Math.max(0, Math.round(m / 10) * 10)} m` : `${(m / 1000).toFixed(1)} km`);
const price = (n?: number) => (n == null ? null : n.toLocaleString("ko-KR"));

/** A rest area's card: its prices on one line, a few of its amenities as chips. */
export function restNote(a: Ahead): Note {
  const r: RestInfo = a.feature.rest ?? { amenities: [] };
  const prices = [
    price(r.gasoline) && `휘발유 ${price(r.gasoline)}`,
    price(r.diesel) && `경유 ${price(r.diesel)}`,
    price(r.lpg) && `LPG ${price(r.lpg)}`,
  ].filter(Boolean) as string[];
  return {
    id: a.feature.id,
    tone: "rest",
    badge: "휴게소",
    title: a.feature.name ?? "휴게소",
    where: km(a.inM),
    lines: prices.length ? [prices.join(" · ") + (r.brand ? ` (${r.brand})` : "")] : ["주유 가격 정보 없음"],
    chips: r.amenities.slice(0, 6),
  };
}

const INCIDENT_BADGE: Record<string, string> = { "incident-crash": "사고", "incident-work": "공사", "incident-other": "돌발" };

export function incidentNote(a: Ahead): Note {
  return {
    id: a.feature.id,
    tone: "incident",
    badge: INCIDENT_BADGE[a.feature.kind] ?? "돌발",
    title: a.feature.name ?? "",
    where: km(a.inM),
    lines: a.feature.detail ? [a.feature.detail] : [],
  };
}

export function schoolNote(a: Ahead, alongM: number): Note {
  const inside = a.alongM <= alongM;
  return {
    id: a.feature.id,
    tone: "school",
    badge: "어린이 보호구역",
    title: [a.feature.name, a.feature.detail].filter(Boolean).join(" · ") || "어린이 보호구역",
    where: inside ? "구역 안" : km(a.inM),
    lines: [`제한 속도 ${a.feature.limit ?? 30}`],
  };
}

const KIND_BADGE: Partial<Record<string, string>> = {
  bump: "과속 방지턱", curve: "급커브", curves: "연속 급커브", accident: "사고 다발 지역", "bike-accident": "자전거 사고 다발",
  merge: "합류 구간", "signal-light": "점멸 신호",
};

/**
 * The card for a thing only shown (안내 설정 → 표시만) at the moment its
 * sentence would have been said; it goes when the car is past it, or when
 * tapped.
 */
export function popupNote(a: Ahead, alongM: number): Note {
  const k = a.feature.kind;
  if (k === "rest-area") return restNote({ ...a, inM: a.alongM - alongM });
  if (k === "school-zone") return schoolNote({ ...a, inM: a.alongM - alongM }, alongM);
  if (k.startsWith("incident")) return incidentNote({ ...a, inM: a.alongM - alongM });
  const inM = a.alongM - alongM;
  const inside = a.endM != null && a.alongM <= alongM && alongM <= a.endM;
  return {
    id: a.feature.id,
    tone: "warn",
    badge: KIND_BADGE[k] ?? "주의",
    title: a.feature.name ?? KIND_BADGE[k] ?? "",
    where: inside ? "구간 안" : km(Math.max(0, inM)),
    lines: a.feature.detail ? [a.feature.detail] : [],
  };
}

export class Notes {
  private shown = new Map<string, HTMLElement>();
  /** A card tapped: it is closed, and not shown again for this drive. */
  onDismiss: (id: string) => void = () => {};

  constructor(private box: HTMLElement) {}

  /** Draws [notes] in order; cards already up are updated in place, so nothing flickers once a second. */
  show(notes: Note[]) {
    const keep = new Set(notes.map((n) => n.id));
    for (const [id, el] of this.shown) if (!keep.has(id)) { el.remove(); this.shown.delete(id); }
    notes.forEach((n, i) => {
      let el = this.shown.get(n.id);
      if (!el) {
        el = document.createElement("div");
        el.className = `note ${n.tone}`;
        el.innerHTML = `<div class="note-head"><span class="note-badge"></span><span class="note-where"></span><span class="note-x" aria-hidden="true">${X}</span></div><div class="note-title"></div><div class="note-lines"></div><div class="note-chips"></div>`;
        const id = n.id, card = el;
        card.addEventListener("click", () => {
          card.remove();
          this.shown.delete(id);
          this.onDismiss(id);
          this.box.hidden = this.shown.size === 0;
        });
        this.shown.set(n.id, el);
      }
      el.querySelector(".note-badge")!.textContent = n.badge;
      el.querySelector(".note-where")!.textContent = n.where ?? "";
      el.querySelector(".note-title")!.textContent = n.title;
      // The lines and chips are the same fix after fix: the elements are made again only when the words change.
      const lines = el.querySelector<HTMLElement>(".note-lines")!, linesKey = n.lines.join("\n");
      if (lines.dataset.text !== linesKey) {
        lines.dataset.text = linesKey;
        lines.replaceChildren(...n.lines.map((t) => Object.assign(document.createElement("div"), { textContent: t })));
      }
      const chips = el.querySelector<HTMLElement>(".note-chips")!, chipsKey = (n.chips ?? []).join("\n");
      chips.hidden = !n.chips?.length;
      if (chips.dataset.text !== chipsKey) {
        chips.dataset.text = chipsKey;
        chips.replaceChildren(...(n.chips ?? []).map((t) => Object.assign(document.createElement("span"), { textContent: t })));
      }
      if (this.box.children[i] !== el) this.box.insertBefore(el, this.box.children[i] ?? null);
    });
    this.box.hidden = notes.length === 0;
  }
}
