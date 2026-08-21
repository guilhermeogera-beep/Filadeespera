/* ============================================================
   Fila Fácil — Quinta do Aveiro
   App principal (funciona em MODO LOCAL e MODO NUVEM/Supabase)
   ============================================================ */
(function () {
  "use strict";

  const CFG = window.FILA_CONFIG || {};
  const STATUS = { AGUARDANDO: "aguardando", CHAMADO: "chamado", SENTADO: "sentado", DESISTIU: "desistiu" };
  const MIN_P = 1, MAX_P = 20;
  // O "máximo de pessoas" da engrenagem vale SÓ para o cliente no totem.
  // No balcão a atendente lança o tamanho real do grupo, sem teto artificial.
  const TETO_EQUIPE = 99;
  const LS_KEY = "fila_espera_v1";
  const SESSION_PIN = "fila_staff_ok";

  // Colunas que podem ainda não existir no banco do cliente.
  // Se faltarem, o app continua funcionando sem elas (e avisa nas configurações).
  const COLS_OPCIONAIS = ["chamadas_perdidas", "pet", "comanda", "pager", "sentou_em", "termos_em", "entrou_em", "sem_area_pet", "pedido_em", "mesa_numero", "email", "aniversario"];
  const LS_COLS = "fila_cols_ausentes";
  const LS_PIN = "fila_pin_atendente";
  const LS_PIN_G = "fila_pin_garcom";
  const LS_MESAS = "fila_mesas_v1";       // mesas livres no modo local
  const SESSION_PIN_G = "fila_garcom_ok";
  const T_MESAS = "mesas_livres";         // tabela das mesas livres na nuvem
  const LS_MAPA = "fila_mapa_v1";         // mapa do salão no modo local
  const T_MAPA = "mapa_mesas";            // tabela do mapa do salão na nuvem

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
  let modoManual = false;   // true = a atendente está digitando um tamanho fora da lista
  let lugaresNovaMesa = 2;  // stepper do pop-up do garçom
  let numerosNovaMesa = []; // números das mesas juntadas (ex.: 12 + 13)
  let editandoMesaId = null; // mesa que o garçom está corrigindo (null = nova)
  let modoManualMesa = false; // true = o garçom está digitando um tamanho fora da lista
  let semTabelaMesas = false; // true se a tabela `mesas_livres` ainda não existe no banco
  let mapa = [];            // mapa do salão (cadastro das mesas da casa)
  let semTabelaMapa = false; // true se a tabela `mapa_mesas` ainda não existe no banco

  // Os tamanhos de mesa que a casa trabalha (viram os botões do pop-up).
  // Sem nada configurado, usa os quatro mais comuns.
  function tamanhosDaCasa() {
    const bruto = Array.isArray(CFG.tamanhosMesa) ? CFG.tamanhosMesa
      : String(CFG.tamanhosMesa || "").split(/[^0-9]+/);
    const nums = bruto.map(Number).filter((n) => n >= 1 && n <= 99);
    const unicos = Array.from(new Set(nums)).sort((a, b) => a - b);
    return unicos.length ? unicos : [2, 4, 6, 8];
  }

  // Abre o pop-up "que mesa vagou". A tela principal fica só com o botão.
  function abrirTamanho() {
    // se a atendente escolheu uma mesa no painel do garçom, já vem marcada
    const daMesa = mesasLivres.find((m) => m.id === mesaSelecionada);
    if (daMesa) mesa = Math.max(MIN_P, Math.min(TETO_EQUIPE, Number(daMesa.lugares) || 2));
    modoManual = !tamanhosDaCasa().includes(Number(mesa));
    $("#mesaPetField").hidden = CFG.petAtivo === false;
    $("#tamanhoMsg").textContent = "";
    $("#staffMsg").textContent = "";
    desenharTamanhos();
    $("#tamanhoModal").hidden = false;
  }

  function desenharTamanhos() {
    $("#tmTamanhos").innerHTML =
      tamanhosDaCasa().map((n) => `<button type="button" class="tm-btn${!modoManual && Number(mesa) === n ? " is-sel" : ""}" data-tam="${n}">
        <b>${n}</b><span>${n === 1 ? "pessoa" : "pessoas"}</span>
      </button>`).join("") +
      `<button type="button" class="tm-btn tm-outro${modoManual ? " is-sel" : ""}" data-tam="manual">
        <b>✎</b><span>outro</span>
      </button>`;
    $("#tmManualField").hidden = !modoManual;
    $("#fMesa").textContent = mesa;
  }

  function escolherTamanho(v) {
    if (v === "manual") modoManual = true;
    else { modoManual = false; mesa = Number(v); }
    $("#tamanhoMsg").textContent = "";
    desenharTamanhos();
  }

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
    function readMapa() {
      try { return JSON.parse(localStorage.getItem(LS_MAPA)) || []; }
      catch (e) { return []; }
    }
    function writeMapa(data) {
      localStorage.setItem(LS_MAPA, JSON.stringify(data));
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
      if (e.key === LS_KEY || e.key === LS_MESAS || e.key === LS_MAPA) notify();
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

      // ---- mapa do salão (cadastro das mesas da casa) ----
      async listMapa() { return readMapa(); },
      async addMapa(m) { const d = readMapa(); d.push(m); writeMapa(d); return m; },
      async updateMapa(id, patch) {
        const d = readMapa();
        const i = d.findIndex((m) => m.id === id);
        if (i >= 0) { d[i] = Object.assign({}, d[i], patch); writeMapa(d); }
      },
      async removeMapa(id) { writeMapa(readMapa().filter((m) => m.id !== id)); },

      onChange(cb) { listeners.push(cb); },
    };
  }

  // ==========================================================
  //  BACKEND: SUPABASE  (tempo real entre aparelhos)
  // ==========================================================
  // Com o banco fechado, quem NÃO está logado só enxerga a "vitrine"
  // (view fila_publica): a fila sem telefone, sem comanda e só com o
  // primeiro nome. A equipe logada continua vendo a tabela inteira.
  const T_PUBLICA = "fila_publica";
  const COLS_PUBLICA = "id,nome,pessoas,preferencial,status,criado_em,chamado_em,pet";
  function temSessaoEquipe() {
    return !!(usuario && usuario.papel && usuario.papel !== PAPEL.TOTEM);
  }

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
        // logado = tabela inteira; totem/sem login = só a vitrine
        const equipe = temSessaoEquipe();
        const tab = equipe ? T : T_PUBLICA;
        const cols = equipe ? "*" : COLS_PUBLICA;
        const ativos = await client.from(tab).select(cols)
          .in("status", [STATUS.AGUARDANDO, STATUS.CHAMADO])
          .order("criado_em", { ascending: true }).limit(PAGINA);
        if (ativos.error) throw ativos.error;
        const desde = new Date(Date.now() - JANELA_HIST_MS).toISOString();
        const hist = await client.from(tab).select(cols)
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
        // O totem só tem permissão de INSERIR — pedir a linha de volta
        // (.select()) exigiria permissão de leitura e daria erro.
        if (!temSessaoEquipe()) {
          await comFallback((corpo) => client.from(T).insert(corpo), entry);
          return entry;
        }
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
        let r = await client.from(T_MESAS).insert(m).select().single();
        // se o banco ainda não tem a coluna "numeros", grava sem ela
        if (r.error && colunaNaoExiste(r.error) && m.numeros !== undefined) {
          const copia = Object.assign({}, m);
          delete copia.numeros;
          r = await client.from(T_MESAS).insert(copia).select().single();
        }
        if (r.error) throw r.error;
        return r.data;
      },
      async updateMesa(id, patch) {
        const { error } = await client.from(T_MESAS).update(patch).eq("id", id);
        if (error) throw error;
      },
      async removeMesa(id) {
        const { error } = await client.from(T_MESAS).delete().eq("id", id);
        if (error) throw error;
      },

      // ---- mapa do salão ----
      async listMapa() {
        const { data, error } = await client.from(T_MAPA).select("*")
          .order("criado_em", { ascending: true }).limit(PAGINA);
        if (error) throw error;
        return data || [];
      },
      async addMapa(m) {
        const { data, error } = await client.from(T_MAPA).insert(m).select().single();
        if (error) throw error;
        return data;
      },
      async updateMapa(id, patch) {
        const { error } = await client.from(T_MAPA).update(patch).eq("id", id);
        if (error) throw error;
      },
      async removeMapa(id) {
        const { error } = await client.from(T_MAPA).delete().eq("id", id);
        if (error) throw error;
      },

      onChange(cb) {
        // A equipe escuta a fila direto. O totem não tem permissão para isso
        // (nem para escutar), então acompanha o "sino": uma tabelinha que só
        // guarda a hora da última mudança e avisa que é hora de recarregar.
        client
          .channel("fila-rt")
          .on("postgres_changes", { event: "*", schema: "public", table: T }, () => cb())
          .subscribe();
        client
          .channel("sino-rt")
          .on("postgres_changes", { event: "*", schema: "public", table: "fila_sinal" }, () => cb())
          .subscribe();
        // as mesas livres têm tabela própria: canal separado
        client
          .channel("mesas-rt")
          .on("postgres_changes", { event: "*", schema: "public", table: T_MESAS }, () => cb())
          .subscribe();
        // o mapa do salão muda de cor sozinho nos outros aparelhos
        client
          .channel("mapa-rt")
          .on("postgres_changes", { event: "*", schema: "public", table: T_MAPA }, () => cb())
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
  // Tempo médio de espera (entrada -> chamada) desde o último reset.
  // Com um filtro, mede só um pedaço da fila (mesas grandes, preferencial, normal).
  function avgWaitMs(filtro) {
    const rp = new Date(getMediaReset()).getTime();
    let done = rows.filter((r) => r.chamado_em && new Date(r.chamado_em).getTime() >= rp);
    if (filtro) done = done.filter(filtro);
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
    if (alt === "pref") return true;      // preferencial sempre na frente
    if (alt === "normal") return false;   // fila normal sempre na frente
    const hist = rows.filter((r) => r.chamado_em)
      .sort((a, b) => new Date(b.chamado_em) - new Date(a.chamado_em));
    const inicio = alt.split(":").map((v) => parseInt(v, 10));
    // começa pelo lado que a regra favorece (1:2 começa pela fila normal)
    if (!hist.length) return (inicio[0] || 1) >= (inicio[1] || 1);
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

  async function addPerson({ nome, telefone, email, aniversario, pessoas, preferencial, pet, semAreaPet, comanda, pager, aceitouTermos }) {
    const agora = new Date().toISOString();
    const entry = {
      id: uuid(),
      nome: nome.trim(),
      telefone: (telefone || "").trim(),
      email: (email || "").trim().toLowerCase() || null,
      aniversario: normalizaAniversario(aniversario) || null,
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
  async function seatPerson(id, mesaNumero) {
    const patch = { status: STATUS.SENTADO, sentou_em: new Date().toISOString() };
    if (mesaNumero !== undefined) patch.mesa_numero = (mesaNumero || "").trim() || null;
    await backend.update(id, patch);
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
    // quem fecha a fila é a recepção: o totem não tem permissão de gravar
    if (loginLigado() && !ehRecepcao()) return;
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
    // tudo aqui é só para CONFERIR — o cadastro já foi feito na entrada
    const selos = (petLigado
      ? (chosen.pet ? " • 🐾 com pet" : "") + (chosen.sem_area_pet ? " • 🚫 não quer área pet" : "")
      : "") +
      (CFG.campoComanda !== false && chosen.comanda ? " • 🧾 comanda " + esc(chosen.comanda) : "") +
      (CFG.campoPager !== false && chosen.pager ? " • 🔔 pager " + esc(chosen.pager) : "");
    const mesaTxt = (petLigado && aceitaPet !== undefined)
      ? `<div class="cc-mesa">Mesa para ${mesa} ${mesa === 1 ? "pessoa" : "pessoas"} • ${aceitaPet ? "🐾 aceita pet" : "não é área pet"}</div>`
      : "";
    $("#callModalBody").innerHTML = `
      <div class="cc-name">${esc(chosen.nome)} ${chosen.preferencial ? "★" : ""}</div>
      <div class="cc-meta">${chosen.pessoas} ${chosen.pessoas === 1 ? "pessoa" : "pessoas"}${chosen.preferencial ? " • Preferencial" : ""}${isMesona(chosen) ? " • 🍽 mesa grande" : ""}${selos} • entrou ${fmtClock(chosen.criado_em)} • esperando há ${fmtElapsed(Date.now() - new Date(chosen.criado_em).getTime())}</div>
      ${mesaTxt}${alerta}`;
    $("#callMsg").textContent = "";
    $("#callModal").hidden = false;
  }

  // ==========================================================
  //  "SENTOU" — em qual mesa o cliente ficou
  // ==========================================================
  let sentandoId = null;

  // Abre o pop-up perguntando a mesa. Se a engrenagem estiver em "não perguntar",
  // marca como sentado direto (como era antes).
  async function pedirMesaSentou(id) {
    const modo = CFG.perguntarMesa || "opcional";
    if (modo === "nao") { await seatPerson(id); return; }
    const r = rows.find((x) => x.id === id);
    if (!r) return;
    sentandoId = id;
    $("#sentouQuem").innerHTML = `<b>${esc(r.nome)}</b> — ${r.pessoas} ${r.pessoas === 1 ? "pessoa" : "pessoas"}`;
    // se a chamada saiu de uma mesa lançada pelo garçom, o número já vem pronto
    $("#sentouMesa").value = r.mesa_numero || "";
    $("#sentouLabel").innerHTML = modo === "obrigatorio"
      ? 'Em qual mesa? <b class="req">*</b>'
      : "Em qual mesa? <small>(opcional)</small>";
    desenharMesasDoSentou(r);
    $("#sentouMsg").textContent = "";
    $("#sentouModal").hidden = false;
    setTimeout(() => $("#sentouMesa").focus(), 60);
  }

  // Mostra as mesas que o garçom liberou como botões, para a atendente tocar
  // em vez de decorar o número e digitar depois — é aí que nasce o erro.
  // As que comportam o grupo vêm primeiro e ficam destacadas.
  function desenharMesasDoSentou(r) {
    const box = $("#sentouMesasBox"), lista = $("#sentouMesas");
    if (!mesasLivres.length) { box.hidden = true; lista.innerHTML = ""; return; }
    const cabe = (m) => Number(m.lugares) >= Number(r.pessoas);
    const ordenadas = mesasLivres.slice().sort((a, b) => {
      if (cabe(a) !== cabe(b)) return cabe(a) ? -1 : 1;    // as que servem primeiro
      return Number(a.lugares) - Number(b.lugares);        // e a menor que serve, antes
    });
    const escolhida = $("#sentouMesa").value.trim().toLowerCase();
    lista.innerHTML = ordenadas.map((m) => {
      const num = String(m.numeros || m.identificacao || "").trim();
      const rotulo = num ? "Mesa " + esc(num) : "sem número";
      const sel = num && num.toLowerCase() === escolhida ? " is-sel" : "";
      return `<button type="button" class="sm-mesa${cabe(m) ? "" : " is-aperta"}${sel}"
        data-sentoumesa="${esc(num)}" data-mesaid="${m.id}">
        <b class="sm-num">${rotulo}</b>
        <span class="sm-lug">${m.lugares} ${Number(m.lugares) === 1 ? "lugar" : "lugares"}</span>
        ${m.pet ? `<span class="sm-pet">🐾 área pet</span>` : ""}
      </button>`;
    }).join("");
    box.hidden = false;
  }

  // Procura, entre as mesas livres, uma que combine com o que foi digitado.
  // Compara número a número ("30 + 31" bate com "30"), sem confundir 3 com 30.
  function acharMesaLivrePeloNumero(txt) {
    const alvo = String(txt || "").split("+").map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (!alvo.length) return null;
    return mesasLivres.find((m) => {
      const dela = String(m.numeros || m.identificacao || "")
        .split("+").map((s) => s.trim().toLowerCase()).filter(Boolean);
      return dela.length && alvo.some((n) => dela.includes(n));
    }) || null;
  }

  async function confirmarSentou() {
    if (!sentandoId) return;
    const btn = $("#sentouOk"), msg = $("#sentouMsg");
    const numero = $("#sentouMesa").value.trim();
    if ((CFG.perguntarMesa || "opcional") === "obrigatorio" && !numero) {
      msg.textContent = "Informe o número da mesa.";
      msg.className = "form-msg err";
      $("#sentouMesa").focus();
      return;
    }
    btn.disabled = true;
    msg.textContent = "Salvando…"; msg.className = "form-msg";
    try {
      // se a mesa digitada estava na lista de livres, ela acabou de ser ocupada
      const livre = acharMesaLivrePeloNumero(numero);
      await seatPerson(sentandoId, numero);
      $("#sentouModal").hidden = true;
      sentandoId = null;
      msg.textContent = "";
      if (livre) {
        try {
          await usarMesa(livre.id);
          avisoStaff(`Mesa ${descMesa(livre)} saiu da lista de livres.`, true);
        } catch (e2) { console.warn("Não deu para baixar a mesa:", e2); }
      }
    } catch (e) {
      console.error("Erro ao marcar sentou:", e);
      msg.textContent = "Não deu para salvar — verifique a internet e tente de novo.";
      msg.className = "form-msg err";
    } finally {
      btn.disabled = false;
    }
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
    $("#edEmail").value = r.email || "";
    $("#edEmailField").hidden = (CFG.campoEmail || "nao") === "nao";
    $("#edAniversario").value = r.aniversario || "";
    $("#edAniversarioField").hidden = (CFG.campoAniversario || "nao") === "nao";
    $("#edPessoas").value = Number(r.pessoas) || 1;
    $("#edPessoas").max = TETO_EQUIPE;
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
    const max = TETO_EQUIPE;
    const patch = {
      nome,
      telefone: $("#edTel").value.trim(),
      email: $("#edEmail").value.trim().toLowerCase() || null,
      aniversario: normalizaAniversario($("#edAniversario").value) || null,
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

  // Protege um botão contra "tela desatualizada": se o app for atualizado e o
  // aparelho ainda tiver um pedaço da tela antiga, o clique falharia em silêncio
  // (o botão parece travado). Assim ele avisa e ensina o que fazer.
  function acaoSegura(nome, fn) {
    return async function (ev) {
      try {
        return await fn.call(this, ev);
      } catch (e) {
        console.error("Falha em " + nome + ":", e);
        avisoStaff("⚠ O app precisa ser atualizado: feche e abra de novo. (" + nome + ")");
      }
    };
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
      await carregarMapa();
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
    // as mesas livres são assunto interno: o totem nem consulta
    if (CFG.garcomAtivo === false || (loginLigado() && !temSessaoEquipe())) { mesasLivres = []; return; }
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

  async function lancarMesa({ lugares, pet, identificacao, numeros }) {
    const nova = {
      id: uuid(),
      lugares: Number(lugares),
      pet: !!pet,
      identificacao: (identificacao || "").trim() || null,
      numeros: (numeros || []).length ? numeros.join(" + ") : null,   // "12 + 13" quando juntam mesas
      status: MESAS.LIVRE,
      criado_em: new Date().toISOString(),
      usada_em: null,
    };
    const salva = await backend.addMesa(nova);
    await refresh();
    return salva || nova;
  }

  // O garçom errou o lançamento: corrige sem precisar apagar e refazer
  async function corrigirMesa(id, { lugares, pet, identificacao, numeros }) {
    const patch = {
      lugares: Number(lugares),
      pet: !!pet,
      identificacao: (identificacao || "").trim() || null,
      numeros: (numeros || []).length ? numeros.join(" + ") : null,
    };
    try {
      await backend.updateMesa(id, patch);
    } catch (e) {
      // banco sem a coluna "numeros": grava o resto
      if (!colunaNaoExiste(e)) throw e;
      delete patch.numeros;
      await backend.updateMesa(id, patch);
    }
    await refresh();
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

  // ==========================================================
  //  MAPA DO SALÃO (planta baixa das mesas da casa)
  // ==========================================================
  //  Estados de uma mesa no mapa:
  //    OCUPADA  (vermelha) - alguém da fila está sentado nela agora
  //    LIMPAR   (amarela)  - o garçom marcou que precisa limpar
  //    AVISADA  (verde/borda) - já foi liberada para a recepção
  //    LIVRE    (verde)    - nenhuma das anteriores
  //  Só o "limpar" fica guardado na mesa; os outros são deduzidos da fila,
  //  para nunca haver duas verdades sobre a mesma mesa.
  const MAPA = { LIVRE: "livre", LIMPAR: "limpar" };

  async function carregarMapa() {
    if (loginLigado() && !temSessaoEquipe()) { mapa = []; return; }
    try {
      mapa = await backend.listMapa();
      semTabelaMapa = false;
    } catch (e) {
      semTabelaMapa = true;
      mapa = [];
      console.warn("Mapa de mesas: tabela indisponível (rode o SQL do mapa).", e);
    }
  }

  // Compara números de mesa com tolerância: "30 + 31" contém "30".
  function numeroBate(numeroDaMesa, texto) {
    const alvo = String(numeroDaMesa || "").trim().toLowerCase();
    if (!alvo) return false;
    return String(texto || "").split("+").map((s) => s.trim().toLowerCase()).includes(alvo);
  }

  // Quem está sentado nesta mesa agora (para a cor vermelha e o cronômetro)
  function ocupanteDaMesa(m) {
    // depois que o garçom encerra a mesa, quem sentou antes disso não conta mais
    const corte = m.liberada_em ? new Date(m.liberada_em).getTime() : 0;
    const candidatos = rows.filter((r) => r.status === STATUS.SENTADO &&
      numeroBate(m.numero, r.mesa_numero) &&
      new Date(r.sentou_em || r.chamado_em || r.criado_em).getTime() > corte);
    // se houver mais de um (mesa reaproveitada), vale o mais recente
    candidatos.sort((a, b) => new Date(b.sentou_em || b.criado_em) - new Date(a.sentou_em || a.criado_em));
    return candidatos[0] || null;
  }

  // Esta mesa já foi avisada à recepção?
  function mesaAvisada(m) {
    return mesasLivres.some((x) => numeroBate(m.numero, x.numeros || x.identificacao));
  }

  function estadoDaMesa(m) {
    if (ocupanteDaMesa(m)) return "ocupada";
    if (m.status === MAPA.LIMPAR) return "limpar";
    if (mesaAvisada(m)) return "avisada";
    return "livre";
  }

  // Encerrar a mesa: some o cronômetro e ela sai do vermelho.
  // "limpar" deixa amarela; "livre" deixa verde.
  async function encerrarMesaMapa(id, status) {
    await backend.updateMapa(id, { status, liberada_em: new Date().toISOString() });
    await refresh();
  }

  // Avisar a recepção: entra na lista de mesas livres, como se o garçom
  // tivesse lançado pelo botão de sempre.
  async function liberarMesaDoMapa(m) {
    await encerrarMesaMapa(m.id, MAPA.LIVRE);
    if (!mesaAvisada(m)) {
      await lancarMesa({ lugares: m.lugares, pet: m.pet, identificacao: "", numeros: [String(m.numero)] });
    }
  }

  // A atendente toca numa mesa: os campos de "liberar mesa" já ficam prontos
  function selecionarMesa(id) {
    const m = mesasLivres.find((x) => x.id === id);
    if (!m) return;
    mesaSelecionada = (mesaSelecionada === id) ? null : id;
    if (mesaSelecionada) {
      mesa = Math.max(MIN_P, Math.min(TETO_EQUIPE, Number(m.lugares) || 2));
      $("#fMesa").textContent = mesa;
      const alvo = $(`input[name="mesapet"][value="${m.pet ? "sim" : "nao"}"]`);
      if (alvo) alvo.checked = true;
      avisoStaff(`Mesa ${descMesa(m)} escolhida — toque em "Chamar próximo".`, true);
    }
    render();
  }

  // ---------- desenho do mapa ----------
  // Uma mesa do mapa vira um quadradinho posicionado em % do piso, para
  // ficar igual em qualquer tela.
  function mesaMapaHTML(m, editando) {
    const est = editando ? "livre" : estadoDaMesa(m);
    const oc = editando ? null : ocupanteDaMesa(m);
    const desde = oc && (oc.sentou_em || oc.chamado_em);
    return `<button type="button" class="mm-mesa is-${est}${m.pet ? " is-pet" : ""}"
      style="left:${Number(m.x) || 50}%;top:${Number(m.y) || 50}%"
      data-mapamesa="${m.id}" title="Mesa ${esc(m.numero)}">
      <b class="mm-num">${esc(m.numero)}</b>
      <span class="mm-lug">${m.lugares}${m.pet ? " 🐾" : ""}</span>
      ${desde ? `<span class="mm-timer" data-since="${desde}">agora</span>` : ""}
    </button>`;
  }

  function renderMapa() {
    const card = $("#mapaCard");
    if (!card) return;
    // o mapa é ferramenta do salão: aparece na aba do garçom
    const vista = appEl.getAttribute("data-view");
    card.hidden = CFG.garcomAtivo === false || vista !== "garcom" || semTabelaMapa;
    if (card.hidden) return;
    $("#mapaPiso").innerHTML = mapa.map((m) => mesaMapaHTML(m, false)).join("");
    $("#mapaVazio").hidden = mapa.length > 0;
  }

  // ---------- pop-up de ação (garçom toca numa mesa) ----------
  let mapaMesaAtiva = null;

  function abrirAcaoMesa(id) {
    const m = mapa.find((x) => x.id === id);
    if (!m) return;
    mapaMesaAtiva = id;
    const est = estadoDaMesa(m);
    const oc = ocupanteDaMesa(m);
    $("#mapaAcaoTitulo").textContent = "Mesa " + m.numero;
    const situacao = { ocupada: "🔴 ocupada", limpar: "🟡 precisa limpar",
                       avisada: "🟢 já avisada à recepção", livre: "🟢 livre" }[est];
    $("#mapaAcaoInfo").innerHTML = `${m.lugares} ${m.lugares === 1 ? "lugar" : "lugares"}${m.pet ? " • 🐾 área pet" : ""} — ${situacao}` +
      (oc ? `<br><b>${esc(firstName(oc.nome))}</b> sentou às ${fmtClock(oc.sentou_em)} (há <b data-since="${oc.sentou_em}">agora</b>)` : "");
    const btns = [];
    if (est === "ocupada" || est === "limpar") {
      if (est === "ocupada") btns.push(`<button type="button" class="btn btn-amarelo" data-macao="limpar">🧽 Terminou — precisa limpar</button>`);
      btns.push(`<button type="button" class="btn btn-primary" data-macao="liberar">✓ Limpa e liberada</button>`);
    } else if (est === "avisada") {
      btns.push(`<button type="button" class="btn btn-amarelo" data-macao="limpar">🧽 Marcar para limpar</button>`);
    } else {
      btns.push(`<button type="button" class="btn btn-primary" data-macao="liberar">🔔 Liberar para a recepção</button>`);
      btns.push(`<button type="button" class="btn btn-amarelo" data-macao="limpar">🧽 Marcar para limpar</button>`);
    }
    $("#mapaAcoes").innerHTML = btns.join("");
    $("#mapaAcaoMsg").textContent = "";
    $("#mapaAcaoModal").hidden = false;
  }

  async function acaoNaMesa(acao) {
    const m = mapa.find((x) => x.id === mapaMesaAtiva);
    if (!m) return;
    const msg = $("#mapaAcaoMsg");
    msg.textContent = "Salvando…"; msg.className = "form-msg";
    try {
      if (acao === "limpar") await encerrarMesaMapa(m.id, MAPA.LIMPAR);
      else await liberarMesaDoMapa(m);
      $("#mapaAcaoModal").hidden = true;
      mapaMesaAtiva = null;
      msg.textContent = "";
    } catch (e) {
      console.error("Erro na mesa do mapa:", e);
      msg.textContent = "Não deu para salvar — verifique a internet e tente de novo.";
      msg.className = "form-msg err";
    }
  }

  // ---------- editor do mapa (engrenagem) ----------
  let mapaEditando = null;   // id da mesa aberta no pop-up de cadastro
  let mmLugares = 4;
  let mmManual = false;

  function abrirEditorMapa() {
    $("#cfgModal").hidden = true;
    $("#mapaEditMsg").textContent = "";
    desenharEditorMapa();
    $("#mapaEditModal").hidden = false;
  }

  function desenharEditorMapa() {
    $("#mapaEditPiso").innerHTML = mapa.map((m) => mesaMapaHTML(m, true)).join("");
    $("#mapaEditInfo").textContent = mapa.length
      ? `${mapa.length} ${mapa.length === 1 ? "mesa cadastrada" : "mesas cadastradas"}`
      : "Nenhuma mesa ainda — toque em “Nova mesa”.";
  }

  // pop-up de uma mesa do cadastro (nova ou existente)
  function abrirMesaCadastro(id) {
    const m = id ? mapa.find((x) => x.id === id) : null;
    mapaEditando = m ? id : null;
    mmLugares = m ? (Number(m.lugares) || 4) : 4;
    mmManual = !tamanhosDaCasa().includes(mmLugares);
    $("#mapaMesaTitulo").textContent = m ? "Mesa " + m.numero : "Nova mesa";
    $("#mmNumero").value = m ? m.numero : "";
    const alvo = $(`input[name="mmpet"][value="${m && m.pet ? "sim" : "nao"}"]`);
    if (alvo) alvo.checked = true;
    $("#mmPetField").hidden = CFG.petAtivo === false;
    $("#mmApagar").hidden = !m;
    $("#mmMsg").textContent = "";
    desenharLugaresCadastro();
    $("#mapaMesaModal").hidden = false;
    setTimeout(() => $("#mmNumero").focus(), 60);
  }

  function desenharLugaresCadastro() {
    $("#mmTamanhos").innerHTML =
      tamanhosDaCasa().map((n) => `<button type="button" class="tm-btn${!mmManual && mmLugares === n ? " is-sel" : ""}" data-mmtam="${n}">
        <b>${n}</b><span>${n === 1 ? "lugar" : "lugares"}</span>
      </button>`).join("") +
      `<button type="button" class="tm-btn tm-outro${mmManual ? " is-sel" : ""}" data-mmtam="manual"><b>✎</b><span>outro</span></button>`;
    $("#mmLugaresField").hidden = !mmManual;
    $("#mmLugares").textContent = mmLugares;
  }

  async function salvarMesaCadastro() {
    const numero = $("#mmNumero").value.trim();
    const msg = $("#mmMsg");
    if (!numero) { msg.textContent = "Digite o número da mesa."; msg.className = "form-msg err"; return; }
    // dois cartões com o mesmo número tornariam impossível saber quem está onde
    const repetida = mapa.some((x) => x.id !== mapaEditando &&
      String(x.numero).trim().toLowerCase() === numero.toLowerCase());
    if (repetida) { msg.textContent = `Já existe a mesa ${numero} no mapa.`; msg.className = "form-msg err"; return; }
    const pet = ($('input[name="mmpet"]:checked') || {}).value === "sim" && CFG.petAtivo !== false;
    msg.textContent = "Salvando…"; msg.className = "form-msg";
    try {
      if (mapaEditando) {
        await backend.updateMapa(mapaEditando, { numero, lugares: mmLugares, pet });
      } else {
        // entra num lugar livre do piso, para não nascer em cima de outra
        const pos = posicaoLivre();
        await backend.addMapa({ id: uuid(), numero, lugares: mmLugares, pet,
          x: pos.x, y: pos.y, status: MAPA.LIVRE, liberada_em: null,
          criado_em: new Date().toISOString() });
      }
      await refresh();
      $("#mapaMesaModal").hidden = true;
      mapaEditando = null;
      desenharEditorMapa();
    } catch (e) {
      console.error("Erro ao salvar a mesa do mapa:", e);
      msg.textContent = "Não deu para salvar — verifique a internet e tente de novo.";
      msg.className = "form-msg err";
    }
  }

  // Procura um ponto do piso onde ainda não há mesa (varre em linhas)
  function posicaoLivre() {
    for (let y = 12; y <= 88; y += 16) {
      for (let x = 10; x <= 90; x += 14) {
        const perto = mapa.some((m) => Math.abs(m.x - x) < 10 && Math.abs(m.y - y) < 12);
        if (!perto) return { x, y };
      }
    }
    return { x: 50, y: 50 };
  }

  async function apagarMesaCadastro() {
    if (!mapaEditando) return;
    try {
      await backend.removeMapa(mapaEditando);
      await refresh();
      $("#mapaMesaModal").hidden = true;
      mapaEditando = null;
      desenharEditorMapa();
    } catch (e) {
      console.error("Erro ao apagar a mesa do mapa:", e);
      $("#mmMsg").textContent = "Não deu para apagar — tente de novo.";
      $("#mmMsg").className = "form-msg err";
    }
  }

  // ---------- arrastar as mesas no editor ----------
  // Trabalha com pointer events: funciona igual no mouse e no toque.
  function ligarArrasto() {
    const piso = $("#mapaEditPiso");
    if (!piso) return;
    let alvo = null, moveu = false, dx = 0, dy = 0;

    piso.addEventListener("pointerdown", (e) => {
      const el = e.target.closest("[data-mapamesa]");
      if (!el) return;
      alvo = el; moveu = false;
      const r = el.getBoundingClientRect();
      dx = e.clientX - (r.left + r.width / 2);
      dy = e.clientY - (r.top + r.height / 2);
      el.setPointerCapture(e.pointerId);
      el.classList.add("is-arrastando");
    });

    piso.addEventListener("pointermove", (e) => {
      if (!alvo) return;
      const p = piso.getBoundingClientRect();
      const x = ((e.clientX - dx - p.left) / p.width) * 100;
      const y = ((e.clientY - dy - p.top) / p.height) * 100;
      // 4 dedos de folga nas bordas para a mesa não sair do piso
      alvo.style.left = Math.max(4, Math.min(96, x)) + "%";
      alvo.style.top = Math.max(6, Math.min(94, y)) + "%";
      if (Math.abs(e.clientX - dx - p.left - (parseFloat(alvo.style.left) / 100) * p.width) > 0) moveu = true;
      moveu = true;
    });

    piso.addEventListener("pointerup", async (e) => {
      if (!alvo) return;
      const el = alvo, arrastou = moveu;
      alvo = null;
      el.classList.remove("is-arrastando");
      const id = el.dataset.mapamesa;
      if (!arrastou) { abrirMesaCadastro(id); return; }   // foi um toque, não um arrasto
      const x = Math.round(parseFloat(el.style.left) * 10) / 10;
      const y = Math.round(parseFloat(el.style.top) * 10) / 10;
      const m = mapa.find((v) => v.id === id);
      if (m) { m.x = x; m.y = y; }                        // desenho já fica no lugar
      try { await backend.updateMapa(id, { x, y }); }
      catch (err) {
        console.error("Erro ao mover a mesa:", err);
        $("#mapaEditMsg").textContent = "Não deu para guardar a posição — verifique a internet.";
        $("#mapaEditMsg").className = "form-msg err";
      }
    });
  }

  function descMesa(m) {
    const nome = m.numeros ? `${m.numeros} • ` : (m.identificacao ? `“${m.identificacao}” • ` : "");
    return `${nome}${m.lugares} ${m.lugares === 1 ? "lugar" : "lugares"}${m.pet ? " 🐾" : ""}`;
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
    if (staff && r.mesa_numero) partes.push("🪑 mesa " + esc(r.mesa_numero));
    if (staff && r.comanda) partes.push("🧾 " + esc(r.comanda));
    if (staff && r.pager) partes.push("🔔 " + esc(r.pager));
    return partes.length ? `<span class="ci-chips">${partes.join(" ")}</span>` : "";
  }

  // Selos de pet / comanda / pager
  function chipsHTML(r, staff) {
    let h = "";
    if (r.pet) h += `<span class="q-chip chip-pet">🐾 pet</span>`;
    if (r.sem_area_pet) h += `<span class="q-chip chip-sempet">🚫 sem área pet</span>`;
    if (staff && r.mesa_numero) h += `<span class="q-chip chip-mesa">🪑 mesa ${esc(r.mesa_numero)}</span>`;
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

  // ==========================================================
  //  BUSCA NA FILA (só a atendente)
  // ----------------------------------------------------------
  //  Um campo só, que procura em tudo. No corrido do serviço, escolher antes
  //  "buscar por nome / por telefone" seria um toque a mais sem ganho: os
  //  formatos quase nunca se confundem e ela reconhece o resultado na hora.
  // ==========================================================
  let busca = "";

  const semAcento = (s) => String(s == null ? "" : s)
    .toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const soDigitos = (s) => String(s == null ? "" : s).replace(/\D/g, "");
  // conferência simples de e-mail: tem @, tem ponto depois, sem espaços
  const emailValido = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(s || "").trim());

  // aniversário: guardamos dia, mês e ano, sempre como "dd/mm/aaaa".
  // Aceita 7/3/1990, 07031990, 7-3-90 — e devolve "" se a data não existir.
  // O ano permite o estudo de faixa etária do relatório.
  function normalizaAniversario(s) {
    const txt = String(s == null ? "" : s).trim();
    if (!txt) return "";
    let dia, mes, ano;
    const partes = txt.split(/[^0-9]+/).filter(Boolean);
    if (partes.length >= 3) {                  // com separador: 7/3/1990
      dia = +partes[0]; mes = +partes[1]; ano = +partes[2];
    } else if (partes.length === 1) {           // tudo junto: 07031990 ou 070390
      const d = partes[0];
      if (d.length !== 8 && d.length !== 6) return "";
      dia = +d.slice(0, 2); mes = +d.slice(2, 4); ano = +d.slice(4);
    } else {
      return "";                                // veio só dia e mês: falta o ano
    }
    if (ano < 100) ano += ano <= (new Date().getFullYear() % 100) ? 2000 : 1900;
    const hoje = new Date();
    if (!(ano >= 1900 && ano <= hoje.getFullYear())) return "";
    if (!(mes >= 1 && mes <= 12)) return "";
    const bissexto = (ano % 4 === 0 && ano % 100 !== 0) || ano % 400 === 0;
    const limite = [31, bissexto ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mes - 1];
    if (!(dia >= 1 && dia <= limite)) return "";
    // data no futuro não é aniversário de ninguém
    if (new Date(ano, mes - 1, dia) > hoje) return "";
    return String(dia).padStart(2, "0") + "/" + String(mes).padStart(2, "0") + "/" + ano;
  }

  // Idade a partir do "dd/mm/aaaa" guardado. Registros antigos, gravados
  // só com dia e mês, devolvem null.
  function idadeDe(aniversario) {
    const p = String(aniversario || "").split("/");
    if (p.length !== 3) return null;
    const [d, m, a] = p.map(Number);
    if (!a) return null;
    const hoje = new Date();
    let idade = hoje.getFullYear() - a;
    const fezAniver = hoje.getMonth() + 1 > m || (hoje.getMonth() + 1 === m && hoje.getDate() >= d);
    if (!fezAniver) idade -= 1;
    return idade >= 0 && idade <= 130 ? idade : null;
  }

  function combinaBusca(r) {
    const t = semAcento(busca).trim();
    if (!t) return true;
    // nome, comanda, pager e mesa: comparação de texto (sem acento, sem maiúscula)
    if ([r.nome, r.comanda, r.pager, r.mesa_numero].some((c) => semAcento(c).includes(t))) return true;
    // telefone: compara só os números, para achar digitando sem parênteses ou traço
    const dig = soDigitos(t);
    if (dig.length >= 3 && soDigitos(r.telefone).includes(dig)) return true;
    return false;
  }

  function atualizarAvisoBusca(buscando, achou, total) {
    const info = $("#buscaInfo"), x = $("#buscaLimpar"), campo = $("#buscaInput");
    // o navegador às vezes preenche o campo sozinho (autocompletar): manda o
    // que está guardado aqui, que é o que a atendente realmente digitou
    if (campo && campo.value !== busca && document.activeElement !== campo) campo.value = busca;
    if (x) x.hidden = !busca;
    if (!info) return;
    info.hidden = !buscando;
    if (!buscando) return;
    info.textContent = achou === 0
      ? `Ninguém encontrado com “${busca}”. Toque no ✕ para ver a fila inteira.`
      : `${achou} ${achou === 1 ? "resultado" : "resultados"} para “${busca}” (de ${total} na tela).`;
    info.className = "busca-info" + (achou === 0 ? " vazio" : "");
  }

  // QR Code de UM cliente: o link leva à página que mostra só a situação dele
  function abrirQrCliente(id) {
    const r = rows.find((x) => x.id === id);
    if (!r) return;
    const url = publicUrl(r.id);
    $("#publicQuem").innerHTML = `<b>${esc(r.nome)}</b> — ${r.pessoas} ${r.pessoas === 1 ? "pessoa" : "pessoas"}`;
    drawQR($("#publicQr"), url);
    $("#publicUrl").textContent = url;
    $("#publicCopy").dataset.link = url;
    const wa = $("#publicWa");
    const num = waNumber(r.telefone);
    if (CFG.whatsAtivo !== false && num) {
      const msg = (CFG.msgLink || "Acompanhe a sua vez na fila: {link}")
        .replace(/\{nome\}/g, firstName(r.nome))
        .replace(/\{restaurante\}/g, CFG.restaurante || "")
        .replace(/\{posicao\}/g, String(waiting().findIndex((x) => x.id === r.id) + 1))
        .replace(/\{link\}/g, url);
      wa.href = "https://wa.me/" + num + "?text=" + encodeURIComponent(msg);
      wa.hidden = false;
    } else {
      wa.hidden = true;
    }
    $("#publicModal").hidden = false;
  }

  // Em quantos minutos esta pessoa deveria ter sido chamada. É o que define a
  // cor do item na tela da atendente (verde no começo, vermelho ao estourar).
  // 0 ou vazio = essa fila não usa o semáforo.
  function prazoDaFila(r) {
    if (isMesona(r)) return Number(CFG.mesonaPrazo) || 0;
    if (r.preferencial) return Number(CFG.prefPrazo) || 0;
    return Number(CFG.normalPrazo) || 0;
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
        ${CFG.linkAtivo === false ? "" : `<button class="btn btn-sm btn-qr" data-qrcliente="${r.id}" title="QR Code deste cliente">📱 QR</button>`}
        ${pedidoBtnHTML(r)}
      </div>` : "";
    return `
      <li class="q-item ${r.preferencial ? "is-pref" : ""} ${meso ? "is-meso" : ""} ${staff && r.chamadas_perdidas ? "is-perdeu" : ""}"
          ${staff && prazoDaFila(r) ? `data-espera-since="${r.criado_em}" data-espera-prazo="${prazoDaFila(r)}"` : ""}>
        <div class="q-pos">${i + 1}</div>
        <div class="q-main">
          <div class="q-name">${esc(staff ? r.nome : firstName(r.nome))}${selosTipo}${staff && r.chamadas_perdidas ? `<span class="q-tag perdeu">⚠️ perdeu a vez${r.chamadas_perdidas > 1 ? " (" + r.chamadas_perdidas + "×)" : ""}</span>` : ""}</div>
          <div class="q-sub">
            <span>👥 ${r.pessoas} ${r.pessoas === 1 ? "pessoa" : "pessoas"}</span>
            ${(staff || CFG.mostrarHoraEntrada !== false) ? `<span>🕐 entrou ${fmtClock(r.criado_em)}</span>` : ""}
            ${(staff || CFG.mostrarTempoEspera !== false) ? `<span>⏱ esperando <b class="q-time" data-since="${r.criado_em}">agora</b></span>` : ""}
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
    const wTodos = waiting();
    const cTodos = called();
    const staff = isStaff();

    // busca (só na tela da atendente): esconde quem não combina, sem tirar da fila
    const buscando = staff && !!busca.trim();
    const w = buscando ? wTodos.filter(combinaBusca) : wTodos;
    const c = buscando ? cTodos.filter(combinaBusca) : cTodos;
    atualizarAvisoBusca(buscando, w.length + c.length, wTodos.length + cTodos.length);

    // -------- listas: mesas grandes, preferencial e normal --------
    const meso = w.filter(isMesona);
    const pref = w.filter((r) => r.preferencial && !isMesona(r));
    const norm = w.filter((r) => !r.preferencial && !isMesona(r));
    $("#statTotal").textContent = buscando ? `${w.length}/${wTodos.length}` : wTodos.length;
    $("#statPref").textContent = pref.length;
    $("#statNorm").textContent = norm.length;
    $("#statMeso").textContent = meso.length;

    // tempo médio: sempre na aba da atendente; no totem, conforme a configuração
    const avg = avgWaitMs();
    $("#statAvg").textContent = avg == null ? "—" : "~" + fmtElapsed(avg);
    $("#statAvgWrap").hidden = !staff && CFG.mostrarMedia === false;

    // filas lado a lado (só na tela da atendente; o celular empilha sozinho)
    $("#queueGroups").classList.toggle("is-colunas", staff && CFG.filasColunas !== false);

    // média de cada fila, para a atendente enxergar onde está apertando
    const media = (el, filtro) => {
      const box = $(el);
      if (!box) return;
      box.hidden = !staff;
      if (!staff) return;
      const m = avgWaitMs(filtro);
      // sem nenhuma chamada ainda, mostra "—": sumir com a linha seria pior,
      // a atendente ficaria procurando uma média que desapareceu
      box.textContent = m == null ? "⏱ —" : "⏱ ~" + fmtElapsed(m);
    };
    media("#avgMeso", (r) => isMesona(r));
    media("#avgPref", (r) => r.preferencial && !isMesona(r));
    media("#avgNorm", (r) => !r.preferencial && !isMesona(r));

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
    renderMapa();

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
      // esvazia as listas separadas: senão ficam itens escondidos no ar,
      // que o relógio continuaria atualizando à toa
      $("#queueListMeso").innerHTML = "";
      $("#queueListPref").innerHTML = "";
      $("#queueListNorm").innerHTML = "";
    } else {
      $("#queueListTodas").innerHTML = "";
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
    // aba do garçom: some quando o recurso está desligado ou o perfil não a alcança
    const tg = $("#tabGarcom");
    if (tg) tg.hidden = CFG.garcomAtivo === false || !podeVer("garcom");

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
          <b class="mesa-nome">${m.numeros ? "Mesa " + esc(m.numeros) : `<span class="mesa-sem-num">sem número</span>`}</b>
          ${m.identificacao ? `<span class="mesa-obs">${esc(m.identificacao)}</span>` : ""}
          <span class="mesa-tags">${m.pet ? `<span class="mesa-tag pet">🐾 área pet</span>` : `<span class="mesa-tag">sem pet</span>`}</span>
        </div>
        <div class="mesa-acoes">
          ${staff
            ? `<button class="btn btn-sm btn-usei" data-usarmesa="${m.id}" title="Já usei esta mesa" aria-label="Já usei esta mesa">✓</button>`
            : `<button class="btn btn-sm btn-edit" data-editmesa="${m.id}" title="Corrigir esta mesa" aria-label="Corrigir esta mesa">✏️</button>`}
          <button class="btn btn-sm btn-danger" data-apagarmesa="${m.id}" title="Cancelar este lançamento" aria-label="Cancelar este lançamento">✕</button>
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
    // Semáforo da espera (só na tela da atendente): cada fila tem o seu prazo,
    // e o item vai de verde a vermelho conforme se aproxima dele.
    $$("[data-espera-since]").forEach((item) => {
      const d = new Date(item.getAttribute("data-espera-since")).getTime();
      const min = Number(item.getAttribute("data-espera-prazo")) || 0;
      if (isNaN(d) || min <= 0) return;
      const frac = Math.max(0, Math.min(1, (now - d) / (min * 60000)));
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
  //  LOGIN E PERFIS DE ACESSO
  // ----------------------------------------------------------
  //  Só entra em ação com `loginAtivo: true` no config.js. Enquanto estiver
  //  desligado, o app funciona como sempre funcionou (com os PINs) — assim dá
  //  para criar e testar os usuários sem correr o risco de ficar trancado fora.
  // ==========================================================
  const PAPEL = { ADM: "adm", ATENDENTE: "atendente", GARCOM: "garcom", TOTEM: "totem" };
  const LS_TOTEM = "fila_modo_totem";
  let usuario = null;   // { email, papel, nome } — null quando não há login

  function loginLigado() {
    return CFG.loginAtivo === true && !!(backend && backend.mode === "online" && backend.client);
  }

  // Quais abas cada perfil enxerga
  function abasPermitidas() {
    if (!loginLigado()) return ["totem", "staff", "garcom"];   // como era antes
    const p = usuario && usuario.papel;
    if (p === PAPEL.ADM) return ["totem", "staff", "garcom"];
    if (p === PAPEL.ATENDENTE) return ["staff"];
    if (p === PAPEL.GARCOM) return ["garcom"];
    return ["totem"];   // totem (ou sem perfil definido): só a fila
  }
  function podeVer(v) { return abasPermitidas().indexOf(v) >= 0; }
  // Em qual aba cada perfil começa: quem trabalha cai direto no seu posto
  function abaInicial() {
    const p = usuario && usuario.papel;
    if (p === PAPEL.ADM) return "staff";
    if (p === PAPEL.ATENDENTE) return "staff";
    if (p === PAPEL.GARCOM) return "garcom";
    return "totem";
  }
  function ehAdm() { return !loginLigado() || (usuario && usuario.papel === PAPEL.ADM); }
  // recepção = quem pode mexer na fila (administrador ou atendente)
  function ehRecepcao() {
    return !loginLigado() ||
      (usuario && (usuario.papel === PAPEL.ADM || usuario.papel === PAPEL.ATENDENTE));
  }

  // Este aparelho foi marcado como o totem do salão (não pede senha)
  function modoTotem() {
    try { return localStorage.getItem(LS_TOTEM) === "1"; } catch (e) { return false; }
  }

  async function lerPapel(client, user) {
    try {
      const { data, error } = await client.from("fila_usuarios")
        .select("papel,nome").eq("user_id", user.id).maybeSingle();
      if (error) throw error;
      return {
        email: user.email,
        nome: (data && data.nome) || user.email,
        // sem linha na tabela de usuários, entra com o perfil mais restrito
        papel: (data && data.papel) || PAPEL.TOTEM,
      };
    } catch (e) {
      console.warn("Não deu para ler o perfil do usuário:", e);
      return { email: user.email, nome: user.email, papel: PAPEL.TOTEM };
    }
  }

  // Decide entre mostrar a tela de login ou o app.
  // A tela de login é uma camada opaca POR CIMA do app — de propósito: assim,
  // se um aparelho ficar com a tela nova e o programa antigo, ninguém vê uma
  // página em branco; no pior caso vê o app, nunca o vazio.
  async function iniciarSessao() {
    const tela = $("#loginScreen");
    if (!loginLigado()) { tela.hidden = true; return true; }
    if (modoTotem()) {
      usuario = { email: "", nome: "Totem", papel: PAPEL.TOTEM };
      tela.hidden = true;
      return true;
    }
    let sess = null;
    try {
      const { data } = await backend.client.auth.getSession();
      sess = data && data.session;
    } catch (e) { console.warn("Sessão:", e); }
    if (!sess || !sess.user) {
      usuario = null;
      $("#loginSub").textContent = CFG.restaurante || "";
      tela.hidden = false;
      setTimeout(() => $("#loginEmail").focus(), 80);
      return false;
    }
    usuario = await lerPapel(backend.client, sess.user);
    tela.hidden = true;
    return true;
  }

  // O Supabase só aceita E-MAIL como identificação, mas quem trabalha no salão
  // digita só "atendente", "garcom" ou "adm". Aqui montamos o e-mail interno.
  // (quem quiser pode digitar o e-mail completo — se tiver "@", vai como está)
  function emailDoUsuario(txt) {
    const t = String(txt || "").trim();
    if (t.indexOf("@") >= 0) return t.toLowerCase();
    const limpo = t.toLowerCase()
      .normalize("NFD").replace(/[̀-ͯ]/g, "")   // garçom -> garcom
      .replace(/[^a-z0-9._-]/g, "");
    return limpo + "@" + (CFG.dominioLogin || "filafacil.local");
  }

  // O Supabase exige senha de 6+ caracteres, mas a equipe usa 4 dígitos.
  // O app completa com um final fixo — por isso a senha cadastrada no painel
  // do Supabase é a senha curta MAIS este final (está explicado no README).
  function senhaCompleta(senha) {
    const s = String(senha || "");
    const suf = String(CFG.sufixoSenha || "");
    return (s.length >= 6 && !suf) ? s : s + suf;
  }

  async function entrar(usuarioTxt, senha) {
    const { data, error } = await backend.client.auth.signInWithPassword({
      email: emailDoUsuario(usuarioTxt), password: senhaCompleta(senha),
    });
    if (error) throw error;
    usuario = await lerPapel(backend.client, data.user);
    return usuario;
  }

  async function sair() {
    try { localStorage.removeItem(LS_TOTEM); } catch (e) { /* ignora */ }
    try {
      if (backend && backend.client) await backend.client.auth.signOut();
    } catch (e) { console.warn("Sair:", e); }
    usuario = null;
    location.reload();
  }

  // Mostra só as abas do perfil e leva para a primeira permitida
  function aplicarPermissoes() {
    const ligado = loginLigado();
    const podeGarcom = CFG.garcomAtivo !== false && podeVer("garcom");
    const map = { totem: "#tabTotem", staff: "#tabStaff", garcom: "#tabGarcom" };
    Object.keys(map).forEach((v) => {
      const b = $(map[v]);
      if (b) b.hidden = (v === "garcom") ? !podeGarcom : !podeVer(v);
    });
    // com um perfil só, nem faz sentido mostrar a barra de abas
    const sw = document.querySelector(".viewswitch");
    if (sw) sw.hidden = abasPermitidas().filter((v) => v !== "garcom" || podeGarcom).length < 2;

    const sb = $("#sairBtn");
    if (sb) sb.hidden = !ligado;
    // configurações e relatório são do administrador
    const cb = $("#cfgBtn");
    if (cb) cb.hidden = !ehAdm();
    const rb = $("#relBtn");
    if (rb) rb.hidden = !ehAdm();
    // o administrador mantém os controles do cabeçalho em qualquer aba
    appEl.setAttribute("data-papel", (ligado && usuario && usuario.papel) || "");

    if (ligado && usuario) {
      $("#brandSub").textContent = (CFG.restaurante || "") +
        (usuario.papel === PAPEL.TOTEM ? "" : " • " + rotuloPapel(usuario.papel));
    }
  }
  function rotuloPapel(p) {
    return p === PAPEL.ADM ? "Administrador"
      : p === PAPEL.ATENDENTE ? "Atendente"
      : p === PAPEL.GARCOM ? "Garçom" : "Totem";
  }

  function wireLogin() {
    const form = $("#loginForm");
    if (!form || form.dataset.pronto === "1") return;
    form.dataset.pronto = "1";

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = $("#loginBtn"), msg = $("#loginMsg");
      if (btn.disabled) return;
      btn.disabled = true;
      msg.textContent = "Entrando…"; msg.className = "form-msg";
      try {
        await entrar($("#loginEmail").value, $("#loginSenha").value);
        $("#loginSenha").value = "";
        msg.textContent = "";
        $("#loginScreen").hidden = true;

        aplicarPermissoes();
        setView(abaInicial());
        await refresh();
      } catch (err) {
        console.warn("Login:", err);
        const m = String((err && err.message) || "");
        msg.textContent = /invalid login|credentials/i.test(m)
          ? "E-mail ou senha incorretos."
          : (/network|fetch/i.test(m) ? "Sem internet para entrar. Verifique a conexão." : "Não deu para entrar. Tente de novo.");
        msg.className = "form-msg err";
      } finally {
        btn.disabled = false;
      }
    });

    $("#loginTotemBtn").addEventListener("click", () => {
      if (!confirm("Deixar este aparelho como TOTEM do salão?\n\nEle vai mostrar só a fila, sem pedir senha.")) return;
      try { localStorage.setItem(LS_TOTEM, "1"); } catch (e) { /* ignora */ }
      location.reload();
    });

    const sb = $("#sairBtn");
    if (sb) sb.addEventListener("click", () => {
      if (confirm("Sair da conta neste aparelho?")) sair();
    });
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
    // com login ligado, quem manda é o perfil — o PIN deixa de ser necessário
    if (loginLigado()) {
      if (!podeVer(v)) return;
    } else {
      if (v === "staff" && String(CFG.pinAtendente || "") && sessionStorage.getItem(SESSION_PIN) !== "1") {
        openPin("staff");
        return;
      }
      // o garçom só precisa de PIN se o dono tiver definido um
      if (v === "garcom" && String(CFG.pinGarcom || "") && sessionStorage.getItem(SESSION_PIN_G) !== "1") {
        openPin("garcom");
        return;
      }
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
    // e-mail: aparece no totem e no balcão conforme a engrenagem
    const modoEmail = CFG.campoEmail || "nao";
    $("#fEmailField").hidden = modoEmail === "nao";
    $("#fEmail").required = modoEmail === "obrigatorio";
    $("#fEmailLabel").innerHTML = modoEmail === "obrigatorio"
      ? 'E-mail <b class="req">*</b>' : "E-mail <small>(opcional)</small>";

    // aniversário: mesma lógica do e-mail, só dia e mês
    const modoAniv = CFG.campoAniversario || "nao";
    $("#fAniversarioField").hidden = modoAniv === "nao";
    $("#fAniversario").required = modoAniv === "obrigatorio";
    $("#fAniversarioLabel").innerHTML = modoAniv === "obrigatorio"
      ? 'Aniversário <b class="req">*</b>' : "Aniversário <small>(opcional)</small>";

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

  // pop-up do garçom: lança uma mesa nova ou corrige uma que ele já lançou
  function abrirMesaModal(id) {
    const m = id ? mesasLivres.find((x) => x.id === id) : null;
    editandoMesaId = m ? id : null;
    lugaresNovaMesa = m ? (Number(m.lugares) || 2) : 2;
    numerosNovaMesa = m && m.numeros
      ? String(m.numeros).split("+").map((s) => s.trim()).filter(Boolean)
      : [];
    modoManualMesa = !tamanhosDaCasa().includes(Number(lugaresNovaMesa));
    $("#mLugares").textContent = lugaresNovaMesa;
    const alvo = $(`input[name="mesapetnova"][value="${m && m.pet ? "sim" : "nao"}"]`);
    if (alvo) alvo.checked = true;
    $("#mNumero").value = "";
    $("#mIdent").value = (m && m.identificacao) || "";
    $("#mMsg").textContent = "";
    $("#mPetField").hidden = CFG.petAtivo === false;
    $("#mesaTitulo").textContent = m ? "✏️ Corrigir mesa" : "🍽 Lançar mesa livre";
    $("#mSalvar").textContent = m ? "Salvar alterações" : "🍽 Liberar esta mesa";
    desenharTamanhosMesa();
    renderNumChips();
    $("#mesaModal").hidden = false;
    setTimeout(() => $("#mNumero").focus(), 60);
  }

  // Os mesmos tamanhos configurados na engrenagem viram botões aqui também,
  // para o garçom lançar a mesa num toque em vez de ficar no contador.
  function desenharTamanhosMesa() {
    $("#mTamanhos").innerHTML =
      tamanhosDaCasa().map((n) => `<button type="button" class="tm-btn${!modoManualMesa && Number(lugaresNovaMesa) === n ? " is-sel" : ""}" data-mtam="${n}">
        <b>${n}</b><span>${n === 1 ? "lugar" : "lugares"}</span>
      </button>`).join("") +
      `<button type="button" class="tm-btn tm-outro${modoManualMesa ? " is-sel" : ""}" data-mtam="manual">
        <b>✎</b><span>outro</span>
      </button>`;
    $("#mLugaresField").hidden = !modoManualMesa;
    $("#mLugares").textContent = lugaresNovaMesa;
  }

  function escolherTamanhoMesa(v) {
    if (v === "manual") modoManualMesa = true;
    else { modoManualMesa = false; lugaresNovaMesa = Number(v); }
    $("#mMsg").textContent = "";
    desenharTamanhosMesa();
  }

  // Números já adicionados (quando o garçom junta duas ou mais mesas)
  function renderNumChips() {
    const box = $("#mNumChips");
    if (!box) return;
    box.innerHTML = numerosNovaMesa.map((n, i) => `
      <span class="num-chip">${esc(n)}<button type="button" data-tiranum="${i}" aria-label="Tirar">✕</button></span>`)
      .join('<span class="num-mais">+</span>');
    box.hidden = !numerosNovaMesa.length;
  }

  // Guarda o que está digitado no campo de número (chamado ao adicionar e ao salvar)
  function guardarNumeroDigitado() {
    const campo = $("#mNumero");
    const n = campo.value.trim();
    if (!n) return false;
    // "12 + 12" não quer dizer nada: se já está na lista, só limpa o campo
    if (numerosNovaMesa.some((x) => x.toLowerCase() === n.toLowerCase())) {
      campo.value = "";
      return true;
    }
    if (numerosNovaMesa.length >= 6) return false;
    numerosNovaMesa.push(n);
    campo.value = "";
    renderNumChips();
    return true;
  }

  function abrirFormulario() {
    $("#joinForm").reset();
    pessoas = 2; $("#fPessoas").textContent = pessoas;
    $('input[name="tipo"][value="normal"]').checked = true;
    $("#fPet").checked = false;
    $("#fSemPet").checked = false;
    $("#fEmail").value = "";
    $("#fAniversario").value = "";
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
    $("#mTamanhos").addEventListener("click", (e) => {
      const b = e.target.closest("[data-mtam]");
      if (!b) return;
      escolherTamanhoMesa(b.dataset.mtam === "manual" ? "manual" : Number(b.dataset.mtam));
    });
    $$(".step-btn[data-mesastep]").forEach((b) =>
      b.addEventListener("click", () => {
        const max = TETO_EQUIPE;
        lugaresNovaMesa = Math.min(max, Math.max(MIN_P, lugaresNovaMesa + Number(b.dataset.mesastep)));
        $("#mLugares").textContent = lugaresNovaMesa;
      })
    );
    // "+" junta outra mesa ao mesmo lançamento
    $("#mAddNum").addEventListener("click", () => {
      if (!guardarNumeroDigitado()) {
        const msg = $("#mMsg");
        msg.textContent = numerosNovaMesa.length >= 6
          ? "São no máximo 6 mesas juntas."
          : "Digite o número da mesa antes de tocar no +.";
        msg.className = "form-msg err";
        $("#mNumero").focus();
        return;
      }
      $("#mMsg").textContent = "";
      $("#mNumero").focus();
    });
    $("#mNumero").addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); $("#mAddNum").click(); }
    });
    // sair do campo já guarda o número: ninguém precisa lembrar de tocar no +
    $("#mNumero").addEventListener("blur", () => {
      if (guardarNumeroDigitado()) $("#mMsg").textContent = "";
    });
    $("#mNumChips").addEventListener("click", (e) => {
      const b = e.target.closest("[data-tiranum]");
      if (!b) return;
      numerosNovaMesa.splice(Number(b.dataset.tiranum), 1);
      renderNumChips();
    });

    $("#mSalvar").addEventListener("click", async () => {
      const btn = $("#mSalvar"), msg = $("#mMsg");
      if (btn.disabled) return;
      guardarNumeroDigitado();   // aproveita o número que ficou digitado sem tocar no +
      btn.disabled = true;
      msg.textContent = "Salvando…"; msg.className = "form-msg";
      try {
        const pet = ($('input[name="mesapetnova"]:checked') || {}).value === "sim";
        const dados = {
          lugares: lugaresNovaMesa, pet,
          identificacao: $("#mIdent").value,
          numeros: numerosNovaMesa,
        };
        if (editandoMesaId) await corrigirMesa(editandoMesaId, dados);
        else await lancarMesa(dados);
        editandoMesaId = null;
        $("#mesaModal").hidden = true;
        msg.textContent = "";
        // sem mensagem de confirmação: o cartão aparecendo na lista já diz tudo,
        // e a tela do garçom fica limpa
        const m = $("#mesasMsg");
        if (m) { m.textContent = ""; m.className = "form-msg"; }
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
      const t = e.target.closest("[data-usarmesa],[data-apagarmesa],[data-editmesa],[data-selmesa]");
      if (!t) return;
      try {
        if (t.dataset.editmesa) { e.stopPropagation(); abrirMesaModal(t.dataset.editmesa); }
        else if (t.dataset.usarmesa) { e.stopPropagation(); await usarMesa(t.dataset.usarmesa); }
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
      const certo = garcom ? String(CFG.pinGarcom || "") : String(CFG.pinAtendente || "");
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
        const max = isStaff() ? TETO_EQUIPE : (Number(CFG.maxPessoas) || MAX_P);
        pessoas = Math.min(max, Math.max(MIN_P, pessoas + Number(b.dataset.step)));
        $("#fPessoas").textContent = pessoas;
        prepararFormulario();
      })
    );
    // stepper mesa (atendente)
    $$(".step-btn[data-freestep]").forEach((b) =>
      b.addEventListener("click", () => {
        const max = TETO_EQUIPE;
        mesa = Math.min(max, Math.max(MIN_P, mesa + Number(b.dataset.freestep)));
        $("#fMesa").textContent = mesa;
      })
    );

    // abrir o formulário em pop-up
    $("#openFormBtn").addEventListener("click", acaoSegura("abrir o formulário", () => {
      if (isGarcom()) abrirMesaModal();
      else abrirFormulario();
    }));

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
      // e-mail: só cobra se estiver ligado na engrenagem
      const email = $("#fEmail").value.trim();
      const modoEmail = CFG.campoEmail || "nao";
      if (modoEmail !== "nao") {
        if (modoEmail === "obrigatorio" && !email) return erro("Digite o e-mail.");
        if (email && !emailValido(email)) return erro("E-mail inválido — confira se está completo (nome@email.com).");
      }
      // aniversário: só cobra se estiver ligado na engrenagem
      const anivTxt = $("#fAniversario").value.trim();
      const modoAniv = CFG.campoAniversario || "nao";
      if (modoAniv !== "nao") {
        if (modoAniv === "obrigatorio" && !anivTxt) return erro("Digite a data de aniversário (dia, mês e ano).");
        if (anivTxt && !normalizaAniversario(anivTxt)) return erro("Aniversário inválido — digite dia, mês e ano, como 07/03/1990.");
      }
      if (precisaTermos && !$("#fTermos").checked) return erro("É preciso aceitar as regras da fila para entrar.");
      if (!isStaff() && CFG.filaFechada === true) return erro("A fila está fechada no momento.");

      $("#joinBtn").disabled = true;
      try {
        const pessoa = await addPerson({
          nome, telefone: tel, pessoas,
          email: modoEmail === "nao" ? "" : email,
          aniversario: modoAniv === "nao" ? "" : anivTxt,
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

    // atendente: o botão da tela só abre o pop-up de "que mesa vagou"
    $("#freeTableBtn").addEventListener("click", acaoSegura("chamar próxima mesa", abrirTamanho));
    $("#tamanhoOk").addEventListener("click", acaoSegura("chamar próxima mesa", () => {
      $("#tamanhoModal").hidden = true;
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
    }));
    // mapa do salão: tocar numa mesa abre as ações do garçom
    $("#mapaPiso").addEventListener("click", (e) => {
      const b = e.target.closest("[data-mapamesa]");
      if (b) acaoSegura("abrir mesa do mapa", () => abrirAcaoMesa(b.dataset.mapamesa))();
    });
    $("#mapaAcoes").addEventListener("click", (e) => {
      const b = e.target.closest("[data-macao]");
      if (b) acaoNaMesa(b.dataset.macao);
    });
    // cadastro do mapa (pela engrenagem)
    $("#cfgMapaBtn").addEventListener("click", acaoSegura("configurar o mapa", abrirEditorMapa));
    $("#mapaNova").addEventListener("click", () => abrirMesaCadastro(null));
    $("#mmSalvar").addEventListener("click", salvarMesaCadastro);
    $("#mmApagar").addEventListener("click", apagarMesaCadastro);
    $("#mmNumero").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#mmSalvar").click(); });
    $("#mmTamanhos").addEventListener("click", (e) => {
      const b = e.target.closest("[data-mmtam]");
      if (!b) return;
      if (b.dataset.mmtam === "manual") mmManual = true;
      else { mmManual = false; mmLugares = Number(b.dataset.mmtam); }
      desenharLugaresCadastro();
    });
    $$(".step-btn[data-mmstep]").forEach((b) =>
      b.addEventListener("click", () => {
        mmLugares = Math.min(TETO_EQUIPE, Math.max(MIN_P, mmLugares + Number(b.dataset.mmstep)));
        $("#mmLugares").textContent = mmLugares;
      })
    );
    ligarArrasto();

    $("#tmTamanhos").addEventListener("click", (e) => {
      const b = e.target.closest("[data-tam]");
      if (!b) return;
      escolherTamanho(b.dataset.tam === "manual" ? "manual" : Number(b.dataset.tam));
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
        // se a chamada saiu de uma mesa do garçom, já guarda o número dela:
        // na hora do "Sentou" o campo vem preenchido sozinho
        const mesaEscolhida = mesasLivres.find((m) => m.id === mesaSelecionada);
        await callPerson(p.id, {
          mesa_numero: (mesaEscolhida && (mesaEscolhida.numeros || mesaEscolhida.identificacao)) || p.mesa_numero || null,
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
      const t = e.target.closest("[data-call],[data-seat],[data-drop],[data-back],[data-discard],[data-toend],[data-edit],[data-pedido],[data-qrcliente]");
      if (!t) return;

      // abrir o pop-up de chamada não grava nada: sai antes
      if (t.dataset.call) {
        const p = rows.find((r) => r.id === t.dataset.call);
        if (p) await acaoSegura("chamar", () => openCallConfirm(p))();
        return;
      }
      if (t.dataset.edit) { await acaoSegura("editar", () => openEdit(t.dataset.edit))(); return; }
      if (t.dataset.qrcliente) { await acaoSegura("QR do cliente", () => abrirQrCliente(t.dataset.qrcliente))(); return; }
      // "Sentou" pode perguntar em qual mesa (o pop-up é que grava)
      if (t.dataset.seat) { await acaoSegura("sentou", () => pedirMesaSentou(t.dataset.seat))(); return; }
      // "pedido pronto" é um link: o WhatsApp abre sozinho, só registramos a hora
      if (t.dataset.pedido) { marcarPedido(t.dataset.pedido); return; }

      if (t.disabled) return;
      t.disabled = true;   // evita toque duplo enquanto grava
      try {
        if (t.dataset.drop) { if (confirm("Remover este cliente da fila?")) await dropPerson(t.dataset.drop); }
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

    // em qual mesa o cliente sentou
    $("#sentouOk").addEventListener("click", confirmarSentou);
    // tocar numa mesa livre preenche o número — sem ninguém decorar nada
    $("#sentouMesas").addEventListener("click", (e) => {
      const b = e.target.closest("[data-sentoumesa]");
      if (!b) return;
      $("#sentouMesa").value = b.dataset.sentoumesa;
      $$("#sentouMesas .sm-mesa").forEach((x) => x.classList.remove("is-sel"));
      b.classList.add("is-sel");
      $("#sentouMsg").textContent = "";
    });
    $("#sentouMesa").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#sentouOk").click(); });

    // editar cliente
    $("#edSave").addEventListener("click", salvarEdicao);

    // busca na fila
    // o campo nasce "somente leitura" para o navegador não preenchê-lo com o
    // login; ao tocar nele, liberamos para digitar
    $("#buscaInput").addEventListener("focus", (e) => e.target.removeAttribute("readonly"));
    $("#buscaInput").addEventListener("input", (e) => { busca = e.target.value; render(); });
    $("#buscaInput").addEventListener("keydown", (e) => {
      if (e.key === "Escape") { busca = ""; e.target.value = ""; render(); }
    });
    $("#buscaLimpar").addEventListener("click", () => {
      busca = "";
      $("#buscaInput").value = "";
      render();
      $("#buscaInput").focus();
    });

    // resetar média
    $("#resetAvgBtn").addEventListener("click", () => { $("#resetModal").hidden = false; });
    $("#resetAvgOk").addEventListener("click", () => { resetMedia(); $("#resetModal").hidden = true; });

    // configurações (engrenagem) — pede senha TODA vez
    $("#cfgBtn").addEventListener("click", () => {
      // Com login ligado, quem chegou aqui já é o administrador — e a senha das
      // configurações fica escrita no config.js (que é público). Então não faz
      // sentido pedi-la: o login é a garantia.
      if (loginLigado() || !String(CFG.pinConfig || "")) { openCfg(); return; }
      $("#cfgPinInput").value = "";
      $("#cfgPinMsg").textContent = "";
      $("#cfgPinModal").hidden = false;
      setTimeout(() => $("#cfgPinInput").focus(), 50);
    });
    $("#cfgPinOk").addEventListener("click", () => {
      if ($("#cfgPinInput").value === String(CFG.pinConfig || "")) {
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
    // o relatório também tem botão próprio no cabeçalho (a atendente usa sem abrir as configurações)
    $("#relBtn").addEventListener("click", openRelatorio);
    // QR de UM cliente: o link é pessoal e mostra só a situação dele
    $("#publicCopy").addEventListener("click", () =>
      copiarLink($("#publicCopy").dataset.link, null));

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
        <td>${esc(r.email || "—")}</td>
        <td>${esc(r.aniversario || "—")}</td>
        <td>${idadeDe(r.aniversario) == null ? "—" : idadeDe(r.aniversario) + " anos"}</td>
        <td>${r.pessoas}</td>
        <td>${r.preferencial ? "★ Pref." : "Normal"}${isMesona(r) ? " / 🍽 grande" : ""}</td>
        <td>${r.pet ? "🐾 sim" : (r.sem_area_pet ? "🚫 sem área pet" : "não")}</td>
        <td>${esc(r.mesa_numero || "—")}</td>
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
    const cab = ["Nome", "Telefone", "E-mail", "Aniversario", "Idade", "Pessoas", "Tipo", "Mesa grande", "Pet", "Comanda", "Pager",
      "Mesa", "Entrou", "Chamado", "Sentou", "Pedido avisado", "Espera ate chamar (min)", "Tempo total (min)", "Perdeu a vez", "Situacao"];
    const linhas = relCache.map((r) => [
      r.nome, r.telefone || "", r.email || "", r.aniversario || "", (idadeDe(r.aniversario) == null ? "" : idadeDe(r.aniversario)), r.pessoas,
      r.preferencial ? "Preferencial" : "Normal",
      isMesona(r) ? "Sim" : "Nao",
      r.pet ? "Sim" : (r.sem_area_pet ? "Nao - sem area pet" : "Nao"),
      r.comanda || "", r.pager || "", r.mesa_numero || "",
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
    "autoFimDaFila", "somAtivo", "filaFechada", "mostrarBtnFila", "maxPessoas", "tamanhosMesa", "filasColunas", "boasVindas",
    "restaurante", "paisDDI", "mostrarMedia", "telObrigatorio", "exigirTermos",
    "termosTexto", "petAtivo", "campoSemPet", "campoEmail", "campoAniversario", "filasJuntas", "mostrarHoraEntrada", "mostrarTempoEspera",
    "campoComanda", "campoPager", "mesonaAtiva", "mesonaMin", "mesonaPrazo", "prefPrazo", "normalPrazo",
    "autoFecharAtiva", "autoFecharQtd", "autoFecharArmado", "linkAtivo", "garcomAtivo", "perguntarMesa",
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
    $("#cfgTamanhos").value = tamanhosDaCasa().join(", ");
    $("#cfgFilasColunas").value = CFG.filasColunas === false ? "lista" : "colunas";
    $("#cfgSom").value = CFG.somAtivo === false ? "nao" : "sim";

    $("#cfgMesoAtiva").value = CFG.mesonaAtiva === true ? "sim" : "nao";
    $("#cfgMesoMin").value = Number(CFG.mesonaMin) || 8;
    $("#cfgMesoPrazo").value = Number(CFG.mesonaPrazo) || 0;
    $("#cfgPrefPrazo").value = Number(CFG.prefPrazo) || 0;
    $("#cfgNormalPrazo").value = Number(CFG.normalPrazo) || 0;

    $("#cfgTelObrig").value = CFG.telObrigatorio === false ? "nao" : "sim";
    $("#cfgTermosOn").value = CFG.exigirTermos === false ? "nao" : "sim";
    $("#cfgTermosTxt").value = CFG.termosTexto || window.TERMOS_PADRAO || "";
    $("#cfgPetOn").value = CFG.petAtivo === false ? "nao" : "sim";
    $("#cfgSemPetOn").value = CFG.campoSemPet === false ? "nao" : "sim";
    $("#cfgCampoEmail").value = CFG.campoEmail || "nao";
    $("#cfgCampoAniversario").value = CFG.campoAniversario || "nao";
    $("#cfgFilasJuntas").value = CFG.filasJuntas === false ? "separadas" : "juntas";
    $("#cfgMostrarHora").value = CFG.mostrarHoraEntrada === false ? "nao" : "sim";
    $("#cfgMostrarTempo").value = CFG.mostrarTempoEspera === false ? "nao" : "sim";
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
    $("#cfgPerguntarMesa").value = CFG.perguntarMesa || "opcional";
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
      // guarda já limpo (números, sem repetir, em ordem)
      filasColunas: $("#cfgFilasColunas").value === "colunas",
      tamanhosMesa: Array.from(new Set($("#cfgTamanhos").value.split(/[^0-9]+/).map(Number)
        .filter((n) => n >= 1 && n <= 99))).sort((a, b) => a - b),
      somAtivo: $("#cfgSom").value === "sim",

      mesonaAtiva: $("#cfgMesoAtiva").value === "sim",
      mesonaMin: num("#cfgMesoMin", 2, 99, 8),
      mesonaPrazo: num("#cfgMesoPrazo", 0, 600, 20),
      prefPrazo: num("#cfgPrefPrazo", 0, 600, 0),
      normalPrazo: num("#cfgNormalPrazo", 0, 600, 0),

      telObrigatorio: $("#cfgTelObrig").value === "sim",
      exigirTermos: $("#cfgTermosOn").value === "sim",
      termosTexto: $("#cfgTermosTxt").value.trim(),
      petAtivo: $("#cfgPetOn").value === "sim",
      campoSemPet: $("#cfgSemPetOn").value === "sim",
      campoEmail: $("#cfgCampoEmail").value,
      campoAniversario: $("#cfgCampoAniversario").value,
      filasJuntas: $("#cfgFilasJuntas").value === "juntas",
      mostrarHoraEntrada: $("#cfgMostrarHora").value === "sim",
      mostrarTempoEspera: $("#cfgMostrarTempo").value === "sim",
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
      perguntarMesa: $("#cfgPerguntarMesa").value,

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
  // Quando o app é atualizado, o aparelho pode ficar com a TELA velha guardada
  // e o PROGRAMA novo. Aí os botões novos somem ou param de responder, sem erro
  // visível. Aqui detectamos isso, limpamos o que está guardado e recarregamos
  // uma vez — o usuário não precisa saber que existe "cache".
  const ELEMENTOS_ESPERADOS = [
    "tabGarcom", "mesasCard", "mesaTitulo", "mNumero",
    "sentouModal", "cfgPerguntarMesa", "editModal", "publicQuem", "tamanhoModal", "tmTamanhos", "mTamanhos",
    "queueGroups", "avgPref", "cfgFilasColunas",
    "mapaCard", "mapaPiso", "mapaEditModal", "cfgMapaBtn", "mmNumero",
    "loginScreen", "relBtn", "sairBtn",
  ];
  const LS_RECARGA = "fila_recarga_versao";

  async function telaEstaAtualizada() {
    const faltando = ELEMENTOS_ESPERADOS.filter((id) => !document.getElementById(id));
    if (!faltando.length) {
      sessionStorage.removeItem(LS_RECARGA);   // tudo certo: libera a proteção p/ a próxima vez
      return true;
    }
    console.warn("Tela desatualizada (faltam: " + faltando.join(", ") + ")");
    if (sessionStorage.getItem(LS_RECARGA) === "1") {
      // já tentamos recarregar e ainda falta: segue mesmo assim, mas avisa
      console.warn("A tela continua desatualizada. Feche e abra o app de novo.");
      return true;
    }
    sessionStorage.setItem(LS_RECARGA, "1");
    try {
      if (window.caches) {
        const chaves = await caches.keys();
        await Promise.all(chaves.map((k) => caches.delete(k)));
      }
      if (navigator.serviceWorker) {
        const reg = await navigator.serviceWorker.getRegistration();
        if (reg) await reg.unregister();
      }
    } catch (e) { console.warn("Não deu para limpar o cache:", e); }
    location.reload();
    return false;   // não continua: a página vai recarregar
  }

  async function start() {
    if (!(await telaEstaAtualizada())) return;
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

    // login (quando ligado): sem sessão, para por aqui e mostra a tela de entrar
    const dentro = await iniciarSessao();
    wireLogin();
    if (!dentro) return;
    aplicarPermissoes();
    // abre já na aba de trabalho do perfil (o ADM começa na da atendente)
    if (loginLigado()) setView(abaInicial());

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
