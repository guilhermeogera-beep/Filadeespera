/* ============================================================
   fila.js — Página PÚBLICA de acompanhamento (só leitura)
   Mostra APENAS a situação de quem abriu o link (?id=...).
   Ninguém vê o nome nem a posição de outro cliente.
   ============================================================ */
(function () {
  "use strict";

  const CFG = window.FILA_CONFIG || {};
  const STATUS = { AGUARDANDO: "aguardando", CHAMADO: "chamado", SENTADO: "sentado" };
  const LS_KEY = "fila_espera_v1";
  const T = "fila_publica";   // a "vitrine": fila sem telefone e só com o primeiro nome

  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // código do cliente que abriu o link (?id=...) — para destacar "você"
  const meuId = new URLSearchParams(location.search).get("id") || "";

  // A vitrine (view) já entrega só o primeiro nome e nada de telefone,
  // comanda ou pager — a proteção está no banco, não só nesta tela.
  // sentou_em e pedido_em entram para a página avisar quando o pedido fica
  // pronto; se a vitrine do banco ainda não os tiver, o app segue sem eles
  const COLS_FILA = "id,nome,pessoas,preferencial,status,criado_em,chamado_em,sentou_em,pedido_em,pet";
  const COLS_ANTIGAS = "id,nome,pessoas,preferencial,status,criado_em,chamado_em,pet";

  // Só estas configurações interessam a quem acompanha a fila. Copiar `dados`
  // inteiro traria junto qualquer ajuste interno guardado na configuração.
  const CFG_PUBLICAS = ["restaurante", "marca", "mostrarMedia", "mesonaAtiva", "mesonaMin", "prazoComparecer",
    "filasJuntas", "mostrarHoraEntrada", "mostrarTempoEspera"];

  // Janela de histórico: a página não precisa (nem deve) baixar a tabela inteira
  const JANELA_HIST_MS = 24 * 3600 * 1000;
  const PAGINA = 1000;

  let rows = [];
  let client = null;

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

  // Se a vitrine do banco ainda for a antiga (sem sentou_em/pedido_em), o
  // PostgREST devolve erro 42703; nesse caso repetimos sem as colunas novas
  // e a página funciona como antes, só sem o aviso de pedido pronto.
  let colunasDaFila = COLS_FILA;
  async function buscar(monta) {
    let r = await monta(client.from(T).select(colunasDaFila));
    if (r.error && r.error.code === "42703" && colunasDaFila !== COLS_ANTIGAS) {
      colunasDaFila = COLS_ANTIGAS;
      r = await monta(client.from(T).select(colunasDaFila));
    }
    return r;
  }

  async function carregar() {
    if (!client) {
      try { rows = JSON.parse(localStorage.getItem(LS_KEY)) || []; } catch (e) { rows = []; }
      return;
    }
    // Lê a "vitrine" (view fila_publica): a fila já vem sem telefone, sem
    // comanda e só com o primeiro nome — nem o banco entrega mais que isso.
    const ativos = await buscar((q) => q
      .in("status", [STATUS.AGUARDANDO, STATUS.CHAMADO])
      .order("criado_em", { ascending: true }).limit(PAGINA));
    if (ativos.error) throw ativos.error;
    const desde = new Date(Date.now() - JANELA_HIST_MS).toISOString();
    const hist = await buscar((q) => q
      .gte("criado_em", desde)
      .order("criado_em", { ascending: false }).limit(PAGINA));
    if (hist.error) throw hist.error;

    const mapa = new Map();
    (ativos.data || []).concat(hist.data || []).forEach((r) => mapa.set(r.id, r));
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
        // O que realmente conta para ele: quantos grupos DO MESMO TAMANHO estão
        // na frente — porque as mesas são chamadas pelo tamanho do grupo.
        const mesmos = w.slice(0, Math.max(0, pos - 1))
          .filter((r) => Number(r.pessoas) === Number(me.pessoas)).length;
        const qtd = `${me.pessoas} ${me.pessoas === 1 ? "pessoa" : "pessoas"}`;
        const frente = mesmos === 0
          ? `Você é o <b>próximo</b> para uma mesa de ${qtd}`
          : `${mesmos} ${mesmos === 1 ? "grupo" : "grupos"} de ${qtd} na sua frente`;
        corpo = `<div class="me-label">Olá, ${esc(firstName(me.nome))} — sua posição</div>
          <div class="me-big">${pos}º</div>
          <div class="me-sub">${frente}${
            CFG.mostrarTempoEspera !== false ? ` • esperando há <b data-since="${me.criado_em}">agora</b>` : ""}</div>
          <div class="me-note">A ordem pode mudar conforme o tamanho das mesas que vagam.</div>`;
      } else if (me.pedido_em) {
        // o mesmo aviso que sai pelo WhatsApp, para quem acompanha pelo link
        corpo = `<div class="me-big">🍽️ Seu pedido está pronto!</div>
          <div class="me-sub">Pode retirar no balcão. Avisamos às ${fmtClock(me.pedido_em)}.</div>`;
      } else if (me.status === STATUS.SENTADO) {
        corpo = `<div class="me-big">✅ Bom apetite!</div>
          <div class="me-sub">Você já está na mesa${me.sentou_em ? " desde as " + fmtClock(me.sentou_em) : ""}. Avisamos aqui assim que o pedido ficar pronto.</div>`;
      } else {
        corpo = `<div class="me-big">Atendimento encerrado</div>
          <div class="me-sub">Este código não está mais na fila. Bom apetite! 🍽️</div>`;
      }
      meCard.innerHTML = corpo;
      meCard.hidden = false;
      meCard.classList.toggle("me-chamado", me.status === STATUS.CHAMADO);
      $("#semCodigo").hidden = true;
      $("#resumoCard").hidden = !mostrarMedia;
    } else {
      meCard.hidden = true;
      // sem código no link (ou código que não está mais na fila): não há o que mostrar
      $("#semCodigo").hidden = false;
      $("#resumoCard").hidden = true;
    }

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
      // a vitrine é uma view e views não avisam ninguém: escutamos o "sino",
      // uma tabelinha que guarda só a hora da última mudança na fila
      client.channel("fila-pub-rt")
        .on("postgres_changes", { event: "*", schema: "public", table: "fila_sinal" }, atualizar)
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
