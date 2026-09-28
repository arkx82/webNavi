/**
 * Renders every fixed phrase into the TTS cache, so the first drive costs
 * nothing per warning. Run once, and again after the phrase list changes:
 *
 *   npx tsx src/prerender.ts        (or the button on /admin)
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Settings } from "./settings.js";
import { Speaker, prerender } from "./tts.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const settings = new Settings(process.env.CONFIG_DIR ?? join(root, "config"));
const speaker = new Speaker(settings.reader("dashscopeApiKey"), process.env.TTS_DIR ?? join(root, "tts"), settings.reader("ttsVoice"));
if (!speaker.ready) {
  console.error("no DashScope key: set it on /admin or as DASHSCOPE_API_KEY");
  process.exit(1);
}
const { made, had } = await prerender(speaker);
console.log(`${made} rendered, ${had} already there`);
