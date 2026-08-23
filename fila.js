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
    "filasJuntas", "mostrarHoraEntrada", "mostrarTempoEspera", "pedidoPainelMin", "avisoPedido"];

  // Por quantos minutos o aviso de "pedido pronto" fica na tela. É o mesmo
  // ajuste da engrenagem que vale para o totem e para a tela da atendente.
  // 0 = não mostra aqui (o cliente foi avisado pelo WhatsApp).
  function minutosDoPedido() {
    const v = Number(CFG.pedidoPainelMin);
    return isNaN(v) || v < 0 ? 10 : v;
  }
  function pedidoNaTela(r) {
    const min = minutosDoPedido();
    if (!r || !r.pedido_em || !min) return false;
    const d = new Date(r.pedido_em).getTime();
    return !isNaN(d) && Date.now() - d < min * 60000;
  }

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

  // ==========================================================
  //  ALARME NO CELULAR DO CLIENTE
  // ----------------------------------------------------------
  //  A mensagem do WhatsApp passa batido no bolso e a pessoa perde a vez.
  //  Com o alarme ligado, é o próprio celular dela que toca e vibra na hora
  //  da chamada — sem instalar nada, só deixando esta tela aberta.
  //
  //  O navegador só deixa tocar som depois de UM toque da pessoa: por isso o
  //  botão. O mesmo toque serve para pedir que a tela não apague.
  // ==========================================================
  let alarmeLigado = false;
  let audioCtx = null;
  let telaAcesa = null;          // WakeLockSentinel
  let statusAnterior = null;     // para tocar só na MUDANÇA de estado
  let pedidoAnterior = null;
  let piscando = null;
  let meAtual = null;             // o cliente deste link, como está agora
  const TITULO = document.title;

  function bip(freq, inicio, dur, vol) {
    if (!audioCtx) return;
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = "square";
    o.frequency.value = freq;
    g.gain.value = vol;
    o.connect(g); g.connect(audioCtx.destination);
    o.start(audioCtx.currentTime + inicio);
    o.stop(audioCtx.currentTime + inicio + dur);
  }

  // Toque + vibração. A chamada da mesa e o pedido pronto têm padrões
  // diferentes: dá para saber qual é sem tirar o celular do bolso.
  const VIBRA = {
    chamada: [500, 200, 500, 200, 900],
    pedido: [250, 120, 250, 120, 250, 120, 250],
  };
  function tocarAlarme(vezes, tipo) {
    if (!alarmeLigado) return;
    const agudo = tipo === "pedido";
    try {
      if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
      for (let i = 0; i < (vezes || 6); i++) {
        bip(agudo ? 880 : 1046, i * 0.42, 0.18, 0.3);
        bip(agudo ? 1318 : 1568, i * 0.42 + 0.2, 0.18, 0.3);
      }
    } catch (e) { console.warn("Som:", e); }
    try {
      if (navigator.vibrate) navigator.vibrate(VIBRA[tipo] || VIBRA.chamada);
    } catch (e) { /* iPhone não vibra pelo navegador */ }
  }

  // o título da aba pisca: quem está com o celular na mão vê mesmo de longe
  function piscarTitulo(texto) {
    clearInterval(piscando);
    let liga = false;
    piscando = setInterval(() => {
      document.title = (liga = !liga) ? texto : TITULO;
    }, 900);
  }
  function pararDePiscar() {
    clearInterval(piscando);
    piscando = null;
    document.title = TITULO;
  }

  async function manterTelaAcesa() {
    if (!alarmeLigado || !navigator.wakeLock) return;
    try { telaAcesa = await navigator.wakeLock.request("screen"); }
    catch (e) { /* bateria fraca ou navegador sem suporte: segue sem */ }
  }

  // ---------- notificação push ----------
  // O alarme da tela só toca com a página aberta. A notificação push chega
  // mesmo com o navegador fechado: quem entrega é o servidor, não a página.
  // No iPhone só funciona se a pessoa tiver usado "Adicionar à Tela de Início".
  function chaveParaBytes(base64) {
    const pad = "=".repeat((4 - (base64.length % 4)) % 4);
    const b64 = (base64 + pad).replace(/-/g, "+").replace(/_/g, "/");
    const bruto = atob(b64);
    const bytes = new Uint8Array(bruto.length);
    for (let i = 0; i < bruto.length; i++) bytes[i] = bruto.charCodeAt(i);
    return bytes;
  }

  async function ligarPush() {
    const chave = CFG.pushChavePublica;
    if (!chave || !client || !meuId) return "sem-push";
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return "sem-suporte";
    try {
      const permissao = await Notification.requestPermission();
      if (permissao !== "granted") return "recusado";
      const reg = await navigator.serviceWorker.register("./sw.js");
      await navigator.serviceWorker.ready;
      const jaTem = await reg.pushManager.getSubscription();
      const sub = jaTem || await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: chaveParaBytes(chave),
      });
      const j = sub.toJSON();
      const { error } = await client.from("fila_push").insert({
        cliente_id: meuId,
        endpoint: j.endpoint,
        p256dh: j.keys.p256dh,
        auth: j.keys.auth,
      });
      // 23505 = já estava cadastrado; 42P01 = a tabela ainda não existe
      if (error && error.code !== "23505") {
        console.warn("Push não cadastrado:", error.message);
        return error.code === "42P01" ? "sem-tabela" : "erro";
      }
      return "ok";
    } catch (e) {
      console.warn("Push:", e);
      return "erro";
    }
  }

  let pushEstado = "";            // "ok", "recusado", "sem-suporte"...
  // o navegador exige um toque novo a cada carregamento para liberar som;
  // quem já ligou uma vez merece um rótulo mais direto
  function jaUsouAlarme() {
    try { return localStorage.getItem("fila_alarme") === "1"; } catch (e) { return false; }
  }

  async function ligarAlarme() {
    const btn = $("#alertaBtn");
    if (btn) { btn.disabled = true; btn.textContent = "⏳ Ligando…"; }
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) { audioCtx = new AC(); await audioCtx.resume(); }
    } catch (e) { console.warn("Áudio:", e); }
    alarmeLigado = true;
    try { localStorage.setItem("fila_alarme", "1"); } catch (e) { /* ignora */ }
    bip(1046, 0, 0.12, 0.2);                       // confirma que está ligado
    try { if (navigator.vibrate) navigator.vibrate(120); } catch (e) { /* ignora */ }
    manterTelaAcesa();
    // o MESMO toque serve para pedir a notificação: é a única chance de pedir
    // sem parecer invasivo, e é ela que salva quem fecha o navegador
    pushEstado = await ligarPush();
    if (btn) btn.disabled = false;
    desenharAlarme();   // o rótulo certo vem daqui
  }

  function desenharAlarme(me) {
    if (me !== undefined) meAtual = me;
    const card = $("#alertaCard");
    if (!card) return;
    const r = meAtual;
    // Vale enquanto ele espera a mesa E enquanto espera o pedido: era aqui que
    // o aviso de "pedido pronto" se perdia — o botão sumia quando a pessoa
    // sentava, e quem recarregava a página ficava sem alarme nenhum.
    const esperandoMesa = r && (r.status === STATUS.AGUARDANDO || r.status === STATUS.CHAMADO);
    const esperandoPedido = r && r.status === STATUS.SENTADO && !r.pedido_em && CFG.avisoPedido !== false;
    card.hidden = !(esperandoMesa || esperandoPedido);
    if (card.hidden) return;
    const btn = $("#alertaBtn");
    btn.hidden = alarmeLigado;
    if (!alarmeLigado) {
      btn.textContent = esperandoPedido
        ? "🔔 Tocar quando o pedido ficar pronto"
        : (jaUsouAlarme() ? "🔔 Reativar o alarme" : "🔔 Tocar quando for a minha vez");
    }
    const recado = {
      ok: "🔔 Pronto! Você recebe a notificação mesmo com o celular guardado.",
      recusado: "🔔 Alarme ligado. As notificações estão bloqueadas neste navegador — deixe esta tela aberta.",
      "sem-suporte": "🔔 Alarme ligado. Este navegador não entrega notificação — deixe esta tela aberta.",
      "sem-tabela": "🔔 Alarme ligado (aviso fora da tela ainda não configurado).",
      erro: "🔔 Alarme ligado. Não deu para ligar o aviso fora da tela — deixe esta tela aberta.",
    };
    $("#alertaNota").textContent = alarmeLigado
      ? (recado[pushEstado] || "🔔 Alarme ligado. Deixe esta tela aberta — o celular toca e vibra na hora.")
      : (esperandoPedido
        ? "Toque uma vez: o celular toca e vibra quando o pedido sair do balcão."
        : "Deixe esta tela aberta. O celular toca e vibra quando a mesa sair.");
  }

  // Toca quando o estado MUDA: virou "é a sua vez" ou o pedido ficou pronto.
  // O primeiro desenho nunca toca (senão tocaria só de abrir a página) — e é
  // por isso que existe a bandeira: comparar com null não servia, porque o
  // banco devolve pedido_em = null e a comparação travava para sempre.
  let primeiroDesenho = true;
  function talvezTocar(me) {
    const st = me ? me.status : null;
    const ped = me ? me.pedido_em : null;
    const eraChamado = statusAnterior === STATUS.CHAMADO;
    const tinhaPedido = !!pedidoAnterior;
    if (!primeiroDesenho && st === STATUS.CHAMADO && !eraChamado) {
      tocarAlarme(8, "chamada");
      piscarTitulo("🔔 É A SUA VEZ!");
    }
    if (!primeiroDesenho && ped && !tinhaPedido) {
      tocarAlarme(6, "pedido");
      piscarTitulo("🍽️ PEDIDO PRONTO!");
    }
    if (st !== STATUS.CHAMADO && !ped && piscando) pararDePiscar();
    statusAnterior = st;
    pedidoAnterior = ped;
    primeiroDesenho = false;
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
    desenharAlarme(me);
    talvezTocar(me);
    const meCard = $("#meCard");
    if (me) {
      const pos = w.findIndex((r) => r.id === me.id) + 1;
      let corpo;
      // O pedido pronto é um aviso à parte, no topo do cartão: ele não pode
      // roubar o lugar da posição na fila nem do "é a sua vez" — o cliente
      // precisa continuar vendo onde está e quando a mesa dele sair.
      const avisoPedido = pedidoNaTela(me)
        ? `<div class="me-pedido">🍽️ Seu pedido está pronto — pode retirar no balcão
             <span>avisamos às ${fmtClock(me.pedido_em)}</span></div>`
        : "";
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
      } else if (me.status === STATUS.SENTADO) {
        // Sentou (chamado ou direto do balcão): para a fila, acabou. O cartão
        // fecha o atendimento em vez de continuar parecendo espera.
        const naMesa = me.sentou_em ? " às " + fmtClock(me.sentou_em) : "";
        const avisa = CFG.avisoPedido !== false && !me.pedido_em
          ? " Avisamos aqui quando o pedido ficar pronto."
          : "";
        corpo = `<div class="me-big">✅ Atendimento concluído</div>
          <div class="me-sub">Você sentou${naMesa}. Bom apetite! 🍽️${avisa}</div>`;
      } else {
        corpo = `<div class="me-big">Atendimento encerrado</div>
          <div class="me-sub">Este código não está mais na fila. Bom apetite! 🍽️</div>`;
      }
      meCard.innerHTML = avisoPedido + corpo;
      meCard.hidden = false;
      meCard.classList.toggle("me-chamado", me.status === STATUS.CHAMADO);
      $("#semCodigo").hidden = true;
      // acabou o atendimento: a espera média da casa não diz mais nada a ele
      const naFila = me.status === STATUS.AGUARDANDO || me.status === STATUS.CHAMADO;
      $("#resumoCard").hidden = !mostrarMedia || !naFila;
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

    $("#alertaBtn").addEventListener("click", ligarAlarme);
    // ao voltar para a tela, o navegador solta o wake lock: pede de novo
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        manterTelaAcesa();
        if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
        atualizar();
      }
    });

    setInterval(tick, 1000);        // tempos ao vivo
    setInterval(atualizar, 20000);  // rede de segurança
  }

  document.addEventListener("DOMContentLoaded", start);
})();
