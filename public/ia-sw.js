/* Service worker d'ADVENTUM IA (décision 0027, point 11) — portée /ia.
 * Notifications Web Push (clés VAPID de l'ERP) qui ouvrent la bonne conversation, et un hors-ligne MINIMAL :
 * les fichiers statiques de l'app en cache, la dernière page /ia servie si le réseau manque. Aucune donnée d'API en cache. */

const CACHE = "adventum-ia-v1";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((cles) => Promise.all(cles.filter((c) => c.startsWith("adventum-ia-") && c !== CACHE).map((c) => caches.delete(c))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // Les fichiers statiques versionnés de Next et de l'app : le cache d'abord.
  if (url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/adventum-ia/")) {
    event.respondWith(caches.open(CACHE).then(async (c) => {
      const deja = await c.match(req);
      if (deja) return deja;
      const r = await fetch(req);
      if (r.ok) c.put(req, r.clone());
      return r;
    }));
    return;
  }
  // La page de l'app : le réseau d'abord ; sans réseau, la dernière page vue (les vocaux attendent dans l'appareil).
  if (req.mode === "navigate" && url.pathname.startsWith("/ia")) {
    event.respondWith(fetch(req).then((r) => {
      if (r.ok) caches.open(CACHE).then((c) => c.put("/ia", r.clone()));
      return r;
    }).catch(() => caches.match("/ia").then((r) => r || new Response("Adventum IA : pas de réseau.", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } }))));
  }
});

self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = {}; }
  const title = data.title || "Adventum IA";
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || "",
    icon: "/adventum-ia/icone-192.png",
    badge: "/adventum-ia/icone-192.png",
    tag: data.tag || data.url || "adventum-ia",
    renotify: true,
    data: { url: data.url || "/ia" },
  }));
});

/** Le lien d'une notification de l'ERP (`/assistant?c=…`) ouvre la même conversation dans l'app. */
function versApp(url) {
  try {
    const u = new URL(url, self.location.origin);
    if (u.pathname === "/assistant" || u.pathname.startsWith("/assistant/")) return "/ia" + u.search;
    return u.pathname + u.search;
  } catch (e) { return "/ia"; }
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = versApp((event.notification.data && event.notification.data.url) || "/ia");
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
