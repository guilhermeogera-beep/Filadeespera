/* Service Worker — Fila de Espera (Quinta do Aveiro)
   Cacheia o "app shell" para carregar rápido e abrir offline.
   Os DADOS da fila vêm sempre da rede (Supabase) — nunca são cacheados. */
const CACHE = "fila-qa-v2";
const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./config.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Nunca cachear chamadas ao Supabase / APIs externas (dados em tempo real)
  if (url.origin !== self.location.origin || url.hostname.includes("supabase")) {
    return; // deixa ir direto para a rede
  }

  // App shell: NETWORK-FIRST — sempre pega a versão nova quando online;
  // usa o cache só quando estiver sem internet (offline).
  e.respondWith(
    fetch(req).then((res) => {
      if (res && res.status === 200) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
      }
      return res;
    }).catch(() => caches.match(req))
  );
});
