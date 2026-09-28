/**
 * Renders every fixed phrase into the TTS cache, so the first drive costs
 * nothing per warning. Run once, and again after the phrase list changes:
 *
 *   DASHSCOPE_API_KEY=… npx tsx src/prerender.ts
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Speaker, fixedPhrases } from "./tts.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const speaker = new Speaker(process.env.DASHSCOPE_API_KEY, process.env.TTS_DIR ?? join(root, "tts"));
if (!speaker.ready) {
  console.error("DASHSCOPE_API_KEY is not set");
  process.exit(1);
}
let made = 0, had = 0;
for (const text of fixedPhrases()) {
  if (speaker.cached(text)) { had++; continue; }
  await speaker.say(text);
  made++;
  console.log(`  ${text}`);
}
console.log(`${made} rendered, ${had} already there`);
