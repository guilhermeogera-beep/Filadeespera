/* ============================================================
   fila.js — Página PÚBLICA de acompanhamento (só leitura)
   Mostra a fila inteira (preferencial + normal + mesas grandes,
   tudo junto na ordem de chegada) e as mesas sendo chamadas.
   Nenhum botão de ação: o cliente só acompanha.
   ============================================================ */
(function () {
  "use strict";

  const CFG = window.FILA_CONFIG || {};
  const STATUS = { AGUARDANDO: "aguardando", CHAMADO: "chamado" };
  const LS_KEY = "fila_espera_v1";
  const T = "fila_espera";

  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // código do cliente que abriu o link (?id=...) — para destacar "você"
  const meuId = new URLSearchParams(location.search).get("id") || "";

  // Só os campos que esta página realmente desenha. Telefone, comanda, pager e
  // termos_em NÃO saem do balcão: quem acompanha a fila não precisa deles.
  const COLS_PUB = "id,nome,pessoas,preferencial,status,criado_em,chamado_em,pet";
  const COLS_PUB_SIMPLES = "id,nome,pessoas,preferencial,status,criado_em,chamado_em";

  // Só estas configurações interessam a quem acompanha a fila. Copiar `dados`
  // inteiro traria junto qualquer ajuste interno guardado na configuração.
  const CFG_PUBLICAS = ["restaurante", "marca", "mostrarMedia", "mesonaAtiva", "mesonaMin", "prazoComparecer", "filasJuntas"];

  // Janela de histórico: a página não precisa (nem deve) baixar a tabela inteira
  const JANELA_HIST_MS = 24 * 3600 * 1000;
  const PAGINA = 1000;

  let rows = [];
  let client = null;
  let colsPub = COLS_PUB;   // vira a versão simples se o banco ainda não tiver `pet`

  // ---------- utilidades ----------
  function fmtElapsed(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    if (h > 0) return `${h}h${String(m % 60).padStart(2, "0")}`;
    return `${m}min${m < 1 ? " " + String(s).padStart(2, "0") + "s" : ""}`;
  }
  function fmtClock(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return "--:--";
    return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  }
  function firstName(n) { return (n || "").split(/\s+/)[0] || n || "Cliente"; }
  // Nome curto e discreto: "Guilherme S." (não expõe o nome completo em público)
  function nomePublico(n) {
    const p = String(n || "").trim().split(/\s+/);
    if (!p[0]) return "Cliente";
    return p.length > 1 ? `${p[0]} ${p[1][0].toUpperCase()}.` : p[0];
  }
  function isMesona(r) {
    return CFG.mesonaAtiva === true && Number(r.pessoas) >= (Number(CFG.mesonaMin) || 8);
  }

  const byCreatedAsc = (a, b) => new Date(a.criado_em) - new Date(b.criado_em);
  const waiting = () => rows.filter((r) => r.status === STATUS.AGUARDANDO).sort(byCreatedAsc);
  const called = () => rows.filter((r) => r.status === STATUS.CHAMADO)
    .sort((a, b) => new Date(b.chamado_em) - new Date(a.chamado_em));

  function avgWaitMs() {
    const done = rows.filter((r) => r.chamado_em);
    if (!done.length) return null;
    const sum = done.reduce((a, r) => a + Math.max(0, new Date(r.chamado_em) - new Date(r.criado_em)), 0);
    return sum / done.length;
  }

  // ---------- dados ----------
  async function carregar() {
    if (!client) {
      try { rows = JSON.parse(localStorage.getItem(LS_KEY)) || []; } catch (e) { rows = []; }
      return;
    }
    // duas consultas curtas: quem está na fila + histórico recente (para a média)
    const busca = async (cols) => {
      const ativos = await client.from(T).select(cols)
        .in("status", [STATUS.AGUARDANDO, STATUS.CHAMADO])
        .order("criado_em", { ascending: true }).limit(PAGINA);
      if (ativos.error) return ativos;
      const desde = new Date(Date.now() - JANELA_HIST_MS).toISOString();
      const hist = await client.from(T).select(cols)
        .gte("criado_em", desde)
        .order("criado_em", { ascending: false }).limit(PAGINA);
      if (hist.error) return hist;
      return { data: (ativos.data || []).concat(hist.data || []) };
    };
    let res = await busca(colsPub);
    // se o banco ainda não tem a coluna `pet`, repete sem ela
    if (res.error && colsPub === COLS_PUB) {
      colsPub = COLS_PUB_SIMPLES;
      res = await busca(colsPub);
    }
    if (res.error) throw res.error;
    const mapa = new Map();
    (res.data || []).forEach((r) => mapa.set(r.id, r));
    rows = Array.from(mapa.values()).sort(byCreatedAsc);
  }

  function aplicarConfigPublica(dados) {
    if (!dados) return;
    CFG_PUBLICAS.forEach((k) => { if (dados[k] !== undefined && dados[k] !== null) CFG[k] = dados[k]; });
  }

  async function carregarConfig() {
    if (!client) {
      try { aplicarConfigPublica(JSON.parse(localStorage.getItem("fila_settings"))); } catch (e) { /* ignora */ }
      return;
    }
    try {
      const { data, error } = await client.from("fila_config").select("dados").eq("id", 1).maybeSingle();
      if (!error && data && data.dados) aplicarConfigPublica(data.dados);
    } catch (e) { console.warn("Config indisponível:", e); }
  }

  // ---------- desenho ----------
  function render() {
    const w = waiting();
    const c = called();

    $("#brandName").textContent = CFG.marca || "Fila Fácil";
    $("#brandSub").textContent = CFG.restaurante || "";
    $("#statTotal").textContent = w.length;

    // tempo médio: segue a mesma configuração do totem
    const avg = avgWaitMs();
    const mostrarMedia = CFG.mostrarMedia !== false && avg != null;
    $("#statAvgWrap").hidden = !mostrarMedia;
    if (mostrarMedia) $("#statAvg").textContent = "~" + fmtElapsed(avg);

    // ---- meu cartão (quem abriu o link com o próprio código) ----
    const me = meuId ? rows.find((r) => r.id === meuId) : null;
    const meCard = $("#meCard");
    if (me) {
      const pos = w.findIndex((r) => r.id === me.id) + 1;
      let corpo;
      if (me.status === STATUS.CHAMADO) {
        corpo = `<div class="me-big">🔔 É a sua vez!</div>
          <div class="me-sub">Dirija-se à recepção agora. Você foi chamado às ${fmtClock(me.chamado_em)}
          e tem até ${esc(String(CFG.prazoComparecer || 5))} minutos para comparecer.</div>`;
      } else if (me.status === STATUS.AGUARDANDO) {
        const naFrente = pos - 1;
        // quem de fato disputa uma mesa deste tamanho são os grupos do mesmo
        // tamanho que chegaram antes — a chamada NÃO segue a ordem de chegada
        const mesmos = w.slice(0, Math.max(0, pos - 1))
          .filter((r) => Number(r.pessoas) === Number(me.pessoas)).length;
        const frase = naFrente === 0
          ? "Ninguém chegou antes de você"
          : `${naFrente} ${naFrente === 1 ? "grupo chegou" : "grupos chegaram"} antes de você`;
        corpo = `<div class="me-label">Olá, ${esc(firstName(me.nome))} — ordem de chegada</div>
          <div class="me-big">${pos}º</div>
          <div class="me-sub">${frase}
            • ${me.pessoas} ${me.pessoas === 1 ? "pessoa" : "pessoas"}
            • esperando há <b data-since="${me.criado_em}">agora</b></div>
          <div class="me-note">A chamada <b>não</b> segue esta ordem: as mesas saem conforme o
            tamanho do grupo e a preferência legal. Grupos de ${me.pessoas}
            ${me.pessoas === 1 ? "pessoa" : "pessoas"} na sua frente: <b>${mesmos}</b>.</div>`;
      } else {
        corpo = `<div class="me-big">Atendimento encerrado</div>
          <div class="me-sub">Este código não está mais na fila. Bom apetite! 🍽️</div>`;
      }
      meCard.innerHTML = corpo;
      meCard.hidden = false;
      meCard.classList.toggle("me-chamado", me.status === STATUS.CHAMADO);
    } else {
      meCard.hidden = true;
    }

    // ---- mesas sendo chamadas ----
    $("#callEmpty").hidden = c.length > 0;
    $("#callList").innerHTML = c.map((r, i) => `
      <div class="call-item ${r.preferencial ? "pref" : ""} ${r.id === meuId ? "is-me" : ""} ${i === 0 ? "fresh" : ""}">
        <span class="ci-label">${r.preferencial ? "★ Preferencial" : "Chamando"}</span>
        <span class="ci-name">${esc(firstName(r.nome))}</span>
        <span class="ci-meta">${r.pessoas} ${r.pessoas === 1 ? "pessoa" : "pessoas"} • chamado às ${fmtClock(r.chamado_em)} (há <b data-since="${r.chamado_em}">agora</b>)</span>
      </div>`).join("");

    // ---- a fila: tudo junto ou separada em grupos (segue a engrenagem) ----
    const item = (r, i, junto) => {
      const selos = (junto
        ? (r.preferencial ? `<span class="q-tag pref">★ preferencial</span>` : "") +
          (isMesona(r) ? `<span class="q-tag meso">🍽 mesa grande</span>` : "")
        : "") +
        (r.pet ? `<span class="q-tag petx">🐾 pet</span>` : "");
      return `
        <li class="q-item ${r.preferencial ? "is-pref" : ""} ${isMesona(r) ? "is-meso-pub" : ""} ${r.id === meuId ? "is-me" : ""}">
          <div class="q-pos">${i + 1}</div>
          <div class="q-main">
            <div class="q-name">${esc(nomePublico(r.nome))}${r.id === meuId ? `<span class="q-tag voce">você</span>` : ""}${selos}</div>
            <div class="q-sub">
              <span>👥 ${r.pessoas} ${r.pessoas === 1 ? "pessoa" : "pessoas"}</span>
              <span>🕐 entrou ${fmtClock(r.criado_em)}</span>
              <span>⏱ esperando <b class="q-time" data-since="${r.criado_em}">agora</b></span>
            </div>
          </div>
        </li>`;
    };

    if (CFG.filasJuntas === false) {
      // separada: mesas grandes, preferencial e normal — cada uma na ordem de chegada
      const meso = w.filter(isMesona);
      const pref = w.filter((r) => r.preferencial && !isMesona(r));
      const norm = w.filter((r) => !r.preferencial && !isMesona(r));
      const grupo = (titulo, classe, lista, vazio) => (!lista.length && !vazio) ? "" : `
        <div class="queue-group">
          <div class="qg-head ${classe}"><span>${titulo}</span><span class="qg-count">${lista.length}</span></div>
          <ol class="queue-list">${lista.map((r, i) => item(r, i, false)).join("")}</ol>
          ${lista.length ? "" : `<div class="queue-empty">${vazio}</div>`}
        </div>`;
      $("#queueWrap").innerHTML =
        (CFG.mesonaAtiva === true ? grupo(`🍽 Mesas grandes (${Number(CFG.mesonaMin) || 8}+ pessoas)`, "qg-meso", meso, "Nenhuma mesa grande na fila") : "") +
        grupo("★ Preferencial", "qg-pref", pref, "Nenhum preferencial na fila") +
        grupo("Normal", "qg-norm", norm, "Ninguém na fila normal");
    } else {
      $("#queueWrap").innerHTML = `<ol class="queue-list">${w.map((r, i) => item(r, i, true)).join("")}</ol>`;
    }
    $("#queueEmpty").hidden = w.length > 0;

    tick();
    $("#pubUpdated").textContent = "atualizado às " + fmtClock(new Date().toISOString());
  }

  function tick() {
    const now = Date.now();
    document.querySelectorAll("[data-since]").forEach((el) => {
      const d = new Date(el.getAttribute("data-since")).getTime();
      if (!isNaN(d)) el.textContent = fmtElapsed(now - d);
    });
    // mesmo semáforo do painel: verde -> vermelho até o prazo de comparecer
    const prazoMs = (Number(CFG.prazoComparecer) || 5) * 60000;
    document.querySelectorAll(".call-item").forEach((card) => {
      const b = card.querySelector("[data-since]");
      if (!b) return;
      const d = new Date(b.getAttribute("data-since")).getTime();
      if (isNaN(d)) return;
      const frac = Math.max(0, Math.min(1, (now - d) / prazoMs));
      card.style.background = `hsl(${Math.round(120 * (1 - frac))}, 75%, 44%)`;
    });
  }

  async function atualizar() {
    try {
      await carregar();
      render();
      $("#liveDot").classList.remove("off");
    } catch (e) {
      console.error(e);
      $("#liveDot").classList.add("off");
    }
  }

  // ---------- arranque ----------
  async function start() {
    if (CFG.supabaseUrl && CFG.supabaseAnonKey && window.supabase) {
      client = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, {
        realtime: { params: { eventsPerSecond: 5 } },
      });
      client.channel("fila-pub-rt")
        .on("postgres_changes", { event: "*", schema: "public", table: T }, atualizar)
        .subscribe();
      client.channel("fila-pub-cfg")
        .on("postgres_changes", { event: "*", schema: "public", table: "fila_config" }, async () => {
          await carregarConfig();
          render();
        })
        .subscribe();
    }
    await carregarConfig();
    await atualizar();

    setInterval(tick, 1000);        // tempos ao vivo
    setInterval(atualizar, 20000);  // rede de segurança
    // recarrega assim que a pessoa volta para a aba
    document.addEventListener("visibilitychange", () => { if (!document.hidden) atualizar(); });
  }

  document.addEventListener("DOMContentLoaded", start);
})();
