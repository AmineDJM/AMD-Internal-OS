/* Service worker — notifications push (Web Push) pour l'AMD Internal OS (PWA). */

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = {}; }
  const title = data.title || "AMD Internal OS";
  const options = {
    body: data.body || "",
    icon: "/icon.svg",
    badge: "/icon.svg",
    tag: data.tag || data.url || "amd-notification",
    renotify: true,
    // Appels entrants : la notification reste affichée jusqu'à interaction + vibre.
    requireInteraction: Boolean(data.requireInteraction),
    vibrate: data.requireInteraction ? [200, 100, 200, 100, 200] : [100],
    data: { url: data.url || "/" },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ("focus" in client) {
          if ("navigate" in client) client.navigate(url).catch(() => {});
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    }),
  );
});

/*
 * LE TERRAIN HORS LIGNE (lot J13, décision 0025) — l'écran « Terrain » s'ouvre sans réseau.
 *
 * Portée VOLONTAIREMENT étroite : seule la page /medical/terrain (réseau d'abord, copie de secours) et les fichiers
 * statiques qu'ELLE charge (empreintés par Next, donc immuables : cache d'abord). Aucune autre page, aucune donnée
 * d'API n'est mise en cache. Les vocaux et photos attendent dans IndexedDB (file de l'écran), pas ici.
 */
const CACHE_TERRAIN = "amd-terrain-v1";
const PAGE_TERRAIN = "/medical/terrain";

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.mode === "navigate" && url.pathname === PAGE_TERRAIN) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) { const copie = res.clone(); caches.open(CACHE_TERRAIN).then((c) => c.put(PAGE_TERRAIN, copie)); }
          return res;
        })
        .catch(() => caches.match(PAGE_TERRAIN).then((r) => r || new Response("Hors ligne — ouvrez l'écran Terrain une fois avec du réseau.", { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } }))),
    );
    return;
  }
  if (url.pathname.startsWith("/_next/static/") && (req.referrer || "").includes(PAGE_TERRAIN)) {
    event.respondWith(
      caches.match(req).then((trouve) => trouve || fetch(req).then((res) => {
        if (res.ok) { const copie = res.clone(); caches.open(CACHE_TERRAIN).then((c) => c.put(req, copie)); }
        return res;
      })),
    );
  }
});
