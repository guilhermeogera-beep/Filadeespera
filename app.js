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
  const COLS_OPCIONAIS = ["chamadas_perdidas", "pet", "comanda", "pager", "sentou_em", "termos_em", "entrou_em", "sem_area_pet", "pedido_em"];
  const LS_COLS = "fila_cols_ausentes";
  const LS_PIN = "fila_pin_atendente";
  const LS_PIN_G = "fila_pin_garcom";
  const LS_MESAS = "fila_mesas_v1";       // mesas livres no modo local
  const SESSION_PIN_G = "fila_garcom_ok";
  const T_MESAS = "mesas_livres";         // tabela das mesas livres na nuvem

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
  let mesasLivres = [];     // mesas que o garçom liberou e ainda não foram usadas
  let mesaSelecionada = null; // mesa que a atendente escolheu para a próxima chamada
  let lugaresNovaMesa = 2;  // stepper do pop-up do garçom
  let semTabelaMesas = false; // true se a tabela `mesas_livres` ainda não existe no banco

  // A mesa que a atendente está liberando é da área pet?
  function mesaAceitaPet() {
    if (CFG.petAtivo === false) return false;
    const r = $('input[name="mesapet"]:checked');
    return !!r && r.value === "sim";
  }
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
    function readMesas() {
      try { return JSON.parse(localStorage.getItem(LS_MESAS)) || []; }
      catch (e) { return []; }
    }
    function writeMesas(data) {
      localStorage.setItem(LS_MESAS, JSON.stringify(data));
      if (bc) bc.postMessage("changed");
    }
    function notify() { listeners.forEach((fn) => fn()); }

    if (bc) bc.onmessage = () => notify();
    window.addEventListener("storage", (e) => {
      if (e.key === LS_KEY || e.key === LS_MESAS) notify();
    });

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

      // ---- mesas livres (lançadas pelo garçom) ----
      async listMesas() {
        // guarda só as últimas 12h para a lista não crescer sem fim
        const lim = Date.now() - 12 * 3600 * 1000;
        return readMesas().filter((m) => new Date(m.criado_em).getTime() > lim);
      },
      async addMesa(m) { const d = readMesas(); d.push(m); writeMesas(d); return m; },
      async updateMesa(id, patch) {
        const d = readMesas();
        const i = d.findIndex((m) => m.id === id);
        if (i >= 0) { d[i] = Object.assign({}, d[i], patch); writeMesas(d); }
      },
      async removeMesa(id) { writeMesas(readMesas().filter((m) => m.id !== id)); },

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
      // ---- mesas livres (lançadas pelo garçom) ----
      async listMesas() {
        const desde = new Date(Date.now() - 12 * 3600 * 1000).toISOString();
        const { data, error } = await client.from(T_MESAS).select("*")
          .gte("criado_em", desde).order("criado_em", { ascending: true }).limit(PAGINA);
        if (error) throw error;
        return data || [];
      },
      async addMesa(m) {
        const { data, error } = await client.from(T_MESAS).insert(m).select().single();
        if (error) throw error;
        return data;
      },
      async updateMesa(id, patch) {
        const { error } = await client.from(T_MESAS).update(patch).eq("id", id);
        if (error) throw error;
      },
      async removeMesa(id) {
        const { error } = await client.from(T_MESAS).delete().eq("id", id);
        if (error) throw error;
      },

      onChange(cb) {
        client
          .channel("fila-rt")
          .on("postgres_changes", { event: "*", schema: "public", table: T }, () => cb())
          .subscribe();
        // as mesas livres têm tabela própria: canal separado
        client
          .channel("mesas-rt")
          .on("postgres_changes", { event: "*", schema: "public", table: T_MESAS }, () => cb())
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
  // A pessoa pode sentar nesta mesa?
  //  - mesa da ÁREA PET: quem pediu "não sentar na área pet" não pode
  //  - mesa comum: quem está com pet não pode
  function cabeNaMesa(r, mesaAceitaPet) {
    if (CFG.petAtivo === false) return true;      // recurso desligado: não filtra nada
    return mesaAceitaPet ? !r.sem_area_pet : !r.pet;
  }

  function pickNext(x, excludeId, mesaAceitaPet) {
    const regra = CFG.regraTamanho || "exato";
    const wait = waiting()
      .filter((r) => (excludeId ? r.id !== excludeId : true))
      .filter((r) => cabeNaMesa(r, mesaAceitaPet));
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

  // Quantos grupos do tamanho certo ficaram de fora só por causa do pet?
  // (serve para explicar à atendente por que "não achou ninguém")
  function barradosPorPet(x, mesaAceitaPet) {
    const regra = CFG.regraTamanho || "exato";
    return waiting().filter((r) =>
      (regra === "ate" ? Number(r.pessoas) <= x : Number(r.pessoas) === x) &&
      !cabeNaMesa(r, mesaAceitaPet)).length;
  }

  async function addPerson({ nome, telefone, pessoas, preferencial, pet, semAreaPet, comanda, pager, aceitouTermos }) {
    const agora = new Date().toISOString();
    const entry = {
      id: uuid(),
      nome: nome.trim(),
      telefone: (telefone || "").trim(),
      pessoas: Number(pessoas),
      preferencial: !!preferencial,
      pet: !!pet,
      sem_area_pet: !pet && !!semAreaPet,   // nunca os dois juntos
      comanda: (comanda || "").trim() || null,
      pager: (pager || "").trim() || null,
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
  // aceitaPet: passado quando a chamada veio do botão "Chamar próximo" (a atendente
  // já disse se a mesa é da área pet). undefined = chamada manual, pela lista.
  function openCallConfirm(chosen, aceitaPet) {
    pendingCall = chosen;
    const petLigado = CFG.petAtivo !== false;
    // aviso quando a pessoa escolhida à mão não combina com o tipo de mesa
    let alerta = "";
    if (petLigado && aceitaPet !== undefined && !cabeNaMesa(chosen, aceitaPet)) {
      alerta = aceitaPet
        ? `<div class="cc-alerta">🚫 Este cliente pediu para <b>não sentar na área pet</b>.</div>`
        : `<div class="cc-alerta">🐾 Este cliente está <b>com pet</b> e a mesa não é da área pet.</div>`;
    }
    const selos = petLigado
      ? (chosen.pet ? " • 🐾 com pet" : "") + (chosen.sem_area_pet ? " • 🚫 não quer área pet" : "")
      : "";
    const mesaTxt = (petLigado && aceitaPet !== undefined)
      ? `<div class="cc-mesa">Mesa para ${mesa} ${mesa === 1 ? "pessoa" : "pessoas"} • ${aceitaPet ? "🐾 aceita pet" : "não é área pet"}</div>`
      : "";
    $("#callModalBody").innerHTML = `
      <div class="cc-name">${esc(chosen.nome)} ${chosen.preferencial ? "★" : ""}</div>
      <div class="cc-meta">${chosen.pessoas} ${chosen.pessoas === 1 ? "pessoa" : "pessoas"}${chosen.preferencial ? " • Preferencial" : ""}${isMesona(chosen) ? " • 🍽 mesa grande" : ""}${selos} • entrou ${fmtClock(chosen.criado_em)} • esperando há ${fmtElapsed(Date.now() - new Date(chosen.criado_em).getTime())}</div>
      ${mesaTxt}${alerta}`;
    // campos extras da atendente (pet / comanda / pager)
    $("#callPet").checked = !!chosen.pet;
    $("#callPetRow").hidden = !petLigado;
    $("#callComanda").value = chosen.comanda || "";
    $("#callPager").value = chosen.pager || "";
    $("#callComandaField").hidden = CFG.campoComanda === false;
    $("#callPagerField").hidden = CFG.campoPager === false;
    $("#callMsg").textContent = "";
    $("#callModal").hidden = false;
  }

  // ==========================================================
  //  EDITAR UM CLIENTE (só a atendente)
  // ==========================================================
  let editandoId = null;

  function openEdit(id) {
    const r = rows.find((x) => x.id === id);
    if (!r) return;
    editandoId = id;
    $("#edNome").value = r.nome || "";
    $("#edTel").value = r.telefone || "";
    $("#edPessoas").value = Number(r.pessoas) || 1;
    $("#edPessoas").max = Number(CFG.maxPessoas) || MAX_P;
    $("#edTipo").value = r.preferencial ? "preferencial" : "normal";
    $("#edComanda").value = r.comanda || "";
    $("#edPager").value = r.pager || "";
    $("#edPet").checked = !!r.pet;
    $("#edSemPet").checked = !!r.sem_area_pet;
    const petLigado = CFG.petAtivo !== false;
    $("#edPetRow").hidden = !petLigado;
    $("#edSemPetRow").hidden = !petLigado || CFG.campoSemPet === false;
    $("#edComandaField").hidden = CFG.campoComanda === false;
    $("#edPagerField").hidden = CFG.campoPager === false;
    $("#edMsg").textContent = "";
    sincPetEdit();   // um tranca o outro, conforme o que já estiver marcado
    $("#editModal").hidden = false;
  }

  async function salvarEdicao() {
    if (!editandoId) return;
    const msg = $("#edMsg");
    const nome = $("#edNome").value.trim();
    if (!nome) { msg.textContent = "Digite o nome."; msg.className = "form-msg err"; return; }
    const max = Number(CFG.maxPessoas) || MAX_P;
    const patch = {
      nome,
      telefone: $("#edTel").value.trim(),
      pessoas: Math.max(MIN_P, Math.min(max, parseInt($("#edPessoas").value, 10) || 1)),
      preferencial: $("#edTipo").value === "preferencial",
      comanda: $("#edComanda").value.trim() || null,
      pager: $("#edPager").value.trim() || null,
      pet: $("#edPet").checked,
      sem_area_pet: !$("#edPet").checked && $("#edSemPet").checked,   // nunca os dois juntos
    };
    const btn = $("#edSave");
    btn.disabled = true;
    msg.textContent = "Salvando…"; msg.className = "form-msg";
    try {
      await backend.update(editandoId, patch);
      await refresh();
      $("#editModal").hidden = true;
      editandoId = null;
      avisoStaff(`✅ Cadastro de ${firstName(nome)} atualizado.`, true);
    } catch (e) {
      console.error("Erro ao editar:", e);
      msg.textContent = "Não deu para salvar — verifique a internet e tente de novo.";
      msg.className = "form-msg err";
    } finally {
      btn.disabled = false;
    }
  }

  // Marca que o cliente já foi avisado de que o pedido está pronto
  // (o WhatsApp abre pelo próprio link; aqui só registramos a hora)
  async function marcarPedido(id) {
    try {
      await backend.update(id, { pedido_em: new Date().toISOString() });
      await refresh();
    } catch (e) { console.warn("Não deu para registrar o aviso do pedido:", e); }
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
      await carregarMesas();
      render();
      checkAutoClose();
    } catch (e) {
      console.error("Erro ao carregar a fila:", e);
      avisoStaff("⚠ Sem ligação com o servidor — o que está na tela pode estar desatualizado.");
    }
  }

  // ==========================================================
  //  MESAS LIVRES (o garçom lança, a atendente usa)
  // ==========================================================
  const MESAS = { LIVRE: "livre", USADA: "usada" };

  // As mesas ficam numa tabela própria; se ela ainda não existe no banco,
  // o recurso simplesmente não aparece (o resto do app continua normal).
  async function carregarMesas() {
    if (CFG.garcomAtivo === false) { mesasLivres = []; return; }
    try {
      const todas = await backend.listMesas();
      semTabelaMesas = false;
      mesasLivres = todas.filter((m) => m.status === MESAS.LIVRE)
        .sort((a, b) => new Date(a.criado_em) - new Date(b.criado_em));
    } catch (e) {
      semTabelaMesas = true;
      mesasLivres = [];
      console.warn("Mesas livres: tabela indisponível (rode o SQL do README).", e);
    }
    // a mesa que estava escolhida pode ter sido usada por outro aparelho
    if (mesaSelecionada && !mesasLivres.some((m) => m.id === mesaSelecionada)) mesaSelecionada = null;
  }

  async function lancarMesa({ lugares, pet, identificacao }) {
    const nova = {
      id: uuid(),
      lugares: Number(lugares),
      pet: !!pet,
      identificacao: (identificacao || "").trim() || null,
      status: MESAS.LIVRE,
      criado_em: new Date().toISOString(),
      usada_em: null,
    };
    const salva = await backend.addMesa(nova);
    await refresh();
    return salva || nova;
  }

  async function usarMesa(id) {
    await backend.updateMesa(id, { status: MESAS.USADA, usada_em: new Date().toISOString() });
    if (mesaSelecionada === id) mesaSelecionada = null;
    await refresh();
  }

  async function apagarMesa(id) {
    await backend.removeMesa(id);
    if (mesaSelecionada === id) mesaSelecionada = null;
    await refresh();
  }

  // A atendente toca numa mesa: os campos de "liberar mesa" já ficam prontos
  function selecionarMesa(id) {
    const m = mesasLivres.find((x) => x.id === id);
    if (!m) return;
    mesaSelecionada = (mesaSelecionada === id) ? null : id;
    if (mesaSelecionada) {
      mesa = Math.max(MIN_P, Math.min(Number(CFG.maxPessoas) || MAX_P, Number(m.lugares) || 2));
      $("#fMesa").textContent = mesa;
      const alvo = $(`input[name="mesapet"][value="${m.pet ? "sim" : "nao"}"]`);
      if (alvo) alvo.checked = true;
      avisoStaff(`Mesa ${descMesa(m)} escolhida — toque em "Chamar próximo".`, true);
    }
    render();
  }

  function descMesa(m) {
    return `${m.identificacao ? "“" + m.identificacao + "” • " : ""}${m.lugares} ${m.lugares === 1 ? "lugar" : "lugares"}${m.pet ? " 🐾" : ""}`;
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
  // Link do WhatsApp avisando que o PEDIDO ficou pronto para retirar
  function waLinkPedido(r) {
    const num = waNumber(r.telefone);
    if (!num) return "";
    const msg = (CFG.msgPedido || window.MSG_PEDIDO_PADRAO || "Olá {nome}! Seu pedido está pronto, pode retirar no balcão.")
      .replace(/\{nome\}/g, firstName(r.nome))
      .replace(/\{restaurante\}/g, CFG.restaurante || "")
      .replace(/\{comanda\}/g, r.comanda || "")
      .replace(/\{pager\}/g, r.pager || "");
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
    if (r.sem_area_pet) h += `<span class="q-chip chip-sempet">🚫 sem área pet</span>`;
    if (staff && r.comanda) h += `<span class="q-chip">🧾 ${esc(r.comanda)}</span>`;
    if (staff && r.pager) h += `<span class="q-chip">🔔 ${esc(r.pager)}</span>`;
    return h;
  }

  // Botão "pedido pronto": avisa o cliente no WhatsApp que pode retirar.
  // É um link de verdade (e não um window.open) para o navegador não bloquear.
  function pedidoBtnHTML(r) {
    if (CFG.avisoPedido === false || CFG.whatsAtivo === false || !r.telefone) return "";
    const link = waLinkPedido(r);
    if (!link) return "";
    const feito = !!r.pedido_em;
    return `<a class="btn btn-sm btn-pedido ${feito ? "is-feito" : ""}" href="${link}" target="_blank" rel="noopener"
      data-pedido="${r.id}" title="${feito ? "Avisado às " + fmtClock(r.pedido_em) : "Avisar no WhatsApp que o pedido está pronto"}">
      ${feito ? "✅ pedido avisado" : "🍽 Pedido pronto"}</a>`;
  }

  // HTML de um item da fila. `junto` = lista única (totem): como não há cabeçalho
  // de grupo, o tipo de cada pessoa vira selo no próprio item.
  function queueItemHTML(r, i, staff, junto) {
    const tel = staff && r.telefone ? `<span>📞 ${esc(r.telefone)}</span>` : "";
    const meso = isMesona(r);
    const selosTipo = junto
      ? (r.preferencial ? `<span class="q-tag pref">★ preferencial</span>` : "") +
        (meso ? `<span class="q-tag meso">🍽 mesa grande</span>` : "")
      : (r.preferencial && meso ? `<span class="q-tag pref">★ preferencial</span>` : "");
    const actions = staff ? `
      <div class="q-actions staff-only">
        <button class="btn btn-sm btn-accent" data-call="${r.id}">Chamar</button>
        <button class="btn btn-sm btn-primary" data-seat="${r.id}">Sentou</button>
        <button class="btn btn-sm btn-danger" data-drop="${r.id}">Saiu</button>
        <button class="btn btn-sm btn-edit" data-edit="${r.id}">✏️ Editar</button>
        ${pedidoBtnHTML(r)}
      </div>` : "";
    return `
      <li class="q-item ${r.preferencial ? "is-pref" : ""} ${meso ? "is-meso" : ""} ${staff && r.chamadas_perdidas ? "is-perdeu" : ""}"
          ${meso && staff ? `data-meso-since="${r.criado_em}"` : ""}>
        <div class="q-pos">${i + 1}</div>
        <div class="q-main">
          <div class="q-name">${esc(staff ? r.nome : firstName(r.nome))}${selosTipo}${staff && r.chamadas_perdidas ? `<span class="q-tag perdeu">⚠️ perdeu a vez${r.chamadas_perdidas > 1 ? " (" + r.chamadas_perdidas + "×)" : ""}</span>` : ""}</div>
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
    // na aba do garçom o botão grande serve para lançar mesa livre
    if (isGarcom()) {
      btn.disabled = false;
      btn.textContent = "🍽 Lançar mesa livre";
      return;
    }
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
          <button class="btn btn-sm ci-edit" data-edit="${r.id}">✏️ Editar</button>
          ${pedidoBtnHTML(r)}
          <button class="btn btn-sm ci-end" data-toend="${r.id}">⬇ Fim da fila</button>
        </div>` : ""}
      </div>`).join("");

    renderMesas();

    // -------- a fila: tudo junto ou separado --------
    // a atendente vê SEMPRE separado (é assim que ela trabalha); o totem segue a configuração
    const juntas = !staff && CFG.filasJuntas !== false;
    $("#groupTodas").hidden = !juntas;
    $("#groupMesona").hidden = juntas || CFG.mesonaAtiva !== true;
    $("#groupPref").hidden = juntas;
    $("#groupNorm").hidden = juntas;

    if (juntas) {
      // uma lista só, na ordem de chegada, com o tipo indicado em cada pessoa
      $("#queueListTodas").innerHTML = w.map((r, i) => queueItemHTML(r, i, staff, true)).join("");
      $("#emptyTodas").hidden = w.length > 0;
    } else {
      $("#queueListMeso").innerHTML = meso.map((r, i) => queueItemHTML(r, i, staff)).join("");
      $("#queueListPref").innerHTML = pref.map((r, i) => queueItemHTML(r, i, staff)).join("");
      $("#queueListNorm").innerHTML = norm.map((r, i) => queueItemHTML(r, i, staff)).join("");
      $("#emptyMeso").hidden = meso.length > 0;
      $("#emptyPref").hidden = pref.length > 0;
      $("#emptyNorm").hidden = norm.length > 0;
      $("#mesoTitle").textContent = `🍽 Mesas grandes (${Number(CFG.mesonaMin) || 8}+ pessoas)`;
    }

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
    // a pergunta "esta mesa aceita pet?" só existe se o recurso estiver ligado
    const mpf = $("#mesaPetField");
    if (mpf) mpf.hidden = CFG.petAtivo === false;
    const fb = $("#toggleFilaBtn");
    if (fb) {
      const fechada = CFG.filaFechada === true;
      fb.textContent = fechada ? "🔓 Abrir fila" : "🔒 Fechar fila";
      fb.classList.toggle("is-closed", fechada);
      fb.hidden = CFG.mostrarBtnFila === false;
    }
    // aba do garçom: some quando o recurso está desligado
    const tg = $("#tabGarcom");
    if (tg) tg.hidden = CFG.garcomAtivo === false;

    tickTimes();
    maybeBeep(c);
  }

  // Painel das mesas livres: a atendente escolhe, o garçom acompanha o que lançou
  function renderMesas() {
    const card = $("#mesasCard");
    if (!card) return;
    const ligado = CFG.garcomAtivo !== false;
    const vista = appEl.getAttribute("data-view");
    card.hidden = !ligado || (vista !== "staff" && vista !== "garcom");
    if (card.hidden) return;

    const staff = vista === "staff";
    $("#mesasCount").textContent = mesasLivres.length;
    $("#mesasList").innerHTML = mesasLivres.map((m) => `
      <div class="mesa-item ${m.pet ? "is-pet" : ""} ${mesaSelecionada === m.id ? "is-sel" : ""}"
           ${staff ? `data-selmesa="${m.id}" role="button" tabindex="0"` : ""}>
        <div class="mesa-lug">${m.lugares}<small>${m.lugares === 1 ? "lugar" : "lugares"}</small></div>
        <div class="mesa-info">
          ${m.identificacao ? `<b class="mesa-nome">${esc(m.identificacao)}</b>` : ""}
          <span class="mesa-tags">${m.pet ? `<span class="mesa-tag pet">🐾 área pet</span>` : `<span class="mesa-tag">sem pet</span>`}</span>
          <span class="mesa-hora">livre há <b data-since="${m.criado_em}">agora</b></span>
        </div>
        <div class="mesa-acoes">
          ${staff ? `<button class="btn btn-sm btn-primary" data-usarmesa="${m.id}">✓ Usei</button>` : ""}
          <button class="btn btn-sm btn-danger" data-apagarmesa="${m.id}" title="Cancelar este lançamento">✕</button>
        </div>
      </div>`).join("");

    const vazio = $("#mesasEmpty");
    vazio.hidden = mesasLivres.length > 0;
    vazio.textContent = semTabelaMesas
      ? "⚠ O banco ainda não tem a tabela das mesas — rode o SQL do README no Supabase."
      : (staff ? "Nenhuma mesa livre. O garçom avisa por aqui quando liberar." : "Nenhuma mesa livre. Toque no botão abaixo para lançar.");
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
  function isGarcom() { return appEl.getAttribute("data-view") === "garcom"; }

  // qual PIN a aba pediu (para o pop-up saber o que conferir)
  let pinAlvo = "staff";

  function setView(v) {
    if (v === "staff" && sessionStorage.getItem(SESSION_PIN) !== "1") {
      openPin("staff");
      return;
    }
    // o garçom só precisa de PIN se o dono tiver definido um
    if (v === "garcom" && String(CFG.pinGarcom || "") && sessionStorage.getItem(SESSION_PIN_G) !== "1") {
      openPin("garcom");
      return;
    }
    appEl.setAttribute("data-view", v);
    $("#tabTotem").classList.toggle("is-active", v === "totem");
    $("#tabStaff").classList.toggle("is-active", v === "staff");
    $("#tabGarcom").classList.toggle("is-active", v === "garcom");
    $("#staffBar").hidden = v !== "staff";
    const rotulo = v === "staff" ? "Adicionar cliente" : "Entrar na fila";
    $("#formTitle").textContent = rotulo;
    $("#joinBtn").textContent = rotulo;
    render();
  }

  function openPin(alvo) {
    pinAlvo = alvo || "staff";
    $("#pinTitulo").textContent = pinAlvo === "garcom" ? "Área do garçom" : "Área da atendente";
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
  // "Estou com pet" e "não sentar na área pet" se contradizem: marcar um
  // desmarca e tranca o outro (vale para o formulário e para a edição).
  function exclusaoPet(selPet, selSemPet) {
    const pet = $(selPet), sem = $(selSemPet);
    if (!pet || !sem) return function () {};
    const trancar = (cx, travado) => {
      cx.disabled = travado;
      const linha = cx.closest(".check-row");
      if (linha) linha.classList.toggle("is-travado", travado);
    };
    const sincronizar = () => { trancar(sem, pet.checked); trancar(pet, sem.checked); };
    pet.addEventListener("change", () => { if (pet.checked) sem.checked = false; sincronizar(); });
    sem.addEventListener("change", () => { if (sem.checked) pet.checked = false; sincronizar(); });
    return sincronizar;
  }
  let sincPetForm = function () {};
  let sincPetEdit = function () {};

  // Ajusta o formulário conforme as configurações (telefone, pet, termos)
  function prepararFormulario() {
    const staff = isStaff();
    const telObrig = CFG.telObrigatorio !== false;
    $("#fTelLabel").innerHTML = telObrig ? 'Telefone <b class="req">*</b>' : "Telefone <small>(opcional)</small>";
    $("#fTel").required = telObrig;
    $("#fTelHint").textContent = telObrig
      ? "Obrigatório: usamos para avisar quando a sua mesa estiver pronta."
      : "Se informar, avisamos no WhatsApp quando a mesa estiver pronta.";
    const petLigado = CFG.petAtivo !== false;
    $("#petRow").hidden = !petLigado;
    // "não sentar na área pet" só faz sentido se existe área pet
    $("#semPetRow").hidden = !petLigado || CFG.campoSemPet === false;
    // as regras são aceitas pelo cliente no totem; a atendente confirma no balcão
    $("#termosRow").hidden = staff || CFG.exigirTermos === false;
    // comanda e pager: só a atendente entrega, e só se estiverem ligados
    const temComanda = staff && CFG.campoComanda !== false;
    const temPager = staff && CFG.campoPager !== false;
    $("#formComandaField").hidden = !temComanda;
    $("#formPagerField").hidden = !temPager;
    $("#formExtras").hidden = !temComanda && !temPager;
    // aviso de mesa grande
    const hint = $("#fMesoHint");
    if (CFG.mesonaAtiva === true && pessoas >= (Number(CFG.mesonaMin) || 8)) {
      hint.hidden = false;
      hint.innerHTML = "🍽 <b>Mesa grande</b>: grupos deste tamanho podem ter uma espera maior.";
    } else {
      hint.hidden = true;
    }
  }

  // pop-up do garçom para lançar uma mesa livre
  function abrirMesaModal() {
    lugaresNovaMesa = 2;
    $("#mLugares").textContent = lugaresNovaMesa;
    const nao = $('input[name="mesapetnova"][value="nao"]');
    if (nao) nao.checked = true;
    $("#mIdent").value = "";
    $("#mMsg").textContent = "";
    $("#mPetField").hidden = CFG.petAtivo === false;
    $("#mesaModal").hidden = false;
  }

  function abrirFormulario() {
    $("#joinForm").reset();
    pessoas = 2; $("#fPessoas").textContent = pessoas;
    $('input[name="tipo"][value="normal"]').checked = true;
    $("#fPet").checked = false;
    $("#fSemPet").checked = false;
    $("#fTermos").checked = false;
    $("#fComanda").value = "";
    $("#fPager").value = "";
    $("#formMsg").textContent = "";
    sincPetForm();   // "com pet" x "sem área pet" recomeçam destravados
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
    $("#tabGarcom").addEventListener("click", () => setView("garcom"));

    // ---- mesas livres ----
    // stepper de lugares (pop-up do garçom)
    $$(".step-btn[data-mesastep]").forEach((b) =>
      b.addEventListener("click", () => {
        const max = Number(CFG.maxPessoas) || MAX_P;
        lugaresNovaMesa = Math.min(max, Math.max(MIN_P, lugaresNovaMesa + Number(b.dataset.mesastep)));
        $("#mLugares").textContent = lugaresNovaMesa;
      })
    );
    $("#mSalvar").addEventListener("click", async () => {
      const btn = $("#mSalvar"), msg = $("#mMsg");
      if (btn.disabled) return;
      btn.disabled = true;
      msg.textContent = "Salvando…"; msg.className = "form-msg";
      try {
        const pet = ($('input[name="mesapetnova"]:checked') || {}).value === "sim";
        await lancarMesa({ lugares: lugaresNovaMesa, pet, identificacao: $("#mIdent").value });
        $("#mesaModal").hidden = true;
        msg.textContent = "";
        const m = $("#mesasMsg");
        if (m) { m.textContent = "✅ Mesa liberada — a recepção já está vendo."; m.className = "form-msg ok"; }
      } catch (e) {
        console.error("Erro ao lançar mesa:", e);
        msg.textContent = semTabelaMesas
          ? "O banco ainda não tem a tabela das mesas — rode o SQL do README."
          : "Não deu para salvar — verifique a internet e tente de novo.";
        msg.className = "form-msg err";
      } finally {
        btn.disabled = false;
      }
    });

    // ações nos cartões de mesa (delegação)
    document.addEventListener("click", async (e) => {
      const t = e.target.closest("[data-usarmesa],[data-apagarmesa],[data-selmesa]");
      if (!t) return;
      try {
        if (t.dataset.usarmesa) { e.stopPropagation(); await usarMesa(t.dataset.usarmesa); }
        else if (t.dataset.apagarmesa) {
          e.stopPropagation();
          if (confirm("Tirar esta mesa da lista?")) await apagarMesa(t.dataset.apagarmesa);
        }
        else if (t.dataset.selmesa) selecionarMesa(t.dataset.selmesa);
      } catch (err) {
        console.error("Ação na mesa falhou:", err);
        const m = $("#mesasMsg");
        if (m) { m.textContent = "⚠ Não deu para salvar — verifique a internet."; m.className = "form-msg err"; }
      }
    });

    // PIN
    $("#pinOk").addEventListener("click", () => {
      const garcom = pinAlvo === "garcom";
      const certo = garcom ? String(CFG.pinGarcom || "") : String(CFG.pinAtendente || "4321");
      if ($("#pinInput").value === certo) {
        sessionStorage.setItem(garcom ? SESSION_PIN_G : SESSION_PIN, "1");
        closePin();
        setView(garcom ? "garcom" : "staff");
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
    $("#openFormBtn").addEventListener("click", () => {
      if (isGarcom()) abrirMesaModal();
      else abrirFormulario();
    });

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
      const petLigado = CFG.petAtivo !== false;
      const pet = $("#fPet").checked && petLigado;
      const semAreaPet = $("#fSemPet").checked && petLigado && CFG.campoSemPet !== false;
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
          pet, semAreaPet,
          comanda: isStaff() && CFG.campoComanda !== false ? $("#fComanda").value : "",
          pager: isStaff() && CFG.campoPager !== false ? $("#fPager").value : "",
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
      const aceitaPet = mesaAceitaPet();
      const chosen = pickNext(mesa, null, aceitaPet);
      if (!chosen) {
        const alvo = mesa === 1 ? "pessoa" : "pessoas";
        const base = (CFG.regraTamanho === "ate")
          ? `Nenhum grupo de até ${mesa} ${alvo} disponível para esta mesa.`
          : `Nenhum grupo de exatamente ${mesa} ${alvo} disponível para esta mesa.`;
        // explica quando o motivo foi o pet (senão a atendente vê gente na fila e não entende)
        const barrados = barradosPorPet(mesa, aceitaPet);
        smsg.textContent = barrados
          ? `${base} ${barrados} ${barrados === 1 ? "grupo desse tamanho não pode" : "grupos desse tamanho não podem"} usar ` +
            (aceitaPet ? "a área pet." : "esta mesa por estar com pet.")
          : base;
        smsg.className = "form-msg err";
        pendingCall = null;
        return;
      }
      smsg.textContent = "";
      openCallConfirm(chosen, aceitaPet);
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
      // se a chamada saiu de uma mesa lançada pelo garçom, ela já sai da lista
      // (o cartão sumindo do painel é o aviso; só falamos algo se der errado)
      if (mesaSelecionada) {
        try {
          await usarMesa(mesaSelecionada);
        } catch (e) {
          console.warn("Não deu para baixar a mesa:", e);
          avisoStaff("Cliente chamado, mas a mesa continua na lista — baixe no ✓ Usei.");
        }
      }
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
      const t = e.target.closest("[data-call],[data-seat],[data-drop],[data-back],[data-discard],[data-toend],[data-edit],[data-pedido]");
      if (!t) return;

      // abrir o pop-up de chamada não grava nada: sai antes
      if (t.dataset.call) {
        const p = rows.find((r) => r.id === t.dataset.call);
        if (p) openCallConfirm(p);
        return;
      }
      if (t.dataset.edit) { openEdit(t.dataset.edit); return; }
      // "pedido pronto" é um link: o WhatsApp abre sozinho, só registramos a hora
      if (t.dataset.pedido) { marcarPedido(t.dataset.pedido); return; }

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

    // "com pet" e "sem área pet" não podem estar marcados juntos
    sincPetForm = exclusaoPet("#fPet", "#fSemPet");
    sincPetEdit = exclusaoPet("#edPet", "#edSemPet");

    // editar cliente
    $("#edSave").addEventListener("click", salvarEdicao);

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
    // QR da página do cliente: pelo botão do cabeçalho ou de dentro das configurações
    function abrirQrPublico() {
      const url = publicUrl();
      drawQR($("#publicQr"), url);
      $("#publicUrl").textContent = url;
      $("#publicOpen").href = url;   // ver a página do cliente numa aba nova
      $("#publicModal").hidden = false;
    }
    $("#openPublicBtn").addEventListener("click", abrirQrPublico);
    $("#qrBtn").addEventListener("click", abrirQrPublico);

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
        <td>${r.pet ? "🐾 sim" : (r.sem_area_pet ? "🚫 sem área pet" : "não")}</td>
        <td>${esc(r.comanda || "—")}</td>
        <td>${esc(r.pager || "—")}</td>
        <td>${fmtDataHora(entradaEm(r))}</td>
        <td>${r.chamado_em ? fmtDataHora(r.chamado_em) : "—"}</td>
        <td>${r.sentou_em ? fmtDataHora(r.sentou_em) : "—"}</td>
        <td>${r.pedido_em ? fmtDataHora(r.pedido_em) : "—"}</td>
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
      "Entrou", "Chamado", "Sentou", "Pedido avisado", "Espera ate chamar (min)", "Tempo total (min)", "Perdeu a vez", "Situacao"];
    const linhas = relCache.map((r) => [
      r.nome, r.telefone || "", r.pessoas,
      r.preferencial ? "Preferencial" : "Normal",
      isMesona(r) ? "Sim" : "Nao",
      r.pet ? "Sim" : (r.sem_area_pet ? "Nao - sem area pet" : "Nao"),
      r.comanda || "", r.pager || "",
      fmtDataHora(entradaEm(r)),
      r.chamado_em ? fmtDataHora(r.chamado_em) : "",
      r.sentou_em ? fmtDataHora(r.sentou_em) : "",
      r.pedido_em ? fmtDataHora(r.pedido_em) : "",
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
    "prazoComparecer", "msgWhats", "msgLink", "msgPedido", "avisoPedido", "alternancia", "regraTamanho", "whatsAtivo", "whatsAuto",
    "autoFimDaFila", "somAtivo", "filaFechada", "mostrarBtnFila", "maxPessoas", "boasVindas",
    "restaurante", "paisDDI", "mostrarMedia", "telObrigatorio", "exigirTermos",
    "termosTexto", "petAtivo", "campoSemPet", "filasJuntas",
    "campoComanda", "campoPager", "mesonaAtiva", "mesonaMin", "mesonaPrazo",
    "autoFecharAtiva", "autoFecharQtd", "autoFecharArmado", "linkAtivo", "garcomAtivo",
  ];

  // O PIN da atendente fica guardado só NESTE aparelho (não sobe para a nuvem)
  function carregarPinLocal() {
    try {
      const p = localStorage.getItem(LS_PIN); if (p) CFG.pinAtendente = p;
      const g = localStorage.getItem(LS_PIN_G); if (g !== null) CFG.pinGarcom = g;
    } catch (e) { /* ignora */ }
  }
  function salvarPinLocal(novo) {
    if (!novo || novo === CFG.pinAtendente) return;
    CFG.pinAtendente = novo;
    try { localStorage.setItem(LS_PIN, novo); } catch (e) { /* ignora */ }
  }
  // o PIN do garçom pode ficar VAZIO de propósito (aba sem senha)
  function salvarPinGarcomLocal(novo) {
    if (novo === CFG.pinGarcom) return;
    CFG.pinGarcom = novo;
    try { localStorage.setItem(LS_PIN_G, novo); } catch (e) { /* ignora */ }
    if (!novo) sessionStorage.removeItem(SESSION_PIN_G);
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
    $("#cfgSemPetOn").value = CFG.campoSemPet === false ? "nao" : "sim";
    $("#cfgFilasJuntas").value = CFG.filasJuntas === false ? "separadas" : "juntas";
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
    $("#cfgAvisoPedido").value = CFG.avisoPedido === false ? "nao" : "sim";
    $("#cfgMsgPedido").value = CFG.msgPedido || window.MSG_PEDIDO_PADRAO || "";

    $("#cfgRest").value = CFG.restaurante || "";
    $("#cfgPinAtend").value = CFG.pinAtendente || "";
    $("#cfgGarcomOn").value = CFG.garcomAtivo === false ? "nao" : "sim";
    $("#cfgPinGarcom").value = CFG.pinGarcom || "";

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
      campoSemPet: $("#cfgSemPetOn").value === "sim",
      filasJuntas: $("#cfgFilasJuntas").value === "juntas",
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
      avisoPedido: $("#cfgAvisoPedido").value === "sim",
      msgPedido: $("#cfgMsgPedido").value.trim(),

      garcomAtivo: $("#cfgGarcomOn").value === "sim",

      restaurante: $("#cfgRest").value.trim() || CFG.restaurante,
    };
    // os PINs não vão para a nuvem: ficam só neste aparelho
    salvarPinLocal($("#cfgPinAtend").value.trim());
    salvarPinGarcomLocal($("#cfgPinGarcom").value.trim());
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
