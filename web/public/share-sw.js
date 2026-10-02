// The /share page's worker: there only so the phone can install the page and list it in its share sheet.
// It caches nothing and does nothing in the background.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
