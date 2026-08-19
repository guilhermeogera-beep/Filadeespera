/* ============================================================
   Fila de Espera — Quinta do Aveiro
   App principal (funciona em MODO LOCAL e MODO NUVEM/Supabase)
   ============================================================ */
(function () {
  "use strict";

  const CFG = window.FILA_CONFIG || {};
  const STATUS = { AGUARDANDO: "aguardando", CHAMADO: "chamado", SENTADO: "sentado", DESISTIU: "desistiu" };
  const MIN_P = 1, MAX_P = 20;
  const LS_KEY = "fila_espera_v1";
  const SESSION_PIN = "fila_staff_ok";

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  // ----------------------------------------------------------
  //  ESTADO
  // ----------------------------------------------------------
  let rows = [];            // linhas da fila (todas)
  let backend = null;       // backend ativo (Local ou Supabase)
  let pessoas = 2;          // stepper do formulário
  let mesa = 2;             // stepper de liberar mesa
  let pendingCall = null;   // linha aguardando confirmação de chamada
  let lastCalledIds = new Set(); // para detectar novas chamadas (beep)

  // ==========================================================
  //  BACKEND: LOCAL  (localStorage + sincronização entre abas)
  // ==========================================================
  function LocalBackend() {
    let listeners = [];
    let bc = null;
    try { bc = new BroadcastChannel("fila_espera"); } catch (e) { bc = null; }

    function read() {
      try { return JSON.parse(localStorage.getItem(LS_KEY)) || []; }
      catch (e) { return []; }
    }
    function write(data) {
      localStorage.setItem(LS_KEY, JSON.stringify(data));
      if (bc) bc.postMessage("changed");
    }
    function notify() { listeners.forEach((fn) => fn()); }

    if (bc) bc.onmessage = () => notify();
    window.addEventListener("storage", (e) => { if (e.key === LS_KEY) notify(); });

    return {
      mode: "local",
      async init() {
        // limpa registros antigos já finalizados (> 8h) para não crescer sem fim
        const lim = Date.now() - 8 * 3600 * 1000;
        const data = read().filter((r) =>
          (r.status === STATUS.AGUARDANDO || r.status === STATUS.CHAMADO) ||
          new Date(r.criado_em).getTime() > lim
        );
        write(data);
      },
      async list() { return read(); },
      async add(entry) {
        const data = read();
        data.push(entry);
        write(data);
        return entry;
      },
      async update(id, patch) {
        const data = read();
        const i = data.findIndex((r) => r.id === id);
        if (i >= 0) { data[i] = Object.assign({}, data[i], patch); write(data); }
      },
      async remove(id) {
        write(read().filter((r) => r.id !== id));
      },
      onChange(cb) { listeners.push(cb); },
    };
  }

  // ==========================================================
  //  BACKEND: SUPABASE  (tempo real entre aparelhos)
  // ==========================================================
  function SupabaseBackend(url, key) {
    const client = window.supabase.createClient(url, key, {
      realtime: { params: { eventsPerSecond: 5 } },
    });
    const T = "fila_espera";

    return {
      mode: "online",
      client,
      async init() {},
      async list() {
        const { data, error } = await client.from(T).select("*").order("criado_em", { ascending: true });
        if (error) throw error;
        return data || [];
      },
      async add(entry) {
        const { data, error } = await client.from(T).insert(entry).select().single();
        if (error) throw error;
        return data;
      },
      async update(id, patch) {
        const { error } = await client.from(T).update(patch).eq("id", id);
        if (error) throw error;
      },
      async remove(id) {
        const { error } = await client.from(T).delete().eq("id", id);
        if (error) throw error;
      },
      onChange(cb) {
        client
          .channel("fila-rt")
          .on("postgres_changes", { event: "*", schema: "public", table: T }, () => cb())
          .subscribe();
      },
    };
  }

  // ==========================================================
  //  LÓGICA DA FILA
  // ==========================================================
  function uuid() {
    if (crypto && crypto.randomUUID) return crypto.randomUUID();
    return "id-" + Math.random().toString(16).slice(2) + Date.now().toString(16);
  }

  const byCreatedAsc = (a, b) => new Date(a.criado_em) - new Date(b.criado_em);

  function waiting() {
    return rows.filter((r) => r.status === STATUS.AGUARDANDO).sort(byCreatedAsc);
  }
  function called() {
    return rows.filter((r) => r.status === STATUS.CHAMADO)
      .sort((a, b) => new Date(b.chamado_em) - new Date(a.chamado_em));
  }

  // Decide se o próximo a chamar deve ser PREFERENCIAL (true) ou NORMAL (false)
  function wantPreferential() {
    const alt = String(CFG.alternancia || "1:1");
    if (alt === "pref") return true;
    const hist = rows.filter((r) => r.chamado_em)
      .sort((a, b) => new Date(b.chamado_em) - new Date(a.chamado_em));
    if (!hist.length) return true; // começa pelo preferencial
    const parts = alt.split(":").map((n) => parseInt(n, 10));
    const p = parts[0] || 1, n = parts[1] || 1;
    const lastPref = !!hist[0].preferencial;
    let run = 0;
    for (const c of hist) { if (!!c.preferencial === lastPref) run++; else break; }
    if (lastPref) return run < p;        // ainda "deve" preferenciais?
    return !(run < n);                   // ainda "deve" normais? então quer normal(false)
  }

  // Escolhe o próximo cliente para uma mesa de X lugares
  function pickNext(x) {
    const regra = CFG.regraTamanho || "exato";
    let pool = waiting().filter((r) =>
      regra === "exato" ? Number(r.pessoas) === x : Number(r.pessoas) <= x
    );
    if (!pool.length) return null;
    const prefPool = pool.filter((r) => r.preferencial);
    const normPool = pool.filter((r) => !r.preferencial);
    const wantP = wantPreferential();
    let chosen;
    if (wantP) chosen = prefPool[0] || normPool[0];
    else chosen = normPool[0] || prefPool[0];
    return chosen || null;
  }

  async function addPerson({ nome, telefone, pessoas, preferencial }) {
    const entry = {
      id: uuid(),
      nome: nome.trim(),
      telefone: (telefone || "").trim(),
      pessoas: Number(pessoas),
      preferencial: !!preferencial,
      status: STATUS.AGUARDANDO,
      criado_em: new Date().toISOString(),
      chamado_em: null,
    };
    await backend.add(entry);
    await refresh();
    return entry;
  }

  async function callPerson(id) {
    await backend.update(id, { status: STATUS.CHAMADO, chamado_em: new Date().toISOString() });
    await refresh();
  }
  async function seatPerson(id) {
    await backend.update(id, { status: STATUS.SENTADO });
    await refresh();
  }
  async function dropPerson(id) {
    await backend.update(id, { status: STATUS.DESISTIU });
    await refresh();
  }
  async function backToQueue(id) {
    await backend.update(id, { status: STATUS.AGUARDANDO, chamado_em: null });
    await refresh();
  }

  async function refresh() {
    try {
      rows = await backend.list();
      render();
    } catch (e) {
      console.error("Erro ao carregar a fila:", e);
      setConn("off");
    }
  }

  // ==========================================================
  //  RENDERIZAÇÃO
  // ==========================================================
  function fmtElapsed(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    if (h > 0) return `${h}h${String(m % 60).padStart(2, "0")}`;
    return `${m}min${m < 1 ? " " + String(s).padStart(2, "0") + "s" : ""}`;
  }
  function firstName(n) { return (n || "").split(/\s+/)[0] || n || "Cliente"; }
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // HTML de um item da fila (usado nas duas listas: preferencial e normal)
  function queueItemHTML(r, i, staff) {
    const tel = staff && r.telefone ? `<span>📞 ${esc(r.telefone)}</span>` : "";
    const actions = staff ? `
      <div class="q-actions staff-only">
        <button class="btn btn-sm btn-accent" data-call="${r.id}">Chamar</button>
        <button class="btn btn-sm btn-primary" data-seat="${r.id}">Sentou</button>
        <button class="btn btn-sm btn-danger" data-drop="${r.id}">Saiu</button>
      </div>` : "";
    return `
      <li class="q-item ${r.preferencial ? "is-pref" : ""}">
        <div class="q-pos">${i + 1}</div>
        <div class="q-main">
          <div class="q-name">${esc(staff ? r.nome : firstName(r.nome))}</div>
          <div class="q-sub">
            <span>👥 ${r.pessoas} ${r.pessoas === 1 ? "pessoa" : "pessoas"}</span>
            <span>⏱ esperando <b class="q-time" data-since="${r.criado_em}">agora</b></span>
            ${tel}
          </div>
        </div>
        ${actions}
      </li>`;
  }

  function render() {
    const w = waiting();
    const c = called();
    const staff = isStaff();

    // -------- filas separadas: preferencial e normal --------
    const pref = w.filter((r) => r.preferencial);
    const norm = w.filter((r) => !r.preferencial);
    $("#statTotal").textContent = w.length;
    $("#statPref").textContent = pref.length;
    $("#statNorm").textContent = norm.length;

    // -------- painel "chamando" --------
    const callList = $("#callList");
    const callEmpty = $("#callEmpty");
    const show = c.slice(0, 4);
    callEmpty.hidden = show.length > 0;
    callList.innerHTML = show.map((r, i) => `
      <div class="call-item ${r.preferencial ? "pref" : ""} ${i === 0 ? "fresh" : ""}">
        ${staff ? `<button class="ci-seat staff-only" data-seat="${r.id}">Sentou ✓</button>` : ""}
        <span class="ci-label">${r.preferencial ? "★ Preferencial" : "Chamando"}</span>
        <span class="ci-name">${esc(firstName(r.nome))}</span>
        <span class="ci-meta">${r.pessoas} ${r.pessoas === 1 ? "pessoa" : "pessoas"} • chamado há <b data-since="${r.chamado_em}">agora</b></span>
      </div>`).join("");

    // -------- listas separadas (cada uma na ordem de chegada) --------
    $("#queueListPref").innerHTML = pref.map((r, i) => queueItemHTML(r, i, staff)).join("");
    $("#queueListNorm").innerHTML = norm.map((r, i) => queueItemHTML(r, i, staff)).join("");
    $("#emptyPref").hidden = pref.length > 0;
    $("#emptyNorm").hidden = norm.length > 0;

    tickTimes();
    maybeBeep(c);
  }

  // Atualiza os "tempos" ao vivo (a cada segundo, sem redesenhar tudo)
  function tickTimes() {
    const now = Date.now();
    $$("[data-since]").forEach((el) => {
      const t = el.getAttribute("data-since");
      if (!t) return;
      const d = new Date(t).getTime();
      if (isNaN(d)) return;
      el.textContent = fmtElapsed(now - d);
    });
  }

  // Beep quando surge uma chamada nova
  function maybeBeep(c) {
    const ids = new Set(c.map((r) => r.id));
    let novo = false;
    ids.forEach((id) => { if (!lastCalledIds.has(id)) novo = true; });
    lastCalledIds = ids;
    if (novo) beep();
  }
  let audioCtx = null;
  function beep() {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.connect(g); g.connect(audioCtx.destination);
      o.type = "sine"; o.frequency.value = 880;
      g.gain.setValueAtTime(0.001, audioCtx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.25, audioCtx.currentTime + 0.03);
      g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.5);
      o.start(); o.stop(audioCtx.currentTime + 0.5);
    } catch (e) { /* silencioso */ }
  }

  // ==========================================================
  //  VISTAS (Totem / Atendente) + PIN
  // ==========================================================
  const appEl = $("#app");
  function isStaff() { return appEl.getAttribute("data-view") === "staff"; }

  function setView(v) {
    if (v === "staff" && sessionStorage.getItem(SESSION_PIN) !== "1") {
      openPin();
      return;
    }
    appEl.setAttribute("data-view", v);
    $("#tabTotem").classList.toggle("is-active", v === "totem");
    $("#tabStaff").classList.toggle("is-active", v === "staff");
    $("#staffBar").hidden = v !== "staff";
    $("#formTitle").textContent = v === "staff" ? "Adicionar cliente" : "Entrar na fila";
    render();
  }

  function openPin() {
    $("#pinMsg").textContent = "";
    $("#pinInput").value = "";
    $("#pinModal").hidden = false;
    setTimeout(() => $("#pinInput").focus(), 50);
  }
  function closePin() { $("#pinModal").hidden = true; }

  // ==========================================================
  //  LIGAÇÃO DOS EVENTOS (UI)
  // ==========================================================
  function wireUI() {
    // troca de vista
    $("#tabTotem").addEventListener("click", () => setView("totem"));
    $("#tabStaff").addEventListener("click", () => setView("staff"));

    // PIN
    $("#pinOk").addEventListener("click", () => {
      if ($("#pinInput").value === String(CFG.pinAtendente || "4321")) {
        sessionStorage.setItem(SESSION_PIN, "1");
        closePin();
        setView("staff");
      } else {
        $("#pinMsg").textContent = "PIN incorreto.";
        $("#pinMsg").className = "form-msg err";
      }
    });
    $("#pinCancel").addEventListener("click", closePin);
    $("#pinInput").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#pinOk").click(); });

    // stepper pessoas (formulário)
    $$(".step-btn[data-step]").forEach((b) =>
      b.addEventListener("click", () => {
        pessoas = Math.min(MAX_P, Math.max(MIN_P, pessoas + Number(b.dataset.step)));
        $("#fPessoas").textContent = pessoas;
      })
    );
    // stepper mesa (atendente)
    $$(".step-btn[data-freestep]").forEach((b) =>
      b.addEventListener("click", () => {
        mesa = Math.min(MAX_P, Math.max(MIN_P, mesa + Number(b.dataset.freestep)));
        $("#fMesa").textContent = mesa;
      })
    );

    // formulário: entrar na fila
    $("#joinForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const nome = $("#fNome").value.trim();
      const tel = $("#fTel").value.trim();
      const tipo = ($('input[name="tipo"]:checked') || {}).value || "normal";
      const msg = $("#formMsg");
      if (!nome) { msg.textContent = "Digite o nome."; msg.className = "form-msg err"; return; }
      $("#joinBtn").disabled = true;
      try {
        await addPerson({ nome, telefone: tel, pessoas, preferencial: tipo === "preferencial" });
        const pos = waiting().length;
        msg.textContent = `✅ ${firstName(nome)} entrou na fila — ${tipo === "preferencial" ? "preferencial" : "posição " + pos}.`;
        msg.className = "form-msg ok";
        e.target.reset();
        pessoas = 2; $("#fPessoas").textContent = pessoas;
        $('input[name="tipo"][value="normal"]').checked = true;
        $("#fNome").focus();
        setTimeout(() => { if (msg.classList.contains("ok")) msg.textContent = ""; }, 6000);
      } catch (err) {
        console.error(err);
        msg.textContent = "Erro ao entrar na fila. Tente de novo.";
        msg.className = "form-msg err";
      } finally {
        $("#joinBtn").disabled = false;
      }
    });

    // atendente: liberar mesa -> escolher próximo
    $("#freeTableBtn").addEventListener("click", () => {
      const smsg = $("#staffMsg");
      const chosen = pickNext(mesa);
      if (!chosen) {
        smsg.textContent = `Nenhum grupo de exatamente ${mesa} ${mesa === 1 ? "pessoa" : "pessoas"} na fila.`;
        smsg.className = "form-msg err";
        pendingCall = null;
        return;
      }
      smsg.textContent = "";
      pendingCall = chosen;
      $("#callModalBody").innerHTML = `
        <div class="cc-name">${esc(chosen.nome)} ${chosen.preferencial ? "★" : ""}</div>
        <div class="cc-meta">${chosen.pessoas} ${chosen.pessoas === 1 ? "pessoa" : "pessoas"}
          ${chosen.preferencial ? "• Preferencial" : ""}
          • esperando há ${fmtElapsed(Date.now() - new Date(chosen.criado_em).getTime())}</div>`;
      $("#callModal").hidden = false;
    });
    $("#callCancel").addEventListener("click", () => { $("#callModal").hidden = true; pendingCall = null; });
    $("#callConfirm").addEventListener("click", async () => {
      if (pendingCall) await callPerson(pendingCall.id);
      $("#callModal").hidden = true;
      pendingCall = null;
    });

    // ações na lista/painel (delegação)
    document.addEventListener("click", async (e) => {
      const t = e.target.closest("[data-call],[data-seat],[data-drop],[data-back]");
      if (!t) return;
      if (t.dataset.call) await callPerson(t.dataset.call);
      else if (t.dataset.seat) await seatPerson(t.dataset.seat);
      else if (t.dataset.drop) { if (confirm("Remover este cliente da fila?")) await dropPerson(t.dataset.drop); }
      else if (t.dataset.back) await backToQueue(t.dataset.back);
    });

    // fechar pop-ups: botão "X", clique fora e tecla Esc
    function closeModal(m) {
      if (!m) return;
      m.hidden = true;
      if (m.id === "callModal") pendingCall = null;
    }
    document.addEventListener("click", (e) => {
      const x = e.target.closest("[data-close]");
      if (x) { closeModal(x.closest(".modal")); return; }
      // clique no fundo escuro (fora da caixa) fecha
      if (e.target.classList && e.target.classList.contains("modal")) closeModal(e.target);
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") $$(".modal").forEach((m) => { if (!m.hidden) closeModal(m); });
    });

    // ajuda iOS
    $("#iosHelpBtn").addEventListener("click", () => { $("#iosModal").hidden = false; });
    $("#iosClose").addEventListener("click", () => { $("#iosModal").hidden = true; });
  }

  // ==========================================================
  //  PWA: instalar + service worker
  // ==========================================================
  let deferredPrompt = null;
  function wirePWA() {
    window.addEventListener("beforeinstallprompt", (e) => {
      e.preventDefault();
      deferredPrompt = e;
      $("#installBtn").hidden = false;
    });
    $("#installBtn").addEventListener("click", async () => {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      await deferredPrompt.userChoice;
      deferredPrompt = null;
      $("#installBtn").hidden = true;
    });
    window.addEventListener("appinstalled", () => { $("#installBtn").hidden = true; });

    // iOS não dispara beforeinstallprompt -> mostrar dica manual
    const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
    const standalone = window.navigator.standalone || window.matchMedia("(display-mode: standalone)").matches;
    if (isIOS && !standalone) $("#iosHelpBtn").hidden = false;

    if ("serviceWorker" in navigator) {
      window.addEventListener("load", () => {
        navigator.serviceWorker.register("./sw.js").catch((e) => console.warn("SW falhou:", e));
      });
    }
  }

  // ==========================================================
  //  CONEXÃO / BADGE
  // ==========================================================
  function setConn(state) {
    const b = $("#connBadge");
    if (state === "online") { b.textContent = "● Nuvem"; b.className = "badge badge-online"; b.title = "Sincronizando em tempo real"; }
    else if (state === "off") { b.textContent = "● Sem ligação"; b.className = "badge badge-off"; b.title = "Sem ligação com a nuvem"; }
    else { b.textContent = "● Local"; b.className = "badge badge-local"; b.title = "Modo local (só este aparelho). Configure o Supabase para sincronizar."; }
  }

  // ==========================================================
  //  ARRANQUE
  // ==========================================================
  async function start() {
    $("#brandName").textContent = CFG.marca || "Fila Fácil";
    $("#brandSub").textContent = CFG.restaurante || "Quinta do Aveiro";
    $("#footInfo").textContent = `${CFG.marca || "Fila Fácil"} • ${CFG.restaurante || "Quinta do Aveiro"}`;

    const hasSupabase = CFG.supabaseUrl && CFG.supabaseAnonKey && window.supabase;
    try {
      backend = hasSupabase ? SupabaseBackend(CFG.supabaseUrl, CFG.supabaseAnonKey) : LocalBackend();
      await backend.init();
      setConn(backend.mode === "online" ? "online" : "local");
    } catch (e) {
      console.error("Falha no backend, usando modo local:", e);
      backend = LocalBackend();
      await backend.init();
      setConn("local");
    }

    backend.onChange(refresh);
    wireUI();
    wirePWA();
    await refresh();

    setInterval(tickTimes, 1000);     // tempos ao vivo
    setInterval(refresh, 15000);      // rede de segurança (recarrega periodicamente)
  }

  document.addEventListener("DOMContentLoaded", start);
})();
