import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 5173,
    proxy: { "/api": "http://localhost:8080", "/tts": "http://localhost:8080" },
  },
  build: {
    // The car's Chromium is a few versions behind. es2022 is Chromium 89
    // (2021): needed because the TIDAL SDK uses top-level await, and it is
    // loaded only when chosen, so the main bundle asks little more than
    // es2020 did.
    target: "es2022",
  },
});
