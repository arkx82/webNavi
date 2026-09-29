/** TIDAL gives lengths as ISO 8601 durations: "PT3M21S". */
export function isoSeconds(text: unknown): number | undefined {
  const m = typeof text === "string" ? text.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/) : null;
  return m ? Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0) : undefined;
}
