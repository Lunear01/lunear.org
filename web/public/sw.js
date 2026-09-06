// Plain service worker (no workbox). Precaches the app shell, then:
// - navigations: network-first, falling back to the cached shell (index.html)
// - /assets/* (Vite's hashed build output): cache-first
// - /api/*: never touched — always bypassed to the network
const CACHE_VERSION = "v1";
const CACHE_NAME = `lunear-games-${CACHE_VERSION}`;
const APP_SHELL = ["/", "/index.html", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Never intercept the API — always go straight to the network.
  if (url.pathname.startsWith("/api/")) {
    return;
  }

  if (request.method !== "GET") {
    return;
  }

  // SPA navigations: network-first, fall back to the cached shell offline.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(() =>
        caches.match("/index.html").then((cached) => cached ?? Response.error()),
      ),
    );
    return;
  }

  // Hashed build assets: cache-first, since the filename changes on content change.
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        });
      }),
    );
  }
});
