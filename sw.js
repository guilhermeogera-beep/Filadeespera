/* Service Worker â€” Fila FÃ¡cil (Quinta do Aveiro)
   Cacheia o "app shell" para carregar rÃ¡pido e abrir offline.
   Os DADOS da fila vÃªm sempre da rede (Supabase) â€” nunca sÃ£o cacheados. */
const CACHE = "fila-qa-v193";
const SHELL = [
  "./",
  "./index.html",
  "./fila.html",
  "./styles.css",
  "./app.js",
  "./fila.js",
  "./qr.js",
  "./config.js",
  "./config-publico.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/logo-simbolo-branco.png",
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

  // App shell: NETWORK-FIRST â€” sempre pega a versÃ£o nova quando online;
  // usa o cache sÃ³ quando estiver sem internet (offline).
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

/* ---------------------------------------------------------------
   NOTIFICAÇÃO PUSH (página do cliente)
   O servidor manda o aviso mesmo com o navegador fechado. Aqui só
   mostramos — e, ao tocar, abrimos a página da fila da pessoa.
   --------------------------------------------------------------- */
self.addEventListener("push", (e) => {
  let d = { titulo: "Fila Fácil", texto: "Você foi chamado.", tag: "fila", id: "" };
  try { if (e.data) d = Object.assign(d, e.data.json()); } catch (err) { /* texto puro */ }
  e.waitUntil(
    self.registration.showNotification(d.titulo, {
      body: d.texto,
      tag: d.tag,
      renotify: true,
      requireInteraction: d.tag === "chamada",   // a chamada fica na tela
      vibrate: d.tag === "pedido" ? [250, 120, 250, 120, 250, 120, 250] : [500, 200, 500, 200, 900],
      icon: "./icons/icon-192.png",
      badge: "./icons/icon-192.png",
      data: { id: d.id },
    })
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const id = (e.notification.data && e.notification.data.id) || "";
  const alvo = new URL("./fila.html" + (id ? "?id=" + id : ""), self.location.href).href;
  e.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((lista) => {
      for (const c of lista) {
        if (c.url.indexOf("fila.html") >= 0 && "focus" in c) return c.focus();
      }
      return clients.openWindow(alvo);
    })
  );
});
