/**
 * Two things the plan leans on that only the car can confirm: that the
 * screen can be kept awake, and that a sound from this page reaches the
 * speakers while the car's own audio plays. Each reports a word.
 */

export async function keepAwake(): Promise<string> {
  const wl = (navigator as Navigator & { wakeLock?: { request(kind: "screen"): Promise<unknown> } }).wakeLock;
  if (!wl) return "API 없음";
  try {
    await wl.request("screen");
    return "켜짐";
  } catch (e) {
    return `거부: ${(e as Error).message}`;
  }
}

let context: AudioContext | null = null;

/** A short two-tone chime through the Web Audio graph the ducking will use. */
export async function chime(): Promise<string> {
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return "AudioContext 없음";
  context ??= new Ctor();
  if (context.state !== "running") await context.resume();
  const gain = context.createGain();
  gain.gain.value = 0.3;
  gain.connect(context.destination);
  const now = context.currentTime;
  for (const [f, at] of [[880, 0], [1175, 0.18]] as const) {
    const osc = context.createOscillator();
    osc.frequency.value = f;
    osc.connect(gain);
    osc.start(now + at);
    osc.stop(now + at + 0.16);
  }
  return `재생 (${context.state})`;
}
