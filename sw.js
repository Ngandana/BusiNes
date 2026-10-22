// Keeps the app's own files on the phone so it opens instantly.
// Sales data always comes fresh from Supabase and is never cached here.
const CACHE = "busynes-v10";
const FILES = ["./", "index.html", "styles.css", "app.js", "config.js", "vendor/supabase.js", "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png", "icons/icon.svg"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
// Network first for our own files (so updates show up), cache as a fallback when offline.
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request).then(res => {
      if (res.ok){
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
      }
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});

// Phone notifications (Web Push). The server sends {title, body, tab}.
self.addEventListener("push", e => {
  let d = {};
  try { d = e.data.json(); } catch (err) { d = { title: "BusyNes", body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.title || "BusyNes", {
    body: d.body || "",
    icon: "icons/icon-192.png",
    badge: "icons/icon-192.png",
    tag: d.tag || undefined,
    data: { tab: d.tab || "sell", biz: d.biz || "" },
  }));
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const data = e.notification.data || {}, tab = data.tab || "sell", biz = data.biz || "";
  e.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    for (const c of list) {
      if ("focus" in c) { c.postMessage({ type: "open-tab", tab, biz }); return c.focus(); }
    }
    return clients.openWindow("./?tab=" + tab + (biz ? "&biz=" + biz : ""));
  }));
});
