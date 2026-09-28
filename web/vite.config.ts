import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 5173,
    proxy: { "/api": "http://localhost:8080", "/tts": "http://localhost:8080" },
  },
  build: {
    // The car's Chromium is a few versions behind; keep the output plain.
    target: "es2020",
  },
});
