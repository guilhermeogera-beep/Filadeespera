/* ============================================================
   fila.js — Página PÚBLICA de acompanhamento (só leitura)
   Mostra APENAS a situação de quem abriu o link (?id=...).
   Ninguém vê o nome nem a posição de outro cliente.
   ============================================================ */
(function () {
  "use strict";

  const CFG = window.FILA_CONFIG || {};
  const STATUS = { AGUARDANDO: "aguardando", CHAMADO: "chamado", SENTADO: "sentado", PREVIA: "previa" };
  const LS_KEY = "fila_espera_v1";
  const T = "fila_publica";   // a "vitrine": fila sem telefone e só com o primeiro nome

  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // código do cliente que abriu o link (?id=...) — para destacar "você"
  // Dois caminhos chegam nesta página:
  //  1) o link/QR pessoal do cliente  ->  fila.html?id=...
  //  2) o QR FIXO do balcão           ->  fila.html (sem código)
  // No segundo, o cliente digita o telefone e o banco devolve o código dele.
  // Guardamos em sessionStorage, e não em localStorage, de propósito: fechou
  // o navegador, acabou. Ninguém pega o celular do outro e vê a fila dele.
  const SS_MEU_ID = "fila_meu_id";
  let meuId = new URLSearchParams(location.search).get("id") || "";
  if (!meuId) {
    try { meuId = sessionStorage.getItem(SS_MEU_ID) || ""; } catch (e) { meuId = ""; }
  }

  function esquecerMeuId() {
    meuId = "";
    try { sessionStorage.removeItem(SS_MEU_ID); } catch (e) { /* ignora */ }
  }

  // A vitrine (view) já entrega só o primeiro nome e nada de telefone,
  // comanda ou pager — a proteção está no banco, não só nesta tela.
  // sentou_em e pedido_em entram para a página avisar quando o pedido fica
  // pronto; se a vitrine do banco ainda não os tiver, o app segue sem eles
  const COLS_FILA = "id,nome,pessoas,preferencial,status,criado_em,chamado_em,sentou_em,pedido_em,mesa_numero,previa_avisado_em,pet";
  const COLS_SEM_PREVIA = "id,nome,pessoas,preferencial,status,criado_em,chamado_em,sentou_em,pedido_em,mesa_numero,pet";
  const COLS_SEM_MESA = "id,nome,pessoas,preferencial,status,criado_em,chamado_em,sentou_em,pedido_em,pet";
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
  // A antessala, na MESMA regra da tela da recepção: ordem de chegada pura, e
  // quem já foi avisado sai da conta (ele não espera mais vaga, está a caminho
  // do balcão). Se o cliente contasse os avisados, o número dele ficaria maior
  // que o da atendente e os dois discutiriam na recepção.
  const antessala = () => rows
    .filter((r) => r.status === STATUS.PREVIA && !r.previa_avisado_em)
    .sort(byCreatedAsc);

  // Mesma conta da tela da atendente: MEDIANA das últimas chamadas, não média.
  // A média era arrastada por um grupo grande que esperou muito e mostrava ao
  // cliente um número que não acontecia com ninguém. Aqui ele vê a FAIXA
  // (p25–p75) — honesta com a variação e sem virar promessa.
  const JANELA_ESPERA = 10;

  function percentil(ordenada, p) {
    if (!ordenada.length) return null;
    const i = (ordenada.length - 1) * p;
    const baixo = Math.floor(i), alto = Math.ceil(i);
    if (baixo === alto) return ordenada[baixo];
    return ordenada[baixo] + (ordenada[alto] - ordenada[baixo]) * (i - baixo);
  }

  function esperaStats() {
    const feitas = rows.filter((r) => r.chamado_em)
      .sort((a, b) => new Date(b.chamado_em) - new Date(a.chamado_em))
      .slice(0, JANELA_ESPERA)
      .map((r) => Math.max(0, new Date(r.chamado_em) - new Date(r.criado_em)))
      .sort((a, b) => a - b);
    if (!feitas.length) return null;
    // Quem ainda espera entra como PISO (não como mais um voto): se metade da
    // fila já espera há 25min, a espera não pode ser menor que isso. A faixa
    // sobe inteira, mantendo a largura. Mesma regra da tela da atendente.
    const meio = percentil(feitas, 0.5);
    const agora = Date.now();
    const emCurso = waiting()
      .map((r) => Math.max(0, agora - new Date(r.criado_em).getTime()))
      .sort((a, b) => a - b);
    const piso = emCurso.length ? percentil(emCurso, 0.5) : 0;
    const desloc = Math.max(0, piso - meio);
    return { min: percentil(feitas, 0.25) + desloc, max: percentil(feitas, 0.75) + desloc };
  }

  function esperaTexto() {
    const s = esperaStats();
    if (!s) return null;
    const a = fmtElapsed(s.min), b = fmtElapsed(s.max);
    if (a === b) return "~" + a;
    if (a.endsWith("min") && b.endsWith("min")) return "~" + a.replace("min", "") + "–" + b;
    return "~" + a + "–" + b;
  }

  // ---------- dados ----------

  // A vitrine do banco pode estar em qualquer uma de três gerações, porque
  // cada recurso novo acrescentou uma coluna a ela. Quando pedimos uma que
  // ainda não existe, o PostgREST devolve 42703 — aí caímos para o conjunto
  // anterior. Assim a página funciona ANTES de o dono rodar o SQL novo: só
  // deixa de mostrar o que aquele SQL traria, sem quebrar nada.
  const GERACOES = [COLS_FILA, COLS_SEM_PREVIA, COLS_SEM_MESA, COLS_ANTIGAS];
  let geracao = 0;
  async function buscar(monta) {
    let r = await monta(client.from(T).select(GERACOES[geracao]));
    while (r.error && r.error.code === "42703" && geracao < GERACOES.length - 1) {
      geracao++;
      r = await monta(client.from(T).select(GERACOES[geracao]));
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
      .in("status", [STATUS.AGUARDANDO, STATUS.CHAMADO, STATUS.PREVIA])
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
  let vagaAnterior = null;   // fila da fila: ja foi avisado de que abriu vaga?
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
  // `volume`: o teste sai baixinho (é só para conferir que funciona, muitas
  // vezes com o aparelho no ouvido); o aviso de verdade sai no mais alto que
  // o navegador permite, porque aí a pessoa está longe e o celular no bolso.
  const VOLUME = { teste: 0.22, aviso: 0.9 };
  // O aviso real toca por uns 10 segundos: tempo de a pessoa ouvir, procurar
  // o celular no bolso e olhar. O teste é curto, só para conferir.
  const REPETE = { chamada: 24, pedido: 18, teste: 2 };
  const repetirVibra = (p, voltas) => {
    let out = [];
    for (let i = 0; i < voltas; i++) out = out.concat(p, i < voltas - 1 ? [300] : []);
    return out;
  };
  function tocarAlarme(vezes, tipo, volume) {
    if (!alarmeLigado) return;
    const agudo = tipo === "pedido";
    const vol = volume || VOLUME.aviso;
    const ehTeste = vol === VOLUME.teste;
    try {
      if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
      // no teste os bipes vêm mais rápido: é só uma amostra, não um alarme
      const passo = ehTeste ? 0.24 : 0.42;
      const meio = ehTeste ? 0.12 : 0.2;
      for (let i = 0; i < (vezes || 6); i++) {
        bip(agudo ? 880 : 1046, i * passo, ehTeste ? 0.1 : 0.18, vol);
        bip(agudo ? 1318 : 1568, i * passo + meio, ehTeste ? 0.1 : 0.18, vol);
      }
    } catch (e) { console.warn("Som:", e); }
    try {
      // a vibração acompanha o som: repete o padrão para durar o mesmo tanto
      const padrao = VIBRA[tipo] || VIBRA.chamada;
      if (navigator.vibrate) navigator.vibrate(ehTeste ? padrao : repetirVibra(padrao, 3));
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

  // iPhone/iPad: a Apple só entrega notificação de site se a pessoa tiver
  // adicionado a página à Tela de Início e aberto por aquele ícone.
  function ehIOS() {
    const ua = navigator.userAgent || "";
    return /iPad|iPhone|iPod/.test(ua) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  }
  function abertoComoAtalho() {
    return window.navigator.standalone === true ||
      (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches);
  }

  async function ligarPush() {
    if (ehIOS() && !abertoComoAtalho()) return "ios-atalho";
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
    // a antessala entra aqui: sem pager, o alarme no celular é o unico aviso
    // que essa pessoa tem de que abriu vaga
    const esperandoVaga = r && r.status === STATUS.PREVIA && !r.previa_avisado_em;
    const esperandoMesa = r && (r.status === STATUS.AGUARDANDO || r.status === STATUS.CHAMADO || esperandoVaga);
    const esperandoPedido = r && r.status === STATUS.SENTADO && !r.pedido_em && CFG.avisoPedido !== false;
    card.hidden = !(esperandoMesa || esperandoPedido);
    if (card.hidden) return;
    const btn = $("#alertaBtn");
    btn.hidden = alarmeLigado;
    if (!alarmeLigado) {
      btn.textContent = esperandoPedido
        ? "🔔 Tocar quando o pedido ficar pronto"
        : esperandoVaga
        ? "🔔 Tocar quando abrir vaga na fila"
        : (jaUsouAlarme() ? "🔔 Ativar alarme" : "🔔 Tocar quando for a minha vez");
    }
    // NÃO FECHE ESTA ABA aparece em todos os casos: mesmo com a notificação
    // funcionando, é a aba que mantém o aviso ligado neste aparelho.
    const NAO_FECHE = " ⚠️ Não feche esta aba — pode bloquear a tela, mas não feche.";
    const recado = {
      ok: "🔔 Pronto! O celular avisa mesmo guardado e com a tela apagada." + NAO_FECHE,
      "ios-atalho": "🔔 Alarme ligado." + NAO_FECHE +
        " No iPhone, para ser avisado com o celular guardado: toque em Compartilhar (o quadradinho com a seta), depois em \"Adicionar à Tela de Início\", e abra a fila por esse ícone.",
      recusado: "🔔 Alarme ligado. As notificações estão bloqueadas neste navegador." + NAO_FECHE,
      "sem-suporte": "🔔 Alarme ligado. Este navegador não entrega notificação." + NAO_FECHE,
      "sem-tabela": "🔔 Alarme ligado (aviso fora da tela ainda não configurado)." + NAO_FECHE,
      erro: "🔔 Alarme ligado. Não deu para ligar o aviso fora da tela." + NAO_FECHE,
    };
    // o teste só aparece depois de ligado: serve para a pessoa conferir o
    // volume e a vibração ANTES de a mesa sair
    const bt = $("#alertaTeste");
    if (bt) bt.hidden = !alarmeLigado;
    $("#alertaNota").textContent = alarmeLigado
      ? (recado[pushEstado] || ("🔔 Alarme ligado." + NAO_FECHE))
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
      tocarAlarme(REPETE.chamada, "chamada");
      piscarTitulo("🔔 É A SUA VEZ!");
    }
    if (!primeiroDesenho && ped && !tinhaPedido) {
      tocarAlarme(REPETE.pedido, "pedido");
      piscarTitulo("🍽️ PEDIDO PRONTO!");
    }
    // fila da fila: abriu vaga. Toca com a mesma força da chamada — para
    // quem está na antessala, este é O aviso, não existe pager nem outro.
    const vaga = me ? me.previa_avisado_em : null;
    if (!primeiroDesenho && vaga && !vagaAnterior) {
      tocarAlarme(REPETE.chamada, "chamada");
      piscarTitulo("🎟️ ABRIU VAGA NA FILA!");
    }
    if (st !== STATUS.CHAMADO && !ped && !vaga && piscando) pararDePiscar();
    statusAnterior = st;
    pedidoAnterior = ped;
    vagaAnterior = vaga;
    primeiroDesenho = false;
  }

  // ---------- desenho ----------
  function render() {
    const w = waiting();
    const c = called();

    $("#brandName").textContent = CFG.marca || "Fila Fácil";
    $("#brandSub").textContent = CFG.restaurante || "";

    // tempo de espera: segue a mesma configuração do totem
    const espera = esperaTexto();
    const mostrarMedia = CFG.mostrarMedia !== false && espera != null;
    $("#statAvgWrap").hidden = !mostrarMedia;
    if (mostrarMedia) $("#statAvg").textContent = espera;

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
      } else if (me.status === STATUS.PREVIA) {
        // A antessala ainda NÃO é a fila de espera, e a página não pode
        // sugerir que é. Mas a POSIÇÃO ele pode ver: é o lugar dele na ordem
        // de chegada da antessala, o mesmo número que a recepção enxerga.
        // Previsão de tempo continua fora — ninguém sabe quando uma mesa vaga.
        const posFF = antessala().findIndex((r) => r.id === me.id) + 1;
        const naFrente = posFF > 1 ? posFF - 1 : 0;
        corpo = me.previa_avisado_em
          ? `<div class="me-big">🎟️ Abriu vaga na fila!</div>
             <div class="me-sub">Vá até a recepção para entrar na fila de espera.
               Avisamos às ${fmtClock(me.previa_avisado_em)}.</div>`
          : `<div class="me-label">Olá, ${esc(firstName(me.nome))} — sua vez na fila da fila</div>
             <div class="me-big">${posFF > 0 ? posFF + "º" : "—"}</div>
             <div class="me-sub">${me.preferencial ? "★ Atendimento preferencial • " : ""}${
               naFrente === 0
                 ? "Você é o <b>próximo</b> a entrar na fila de espera"
                 : `${naFrente} ${naFrente === 1 ? "grupo" : "grupos"} na sua frente`}</div>
             <div class="me-note">A fila de espera está cheia. Avisamos aqui assim que abrir vaga
               para você — ainda sem previsão: depende de quantas mesas vagarem.</div>`;
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
        // O número da mesa é o que mais falta aqui: em salão grande a pessoa
        // levanta, vai ao banheiro e volta sem saber para onde ir. Só aparece
        // se a atendente apontou a mesa — e se a vitrine do banco já tem a
        // coluna (ver supabase-mesa-no-link.sql).
        const mesa = String(me.mesa_numero || "").trim();
        const cartaoMesa = mesa
          ? `<div class="me-mesa">🪑 Mesa <b>${esc(mesa)}</b></div>` : "";
        corpo = `<div class="me-big">✅ Atendimento concluído</div>
          ${cartaoMesa}
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
      // Código que não está mais na fila: o serviço acabou. Esquece quem era e
      // volta para a busca — que, por sua vez, também não vai achar mais nada.
      // É isto que faz a página "fechar" no fim do dia.
      if (meuId) esquecerMeuId();
      $("#semCodigo").hidden = false;
      $("#resumoCard").hidden = true;
    }

    tick();
    $("#pubUpdated").textContent = "atualizado às " + fmtClock(new Date().toISOString());
  }

  // ---------- QR fixo do balcão: achar o cliente pelo telefone ----------
  // Quem faz a comparação é o BANCO, pela função `acompanhar_por_telefone`.
  // Ela devolve só o código do cliente — o telefone de ninguém sai de lá.
  async function buscarPeloTelefone(e) {
    e.preventDefault();
    const campo = $("#buscaTel"), msg = $("#buscaTelMsg"), btn = $("#buscaTelBtn");
    const digitos = (campo.value || "").replace(/\D/g, "");
    const erro = (t) => { msg.textContent = t; msg.className = "form-msg err"; };

    if (digitos.length < 10) return erro("Digite o telefone completo, com DDD.");
    if (!client) return erro("Sem ligação com o servidor. Tente de novo em instantes.");

    btn.disabled = true;
    msg.textContent = "Procurando…";
    msg.className = "form-msg";
    try {
      const { data, error } = await client.rpc("acompanhar_por_telefone", { tel: digitos });
      if (error) throw error;
      const achado = Array.isArray(data) ? data[0] : data;
      if (!achado || !achado.id) {
        erro("Não encontramos esse telefone na fila de agora. Confira o número ou fale com a recepção.");
        return;
      }
      meuId = achado.id;
      try { sessionStorage.setItem(SS_MEU_ID, meuId); } catch (err) { /* segue sem guardar */ }
      campo.value = "";
      msg.textContent = "";
      await atualizar();
    } catch (err) {
      console.warn("Busca pelo telefone:", err);
      erro("Não deu para procurar agora. Tente de novo em instantes.");
    } finally {
      btn.disabled = false;
    }
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

    $("#buscaTelForm").addEventListener("submit", buscarPeloTelefone);
    $("#alertaBtn").addEventListener("click", ligarAlarme);
    $("#alertaTeste").addEventListener("click", () => {
      tocarAlarme(REPETE.teste, "chamada", VOLUME.teste);
      piscarTitulo("🔔 TESTE");
      setTimeout(pararDePiscar, 4000);
    });
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
