/* ============================================================
   Fila Fácil — Quinta do Aveiro
   App principal (funciona em MODO LOCAL e MODO NUVEM/Supabase)
   ============================================================ */
(function () {
  "use strict";

  const CFG = window.FILA_CONFIG || {};
  const STATUS = { AGUARDANDO: "aguardando", CHAMADO: "chamado", SENTADO: "sentado", DESISTIU: "desistiu" };
  const MIN_P = 1, MAX_P = 20;
  const LS_KEY = "fila_espera_v1";
  const SESSION_PIN = "fila_staff_ok";

  // Colunas que podem ainda não existir no banco do cliente.
  // Se faltarem, o app continua funcionando sem elas (e avisa nas configurações).
  const COLS_OPCIONAIS = ["chamadas_perdidas", "pet", "comanda", "pager", "sentou_em", "termos_em", "entrou_em"];
  const LS_COLS = "fila_cols_ausentes";
  const LS_PIN = "fila_pin_atendente";

  // A tela ao vivo precisa da fila + um pouco de histórico (média e alternância).
  // Baixar a tabela INTEIRA é perigoso: o Supabase corta a resposta no "Max rows"
  // e o corte cai justamente em quem está esperando — a fila sumiria da tela.
  const JANELA_HIST_MS = 24 * 3600 * 1000;
  const PAGINA = 1000;

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
  let relCache = [];        // linhas mostradas no relatório (para exportar/limpar)

  let colsAusentes = new Set();
  try { colsAusentes = new Set(JSON.parse(localStorage.getItem(LS_COLS)) || []); } catch (e) { colsAusentes = new Set(); }

  function marcarColunaAusente(col) {
    colsAusentes.add(col);
    try { localStorage.setItem(LS_COLS, JSON.stringify(Array.from(colsAusentes))); } catch (e) { /* ignora */ }
    console.warn(`Coluna '${col}' não existe no banco — rode o SQL do README para ativar esse recurso.`);
  }
  // Remove do objeto as colunas que sabemos que não existem no banco
  function semColunasAusentes(obj) {
    const o = Object.assign({}, obj);
    colsAusentes.forEach((c) => { delete o[c]; });
    return o;
  }
  // O banco respondeu e a TABELA inteira não existe? (checar antes da coluna)
  function tabelaNaoExiste(e) {
    if (!e) return false;
    const msg = String(e.message || "");
    return e.code === "PGRST205" || e.code === "42P01" ||
      /find the table|relation .* does not exist/i.test(msg);
  }
  // O banco respondeu e faltou uma COLUNA?
  function colunaNaoExiste(e) {
    if (!e || tabelaNaoExiste(e)) return false;
    const msg = String(e.message || "");
    return e.code === "42703" || e.code === "PGRST204" ||
      /column .* does not exist|schema cache/i.test(msg);
  }

  // Confere no banco quais colunas novas já existem (o cliente pode ter rodado
  // o SQL depois; sem isso o app ficaria "lembrando" de uma falta já resolvida).
  // Internet caída, projeto pausado ou erro de permissão NÃO podem virar "coluna
  // ausente" — se isso acontecesse, o app pararia de gravar pet/comanda/pager em silêncio.
  async function verificarColunas() {
    if (!backend || backend.mode !== "online" || !backend.client) return;
    const client = backend.client;
    const primeira = await client.from("fila_espera").select(COLS_OPCIONAIS.join(",")).limit(1);
    if (!primeira.error) {
      colsAusentes.clear();
      try { localStorage.removeItem(LS_COLS); } catch (e) { /* ignora */ }
      return;
    }
    if (tabelaNaoExiste(primeira.error)) return;          // falta a tabela, não as colunas
    if (!colunaNaoExiste(primeira.error)) {               // não deu para saber: não conclui nada
      console.warn("Verificação de colunas adiada (o banco não respondeu):", primeira.error);
      return;
    }
    // alguma falta mesmo: testa uma a uma para saber exatamente quais
    const faltando = [];
    for (const col of COLS_OPCIONAIS) {
      const r = await client.from("fila_espera").select(col).limit(1);
      if (!r.error) continue;
      if (!colunaNaoExiste(r.error)) {
        console.warn("Verificação de colunas adiada (o banco não respondeu):", r.error);
        return;
      }
      faltando.push(col);
    }
    colsAusentes = new Set(faltando);
    try { localStorage.setItem(LS_COLS, JSON.stringify(faltando)); } catch (e) { /* ignora */ }
    if (faltando.length) console.warn("Colunas ausentes no banco:", faltando.join(", "), "— rode o SQL do README.");
  }

  // Descobre, pela mensagem de erro do Supabase, qual coluna está faltando
  function colunaDoErro(err) {
    const msg = [err && err.message, err && err.details, err && err.hint].filter(Boolean).join(" ");
    const m = msg.match(/'([a-zA-Z_]+)' column/) ||
              msg.match(/column "([a-zA-Z_]+)"/) ||
              msg.match(/column ([a-zA-Z_]+) of relation/);
    return m ? m[1] : null;
  }

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
        // limpa registros antigos já finalizados (> 30 dias) para não crescer sem fim
        const lim = Date.now() - 30 * 24 * 3600 * 1000;
        const data = read().filter((r) =>
          (r.status === STATUS.AGUARDANDO || r.status === STATUS.CHAMADO) ||
          new Date(r.criado_em).getTime() > lim
        );
        write(data);
      },
      // mesmo recorte do modo nuvem (fila + histórico recente)
      async list() {
        const desde = Date.now() - JANELA_HIST_MS;
        return read().filter((r) =>
          r.status === STATUS.AGUARDANDO || r.status === STATUS.CHAMADO ||
          new Date(r.criado_em).getTime() >= desde);
      },
      // o relatório enxerga tudo o que está guardado
      async listRelatorio(desdeMs) {
        return read().filter((r) => new Date(r.criado_em).getTime() >= (desdeMs || 0));
      },
      async getOne(id) { return read().find((r) => r.id === id) || null; },
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
      // só grava se a pessoa ainda estiver no status esperado (evita desfazer o que
      // outro aparelho acabou de fazer)
      async updateSeStatus(id, statusEsperado, patch) {
        const data = read();
        const i = data.findIndex((r) => r.id === id);
        if (i < 0 || data[i].status !== statusEsperado) return false;
        data[i] = Object.assign({}, data[i], patch);
        write(data);
        return true;
      },
      async remove(id) {
        write(read().filter((r) => r.id !== id));
      },
      async removeMany(ids) {
        const set = new Set(ids);
        write(read().filter((r) => !set.has(r.id)));
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

    // Tenta gravar; se o banco reclamar de uma coluna nova que ainda não existe,
    // remove essa coluna e tenta de novo (assim o app funciona antes do SQL rodar).
    async function comFallback(fn, payload) {
      let corpo = semColunasAusentes(payload);
      for (let tentativa = 0; tentativa <= COLS_OPCIONAIS.length; tentativa++) {
        const res = await fn(corpo);
        if (!res.error) return res;
        const col = colunaDoErro(res.error);
        if (col && COLS_OPCIONAIS.indexOf(col) >= 0 && Object.prototype.hasOwnProperty.call(corpo, col)) {
          marcarColunaAusente(col);
          corpo = Object.assign({}, corpo);
          delete corpo[col];
          continue;
        }
        throw res.error;
      }
      throw new Error("Não foi possível gravar no banco.");
    }

    return {
      mode: "online",
      client,
      async init() {},
      // Duas consultas curtas em vez de baixar a tabela toda: quem está na fila
      // (sempre) + o histórico recente (para a média e a alternância).
      async list() {
        const ativos = await client.from(T).select("*")
          .in("status", [STATUS.AGUARDANDO, STATUS.CHAMADO])
          .order("criado_em", { ascending: true }).limit(PAGINA);
        if (ativos.error) throw ativos.error;
        const desde = new Date(Date.now() - JANELA_HIST_MS).toISOString();
        const hist = await client.from(T).select("*")
          .gte("criado_em", desde)
          .order("criado_em", { ascending: false }).limit(PAGINA); // do mais novo para o mais velho
        if (hist.error) throw hist.error;
        const mapa = new Map();
        (ativos.data || []).concat(hist.data || []).forEach((r) => mapa.set(r.id, r));
        return Array.from(mapa.values()).sort(byCreatedAsc);
      },
      // Relatório: consulta própria, em páginas (pode ser um histórico grande)
      async listRelatorio(desdeMs) {
        const desde = new Date(desdeMs || 0).toISOString();
        const out = [];
        let de = 0;
        for (;;) {
          const { data, error } = await client.from(T).select("*")
            .gte("criado_em", desde).order("criado_em", { ascending: false })
            .range(de, de + PAGINA - 1);
          if (error) throw error;
          const lote = data || [];
          out.push(...lote);
          if (lote.length < PAGINA || out.length >= 20000) break;
          de += lote.length;
        }
        return out;
      },
      async getOne(id) {
        const { data, error } = await client.from(T).select("*").eq("id", id).limit(1);
        if (error) throw error;
        return (data && data[0]) || null;
      },
      async add(entry) {
        const res = await comFallback((corpo) => client.from(T).insert(corpo).select().single(), entry);
        return res.data;
      },
      async update(id, patch) {
        await comFallback((corpo) => client.from(T).update(corpo).eq("id", id), patch);
      },
      async updateSeStatus(id, statusEsperado, patch) {
        await comFallback((corpo) => client.from(T).update(corpo).eq("id", id).eq("status", statusEsperado), patch);
        return true;
      },
      async remove(id) {
        const { error } = await client.from(T).delete().eq("id", id);
        if (error) throw error;
      },
      async removeMany(ids) {
        // apaga em lotes para não estourar o tamanho da URL
        for (let i = 0; i < ids.length; i += 100) {
          const { error } = await client.from(T).delete().in("id", ids.slice(i, i + 100));
          if (error) throw error;
        }
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

  // Hora REAL em que a pessoa chegou. Quem perde a vez tem o `criado_em` reescrito
  // (é ele que define a POSIÇÃO na fila), então o horário original fica em `entrou_em`.
  const entradaEm = (r) => r.entrou_em || r.criado_em;

  function waiting() {
    return rows.filter((r) => r.status === STATUS.AGUARDANDO).sort(byCreatedAsc);
  }
  function called() {
    return rows.filter((r) => r.status === STATUS.CHAMADO)
      .sort((a, b) => new Date(b.chamado_em) - new Date(a.chamado_em));
  }

  // "Mesona" = grupo grande, mostrado numa lista à parte (a ordem de chamada não muda)
  function isMesona(r) {
    return CFG.mesonaAtiva === true && Number(r.pessoas) >= (Number(CFG.mesonaMin) || 8);
  }

  // Momento do último "reset" da média (guardado neste aparelho)
  function getMediaReset() {
    return localStorage.getItem("fila_media_reset") || "1970-01-01T00:00:00.000Z";
  }
  // Tempo médio de espera (entrada → chamada) de todos os chamados desde o último reset
  function avgWaitMs() {
    const rp = new Date(getMediaReset()).getTime();
    const done = rows.filter((r) => r.chamado_em && new Date(r.chamado_em).getTime() >= rp);
    if (!done.length) return null;
    const sum = done.reduce((a, r) => a + Math.max(0, new Date(r.chamado_em) - new Date(entradaEm(r))), 0);
    return sum / done.length;
  }
  // Zera a média (a fila e as pessoas não são afetadas)
  function resetMedia() {
    localStorage.setItem("fila_media_reset", new Date().toISOString());
    render();
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
  // (excludeId: ignora essa pessoa — usado ao "voltar à fila e chamar o próximo")
  function pickNext(x, excludeId) {
    const regra = CFG.regraTamanho || "exato";
    const wait = waiting().filter((r) => (excludeId ? r.id !== excludeId : true));
    function pickFrom(pool) {
      if (!pool.length) return null;
      const prefPool = pool.filter((r) => r.preferencial);
      const normPool = pool.filter((r) => !r.preferencial);
      return wantPreferential() ? (prefPool[0] || normPool[0]) : (normPool[0] || prefPool[0]);
    }
    // sempre tenta o tamanho EXATO primeiro
    const exato = pickFrom(wait.filter((r) => Number(r.pessoas) === x));
    if (regra === "exato" || exato) return exato;
    // modo "ate": não há exato -> pega um grupo MENOR que caiba
    return pickFrom(wait.filter((r) => Number(r.pessoas) < x));
  }

  async function addPerson({ nome, telefone, pessoas, preferencial, pet, aceitouTermos }) {
    const agora = new Date().toISOString();
    const entry = {
      id: uuid(),
      nome: nome.trim(),
      telefone: (telefone || "").trim(),
      pessoas: Number(pessoas),
      preferencial: !!preferencial,
      pet: !!pet,
      comanda: null,
      pager: null,
      status: STATUS.AGUARDANDO,
      criado_em: agora,
      entrou_em: agora,
      chamado_em: null,
      sentou_em: null,
      termos_em: aceitouTermos ? agora : null,
    };
    const salvo = await backend.add(entry);
    await refresh();
    return salvo || entry;
  }

  async function callPerson(id, extras) {
    await backend.update(id, Object.assign({
      status: STATUS.CHAMADO,
      chamado_em: new Date().toISOString(),
    }, extras || {}));
    await refresh();
  }
  async function seatPerson(id) {
    await backend.update(id, { status: STATUS.SENTADO, sentou_em: new Date().toISOString() });
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

  // Manda a pessoa para o FIM da fila (não compareceu no prazo — perdeu a vez).
  // Confere no BANCO se ela ainda está "chamado": entre o que está na tela e a
  // gravação, a atendente pode ter marcado "sentou" em outro aparelho.
  async function toEndOfQueue(id) {
    let atual = null;
    try { atual = await backend.getOne(id); }
    catch (e) { atual = rows.find((r) => r.id === id) || null; }
    if (!atual || atual.status !== STATUS.CHAMADO) { await refresh(); return false; }
    await backend.updateSeStatus(id, STATUS.CHAMADO, {
      status: STATUS.AGUARDANDO,
      chamado_em: null,
      criado_em: new Date().toISOString(),          // volta para o fim da fila
      entrou_em: entradaEm(atual),                  // ...sem perder a hora real de chegada
      chamadas_perdidas: (atual.chamadas_perdidas || 0) + 1,
    });
    await refresh();
    return true;
  }

  // Verifica e move automaticamente quem passou do prazo (se ativado no config)
  let _autoMovendo = new Set();
  async function checkExpired() {
    if (CFG.autoFimDaFila === false) return;
    const prazoMs = (CFG.prazoComparecer || 10) * 60000;
    const now = Date.now();
    const vencidos = rows.filter((r) =>
      r.status === STATUS.CHAMADO && r.chamado_em &&
      now - new Date(r.chamado_em).getTime() >= prazoMs &&
      !_autoMovendo.has(r.id)
    );
    for (const r of vencidos) {
      _autoMovendo.add(r.id);
      try {
        const moveu = await toEndOfQueue(r.id);
        // só avisa se realmente moveu (a pessoa pode já ter sentado em outro aparelho)
        if (moveu) avisoStaff(`${firstName(r.nome)} não compareceu no prazo — foi para o fim da fila.`);
      } catch (e) { console.warn(e); }
      finally { _autoMovendo.delete(r.id); }
    }
  }

  // ---- Fechamento automático da fila quando encher ----------
  // Fecha sozinha ao passar do limite; para reabrir é SEMPRE manual.
  let _autoFechando = false;
  async function checkAutoClose() {
    if (CFG.autoFecharAtiva !== true || _autoFechando) return;
    const lim = Number(CFG.autoFecharQtd) || 0;
    if (lim < 1) return;
    // o limite é em PESSOAS aguardando (soma o tamanho dos grupos), como diz a engrenagem
    const grupos = waiting();
    const n = grupos.reduce((a, r) => a + Number(r.pessoas || 0), 0);
    const armado = CFG.autoFecharArmado !== false;   // já pode fechar de novo?
    try {
      if (n >= lim && CFG.filaFechada !== true && armado) {
        _autoFechando = true;
        await saveSettings({ filaFechada: true, autoFecharArmado: false });
        avisoStaff(`🔒 A fila fechou sozinha: ${n} pessoas em ${grupos.length} ${grupos.length === 1 ? "grupo" : "grupos"} (limite ${lim} pessoas). Reabra pelo botão do cabeçalho.`);
      } else if (n < lim && !armado) {
        // a fila esvaziou: rearma o fechamento automático para a próxima vez
        _autoFechando = true;
        await saveSettings({ autoFecharArmado: true });
      }
    } catch (e) { console.warn("Fechamento automático:", e); }
    finally { _autoFechando = false; }
  }

  // Abre o pop-up de confirmação de chamada para uma pessoa escolhida
  function openCallConfirm(chosen) {
    pendingCall = chosen;
    $("#callModalBody").innerHTML = `
      <div class="cc-name">${esc(chosen.nome)} ${chosen.preferencial ? "★" : ""}</div>
      <div class="cc-meta">${chosen.pessoas} ${chosen.pessoas === 1 ? "pessoa" : "pessoas"}${chosen.preferencial ? " • Preferencial" : ""}${isMesona(chosen) ? " • 🍽 mesa grande" : ""} • entrou ${fmtClock(chosen.criado_em)} • esperando há ${fmtElapsed(Date.now() - new Date(chosen.criado_em).getTime())}</div>`;
    // campos extras da atendente (pet / comanda / pager)
    $("#callPet").checked = !!chosen.pet;
    $("#callComanda").value = chosen.comanda || "";
    $("#callPager").value = chosen.pager || "";
    $("#callComandaField").hidden = CFG.campoComanda === false;
    $("#callPagerField").hidden = CFG.campoPager === false;
    $("#callModal").hidden = false;
  }

  // O selo de conexão saiu da interface: os erros aparecem na faixa da atendente.
  function avisoStaff(txt, ok) {
    const smsg = $("#staffMsg");
    if (!smsg) return;
    smsg.textContent = txt;
    smsg.className = "form-msg " + (ok ? "ok" : "err");
  }

  async function refresh() {
    try {
      rows = await backend.list();
      render();
      checkAutoClose();
    } catch (e) {
      console.error("Erro ao carregar a fila:", e);
      avisoStaff("⚠ Sem ligação com o servidor — o que está na tela pode estar desatualizado.");
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
  // Hora "de relógio" (ex.: 19:05) a partir de um ISO
  function fmtClock(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return "--:--";
    return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  }
  function firstName(n) { return (n || "").split(/\s+/)[0] || n || "Cliente"; }
  // Número no formato do WhatsApp (só dígitos, com DDI)
  function waNumber(tel) {
    let d = String(tel || "").replace(/\D/g, "");
    if (!d) return "";
    const ddi = String(CFG.paisDDI || "55");
    // Não dá para decidir pelo começo do número: o DDD 55 (Rio Grande do Sul)
    // é igual ao DDI 55 do Brasil. Decide pelo TAMANHO:
    // 10 dígitos (fixo) ou 11 (celular) = ainda falta o DDI.
    if (d.length === 10 || d.length === 11) d = ddi + d;
    return d;
  }
  // Link "click to chat" do WhatsApp com a mensagem já preenchida
  function waLink(r) {
    const num = waNumber(r.telefone);
    if (!num) return "";
    const msg = (CFG.msgWhats || "Olá {nome}! Sua mesa está pronta. Pode comparecer, por favor.")
      .replace(/\{nome\}/g, firstName(r.nome))
      .replace(/\{restaurante\}/g, CFG.restaurante || "")
      .replace(/\{prazo\}/g, String(CFG.prazoComparecer || 10));
    return "https://wa.me/" + num + "?text=" + encodeURIComponent(msg);
  }
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // Endereço da página pública de acompanhamento (só leitura)
  function publicUrl(id) {
    try {
      const u = new URL("fila.html", location.href);
      if (id) u.searchParams.set("id", id);
      return u.href;
    } catch (e) {
      return location.href.replace(/[^/]*$/, "fila.html") + (id ? "?id=" + id : "");
    }
  }
  // Desenha um QR Code dentro de um elemento
  function drawQR(el, texto) {
    if (!el) return false;
    try {
      // margem 4 = "zona de silêncio" do padrão QR (leitura mais segura pela câmera)
      el.innerHTML = window.QRCode.svg(texto, { margin: 4 });
      return true;
    } catch (e) {
      console.warn("QR Code:", e);
      el.innerHTML = `<p class="qr-fail">${esc(texto)}</p>`;
      return false;
    }
  }

  // Selos do painel "Chamando". O 🐾 pet pode aparecer no totem (é informação do
  // próprio cliente), mas comanda e pager são internos — só na tela da atendente.
  function callChipsHTML(r, staff) {
    const partes = [];
    if (r.pet) partes.push("🐾 pet");
    if (staff && r.comanda) partes.push("🧾 " + esc(r.comanda));
    if (staff && r.pager) partes.push("🔔 " + esc(r.pager));
    return partes.length ? `<span class="ci-chips">${partes.join(" ")}</span>` : "";
  }

  // Selos de pet / comanda / pager
  function chipsHTML(r, staff) {
    let h = "";
    if (r.pet) h += `<span class="q-chip chip-pet">🐾 pet</span>`;
    if (staff && r.comanda) h += `<span class="q-chip">🧾 ${esc(r.comanda)}</span>`;
    if (staff && r.pager) h += `<span class="q-chip">🔔 ${esc(r.pager)}</span>`;
    return h;
  }

  // HTML de um item da fila (usado nas três listas: mesona, preferencial e normal)
  function queueItemHTML(r, i, staff) {
    const tel = staff && r.telefone ? `<span>📞 ${esc(r.telefone)}</span>` : "";
    const meso = isMesona(r);
    const actions = staff ? `
      <div class="q-actions staff-only">
        <button class="btn btn-sm btn-accent" data-call="${r.id}">Chamar</button>
        <button class="btn btn-sm btn-primary" data-seat="${r.id}">Sentou</button>
        <button class="btn btn-sm btn-danger" data-drop="${r.id}">Saiu</button>
      </div>` : "";
    return `
      <li class="q-item ${r.preferencial ? "is-pref" : ""} ${meso ? "is-meso" : ""} ${staff && r.chamadas_perdidas ? "is-perdeu" : ""}"
          ${meso && staff ? `data-meso-since="${r.criado_em}"` : ""}>
        <div class="q-pos">${i + 1}</div>
        <div class="q-main">
          <div class="q-name">${esc(staff ? r.nome : firstName(r.nome))}${r.preferencial && meso ? `<span class="q-tag pref">★ preferencial</span>` : ""}${staff && r.chamadas_perdidas ? `<span class="q-tag perdeu">⚠️ perdeu a vez${r.chamadas_perdidas > 1 ? " (" + r.chamadas_perdidas + "×)" : ""}</span>` : ""}</div>
          <div class="q-sub">
            <span>👥 ${r.pessoas} ${r.pessoas === 1 ? "pessoa" : "pessoas"}</span>
            <span>🕐 entrou ${fmtClock(r.criado_em)}</span>
            <span>⏱ esperando <b class="q-time" data-since="${r.criado_em}">agora</b></span>
            ${tel}
            ${chipsHTML(r, staff)}
          </div>
        </div>
        ${actions}
      </li>`;
  }

  // Botão de adicionar: rótulo por aba e bloqueio quando a fila está fechada (totem)
  function updateAddBtn() {
    const btn = $("#openFormBtn");
    if (!btn) return;
    if (!isStaff() && CFG.filaFechada === true) {
      btn.disabled = true;
      btn.textContent = "🔒 Fila fechada";
    } else {
      btn.disabled = false;
      btn.textContent = "➕ " + (isStaff() ? "Adicionar cliente" : "Entrar na fila");
    }
  }

  function render() {
    const w = waiting();
    const c = called();
    const staff = isStaff();

    // -------- listas: mesas grandes, preferencial e normal --------
    const meso = w.filter(isMesona);
    const pref = w.filter((r) => r.preferencial && !isMesona(r));
    const norm = w.filter((r) => !r.preferencial && !isMesona(r));
    $("#statTotal").textContent = w.length;
    $("#statPref").textContent = pref.length;
    $("#statNorm").textContent = norm.length;
    $("#statMeso").textContent = meso.length;

    // tempo médio: sempre na aba da atendente; no totem, conforme a configuração
    const avg = avgWaitMs();
    $("#statAvg").textContent = avg == null ? "—" : "~" + fmtElapsed(avg);
    $("#statAvgWrap").hidden = !staff && CFG.mostrarMedia === false;

    // -------- painel "chamando" (mostra TODAS as mesas chamadas) --------
    const callList = $("#callList");
    const callEmpty = $("#callEmpty");
    callEmpty.hidden = c.length > 0;
    callList.innerHTML = c.map((r, i) => `
      <div class="call-item ${r.preferencial ? "pref" : ""} ${i === 0 ? "fresh" : ""}">
        ${staff ? `<button class="ci-x staff-only" data-discard="${r.id}" aria-label="Remover">✕</button>` : ""}
        <span class="ci-label">${r.preferencial ? "★ Preferencial" : "Chamando"}</span>
        <span class="ci-name">${esc(firstName(r.nome))}</span>
        <span class="ci-meta">${r.pessoas} ${r.pessoas === 1 ? "pessoa" : "pessoas"} • chamado às ${fmtClock(r.chamado_em)} (há <b data-since="${r.chamado_em}">agora</b>)</span>
        ${callChipsHTML(r, staff)}
        ${staff ? `<div class="ci-actions staff-only">
          ${(CFG.whatsAtivo !== false && r.telefone) ? `<a class="btn btn-sm ci-wa" href="${waLink(r)}" target="_blank" rel="noopener">📲 WhatsApp</a>` : ""}
          <button class="btn btn-sm ci-ok" data-seat="${r.id}">✓ Sentou</button>
          <button class="btn btn-sm ci-back" data-back="${r.id}">↩ Voltar à fila</button>
          <button class="btn btn-sm ci-end" data-toend="${r.id}">⬇ Fim da fila</button>
        </div>` : ""}
      </div>`).join("");

    // -------- listas separadas (cada uma na ordem de chegada) --------
    $("#queueListMeso").innerHTML = meso.map((r, i) => queueItemHTML(r, i, staff)).join("");
    $("#queueListPref").innerHTML = pref.map((r, i) => queueItemHTML(r, i, staff)).join("");
    $("#queueListNorm").innerHTML = norm.map((r, i) => queueItemHTML(r, i, staff)).join("");
    $("#emptyMeso").hidden = meso.length > 0;
    $("#emptyPref").hidden = pref.length > 0;
    $("#emptyNorm").hidden = norm.length > 0;
    $("#groupMesona").hidden = CFG.mesonaAtiva !== true;
    $("#mesoTitle").textContent = `🍽 Mesas grandes (${Number(CFG.mesonaMin) || 8}+ pessoas)`;

    // boas-vindas (totem) e estado do botão de adicionar (fila fechada)
    const wb = $("#welcomeBanner");
    if (wb) { const txt = (CFG.boasVindas || "").trim(); wb.textContent = txt; wb.hidden = !txt; }
    const cb = $("#closedBanner");
    if (cb) {
      const fechada = CFG.filaFechada === true;
      cb.hidden = !fechada;
      cb.textContent = staff
        ? "🔒 A fila está FECHADA para o totem. A atendente ainda pode adicionar clientes."
        : "🔒 No momento não estamos aceitando novos nomes na fila. Fale com a recepção.";
    }
    updateAddBtn();
    const fb = $("#toggleFilaBtn");
    if (fb) {
      const fechada = CFG.filaFechada === true;
      fb.textContent = fechada ? "🔓 Abrir fila" : "🔒 Fechar fila";
      fb.classList.toggle("is-closed", fechada);
      fb.hidden = CFG.mostrarBtnFila === false;
    }

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
    // escala de cor verde → vermelho (0 até o prazo) + destaque de prazo esgotado
    const prazoMs = (CFG.prazoComparecer || 10) * 60000;
    $$(".call-item").forEach((card) => {
      const b = card.querySelector("[data-since]");
      if (!b) return;
      const d = new Date(b.getAttribute("data-since")).getTime();
      if (isNaN(d)) return;
      const frac = Math.max(0, Math.min(1, (now - d) / prazoMs)); // 0 = recém, 1 = prazo
      const hue = 120 * (1 - frac); // 120 = verde → 0 = vermelho
      card.style.background = `hsl(${Math.round(hue)}, 75%, 44%)`;
      card.classList.toggle("expirado", frac >= 1);
    });
    // mesas grandes: mesma escala de cor, só na tela da atendente
    const mesoMs = (Number(CFG.mesonaPrazo) || 20) * 60000;
    $$("[data-meso-since]").forEach((item) => {
      const d = new Date(item.getAttribute("data-meso-since")).getTime();
      if (isNaN(d)) return;
      const frac = Math.max(0, Math.min(1, (now - d) / mesoMs));
      const hue = Math.round(120 * (1 - frac));
      item.style.background = `hsl(${hue}, 80%, 94%)`;
      item.style.borderColor = `hsl(${hue}, 60%, 48%)`;
      const pos = item.querySelector(".q-pos");
      if (pos) pos.style.background = `hsl(${hue}, 62%, 40%)`;
      item.classList.toggle("meso-urgente", frac >= 1);
    });
  }

  // Beep quando surge uma chamada nova
  function maybeBeep(c) {
    const ids = new Set(c.map((r) => r.id));
    let novo = false;
    ids.forEach((id) => { if (!lastCalledIds.has(id)) novo = true; });
    lastCalledIds = ids;
    if (novo && CFG.somAtivo !== false) beep();
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
    const rotulo = v === "staff" ? "Adicionar cliente" : "Entrar na fila";
    $("#formTitle").textContent = rotulo;
    $("#joinBtn").textContent = rotulo;
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
  //  TERMOS DE USO (regras da fila)
  // ==========================================================
  function termosTexto() {
    const t = (CFG.termosTexto || "").trim() || (window.TERMOS_PADRAO || "");
    return t
      .replace(/\{restaurante\}/g, CFG.restaurante || "o estabelecimento")
      .replace(/\{prazo\}/g, String(CFG.prazoComparecer || 5));
  }
  function openTermos() {
    $("#termosTxt").innerHTML = termosTexto()
      .split(/\n{2,}/)
      .map((p) => `<p>${esc(p.trim()).replace(/\n/g, "<br>")}</p>`)
      .join("");
    $("#termosModal").hidden = false;
  }

  // ==========================================================
  //  FORMULÁRIO DE ENTRADA
  // ==========================================================
  // Ajusta o formulário conforme as configurações (telefone, pet, termos)
  function prepararFormulario() {
    const staff = isStaff();
    const telObrig = CFG.telObrigatorio !== false;
    $("#fTelLabel").innerHTML = telObrig ? 'Telefone <b class="req">*</b>' : "Telefone <small>(opcional)</small>";
    $("#fTel").required = telObrig;
    $("#fTelHint").textContent = telObrig
      ? "Obrigatório: usamos para avisar quando a sua mesa estiver pronta."
      : "Se informar, avisamos no WhatsApp quando a mesa estiver pronta.";
    $("#petRow").hidden = CFG.petAtivo === false;
    // as regras são aceitas pelo cliente no totem; a atendente confirma no balcão
    $("#termosRow").hidden = staff || CFG.exigirTermos === false;
    // aviso de mesa grande
    const hint = $("#fMesoHint");
    if (CFG.mesonaAtiva === true && pessoas >= (Number(CFG.mesonaMin) || 8)) {
      hint.hidden = false;
      hint.innerHTML = "🍽 <b>Mesa grande</b>: grupos deste tamanho podem ter uma espera maior.";
    } else {
      hint.hidden = true;
    }
  }

  function abrirFormulario() {
    $("#joinForm").reset();
    pessoas = 2; $("#fPessoas").textContent = pessoas;
    $('input[name="tipo"][value="normal"]').checked = true;
    $("#fPet").checked = false;
    $("#fTermos").checked = false;
    $("#formMsg").textContent = "";
    prepararFormulario();
    $("#formModal").hidden = false;
    setTimeout(() => $("#fNome").focus(), 60);
  }

  // Pop-up mostrado depois de entrar na fila: posição + QR + link
  function mostrarEntrou(pessoa) {
    const pos = waiting().findIndex((r) => r.id === pessoa.id) + 1;
    const total = waiting().length;
    $("#joinedTitle").textContent = isStaff() ? `✅ ${firstName(pessoa.nome)} entrou na fila!` : "✅ Você está na fila!";
    $("#joinedPos").textContent = pos > 0 ? pos + "º" : "—";
    const avg = avgWaitMs();
    $("#joinedSub").textContent = `${total} ${total === 1 ? "grupo" : "grupos"} aguardando` +
      (avg != null && CFG.mostrarMedia !== false ? ` • espera média ~${fmtElapsed(avg)}` : "");

    const link = publicUrl(pessoa.id);
    drawQR($("#joinedQr"), link);
    $("#joinedMsg").textContent = "";
    $("#joinedCopy").dataset.link = link;

    // botão de mandar o link no WhatsApp (precisa do telefone)
    const wa = $("#joinedWa");
    const num = waNumber(pessoa.telefone);
    if (CFG.linkAtivo !== false && CFG.whatsAtivo !== false && num) {
      const msg = (CFG.msgLink || "Olá {nome}! Você entrou na fila da {restaurante}. Acompanhe aqui: {link}")
        .replace(/\{nome\}/g, firstName(pessoa.nome))
        .replace(/\{restaurante\}/g, CFG.restaurante || "")
        .replace(/\{posicao\}/g, pos > 0 ? pos + "º" : "—")
        .replace(/\{link\}/g, link);
      wa.href = "https://wa.me/" + num + "?text=" + encodeURIComponent(msg);
      wa.hidden = false;
    } else {
      wa.hidden = true;
    }
    $("#joinedModal").hidden = false;
  }

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
        const max = Number(CFG.maxPessoas) || MAX_P;
        pessoas = Math.min(max, Math.max(MIN_P, pessoas + Number(b.dataset.step)));
        $("#fPessoas").textContent = pessoas;
        prepararFormulario();
      })
    );
    // stepper mesa (atendente)
    $$(".step-btn[data-freestep]").forEach((b) =>
      b.addEventListener("click", () => {
        const max = Number(CFG.maxPessoas) || MAX_P;
        mesa = Math.min(max, Math.max(MIN_P, mesa + Number(b.dataset.freestep)));
        $("#fMesa").textContent = mesa;
      })
    );

    // abrir o formulário em pop-up
    $("#openFormBtn").addEventListener("click", abrirFormulario);

    // regras da fila (termos)
    $("#verTermosBtn").addEventListener("click", openTermos);
    $("#termosAceitar").addEventListener("click", () => {
      $("#fTermos").checked = true;
      $("#termosModal").hidden = true;
    });

    // formulário: entrar na fila
    $("#joinForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const nome = $("#fNome").value.trim();
      const tel = $("#fTel").value.trim();
      const tipo = ($('input[name="tipo"]:checked') || {}).value || "normal";
      const pet = $("#fPet").checked && CFG.petAtivo !== false;
      const precisaTermos = !isStaff() && CFG.exigirTermos !== false;
      const msg = $("#formMsg");
      const erro = (t) => { msg.textContent = t; msg.className = "form-msg err"; };

      if (!nome) return erro("Digite o nome.");
      if (CFG.telObrigatorio !== false) {
        const dig = tel.replace(/\D/g, "");
        if (!dig) return erro("Digite o telefone (com DDD).");
        if (dig.length < 10) return erro("Telefone incompleto — digite o DDD + número.");
      }
      if (precisaTermos && !$("#fTermos").checked) return erro("É preciso aceitar as regras da fila para entrar.");
      if (!isStaff() && CFG.filaFechada === true) return erro("A fila está fechada no momento.");

      $("#joinBtn").disabled = true;
      try {
        const pessoa = await addPerson({
          nome, telefone: tel, pessoas,
          preferencial: tipo === "preferencial",
          pet,
          aceitouTermos: precisaTermos,
        });
        msg.textContent = "";
        $("#formModal").hidden = true;
        mostrarEntrou(pessoa);
      } catch (err) {
        console.error(err);
        erro("Erro ao entrar na fila. Tente de novo.");
      } finally {
        $("#joinBtn").disabled = false;
      }
    });

    // copiar o link de acompanhamento
    $("#joinedCopy").addEventListener("click", () => copiarLink($("#joinedCopy").dataset.link, $("#joinedMsg")));
    $("#publicCopy").addEventListener("click", () => copiarLink(publicUrl(), null));

    // atendente: liberar mesa -> escolher próximo
    $("#freeTableBtn").addEventListener("click", () => {
      const smsg = $("#staffMsg");
      const chosen = pickNext(mesa);
      if (!chosen) {
        const alvo = mesa === 1 ? "pessoa" : "pessoas";
        smsg.textContent = (CFG.regraTamanho === "ate")
          ? `Nenhum grupo de até ${mesa} ${alvo} na fila.`
          : `Nenhum grupo de exatamente ${mesa} ${alvo} na fila.`;
        smsg.className = "form-msg err";
        pendingCall = null;
        return;
      }
      smsg.textContent = "";
      openCallConfirm(chosen);
    });
    $("#callCancel").addEventListener("click", () => { $("#callModal").hidden = true; pendingCall = null; });
    $("#callConfirm").addEventListener("click", async () => {
      const p = pendingCall;
      if (!p) { $("#callModal").hidden = true; return; }
      const btn = $("#callConfirm");
      if (btn.disabled) return;                 // já está gravando: ignora clique repetido
      const cmsg = $("#callMsg");
      btn.disabled = true;
      if (cmsg) { cmsg.textContent = "Salvando…"; cmsg.className = "form-msg"; }
      try {
        // GRAVA PRIMEIRO: nunca avisar o cliente de uma mesa que não foi registrada
        await callPerson(p.id, {
          pet: $("#callPet").checked,
          comanda: $("#callComanda").value.trim() || null,
          pager: $("#callPager").value.trim() || null,
        });
      } catch (e) {
        console.error("Erro ao gravar a chamada:", e);
        // NÃO fecha o pop-up: a atendente vê o erro e tenta de novo sem redigitar nada
        if (cmsg) {
          cmsg.textContent = "Não deu para salvar — verifique a internet. O cliente NÃO foi avisado.";
          cmsg.className = "form-msg err";
        }
        btn.disabled = false;
        return;
      }
      btn.disabled = false;
      if (cmsg) cmsg.textContent = "";
      $("#callModal").hidden = true;
      pendingCall = null;
      // só depois de gravado, abre o WhatsApp já com a mensagem pronta
      if (CFG.whatsAtivo !== false && CFG.whatsAuto && p.telefone) {
        const link = waLink(p);
        if (link) {
          const aba = window.open(link, "_blank");
          if (!aba) avisoStaff("Chamada registrada. O navegador bloqueou o WhatsApp — toque em 📲 WhatsApp no cartão.");
        }
      }
    });

    // ações na lista/painel (delegação)
    document.addEventListener("click", async (e) => {
      const t = e.target.closest("[data-call],[data-seat],[data-drop],[data-back],[data-discard],[data-toend]");
      if (!t) return;

      // abrir o pop-up de chamada não grava nada: sai antes
      if (t.dataset.call) {
        const p = rows.find((r) => r.id === t.dataset.call);
        if (p) openCallConfirm(p);
        return;
      }

      if (t.disabled) return;
      t.disabled = true;   // evita toque duplo enquanto grava
      try {
        if (t.dataset.seat) await seatPerson(t.dataset.seat);
        else if (t.dataset.drop) { if (confirm("Remover este cliente da fila?")) await dropPerson(t.dataset.drop); }
        else if (t.dataset.back) await backToQueue(t.dataset.back);
        else if (t.dataset.discard) { if (confirm("Remover esta chamada?")) await dropPerson(t.dataset.discard); }
        else if (t.dataset.toend) {
          // ação de exceção (o cliente perde a vez): sempre confirma antes
          if (confirm("Mandar este cliente para o FIM da fila? Ele perde a vez.")) await toEndOfQueue(t.dataset.toend);
        }
      } catch (err) {
        console.error("Ação da atendente falhou:", err);
        avisoStaff("⚠ Não deu para salvar — verifique a internet e tente de novo.");
      } finally {
        t.disabled = false;
      }
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
      if (e.key === "Escape") {
        // fecha só o pop-up que está por cima
        const abertos = $$(".modal").filter((m) => !m.hidden);
        if (abertos.length) closeModal(abertos[abertos.length - 1]);
      }
    });

    // resetar média
    $("#resetAvgBtn").addEventListener("click", () => { $("#resetModal").hidden = false; });
    $("#resetAvgOk").addEventListener("click", () => { resetMedia(); $("#resetModal").hidden = true; });

    // configurações (engrenagem) — pede senha TODA vez
    $("#cfgBtn").addEventListener("click", () => {
      $("#cfgPinInput").value = "";
      $("#cfgPinMsg").textContent = "";
      $("#cfgPinModal").hidden = false;
      setTimeout(() => $("#cfgPinInput").focus(), 50);
    });
    $("#cfgPinOk").addEventListener("click", () => {
      if ($("#cfgPinInput").value === String(CFG.pinConfig || "12345678")) {
        $("#cfgPinModal").hidden = true;
        openCfg();
      } else {
        $("#cfgPinMsg").textContent = "Senha incorreta.";
        $("#cfgPinMsg").className = "form-msg err";
      }
    });
    $("#cfgPinInput").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#cfgPinOk").click(); });
    $("#cfgSave").addEventListener("click", saveCfgFromForm);

    // atalhos dentro das configurações
    $("#openRelBtn").addEventListener("click", () => { $("#cfgModal").hidden = true; openRelatorio(); });
    $("#openPublicBtn").addEventListener("click", () => {
      const url = publicUrl();
      drawQR($("#publicQr"), url);
      $("#publicUrl").textContent = url;
      $("#publicModal").hidden = false;
    });

    // relatório
    $("#relPeriodo").addEventListener("change", renderRelatorio);
    $("#relExport").addEventListener("click", exportarCSV);
    $("#relClear").addEventListener("click", pedirLimpeza);
    $("#relClearOk").addEventListener("click", limparRelatorio);

    // abrir/fechar fila (botão do cabeçalho)
    $("#toggleFilaBtn").addEventListener("click", () => {
      const fechando = !(CFG.filaFechada === true);
      // ao reabrir manualmente, não deixa o automático fechar de novo na hora:
      // só rearma quando a fila baixar do limite
      saveSettings(fechando ? { filaFechada: true } : { filaFechada: false, autoFecharArmado: false });
    });
  }

  function copiarLink(url, msgEl) {
    if (!url) return;
    const ok = () => {
      if (msgEl) { msgEl.textContent = "🔗 Link copiado!"; msgEl.className = "form-msg ok"; }
      else alert("Link copiado:\n" + url);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(ok).catch(() => prompt("Copie o link:", url));
    } else {
      prompt("Copie o link:", url);
    }
  }

  // ==========================================================
  //  RELATÓRIO
  // ==========================================================
  function relInicio() {
    const p = $("#relPeriodo").value;
    if (p === "tudo") return 0;
    if (p === "hoje") { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }
    return Date.now() - Number(p) * 24 * 3600 * 1000;
  }

  function openRelatorio() {
    $("#relMsg").textContent = "";
    $("#relModal").hidden = false;
    renderRelatorio();
  }

  async function renderRelatorio() {
    const ini = relInicio();
    $("#relMsg").textContent = "Carregando…";
    $("#relMsg").className = "form-msg";
    let lista;
    try {
      // consulta própria: o relatório enxerga todo o histórico, não só o que está na tela
      lista = (await backend.listRelatorio(ini))
        .sort((a, b) => new Date(b.criado_em) - new Date(a.criado_em));
      $("#relMsg").textContent = "";
    } catch (e) {
      console.error(e);
      $("#relMsg").textContent = "Não deu para carregar o relatório — verifique a internet.";
      $("#relMsg").className = "form-msg err";
      return;
    }
    relCache = lista;

    const situacao = {
      aguardando: "⏳ na fila", chamado: "🔔 chamado",
      sentado: "✅ sentou", desistiu: "✖ saiu",
    };
    // conta desde a hora REAL de chegada (quem perdeu a vez teve o criado_em reescrito)
    const esperaAteChamar = (r) => (r.chamado_em ? new Date(r.chamado_em) - new Date(entradaEm(r)) : null);
    const tempoTotal = (r) => (r.sentou_em ? new Date(r.sentou_em) - new Date(entradaEm(r)) : null);
    const dash = (v) => (v == null ? "—" : fmtElapsed(v));

    $("#relBody").innerHTML = lista.map((r) => `
      <tr>
        <td>${esc(r.nome)}</td>
        <td>${esc(r.telefone || "—")}</td>
        <td>${r.pessoas}</td>
        <td>${r.preferencial ? "★ Pref." : "Normal"}${isMesona(r) ? " / 🍽 grande" : ""}</td>
        <td>${r.pet ? "🐾 sim" : "não"}</td>
        <td>${esc(r.comanda || "—")}</td>
        <td>${esc(r.pager || "—")}</td>
        <td>${fmtDataHora(entradaEm(r))}</td>
        <td>${r.chamado_em ? fmtDataHora(r.chamado_em) : "—"}</td>
        <td>${r.sentou_em ? fmtDataHora(r.sentou_em) : "—"}</td>
        <td>${dash(esperaAteChamar(r))}</td>
        <td>${dash(tempoTotal(r))}</td>
        <td>${r.chamadas_perdidas || 0}</td>
        <td>${situacao[r.status] || esc(r.status)}</td>
      </tr>`).join("");
    $("#relEmpty").hidden = lista.length > 0;

    // resumo do período
    const chamados = lista.filter((r) => r.chamado_em);
    const sentados = lista.filter((r) => r.sentou_em);
    const media = (arr, fn) => (arr.length ? arr.reduce((a, r) => a + fn(r), 0) / arr.length : null);
    const cards = [
      ["Grupos", lista.length],
      ["Pessoas", lista.reduce((a, r) => a + Number(r.pessoas || 0), 0)],
      ["Sentaram", lista.filter((r) => r.status === STATUS.SENTADO).length],
      ["Desistiram", lista.filter((r) => r.status === STATUS.DESISTIU).length],
      ["Com pet", lista.filter((r) => r.pet).length],
      ["Preferenciais", lista.filter((r) => r.preferencial).length],
      ["Perderam a vez", lista.filter((r) => r.chamadas_perdidas).length],
      ["Espera média até chamar", dash(media(chamados, esperaAteChamar))],
      ["Tempo médio até sentar", dash(media(sentados, tempoTotal))],
    ];
    $("#relCards").innerHTML = cards.map(([t, v]) =>
      `<div class="rel-card"><b>${v}</b><span>${t}</span></div>`).join("");
  }

  function fmtDataHora(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return "—";
    return d.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });
  }

  function exportarCSV() {
    if (!relCache.length) {
      $("#relMsg").textContent = "Nada para exportar nesse período.";
      $("#relMsg").className = "form-msg err";
      return;
    }
    const min = (ms) => (ms == null ? "" : String(Math.round(ms / 60000)).replace(".", ","));
    const cab = ["Nome", "Telefone", "Pessoas", "Tipo", "Mesa grande", "Pet", "Comanda", "Pager",
      "Entrou", "Chamado", "Sentou", "Espera ate chamar (min)", "Tempo total (min)", "Perdeu a vez", "Situacao"];
    const linhas = relCache.map((r) => [
      r.nome, r.telefone || "", r.pessoas,
      r.preferencial ? "Preferencial" : "Normal",
      isMesona(r) ? "Sim" : "Nao",
      r.pet ? "Sim" : "Nao",
      r.comanda || "", r.pager || "",
      fmtDataHora(entradaEm(r)),
      r.chamado_em ? fmtDataHora(r.chamado_em) : "",
      r.sentou_em ? fmtDataHora(r.sentou_em) : "",
      min(r.chamado_em ? new Date(r.chamado_em) - new Date(entradaEm(r)) : null),
      min(r.sentou_em ? new Date(r.sentou_em) - new Date(entradaEm(r)) : null),
      r.chamadas_perdidas || 0,
      r.status,
    ]);
    const escCSV = (v) => {
      let s = String(v == null ? "" : v);
      // Nome, telefone e comanda são texto digitado no totem. Se a célula começa com
      // = + - @ o Excel abre como FÓRMULA; o apóstrofo força a leitura como texto.
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
      return /[";\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    // ﻿ (BOM) faz o Excel abrir os acentos corretamente
    const csv = "﻿" + [cab, ...linhas].map((l) => l.map(escCSV).join(";")).join("\r\n");
    const hoje = new Date().toISOString().slice(0, 10);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `relatorio-fila-${hoje}.csv`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    $("#relMsg").textContent = `✅ ${relCache.length} registros exportados.`;
    $("#relMsg").className = "form-msg ok";
  }

  function apagaveis() {
    return relCache.filter((r) => r.status === STATUS.SENTADO || r.status === STATUS.DESISTIU);
  }

  function pedirLimpeza() {
    const n = apagaveis().length;
    if (!n) {
      $("#relMsg").textContent = "Não há atendimentos finalizados para apagar nesse período.";
      $("#relMsg").className = "form-msg err";
      return;
    }
    const periodo = $("#relPeriodo").selectedOptions[0].textContent.toLowerCase();
    $("#relClearTxt").textContent = `Serão apagados ${n} atendimentos finalizados de "${periodo}". Exporte o CSV antes, se ainda precisar dos dados.`;
    $("#relClearModal").hidden = false;
  }

  async function limparRelatorio() {
    const ids = apagaveis().map((r) => r.id);
    $("#relClearModal").hidden = true;
    if (!ids.length) return;
    try {
      await backend.removeMany(ids);
      await refresh();
      await renderRelatorio();
      $("#relMsg").textContent = `🗑 ${ids.length} registros apagados.`;
      $("#relMsg").className = "form-msg ok";
    } catch (e) {
      console.error(e);
      $("#relMsg").textContent = "Erro ao apagar os dados.";
      $("#relMsg").className = "form-msg err";
    }
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

    if ("serviceWorker" in navigator) {
      window.addEventListener("load", () => {
        navigator.serviceWorker.register("./sw.js").catch((e) => console.warn("SW falhou:", e));
      });
    }
  }

  // ==========================================================
  //  CONFIGURAÇÕES (compartilhadas na nuvem, com fallback local)
  // ==========================================================
  // ATENÇÃO: esta lista é gravada na tabela `fila_config`, que QUALQUER cliente lê
  // pela página pública (fila.html). Nunca coloque senha nem PIN aqui.
  const SETTINGS_KEYS = [
    "prazoComparecer", "msgWhats", "msgLink", "alternancia", "regraTamanho", "whatsAtivo", "whatsAuto",
    "autoFimDaFila", "somAtivo", "filaFechada", "mostrarBtnFila", "maxPessoas", "boasVindas",
    "restaurante", "paisDDI", "mostrarMedia", "telObrigatorio", "exigirTermos",
    "termosTexto", "petAtivo", "campoComanda", "campoPager", "mesonaAtiva", "mesonaMin", "mesonaPrazo",
    "autoFecharAtiva", "autoFecharQtd", "autoFecharArmado", "linkAtivo",
  ];

  // O PIN da atendente fica guardado só NESTE aparelho (não sobe para a nuvem)
  function carregarPinLocal() {
    try { const p = localStorage.getItem(LS_PIN); if (p) CFG.pinAtendente = p; } catch (e) { /* ignora */ }
  }
  function salvarPinLocal(novo) {
    if (!novo || novo === CFG.pinAtendente) return;
    CFG.pinAtendente = novo;
    try { localStorage.setItem(LS_PIN, novo); } catch (e) { /* ignora */ }
  }

  function settingsSnapshot() {
    const o = {};
    SETTINGS_KEYS.forEach((k) => { o[k] = CFG[k]; });
    return o;
  }

  function applyBrand() {
    $("#brandName").textContent = CFG.marca || "Fila Fácil";
    $("#brandSub").textContent = CFG.restaurante || "Quinta do Aveiro";
  }

  // Lê a configuração que está na nuvem AGORA (null = não deu para ler)
  async function lerConfigNuvem() {
    if (!backend || backend.mode !== "online" || !backend.client) return null;
    try {
      const { data, error } = await backend.client.from("fila_config").select("dados").eq("id", 1).maybeSingle();
      if (error) throw error;
      return (data && data.dados) ? data.dados : {};
    } catch (e) {
      console.warn("Config: não deu para ler a nuvem agora.", e);
      return null;
    }
  }

  // só aplica as chaves conhecidas e que realmente têm valor
  function aplicarConfig(stored) {
    if (!stored) return;
    SETTINGS_KEYS.forEach((k) => {
      if (stored[k] !== undefined && stored[k] !== null) CFG[k] = stored[k];
    });
    applyBrand();
  }

  async function loadSettings() {
    if (backend && backend.mode === "online" && backend.client) {
      const stored = await lerConfigNuvem();
      // nuvem fora do ar: mantém o que já está na memória em vez de voltar para
      // uma cópia velha do localStorage (isso reabriria a fila fechada, por exemplo)
      if (stored === null) return;
      aplicarConfig(stored);
      return;
    }
    let stored = {};
    try { stored = JSON.parse(localStorage.getItem("fila_settings")) || {}; } catch (e) { stored = {}; }
    aplicarConfig(stored);
  }

  // Recarrega as configurações periodicamente (rede de segurança do tempo real)
  async function recarregarConfig() {
    if (_autoFechando) return;
    const modal = $("#cfgModal");
    if (modal && !modal.hidden) return;   // a atendente está editando: não mexe embaixo dela
    try { await loadSettings(); render(); } catch (e) { console.warn("Recarga da config:", e); }
  }

  async function saveSettings(obj) {
    // relê a nuvem ANTES de gravar: assim este aparelho não apaga, com um snapshot
    // velho, o que outro aparelho mudou (ex.: reabrir uma fila fechada pela atendente)
    aplicarConfig(await lerConfigNuvem());
    Object.assign(CFG, obj);
    const snap = settingsSnapshot();
    try {
      if (backend.mode === "online" && backend.client) {
        const { error } = await backend.client.from("fila_config").upsert({ id: 1, dados: snap });
        if (error) throw error;
      } else {
        localStorage.setItem("fila_settings", JSON.stringify(snap));
      }
    } catch (e) {
      console.warn("Config: não salvou na nuvem (crie a tabela fila_config). Salvo localmente.", e);
      localStorage.setItem("fila_settings", JSON.stringify(snap));
    }
    applyBrand();
    render();
  }

  function subscribeConfig() {
    if (backend.mode !== "online" || !backend.client) return;
    backend.client
      .channel("fila-cfg-rt")
      .on("postgres_changes", { event: "*", schema: "public", table: "fila_config" }, async () => {
        await loadSettings();
        render();
      })
      .subscribe();
  }

  // preenche e abre a tela de configurações
  function openCfg() {
    $("#cfgPrazo").value = CFG.prazoComparecer || 5;
    $("#cfgAutoFim").value = CFG.autoFimDaFila === false ? "nao" : "sim";
    $("#cfgAlt").value = CFG.alternancia || "1:1";
    $("#cfgRegra").value = CFG.regraTamanho || "exato";
    $("#cfgSom").value = CFG.somAtivo === false ? "nao" : "sim";

    $("#cfgMesoAtiva").value = CFG.mesonaAtiva === true ? "sim" : "nao";
    $("#cfgMesoMin").value = Number(CFG.mesonaMin) || 8;
    $("#cfgMesoPrazo").value = Number(CFG.mesonaPrazo) || 20;

    $("#cfgTelObrig").value = CFG.telObrigatorio === false ? "nao" : "sim";
    $("#cfgTermosOn").value = CFG.exigirTermos === false ? "nao" : "sim";
    $("#cfgTermosTxt").value = CFG.termosTexto || window.TERMOS_PADRAO || "";
    $("#cfgPetOn").value = CFG.petAtivo === false ? "nao" : "sim";
    $("#cfgMostrarMedia").value = CFG.mostrarMedia === false ? "nao" : "sim";
    $("#cfgBoas").value = CFG.boasVindas || "";
    $("#cfgMaxP").value = CFG.maxPessoas || 20;

    $("#cfgAutoFecha").value = CFG.autoFecharAtiva === true ? "sim" : "nao";
    $("#cfgAutoFechaQtd").value = Number(CFG.autoFecharQtd) || 30;
    $("#cfgMostrarFila").value = CFG.mostrarBtnFila === false ? "nao" : "sim";

    $("#cfgComandaOn").value = CFG.campoComanda === false ? "nao" : "sim";
    $("#cfgPagerOn").value = CFG.campoPager === false ? "nao" : "sim";
    $("#cfgWhatsMode").value = CFG.whatsAtivo === false ? "off" : (CFG.whatsAuto === false ? "toque" : "auto");
    $("#cfgMsg").value = CFG.msgWhats || "";
    $("#cfgMsgLink").value = CFG.msgLink || "";

    $("#cfgRest").value = CFG.restaurante || "";
    $("#cfgPinAtend").value = CFG.pinAtendente || "";

    // aviso caso o banco ainda não tenha as colunas novas
    const msg = $("#cfgMsgStatus");
    if (colsAusentes.size) {
      msg.textContent = "⚠ O banco ainda não tem as colunas: " + Array.from(colsAusentes).join(", ") +
        ". Rode o SQL do README no Supabase para ativar esses campos.";
      msg.className = "form-msg err";
    } else {
      msg.textContent = "";
    }
    $("#cfgModal").hidden = false;
  }

  async function saveCfgFromForm() {
    const num = (sel, min, max, pad) => Math.max(min, Math.min(max, parseInt($(sel).value, 10) || pad));
    const obj = {
      prazoComparecer: num("#cfgPrazo", 1, 60, 5),
      autoFimDaFila: $("#cfgAutoFim").value === "sim",
      alternancia: $("#cfgAlt").value,
      regraTamanho: $("#cfgRegra").value,
      somAtivo: $("#cfgSom").value === "sim",

      mesonaAtiva: $("#cfgMesoAtiva").value === "sim",
      mesonaMin: num("#cfgMesoMin", 2, 99, 8),
      mesonaPrazo: num("#cfgMesoPrazo", 1, 600, 20),

      telObrigatorio: $("#cfgTelObrig").value === "sim",
      exigirTermos: $("#cfgTermosOn").value === "sim",
      termosTexto: $("#cfgTermosTxt").value.trim(),
      petAtivo: $("#cfgPetOn").value === "sim",
      mostrarMedia: $("#cfgMostrarMedia").value === "sim",
      boasVindas: $("#cfgBoas").value.trim(),
      maxPessoas: num("#cfgMaxP", 1, 99, 20),

      autoFecharAtiva: $("#cfgAutoFecha").value === "sim",
      autoFecharQtd: num("#cfgAutoFechaQtd", 1, 999, 30),
      mostrarBtnFila: $("#cfgMostrarFila").value === "sim",

      campoComanda: $("#cfgComandaOn").value === "sim",
      campoPager: $("#cfgPagerOn").value === "sim",
      whatsAtivo: $("#cfgWhatsMode").value !== "off",
      whatsAuto: $("#cfgWhatsMode").value === "auto",
      msgWhats: $("#cfgMsg").value.trim(),
      msgLink: $("#cfgMsgLink").value.trim(),

      restaurante: $("#cfgRest").value.trim() || CFG.restaurante,
    };
    // o PIN não vai para a nuvem: fica só neste aparelho
    salvarPinLocal($("#cfgPinAtend").value.trim());
    const btn = $("#cfgSave");
    btn.disabled = true;
    $("#cfgMsgStatus").textContent = "Salvando…";
    $("#cfgMsgStatus").className = "form-msg";
    await saveSettings(obj);
    $("#cfgMsgStatus").textContent = "✅ Salvo!";
    $("#cfgMsgStatus").className = "form-msg ok";
    btn.disabled = false;
    setTimeout(() => { $("#cfgModal").hidden = true; $("#cfgMsgStatus").textContent = ""; }, 900);
  }

  // ==========================================================
  //  ARRANQUE
  // ==========================================================
  async function start() {
    applyBrand();
    carregarPinLocal();   // PIN da atendente: guardado só neste aparelho

    const hasSupabase = CFG.supabaseUrl && CFG.supabaseAnonKey && window.supabase;
    try {
      backend = hasSupabase ? SupabaseBackend(CFG.supabaseUrl, CFG.supabaseAnonKey) : LocalBackend();
      await backend.init();
    } catch (e) {
      console.error("Falha no backend, usando modo local:", e);
      backend = LocalBackend();
      await backend.init();
    }

    backend.onChange(refresh);
    try { await verificarColunas(); } catch (e) { console.warn("Verificação de colunas:", e); }
    await loadSettings();
    subscribeConfig();
    wireUI();
    wirePWA();
    await refresh();

    setInterval(tickTimes, 1000);          // tempos ao vivo
    setInterval(checkExpired, 3000);       // move sozinho quem estourou o prazo
    setInterval(refresh, 15000);           // rede de segurança da FILA
    setInterval(recarregarConfig, 15000);  // rede de segurança das CONFIGURAÇÕES
    // ao voltar para a tela (totem que estava em segundo plano), atualiza tudo
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") { recarregarConfig(); refresh(); }
    });
  }

  document.addEventListener("DOMContentLoaded", start);
})();
