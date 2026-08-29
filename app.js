/* ============================================================
   Fila Fácil — Quinta do Aveiro
   App principal (funciona em MODO LOCAL e MODO NUVEM/Supabase)
   ============================================================ */
(function () {
  "use strict";

  const CFG = window.FILA_CONFIG || {};
  // FINALIZADO = comeu e foi embora. É diferente de DESISTIU (foi embora sem
  // sentar): no relatório um é atendimento cumprido, o outro é cliente perdido.
  const STATUS = { AGUARDANDO: "aguardando", CHAMADO: "chamado", SENTADO: "sentado", DESISTIU: "desistiu", FINALIZADO: "finalizado", PREVIA: "previa" };
  // Versão do programa. Aparece no rodapé das configurações: quando algo não
  // bate entre dois aparelhos, é a primeira coisa a conferir.
  //
  // Ela é LIDA do `?v=` da própria tag <script> que carregou este arquivo, em
  // vez de escrita à mão aqui. Escrita à mão, ela desandava: quem publicava
  // subia o número no index.html e no sw.js e esquecia deste, e a engrenagem
  // passava meses mostrando uma versão que não existia mais. Agora só existe
  // um número para manter — o do endereço do arquivo.
  const VERSAO = (function () {
    try {
      const s = document.currentScript ||
        Array.prototype.slice.call(document.scripts).filter((x) => /app\.js/.test(x.src)).pop();
      const m = s && s.src && s.src.match(/[?&]v=([^&]+)/);
      return m ? "v" + m[1] : "?";
    } catch (e) { return "?"; }
  })();

  // Textos padrão das mensagens. Ficam AQUI, e não espalhados como
  // `window.MSG_..._PADRAO` (que nunca existiu em lugar nenhum): sem isso a
  // engrenagem abria com o campo VAZIO e parecia que não havia mensagem
  // nenhuma configurada — quando na verdade o texto existia, escondido num
  // fallback lá no meio do código.
  const MSG_PEDIDO_PADRAO = "Olá {nome}! Seu pedido está pronto, pode retirar no balcão.";
  const MSG_PREVIA_PADRAO = "Olá {nome}! Já abriu vaga na fila de espera da {restaurante}. Pode vir até a recepção para entrar na fila.";

  const MIN_P = 1, MAX_P = 20;
  // O "máximo de pessoas" da engrenagem vale SÓ para o cliente no totem.
  // No balcão a atendente lança o tamanho real do grupo, sem teto artificial.
  const TETO_EQUIPE = 99;
  const LS_KEY = "fila_espera_v1";
  const SESSION_PIN = "fila_staff_ok";

  // Colunas que podem ainda não existir no banco do cliente.
  // Se faltarem, o app continua funcionando sem elas (e avisa nas configurações).
  const COLS_OPCIONAIS = ["chamadas_perdidas", "pet", "comanda", "pager", "sentou_em", "termos_em", "entrou_em", "sem_area_pet", "pedido_em", "mesa_numero", "email", "aniversario", "previa_em", "previa_avisado_em"];
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
  let tamanhoTravado = false; // true = a chamada saiu de uma mesa do garçom
  let grupoManual = false;  // true = o cliente está usando o contador em vez dos botões
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

  // Tamanhos de grupo mais comuns: viram os botões de "Quantas pessoas?".
  // É uma lista separada da dos tamanhos de mesa — grupo de 1 existe, mesa de 1 não.
  function tamanhosDeGrupo() {
    const bruto = Array.isArray(CFG.tamanhosGrupo) ? CFG.tamanhosGrupo
      : String(CFG.tamanhosGrupo === undefined ? "" : CFG.tamanhosGrupo).split(/[^0-9]+/);
    const nums = bruto.map(Number).filter((n) => n >= MIN_P && n <= 99);
    const unicos = Array.from(new Set(nums)).sort((a, b) => a - b);
    return unicos.length ? unicos : [1, 2, 3, 4, 5, 6];
  }

  // No totem o máximo da engrenagem vale; no balcão, não.
  function desenharTamanhosGrupo() {
    const caixa = $("#fpTamanhos");
    if (!caixa) return;
    const teto = isStaff() ? TETO_EQUIPE : (Number(CFG.maxPessoas) || MAX_P);
    const tams = tamanhosDeGrupo().filter((n) => n <= teto);
    const naLista = !grupoManual && tams.includes(Number(pessoas));
    caixa.innerHTML =
      tams.map((n) => `<button type="button" class="tm-btn${naLista && Number(pessoas) === n ? " is-sel" : ""}" data-fptam="${n}">
        <b>${n}</b><span>${n === 1 ? "pessoa" : "pessoas"}</span>
      </button>`).join("") +
      `<button type="button" class="tm-btn tm-outro${naLista ? "" : " is-sel"}" data-fptam="manual"><b>✏️</b><span>outro</span></button>`;
    $("#fpStepper").hidden = naLista;
    $("#fPessoas").textContent = pessoas;
  }

  // Abre o pop-up "que mesa vagou". A tela principal fica só com o botão.
  function abrirTamanho() {
    // se a atendente escolheu uma mesa no painel do garçom, o tamanho e o pet
    // vêm daquela mesa e ficam TRAVADOS: ela não tem como conferir os lugares
    // à distância, e um toque errado mandaria o grupo para a mesa errada
    const daMesa = mesasLivres.find((m) => m.id === mesaSelecionada);
    tamanhoTravado = !!daMesa;
    if (daMesa) {
      mesa = Math.max(MIN_P, Math.min(TETO_EQUIPE, Number(daMesa.lugares) || 2));
      const alvo = $(`input[name="mesapet"][value="${daMesa.pet ? "sim" : "nao"}"]`);
      if (alvo) alvo.checked = true;
    }
    // nunca abre no "outro"
    modoManual = false;
    if (!daMesa) mesa = valorDaLista(tamanhosDaCasa(), mesa);
    $("#tamanhoMsg").textContent = "";
    $("#staffMsg").textContent = "";
    ajustarBarraStaff();
    desenharTamanhos();
    $("#tamanhoModal").hidden = false;
  }

  function desenharTamanhos() {
    const daMesa = mesasLivres.find((m) => m.id === mesaSelecionada);
    if (tamanhoTravado && daMesa) {
      const nome = daMesa.numeros ? "Mesa " + esc(daMesa.numeros)
        : (daMesa.identificacao ? esc(daMesa.identificacao) : "Mesa lançada pelo garçom");
      $("#tmTamanhos").innerHTML = `
        <div class="tm-travado">
          <b class="tm-travado-nome">${nome}</b>
          <span class="tm-travado-info">${mesa} ${mesa === 1 ? "lugar" : "lugares"}${daMesa.pet ? " • 🐾 área pet" : ""}</span>
          <button type="button" class="tm-destravar" data-tam="destravar">✏️ corrigir</button>
        </div>`;
      $("#tmManualField").hidden = true;
      $("#mesaPetField").hidden = true;
      $("#fMesa").textContent = mesa;
      return;
    }
    $("#mesaPetField").hidden = CFG.petAtivo === false;
    $("#tmTamanhos").innerHTML =
      tamanhosDaCasa().map((n) => `<button type="button" class="tm-btn${!modoManual && Number(mesa) === n ? " is-sel" : ""}" data-tam="${n}">
        <b>${n}</b><span>${n === 1 ? "pessoa" : "pessoas"}</span>
      </button>`).join("") +
      `<button type="button" class="tm-btn tm-outro${modoManual ? " is-sel" : ""}" data-tam="manual">
        <b>✏️</b><span>outro</span>
      </button>`;
    $("#tmManualField").hidden = !modoManual;
    $("#fMesa").textContent = mesa;
  }

  function escolherTamanho(v) {
    if (v === "destravar") tamanhoTravado = false;    // correção proposital, não acidental
    else if (v === "manual") { modoManual = true; mesa = proximoDepoisDaLista(tamanhosDaCasa()); }
    else { modoManual = false; mesa = Number(v); }
    $("#tamanhoMsg").textContent = "";
    desenharTamanhos();
  }

  // Primeiro número que os botões não cobrem: com 4, 6 e 8 na lista, é 9.
  // Serve para o "outro" já abrir num valor útil em vez de repetir o atual.
  function proximoDepoisDaLista(lista, teto) {
    const maior = lista.length ? Math.max.apply(null, lista) : MIN_P;
    const limite = teto || TETO_EQUIPE;
    return Math.max(MIN_P, Math.min(limite, maior + 1));
  }

  // Ao ABRIR um pop-up nunca começamos no "outro": se o valor guardado não
  // está entre os botões, cai no primeiro da lista.
  function valorDaLista(lista, atual) {
    if (lista.includes(Number(atual))) return Number(atual);
    return lista.length ? lista[0] : Number(atual);
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
  // pedido_em entra para o totem poder anunciar "pedido pronto"; se a vitrine
  // do banco ainda for a antiga, o app cai de volta para as colunas de sempre
  const COLS_PUBLICA = "id,nome,pessoas,preferencial,status,criado_em,chamado_em,pedido_em,pet";
  const COLS_PUBLICA_ANTIGA = "id,nome,pessoas,preferencial,status,criado_em,chamado_em,pet";
  let colsPublicaEmUso = COLS_PUBLICA;
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
        const busca = async (monta) => {
          const cols = () => (equipe ? "*" : colsPublicaEmUso);
          let r = await monta(client.from(tab).select(cols()));
          if (!equipe && r.error && r.error.code === "42703" && colsPublicaEmUso !== COLS_PUBLICA_ANTIGA) {
            colsPublicaEmUso = COLS_PUBLICA_ANTIGA;
            r = await monta(client.from(tab).select(cols()));
          }
          return r;
        };
        // a antessala entra aqui junto com os ativos: ela não pode depender da
        // janela de 24h do histórico, senão quem espera desde ontem sumiria
        const ativos = await busca((q) => q
          .in("status", [STATUS.AGUARDANDO, STATUS.CHAMADO, STATUS.PREVIA])
          .order("criado_em", { ascending: true }).limit(PAGINA));
        if (ativos.error) throw ativos.error;
        const desde = new Date(Date.now() - JANELA_HIST_MS).toISOString();
        const hist = await busca((q) => q
          .gte("criado_em", desde)
          .order("criado_em", { ascending: false }).limit(PAGINA)); // do mais novo para o mais velho
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
      // O `.select("id")` no fim não é enfeite. Sem ele, um UPDATE barrado
      // pela permissão do banco volta como SUCESSO com zero linhas mexidas —
      // e o app pinta a mudança na tela, o servidor ignora, e no `refresh`
      // seguinte tudo "volta sozinho", sem erro nenhum em lugar nenhum.
      // Com o select, sabemos quantas linhas mudaram de verdade.
      async update(id, patch) {
        const res = await comFallback(
          (corpo) => client.from(T).update(corpo).eq("id", id).select("id"), patch);
        if (!res.data || !res.data.length) {
          const e = new Error("O banco não deixou gravar esta alteração (permissão).");
          e.semPermissao = true;
          throw e;
        }
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

  // ---- "Pedido pronto" no painel do totem ----
  // Quando a atendente avisa que o pedido ficou pronto, o cliente pode estar
  // longe do celular. O aviso fica à mostra por alguns minutos no totem, na
  // tela da atendente e no link que o cliente acompanha (mesmo ajuste).
  function minutosDoPedidoNoPainel() {
    const v = Number(CFG.pedidoPainelMin);
    return isNaN(v) || v < 0 ? 10 : v;
  }
  function pedidoNoPainel(r) {
    const min = minutosDoPedidoNoPainel();
    if (!r.pedido_em || !min) return false;
    const d = new Date(r.pedido_em).getTime();
    return !isNaN(d) && Date.now() - d < min * 60000;
  }
  function pedidosProntos() {
    return rows.filter(pedidoNoPainel)
      .sort((a, b) => new Date(b.pedido_em) - new Date(a.pedido_em));
  }

  // "Mesona" = grupo grande, mostrado numa lista à parte (a ordem de chamada não muda)
  function isMesona(r) {
    return CFG.mesonaAtiva === true && Number(r.pessoas) >= (Number(CFG.mesonaMin) || 8);
  }

  // Momento do último "reset" da média (guardado neste aparelho)
  function getMediaReset() {
    return localStorage.getItem("fila_media_reset") || "1970-01-01T00:00:00.000Z";
  }
  // ---- Tempo de espera: MEDIANA das chamadas recentes ----
  // A média não servia. Um grupo de 8 que esperou 90min puxava sozinho o número
  // de um salão inteiro, e o resultado (uns "25min") não acontecia com ninguém:
  // ficava no meio do caminho entre os 10min de quem senta rápido e os 40min de
  // quem espera mesa grande. A mediana é o valor DO MEIO — o caso extremo entra
  // na conta, mas não desloca o número.
  //
  // Só as últimas chamadas entram: às 21h a espera das 18h não diz mais nada.
  const JANELA_ESPERA = 10;

  // Quantos minutos cada um esperou, do mais recente para trás.
  // `filtro` recorta uma fila só (mesona, preferencial, normal).
  function esperasRecentes(filtro) {
    const rp = new Date(getMediaReset()).getTime();
    let done = rows.filter((r) => r.chamado_em && new Date(r.chamado_em).getTime() >= rp);
    if (filtro) done = done.filter(filtro);
    return done
      .sort((a, b) => new Date(b.chamado_em) - new Date(a.chamado_em))
      .slice(0, JANELA_ESPERA)
      .map((r) => Math.max(0, new Date(r.chamado_em) - new Date(entradaEm(r))));
  }

  // Percentil de uma lista já ordenada (0.5 = mediana), com interpolação
  function percentil(ordenada, p) {
    if (!ordenada.length) return null;
    const i = (ordenada.length - 1) * p;
    const baixo = Math.floor(i), alto = Math.ceil(i);
    if (baixo === alto) return ordenada[baixo];
    return ordenada[baixo] + (ordenada[alto] - ordenada[baixo]) * (i - baixo);
  }

  // Mediana + faixa (p25–p75) da espera. Devolve null enquanto não houver
  // nenhuma chamada para medir.
  //
  // Com gente na fila o número TEM de subir, e as chamadas já feitas sozinhas
  // não fazem isso: elas são passado. Quem está esperando agora é o presente.
  // Então quem ainda aguarda entra como PISO, não como mais um voto: se metade
  // da fila já espera há 25min, a espera típica não pode ser menor que isso —
  // essas pessoas são a prova viva de que não é. Como o piso é a mediana da
  // fila (e não o recordista), um grupo grande que espera há horas continua
  // sem mandar no número.
  //
  // A faixa inteira sobe junto, mantendo a largura: o que muda é o patamar,
  // não a incerteza.
  function esperaStats(filtro) {
    const feitas = esperasRecentes(filtro);
    if (!feitas.length) return null;
    const base = feitas.slice().sort((a, b) => a - b);
    const meio = percentil(base, 0.5);

    const agora = Date.now();
    let esperando = waiting();
    if (filtro) esperando = esperando.filter(filtro);
    const emCurso = esperando
      .map((r) => Math.max(0, agora - new Date(entradaEm(r)).getTime()))
      .sort((a, b) => a - b);
    const piso = emCurso.length ? percentil(emCurso, 0.5) : 0;
    const desloc = Math.max(0, piso - meio);

    return {
      meio: meio + desloc,
      min: percentil(base, 0.25) + desloc,
      max: percentil(base, 0.75) + desloc,
      n: feitas.length,
    };
  }

  // Um número só (a mediana), para as linhas de cada fila
  function avgWaitMs(filtro) {
    const s = esperaStats(filtro);
    return s ? s.meio : null;
  }

  // Faixa "~20–35min" para o cliente: honesta com a variação, e não vira a
  // promessa que um número cravado vira. Se as duas pontas caem no mesmo
  // valor arredondado, mostra um número só em vez de "~20–20min".
  function esperaTexto(faixa) {
    const s = esperaStats();
    if (!s) return "—";
    if (!faixa) return "~" + fmtElapsed(s.meio);
    const a = fmtElapsed(s.min), b = fmtElapsed(s.max);
    if (a === b) return "~" + a;
    // as duas pontas abaixo de 1h viram "~20–35min" (a unidade uma vez só)
    if (a.endsWith("min") && b.endsWith("min")) return "~" + a.replace("min", "") + "–" + b;
    return "~" + a + "–" + b;
  }
  // Zera a contagem da espera (a fila e as pessoas não são afetadas)
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

  // Quantos grupos ainda dá para sentar, dadas as mesas que sobram.
  // Guloso: começa pela MENOR mesa e coloca nela o MAIOR grupo que couber.
  // Não é a divisão perfeita de todos os casos, mas acerta o que importa aqui:
  // não gastar a mesa grande com um grupo pequeno quando existe mesa pequena.
  function quantosSentam(mesas, grupos) {
    const livres = mesas.slice().sort((a, b) => a.lugares - b.lugares);
    const fila = grupos.slice();
    let n = 0;
    for (const mesa of livres) {
      let melhor = -1;
      for (let i = 0; i < fila.length; i++) {
        const g = fila[i];
        if (Number(g.pessoas) > mesa.lugares) continue;
        if (!cabeNaMesa(g, mesa.pet)) continue;
        if (melhor < 0 || Number(g.pessoas) > Number(fila[melhor].pessoas)) melhor = i;
      }
      if (melhor >= 0) { fila.splice(melhor, 1); n++; }
    }
    return n;
  }

  // Menor mesa da casa que serve um grupo deste tamanho. Um casal não pode
  // ficar esperando para sempre porque a casa não tem mesa de 2: se a menor
  // mesa é de 4, é para a de 4 que ele vai.
  function mesaMinimaPara(p) {
    const tam = tamanhosDaCasa().slice().sort((a, b) => a - b);
    const t = tam.find((n) => n >= Number(p));
    return t === undefined ? null : t;
  }

  // Este grupo pode ser chamado para uma mesa de x lugares?
  function serveNaMesa(r, x, regra) {
    const p = Number(r.pessoas);
    if (p === x) return true;
    if (p > x) return false;
    if (regra === "ate") return true;         // a casa aceita grupo menor
    return mesaMinimaPara(p) === x;           // ou é a menor mesa que serve ele
  }

  function pickNext(x, excludeId, mesaAceitaPet) {
    const regra = CFG.regraTamanho || "exato";
    const wait = waiting()
      .filter((r) => (excludeId ? r.id !== excludeId : true))
      .filter((r) => cabeNaMesa(r, mesaAceitaPet))
      .filter((r) => serveNaMesa(r, x, regra));
    if (!wait.length) return null;

    // QUEM ESPERA HÁ MAIS TEMPO VAI PRIMEIRO. É a regra que a casa enxerga da
    // porta: não adianta o tamanho bater se tem gente há muito mais tempo em pé.
    // A alternância preferencial/normal da engrenagem virou desempate: só entra
    // quando duas pessoas entraram no mesmo instante.
    const querPref = wantPreferential();
    const ordenados = wait.slice().sort((a, b) => {
      const t = new Date(entradaEm(a)) - new Date(entradaEm(b));
      if (t) return t;
      const pa = a.preferencial ? 1 : 0, pb = b.preferencial ? 1 : 0;
      return querPref ? pb - pa : pa - pb;
    });
    const escolhido = ordenados[0];

    // ANTES de confirmar, olha as OUTRAS mesas livres: dar esta mesa ao grupo
    // errado pode deixar um grupo grande sem mesa nenhuma. Exemplo real:
    // mesas de 12 e 10 livres, grupos de 10 e 11. Chamando o de 10 para a de
    // 12, o de 11 não cabe em lugar nenhum. Chamando o de 11, os dois sentam.
    const outras = mesasLivres.filter((m) => m.id !== mesaSelecionada && !m.reservada_para);
    if (!outras.length) return escolhido;

    const semEle = (g) => ordenados.filter((r) => r.id !== g.id);
    let melhor = escolhido;
    let melhorTotal = 1 + quantosSentam(outras, semEle(escolhido));
    for (const g of ordenados) {
      if (g.id === escolhido.id) continue;
      const total = 1 + quantosSentam(outras, semEle(g));
      // só troca se atender MAIS grupos; empate mantém quem espera há mais tempo
      if (total > melhorTotal) { melhor = g; melhorTotal = total; }
    }
    return melhor;
  }

  // Quantos grupos do tamanho certo ficaram de fora só por causa do pet?
  // (serve para explicar à atendente por que "não achou ninguém")
  function barradosPorPet(x, mesaAceitaPet) {
    const regra = CFG.regraTamanho || "exato";
    return waiting().filter((r) => serveNaMesa(r, x, regra) && !cabeNaMesa(r, mesaAceitaPet)).length;
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
      // cadastrado pela aba da antessala? entra como 'previa': fica guardado,
      // mas fora da fila de verdade até alguém promovê-lo
      status: naAbaPrevia() ? STATUS.PREVIA : STATUS.AGUARDANDO,
      previa_em: naAbaPrevia() ? agora : null,
      criado_em: agora,
      entrou_em: agora,
      chamado_em: null,
      sentou_em: null,
      termos_em: aceitouTermos ? agora : null,
    };
    let salvo = null;
    try {
      salvo = await backend.add(entry);
      marcarSemRede(false);
    } catch (e) {
      // Internet fora não pode custar um cliente. Guarda no aparelho e segue:
      // a pessoa entra na fila normalmente e o envio acontece quando voltar.
      console.warn("Entrada guardada para reenvio:", e && e.message);
      guardarNoOutbox(entry);
      marcarSemRede(true);
      rows = rows.concat([Object.assign({ _pendente: true }, entry)]);
      render();
      return entry;
    }
    await refresh();                   // o refresh é que grava a cópia em arquivo
    return salvo || entry;
  }

  // ==========================================================
  //  FILA DE REENVIO (quando a internet cai)
  // ----------------------------------------------------------
  //  Só para ENTRADAS na fila, de propósito. Cada entrada tem código próprio
  //  e hora de chegada, então quando enfim chega ao banco ela se ordena
  //  sozinha, mesmo tendo saído de outro aparelho — não atropela ninguém.
  //
  //  Chamar e sentar ficam de fora: reenviar um "sentou" de dez minutos atrás
  //  poderia desfazer o que outra pessoa fez nesse meio-tempo. Perder uma
  //  chamada é chato; ressuscitar um estado velho é pior.
  // ==========================================================
  const LS_OUTBOX = "fila_outbox";
  let semRede = false;

  function lerOutbox() {
    try { return JSON.parse(localStorage.getItem(LS_OUTBOX)) || []; }
    catch (e) { return []; }
  }
  function escreverOutbox(arr) {
    try { localStorage.setItem(LS_OUTBOX, JSON.stringify(arr)); } catch (e) { /* ignora */ }
  }
  function guardarNoOutbox(entry) {
    const fila = lerOutbox();
    if (!fila.some((x) => x.id === entry.id)) fila.push(entry);
    escreverOutbox(fila);
    pintarSemRede();
  }

  // A faixa fica ENQUANTO durar o problema — não some sozinha em 6 segundos
  // como os outros avisos. A atendente precisa saber que está trabalhando
  // sem rede o tempo todo, não só no instante da falha.
  function marcarSemRede(v) {
    if (semRede === !!v) return;
    semRede = !!v;
    pintarSemRede();
  }
  function pintarSemRede() {
    const b = $("#semRedeBanner");
    if (!b) return;
    const presos = lerOutbox().length;
    b.hidden = !semRede && !presos;
    if (b.hidden) return;
    b.textContent = presos
      ? `⚠ Sem ligação com o servidor — ${presos} ${presos === 1 ? "cadastro guardado" : "cadastros guardados"} neste aparelho. Enviamos sozinho quando a internet voltar.`
      : "⚠ Sem ligação com o servidor — a tela pode estar desatualizada.";
  }

  // Tenta esvaziar a fila de reenvio. Roda a cada `refresh` e quando o
  // navegador avisa que a rede voltou.
  let reenviando = false;
  async function reenviarOutbox() {
    if (reenviando) return;
    const fila = lerOutbox();
    if (!fila.length) return;
    reenviando = true;
    try {
      const sobraram = [];
      for (const entry of fila) {
        try {
          await backend.add(entry);
        } catch (e) {
          sobraram.push(entry);       // ainda sem rede: continua guardado
        }
      }
      escreverOutbox(sobraram);
      if (!sobraram.length) {
        marcarSemRede(false);
        avisoStaff("✅ Os cadastros guardados foram enviados.", true);
        await refresh();
      }
      pintarSemRede();
    } finally {
      reenviando = false;
    }
  }

  // ==========================================================
  //  CÓPIA EM ARQUIVO (só no computador do administrador)
  // ----------------------------------------------------------
  //  Uma linha de CSV no disco a cada cliente que entra na fila — rede de
  //  segurança para abrir no Excel se algum dia faltar acesso ao banco.
  //
  //  Página da web não escreve em arquivo do sistema por conta própria. A
  //  File System Access API resolve: o administrador escolhe o arquivo UMA
  //  vez, autoriza, e o app passa a acrescentar linhas nele. Existe só no
  //  Chrome/Edge de computador — em tablet e celular a API não existe e o
  //  recurso nem aparece na tela.
  // ==========================================================
  const temArquivoLocal = () => typeof window.showSaveFilePicker === "function";
  const LS_BACKUP_NOME = "fila_backup_nome";
  let arquivoBackup = null;    // FileSystemFileHandle escolhido pelo administrador

  // O "endereço" do arquivo não cabe no localStorage (não é texto): vai para o
  // IndexedDB, que guarda objetos de verdade.
  function bancoDoBackup() {
    return new Promise((ok, erro) => {
      const req = indexedDB.open("fila_backup", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("handles");
      req.onsuccess = () => ok(req.result);
      req.onerror = () => erro(req.error);
    });
  }
  async function guardarArquivoBackup(h) {
    const db = await bancoDoBackup();
    await new Promise((ok, erro) => {
      const t = db.transaction("handles", "readwrite");
      t.objectStore("handles").put(h, "arquivo");
      t.oncomplete = ok;
      t.onerror = () => erro(t.error);
    });
  }
  async function lerArquivoBackup() {
    try {
      const db = await bancoDoBackup();
      return await new Promise((ok) => {
        const t = db.transaction("handles", "readonly");
        const r = t.objectStore("handles").get("arquivo");
        r.onsuccess = () => ok(r.result || null);
        r.onerror = () => ok(null);
      });
    } catch (e) { return null; }
  }

  // `pedir: false` só confere (pode rodar a qualquer momento);
  // `pedir: true` abre o pedido do navegador, que exige um clique da pessoa.
  async function permissaoDoArquivo(pedir) {
    if (!arquivoBackup) return false;
    const opc = { mode: "readwrite" };
    try {
      if ((await arquivoBackup.queryPermission(opc)) === "granted") return true;
      if (!pedir) return false;
      return (await arquivoBackup.requestPermission(opc)) === "granted";
    } catch (e) { return false; }
  }

  const CAB_BACKUP = ["Entrou", "Nome", "Telefone", "Pessoas", "Tipo", "Pet", "Comanda", "Pager", "Código"];

  // Acrescenta no FIM do arquivo, sem apagar o que já estava
  async function escreverNoArquivo(texto) {
    if (!arquivoBackup) return false;
    try {
      const f = await arquivoBackup.getFile();
      const w = await arquivoBackup.createWritable({ keepExistingData: true });
      await w.write({ type: "write", position: f.size, data: texto });
      await w.close();
      return true;
    } catch (e) {
      console.warn("Cópia em arquivo:", e);
      return false;
    }
  }

  async function escolherArquivoBackup() {
    if (!temArquivoLocal()) return;
    try {
      const h = await window.showSaveFilePicker({
        suggestedName: "fila-backup.csv",
        types: [{ description: "Planilha CSV", accept: { "text/csv": [".csv"] } }],
      });
      arquivoBackup = h;
      await guardarArquivoBackup(h);
      localStorage.setItem(LS_BACKUP_NOME, h.name || "");
      // arquivo novo (ou vazio) começa pelo cabeçalho das colunas.
      // O BOM faz o Excel abrir os acentos certos.
      const f = await h.getFile();
      if (!f.size) await escreverNoArquivo("﻿" + CAB_BACKUP.join(";") + "\n");
      // a cópia vale a partir de AGORA: sem isto, escolher o arquivo
      // despejaria as últimas 24 horas de fila de uma vez só
      localStorage.setItem(LS_BACKUP_DESDE, String(Date.now()));
      localStorage.removeItem(LS_BACKUP_IDS);
      atualizarSeloBackup();
      varrerParaOArquivo();
    } catch (e) {
      // a pessoa fechou o seletor: não é erro
    }
  }

  async function desligarArquivoBackup() {
    arquivoBackup = null;
    localStorage.removeItem(LS_BACKUP_NOME);
    try { await guardarArquivoBackup(null); } catch (e) { /* ignora */ }
    atualizarSeloBackup();
  }

  function linhaDoBackup(r) {
    return [
      fmtDataHora(entradaEm(r)), r.nome, r.telefone || "", r.pessoas,
      r.preferencial ? "Preferencial" : "Normal",
      r.pet ? "Sim" : "Não", r.comanda || "", r.pager || "", r.id,
    ].map(csvCampo).join(";") + "\n";
  }

  // ----------------------------------------------------------
  //  A VARREDURA
  // ----------------------------------------------------------
  //  Antes eu gravava a linha no momento do cadastro — e isso só funcionava
  //  para quem entrava PELO PRÓPRIO computador. Cliente cadastrado no celular
  //  da atendente ou no totem nunca chegava ao arquivo, que é justamente o
  //  contrário do que um backup serve.
  //
  //  Agora o computador grava o que ele VÊ CHEGAR: a cada leitura da fila,
  //  quem ainda não foi gravado entra no arquivo, tenha vindo de onde vier.
  //  Como o app já recarrega em tempo real, a linha sai em um ou dois
  //  segundos — e se o PC estava desligado na hora, ele grava quando abrir.
  const LS_BACKUP_IDS = "fila_backup_ids";       // quem já foi para o arquivo
  const LS_BACKUP_DESDE = "fila_backup_desde";   // quando a cópia foi ligada
  let varrendoBackup = false;

  function idsGravados() {
    try { return new Set(JSON.parse(localStorage.getItem(LS_BACKUP_IDS)) || []); }
    catch (e) { return new Set(); }
  }
  function guardarIdsGravados(s) {
    // não deixa a lista crescer para sempre: só os últimos importam, porque
    // a fila de ontem já não volta a aparecer
    const arr = Array.from(s).slice(-800);
    try { localStorage.setItem(LS_BACKUP_IDS, JSON.stringify(arr)); } catch (e) { /* ignora */ }
  }

  async function varrerParaOArquivo() {
    if (varrendoBackup || !arquivoBackup || !ehAdm()) return;
    if (!(await permissaoDoArquivo(false))) { atualizarSeloBackup(); return; }
    varrendoBackup = true;
    try {
      // só o que entrou DEPOIS de a cópia ser ligada: senão, ao escolher o
      // arquivo, ele despejaria as últimas 24 horas de uma vez
      const desde = Number(localStorage.getItem(LS_BACKUP_DESDE) || 0);
      const feitos = idsGravados();
      const novos = rows
        .filter((r) => !feitos.has(r.id) && new Date(entradaEm(r)).getTime() >= desde)
        .sort((a, b) => new Date(entradaEm(a)) - new Date(entradaEm(b)));
      if (!novos.length) return;
      if (await escreverNoArquivo(novos.map(linhaDoBackup).join(""))) {
        novos.forEach((r) => feitos.add(r.id));
        guardarIdsGravados(feitos);
      } else {
        atualizarSeloBackup();
      }
    } catch (e) {
      console.warn("Cópia em arquivo:", e);
    } finally {
      varrendoBackup = false;
    }
  }

  // O selo do cabeçalho conta o que está acontecendo: verde = gravando,
  // cadeado = precisa de um clique para reativar. Sem isso a atendente não
  // teria como saber que a cópia parou.
  async function atualizarSeloBackup() {
    const b = $("#backupBtn");
    if (!b) return;
    if (!temArquivoLocal() || !ehAdm() || !arquivoBackup) { b.hidden = true; return; }
    b.hidden = false;
    const ok = await permissaoDoArquivo(false);
    const nome = localStorage.getItem(LS_BACKUP_NOME) || "arquivo";
    b.classList.toggle("is-off", !ok);
    b.textContent = ok ? "💾" : "🔒";
    b.title = ok
      ? "Cópia em arquivo ativa: " + nome
      : "Cópia em arquivo pausada — toque para reativar (" + nome + ")";
  }

  // ==========================================================
  //  PAGER POR RÁDIO (ESP32-C3 + CC1101)
  // ----------------------------------------------------------
  //  A base é o ESP32 com o rádio. Ela NÃO fala com esta página direto: o
  //  app roda em HTTPS e o navegador bloqueia chamada para a rede local.
  //  Então a conversa é pelo Supabase — aqui a gente escreve ordens, a base
  //  lê, executa e escreve de volta o que ouviu.
  //
  //  Enquanto o rádio não chega, esta tela já funciona: ela só não vai ver
  //  a base acender nem receber captura nenhuma.
  // ==========================================================
  let pagers = [];             // { numero, codigo }
  let capturas = [];           // o que a base ouviu e ainda não tem dono
  let pagerCanais = [];        // assinaturas de tempo real, para desligar depois
  let pagerRelogio = null;
  let pagerSemTabela = false;

  const cli = () => (backend && backend.client) || null;

  // A base carimba `visto_em` a cada consulta. Se o carimbo é recente, ela
  // está viva — é o "ela está aí?" sem precisar de ping nenhum.
  function baseViva(estado) {
    if (!estado || !estado.visto_em) return false;
    return Date.now() - new Date(estado.visto_em).getTime() < 15000;
  }

  async function abrirPager() {
    if (!cli()) { avisoStaff("⚠ O pager precisa do Supabase ligado."); return; }
    pagerSemTabela = false;
    $("#pgMsg").textContent = "";
    $("#pagerModal").hidden = false;
    await recarregarPager();
    ligarTempoRealDoPager();
    clearInterval(pagerRelogio);
    pagerRelogio = setInterval(lerEstadoDaBase, 5000);   // a luz da base
  }

  function fecharPager() {
    clearInterval(pagerRelogio);
    pagerRelogio = null;
    pagerCanais.forEach((c) => { try { cli().removeChannel(c); } catch (e) { /* ignora */ } });
    pagerCanais = [];
    // deixar a base escutando para sempre gastaria bateria e encheria a
    // tabela de lixo: fechou a tela, para a escuta
    mandarComando("parar").catch(() => { /* silencioso */ });
  }

  async function recarregarPager() {
    try {
      const [p, c] = await Promise.all([
        cli().from("fila_pagers").select("numero,tipo,codigo").order("numero"),
        cli().from("fila_pager_capturas").select("id,tipo,codigo,criado_em")
          .order("criado_em", { ascending: false }).limit(20),
      ]);
      if (p.error) throw p.error;
      if (c.error) throw c.error;
      pagers = p.data || [];
      capturas = c.data || [];
      renderPager();
      await lerEstadoDaBase();
    } catch (e) {
      // 42P01 = tabela não existe: é o caso de quem ainda não rodou o SQL
      pagerSemTabela = e && (e.code === "42P01" || /does not exist/i.test(e.message || ""));
      $("#pgSemTabela").hidden = !pagerSemTabela;
      if (!pagerSemTabela) console.warn("Pager:", e);
    }
  }

  async function lerEstadoDaBase() {
    if (pagerSemTabela || !cli() || $("#pagerModal").hidden) return;
    try {
      const { data } = await cli().from("fila_pager_estado")
        .select("modo,visto_em,detalhe").eq("id", 1).maybeSingle();
      pintarEstadoDaBase(data);
    } catch (e) { pintarEstadoDaBase(null); }
  }

  function pintarEstadoDaBase(estado) {
    const viva = baseViva(estado);
    const escutando = viva && estado.modo === "escutando";
    $("#pgLuz").className = "pg-luz" + (viva ? (escutando ? " is-escuta" : " is-on") : "");
    $("#pgBaseTxt").textContent = !viva
      ? "Base não encontrada — confira se o ESP32 está ligado e na internet."
      : (escutando ? "Base conectada — escutando o transmissor…" : "Base conectada e pronta.");
    $("#pgEscutar").hidden = escutando;
    $("#pgParar").hidden = !escutando;
  }

  // Toda ordem para a base é uma linha nesta tabela. Ela consome na ordem.
  async function mandarComando(acao, numero, motivo, dados) {
    if (pagerSemTabela || !cli()) return;
    const { error } = await cli().from("fila_pager_comandos")
      .insert({ acao, numero: numero || null, motivo: motivo || null, dados: dados || null });
    if (error) throw error;
  }

  // ----------------------------------------------------------
  //  O DISPARO AUTOMÁTICO
  // ----------------------------------------------------------
  //  É isto que liga a fila ao rádio. Chamou a mesa, o pager toca; avisou o
  //  pedido, o pager toca de novo — com a mensagem certa para cada caso.
  //
  //  Nunca atrapalha o serviço: se o cliente não tem pager, se as tabelas
  //  não existem ou se o Supabase engasgou, isto some em silêncio. A
  //  chamada da mesa já foi gravada antes de chegar aqui.
  //
  //  Acentos saem fora: a tela do pager desenha com a fonte do Adafruit_GFX,
  //  que não tem acentuado — "José" viraria lixo no display. Tirar aqui é
  //  melhor do que no aparelho, que é o lado difícil de reprogramar depois.
  function semAcentoParaTela(s) {
    return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "");
  }

  function dispararPager(r, motivo) {
    try {
      const numero = String((r && r.pager) || "").trim();
      if (!numero || !cli() || pagerSemTabela) return;
      const dados = {
        nome: semAcentoParaTela(firstName(r.nome)).slice(0, 19),
        mesa: String(r.mesa_numero || "").slice(0, 7),
        pessoas: Number(r.pessoas) || 0,
      };
      mandarComando("tocar", numero, motivo, dados)
        .catch((e) => console.warn("Pager não acionado:", e && e.message));
    } catch (e) {
      console.warn("Pager não acionado:", e);
    }
  }

  function recadoPager(txt, erro) {
    const m = $("#pgMsg");
    if (!m) return;
    m.textContent = txt;
    m.className = "form-msg" + (erro ? " err" : " ok");
    clearTimeout(recadoPager._t);
    recadoPager._t = setTimeout(() => { m.textContent = ""; }, 4000);
  }

  function renderPager() {
    // --- capturas sem dono ---
    $("#pgCapturasVazio").hidden = capturas.length > 0;
    $("#pgCapturas").innerHTML = capturas.map((c) => `
      <div class="pg-cap" data-cap="${c.id}">
        <span class="pg-cap-cod">
          <b>${esc(c.codigo)}</b>
          <small>ouvido às ${fmtClock(c.criado_em)}</small>
        </span>
        <input class="pg-cap-num" type="text" maxlength="8" inputmode="numeric"
               placeholder="nº do pager" data-capnum="${c.id}" />
        <button type="button" class="btn btn-sm btn-primary" data-capsalvar="${c.id}">Salvar</button>
        <button type="button" class="btn btn-sm btn-ghost btn-danger" data-capapagar="${c.id}">✕</button>
      </div>`).join("");

    // --- cadastrados ---
    $("#pgCount").textContent = pagers.length;
    $("#pgListaVazio").hidden = pagers.length > 0;
    $("#pgLista").innerHTML = pagers.map((p) => `
      <div class="pg-item">
        <span class="pg-num">${esc(p.numero)}</span>
        <span class="pg-tipo ${p.tipo === "proprio" ? "is-proprio" : ""}">${
          p.tipo === "proprio" ? "📟 com tela" : "📡 433MHz"}</span>
        <span class="pg-cod">${p.tipo === "proprio" ? "chamado pelo número" : esc(p.codigo || "—")}</span>
        <button type="button" class="btn btn-sm btn-accent" data-pgtocar="${esc(p.numero)}">🔔 Tocar</button>
        <button type="button" class="btn btn-sm btn-ghost btn-danger" data-pgapagar="${esc(p.numero)}">🗑</button>
      </div>`).join("");
  }

  // Dar número a uma captura: vira pager cadastrado e sai da lista de cima
  async function salvarCaptura(id) {
    const campo = document.querySelector(`[data-capnum="${id}"]`);
    const numero = (campo ? campo.value : "").trim();
    if (!numero) { recadoPager("Digite o número do pager.", true); campo && campo.focus(); return; }
    const cap = capturas.find((c) => c.id === id);
    if (!cap) return;
    if (pagers.some((p) => p.numero === numero) &&
        !confirm(`O pager ${numero} já tem um código. Trocar pelo novo?`)) return;
    try {
      const { error } = await cli().from("fila_pagers")
        .upsert({ numero, codigo: cap.codigo }, { onConflict: "numero" });
      if (error) throw error;
      await cli().from("fila_pager_capturas").delete().eq("id", id);
      await recarregarPager();
      recadoPager(`✅ Pager ${numero} guardado.`);
    } catch (e) {
      console.warn(e);
      recadoPager("Não deu para guardar. Tente de novo.", true);
    }
  }

  // O pager com tela não aprende código: ele é chamado pelo número, via
  // ESP-NOW. Por isso ele se cadastra direto, sem passar pela escuta.
  async function cadastrarPagerProprio() {
    const campo = $("#pgProprioNum");
    const numero = (campo.value || "").trim();
    if (!numero) { recadoPager("Digite o número do aparelho.", true); campo.focus(); return; }
    if (pagers.some((p) => p.numero === numero) &&
        !confirm(`Já existe um pager ${numero}. Trocar para "com tela"?`)) return;
    try {
      const { error } = await cli().from("fila_pagers")
        .upsert({ numero, tipo: "proprio", codigo: null }, { onConflict: "numero" });
      if (error) throw error;
      campo.value = "";
      await recarregarPager();
      recadoPager(`✅ Pager ${numero} (com tela) cadastrado.`);
    } catch (e) {
      console.warn(e);
      recadoPager("Não deu para cadastrar. Tente de novo.", true);
    }
  }

  async function tocarPager(numero) {
    const n = String(numero || "").trim();
    if (!n) { recadoPager("Digite o número do pager.", true); return; }
    if (!pagers.some((p) => p.numero === n)) {
      recadoPager(`O pager ${n} ainda não foi aprendido — capture o código dele primeiro.`, true);
      return;
    }
    try {
      await mandarComando("tocar", n);
      recadoPager(`🔔 Ordem enviada para o pager ${n}.`);
    } catch (e) {
      console.warn(e);
      recadoPager("Não deu para enviar a ordem.", true);
    }
  }

  // Tempo real: a captura tem que aparecer no instante em que você aperta a
  // tecla do transmissor. Recarregar de 5 em 5s daria a impressão de travado.
  function ligarTempoRealDoPager() {
    if (pagerSemTabela || !cli() || pagerCanais.length) return;
    try {
      pagerCanais.push(cli().channel("pager-cap-rt")
        .on("postgres_changes", { event: "*", schema: "public", table: "fila_pager_capturas" },
          () => { if (!$("#pagerModal").hidden) recarregarPager(); })
        .subscribe());
      pagerCanais.push(cli().channel("pager-estado-rt")
        .on("postgres_changes", { event: "*", schema: "public", table: "fila_pager_estado" },
          (p) => pintarEstadoDaBase(p.new))
        .subscribe());
    } catch (e) { console.warn("Pager em tempo real:", e); }
  }

  // ==========================================================
  //  QR CODE FIXO DO BALCÃO
  // ----------------------------------------------------------
  //  O link pessoal (fila.html?id=...) continua existindo. Este é o segundo
  //  caminho: um QR só, impresso e colado no balcão, que abre a mesma página
  //  SEM código. Lá o cliente digita o próprio telefone e vê a vez dele.
  //  Como não leva o código de ninguém, o mesmo papel serve para o dia todo
  //  e para sempre.
  // ==========================================================
  function linkDoQrFixo() { return publicUrl(null); }

  function desenharQrFixo() {
    const box = $("#cfgQrFixo");
    if (!box) return;
    const url = linkDoQrFixo();
    drawQR(box, url);
    const t = $("#cfgQrLink");
    if (t) t.textContent = url;
  }

  // Baixa em PNG grande: é o formato que entra no Word, no Canva e na gráfica
  // sem ninguém perguntar nada. 1024px imprime nítido num quadrado de 10cm.
  function baixarQrFixo() {
    const svg = $("#cfgQrFixo") && $("#cfgQrFixo").querySelector("svg");
    if (!svg) { avisoStaff("⚠ O QR ainda não foi desenhado. Feche e abra as configurações."); return; }
    const LADO = 1024;
    const texto = new XMLSerializer().serializeToString(svg);
    const urlSvg = URL.createObjectURL(new Blob([texto], { type: "image/svg+xml;charset=utf-8" }));
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = c.height = LADO;
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#fff";                 // fundo branco: QR não lê em transparente
      ctx.fillRect(0, 0, LADO, LADO);
      ctx.drawImage(img, 0, 0, LADO, LADO);
      URL.revokeObjectURL(urlSvg);
      c.toBlob((blob) => {
        if (!blob) { avisoStaff("⚠ Não deu para gerar a imagem."); return; }
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "qr-fila-" + (CFG.restaurante || "balcao").toLowerCase().replace(/[^a-z0-9]+/g, "-") + ".png";
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      }, "image/png");
    };
    img.onerror = () => { URL.revokeObjectURL(urlSvg); avisoStaff("⚠ Não deu para gerar a imagem do QR."); };
    img.src = urlSvg;
  }

  // Como a seção aparece dentro da engrenagem
  async function mostrarEstadoDoBackup() {
    const campo = $("#cfgBackupField");
    if (!campo) return;
    // navegador sem a API (tablet, celular, Firefox): a seção some inteira,
    // melhor do que um botão que não faz nada
    campo.hidden = !temArquivoLocal() || !ehAdm();
    if (campo.hidden) return;
    const nome = localStorage.getItem(LS_BACKUP_NOME) || "";
    const ligado = !!arquivoBackup;
    $("#cfgBackupDesligar").hidden = !ligado;
    $("#cfgBackupEscolher").textContent = ligado ? "📄 Trocar de arquivo" : "📄 Escolher o arquivo";
    const ok = ligado && await permissaoDoArquivo(false);
    $("#cfgBackupEstado").textContent = !ligado
      ? "Nenhum arquivo escolhido — a cópia está desligada."
      : (ok ? "✅ Gravando em " + nome : "🔒 " + nome + " — toque no 🔒 do cabeçalho para reativar.");
  }

  async function reativarBackup() {
    if (await permissaoDoArquivo(true)) avisoStaff("💾 Cópia em arquivo reativada.", true);
    atualizarSeloBackup();
  }

  async function callPerson(id, extras) {
    await backend.update(id, Object.assign({
      status: STATUS.CHAMADO,
      chamado_em: new Date().toISOString(),
    }, extras || {}));
    // grava primeiro, avisa depois: a notificação nunca sai de uma chamada
    // que não foi registrada
    avisarNoCelular(id, "chamada");
    // e o pager de rádio, se este cliente estiver com um
    const quem = rows.find((x) => x.id === id);
    if (quem) dispararPager(Object.assign({}, quem, extras || {}), "chamada");
  }
  // Pinta a mudança na tela ANTES de o servidor responder. A gravação segue
  // acontecendo; se ela falhar, o `refresh` seguinte devolve a verdade do
  // banco. Sem isto, a atendente fica olhando para um botão travado enquanto
  // a internet do restaurante decide se colabora.
  function pintarLocal(id, patch) {
    const r = rows.find((x) => x.id === id);
    if (r) Object.assign(r, patch);
    render();
  }

  // `opcoes.semEsperar` devolve a gravação em vez de esperar por ela: quem
  // chamou junta com as outras gravações e espera todas de uma vez só.
  async function seatPerson(id, mesaNumero, opcoes) {
    const patch = { status: STATUS.SENTADO, sentou_em: new Date().toISOString() };
    if (mesaNumero !== undefined) patch.mesa_numero = (mesaNumero || "").trim() || null;
    pintarLocal(id, patch);
    const gravando = backend.update(id, patch);
    if (opcoes && opcoes.semEsperar) return gravando;
    await gravando;
    await refresh();
  }
  async function dropPerson(id) {
    const patch = { status: STATUS.DESISTIU };
    pintarLocal(id, patch);             // some da fila na hora
    const gravacoes = soltarReservaDe(id).concat(backend.update(id, patch));
    await Promise.allSettled(gravacoes);
    await refresh();
  }
  // Atendimento cumprido: o cliente comeu e foi embora. Sai da aba "Na mesa"
  // e a mesa dele deixa de aparecer ocupada no mapa (o mapa procura por quem
  // está SENTADO). No relatório continua contando como quem sentou — não é
  // desistência, é o serviço que terminou direito.
  async function finalizarAtendimento(id) {
    const patch = { status: STATUS.FINALIZADO };
    pintarLocal(id, patch);             // some da lista na hora
    const gravacoes = soltarReservaDe(id).concat(backend.update(id, patch));
    await Promise.allSettled(gravacoes);
    await refresh();
  }
  async function backToQueue(id) {
    const patch = { status: STATUS.AGUARDANDO, chamado_em: null };
    pintarLocal(id, patch);
    const gravacoes = soltarReservaDe(id).concat(backend.update(id, patch));
    await Promise.allSettled(gravacoes);
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
    const soltando = soltarReservaDe(id);   // não compareceu: a mesa volta para a lista
    await backend.updateSeStatus(id, STATUS.CHAMADO, {
      status: STATUS.AGUARDANDO,
      chamado_em: null,
      criado_em: new Date().toISOString(),          // volta para o fim da fila
      entrou_em: entradaEm(atual),                  // ...sem perder a hora real de chegada
      chamadas_perdidas: (atual.chamadas_perdidas || 0) + 1,
    });
    await Promise.allSettled(soltando);
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

  // Mesas que a atendente pode escolher na hora de chamar alguém pela lista.
  // É o caminho inverso do "tocar na mesa primeiro": ela escolhe a pessoa e
  // diz para qual mesa vai mandar. A mesa escolhida fica reservada (vermelha
  // na lista) até o cliente sentar, exatamente como no outro caminho.
  function mesasParaEscolher(chosen) {
    const livres = mesasLivres.filter((m) => !m.reservada_para);
    if (!livres.length) return "";
    const cabe = (m) => Number(m.lugares) >= Number(chosen.pessoas);
    const ordenadas = livres.slice().sort((a, b) => {
      if (cabe(a) !== cabe(b)) return cabe(a) ? -1 : 1;    // as que servem primeiro
      return Number(a.lugares) - Number(b.lugares);        // e a menor que serve, antes
    });
    return `
      <div class="cc-mesas">
        <div class="cc-mesas-tit">Qual mesa vai usar? <small>(opcional)</small></div>
        <div class="cc-mesas-lista">
          ${ordenadas.map((m) => {
            const num = String(m.numeros || m.identificacao || "").trim();
            const rotulo = num ? "Mesa " + esc(num) : "sem número";
            const sel = mesaSelecionada === m.id ? " is-sel" : "";
            return `<button type="button" class="sm-mesa${cabe(m) ? "" : " is-aperta"}${sel}"
              data-callmesa="${m.id}">
              <b class="sm-num">${rotulo}</b>
              <span class="sm-lug">${m.lugares} ${Number(m.lugares) === 1 ? "lugar" : "lugares"}</span>
              ${m.pet ? `<span class="sm-pet">🐾 área pet</span>` : ""}
            </button>`;
          }).join("")}
        </div>
      </div>`;
  }

  // Abre o pop-up de confirmação de chamada para uma pessoa escolhida
  // aceitaPet: passado quando a chamada veio do botão "Chamar mesa" (a atendente
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
      ? `<div class="cc-mesa">Mesa para ${mesa} ${mesa === 1 ? "pessoa" : "pessoas"}${aceitaPet ? " • 🐾 área pet" : ""}</div>`
      : "";
    $("#callModalBody").innerHTML = `
      <div class="cc-name">${esc(chosen.nome)} ${chosen.preferencial ? "★" : ""}</div>
      <div class="cc-meta">${chosen.pessoas} ${chosen.pessoas === 1 ? "pessoa" : "pessoas"}${chosen.preferencial ? " • Preferencial" : ""}${isMesona(chosen) ? " • 🍽 mesa grande" : ""}${selos} • entrou ${fmtClock(chosen.criado_em)} • esperando há ${fmtElapsed(Date.now() - new Date(chosen.criado_em).getTime())}</div>
      ${mesaTxt}${alerta}
      ${aceitaPet === undefined ? mesasParaEscolher(chosen) : ""}`;
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
    focoSePuder("#sentouMesa");
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

  // Acende a mesa que corresponde ao que está escrito no campo — e apaga as
  // outras. É o campo que manda: assim, apagar o número na mão desmarca a
  // mesa, que é o que qualquer um tenta fazer para voltar atrás.
  function marcarMesaDoSentou() {
    const escolhida = $("#sentouMesa").value.trim().toLowerCase();
    $$("#sentouMesas .sm-mesa").forEach((x) => {
      const num = String(x.dataset.sentoumesa || "").trim().toLowerCase();
      x.classList.toggle("is-sel", !!num && num === escolhida);
    });
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
    // Fecha o pop-up NA HORA e pinta o resultado: a confirmação é a fila
    // mudando atrás. Antes eram quatro esperas em fila indiana (gravar o
    // cliente, reler tudo, baixar a mesa, reler tudo de novo) — com internet
    // ruim isso dava vários segundos de botão travado.
    const quem = sentandoId;
    const livre = acharMesaLivrePeloNumero(numero);
    sentandoId = null;
    msg.textContent = "";
    btn.disabled = false;
    $("#sentouModal").hidden = true;

    const gravacoes = [seatPerson(quem, numero, { semEsperar: true })];
    if (livre) {
      // a mesa sai da lista de livres na mesma hora
      mesasLivres = mesasLivres.filter((m) => m.id !== livre.id);
      if (mesaSelecionada === livre.id) mesaSelecionada = null;
      renderMesas();
      gravacoes.push(backend.updateMesa(livre.id, {
        status: MESAS.USADA, usada_em: new Date().toISOString(),
      }));
    }
    const r = await Promise.allSettled(gravacoes);
    await refresh();
    if (r.some((x) => x.status === "rejected")) {
      console.error("Erro ao marcar sentou:", r.filter((x) => x.status === "rejected"));
      avisoStaff("⚠ Não deu para salvar tudo — confira se o cliente saiu da fila.");
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
  // Avisa o celular do cliente (notificação push). Quem entrega é a função
  // "avisar" no Supabase — o app só pede. Se a função não existir ainda, isto
  // falha em silêncio: o WhatsApp e o alarme da tela continuam valendo.
  async function avisarNoCelular(id, tipo) {
    try {
      if (!backend || !backend.client || !backend.client.functions) return;
      await backend.client.functions.invoke("avisar", { body: { id, tipo } });
    } catch (e) {
      console.warn("Notificação não enviada:", e && e.message);
    }
  }

  async function marcarPedido(id) {
    const patch = { pedido_em: new Date().toISOString() };
    pintarLocal(id, patch);             // o botão vira "avisado" na hora
    try {
      await backend.update(id, patch);
      avisarNoCelular(id, "pedido");
      const quem = rows.find((x) => x.id === id);
      if (quem) dispararPager(quem, "pedido");
    } catch (e) {
      console.warn("Não deu para registrar o aviso do pedido:", e);
    }
    await refresh();
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
  // O card da atendente só existe para avisos e para o botão de instalar.
  // Vazio, ele vira uma faixa branca sem sentido no meio da tela.
  function ajustarBarraStaff() {
    const card = $("#staffBar");
    if (!card) return;
    if (appEl.getAttribute("data-view") !== "staff") { card.hidden = true; return; }
    const temAviso = !!($("#staffMsg") && $("#staffMsg").textContent.trim());
    const temInstalar = !!($("#installBtn") && !$("#installBtn").hidden);
    card.hidden = !temAviso && !temInstalar;
  }

  // A faixa de avisos da atendente não pode virar mural: um "deu certo" que
  // fica na tela o dia todo só atrapalha. Confirmação some sozinha em segundos;
  // aviso de problema (sem internet, não gravou) fica até o próximo.
  let sumirAviso = null;
  function avisoStaff(txt, ok) {
    const smsg = $("#staffMsg");
    if (!smsg) return;
    smsg.textContent = txt;
    smsg.className = "form-msg " + (ok ? "ok" : "err");
    ajustarBarraStaff();
    clearTimeout(sumirAviso);
    if (ok) {
      sumirAviso = setTimeout(() => {
        smsg.textContent = "";
        ajustarBarraStaff();
      }, 6000);
    }
  }

  async function refresh() {
    try {
      // as três consultas vão JUNTAS: em sequência eram três idas ao servidor,
      // uma esperando a outra, e a tela só respondia no fim
      const [lista] = await Promise.all([backend.list(), carregarMesas(), carregarMapa()]);
      // quem ainda não conseguiu ser gravado continua aparecendo na fila:
      // para a atendente, aquela pessoa ESTÁ na fila — o problema é nosso
      const presos = lerOutbox().filter((p) => !lista.some((r) => r.id === p.id));
      rows = lista.concat(presos.map((p) => Object.assign({ _pendente: true }, p)));
      marcarSemRede(false);
      render();
      checkAutoClose();
      // grava no arquivo quem entrou na fila por QUALQUER aparelho
      varrerParaOArquivo();
      reenviarOutbox();        // a rede voltou? esvazia o que ficou preso
    } catch (e) {
      console.error("Erro ao carregar a fila:", e);
      marcarSemRede(true);
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

  // ==========================================================
  //  O MAPA APRENDE COM O GARÇOM
  // ----------------------------------------------------------
  //  Cadastrar quantas cadeiras cada mesa tem, e quais ficam na área pet, é a
  //  parte chata de montar o mapa — e é justamente o que o garçom sabe de cor.
  //  Quando ele lança uma mesa à mão, aquilo é a realidade do salão. Então o
  //  mapa se corrige sozinho: em algumas semanas de uso, ele fica certo sem
  //  ninguém ter parado para conferir mesa por mesa.
  //
  //  Uma trava importante: com mesas JUNTAS ("12 + 13") o total de lugares é
  //  do conjunto, e não dá para saber quanto é de cada uma — nesse caso só a
  //  área pet é aprendida.
  // ==========================================================
  async function mapaAprendeComOGarcom(numeros, lugares, pet) {
    if (!Array.isArray(numeros) || !numeros.length || !mapa.length) return;
    const acha = (n) => mapa.find((m) =>
      String(m.numero).trim().toLowerCase() === String(n).trim().toLowerCase());
    const sozinha = numeros.length === 1;
    const gravacoes = [];
    const mudou = [];
    for (const n of numeros) {
      const m = acha(n);
      if (!m) continue;                       // número que não está no mapa: não inventa mesa
      const patch = {};
      if (sozinha && Number(lugares) > 0 && Number(m.lugares) !== Number(lugares)) {
        patch.lugares = Number(lugares);
        mudou.push(`mesa ${m.numero}: ${m.lugares} → ${lugares} lugares`);
      }
      if (!!m.pet !== !!pet) {
        patch.pet = !!pet;
        mudou.push(`mesa ${m.numero}: ${pet ? "passou a ser" : "deixou de ser"} área pet`);
      }
      if (!Object.keys(patch).length) continue;
      Object.assign(m, patch);                // pinta na hora
      gravacoes.push(backend.updateMapa(m.id, patch));
    }
    if (!gravacoes.length) return;
    renderMapa();
    await Promise.allSettled(gravacoes);
    // aviso curto: se foi engano de digitação, dá para desfazer no editor
    avisoStaff("🗺 Mapa atualizado — " + mudou.join(" • "), true);
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
    // o que o garçom lançou é a verdade do salão: o mapa se ajusta a ela
    await mapaAprendeComOGarcom(numeros || [], lugares, pet);
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
    // corrigir o lançamento também ensina o mapa: a correção é a versão certa
    await mapaAprendeComOGarcom(numeros || [], lugares, pet);
    await refresh();
  }

  // Marca a mesa como "chamada, esperando sentar"
  async function reservarMesa(id, pessoaId) {
    const m = mesasLivres.find((x) => x.id === id);
    if (m) m.reservada_para = pessoaId;          // pinta na hora
    renderMesas();
    try { await backend.updateMesa(id, { reservada_para: pessoaId }); }
    catch (e) {
      if (!colunaNaoExiste(e)) throw e;          // banco sem a coluna: segue sem reservar
      console.warn("Mesas: sem a coluna reservada_para (rode o SQL). A mesa não fica marcada.");
    }
    mesaSelecionada = null;
  }

  // O cliente não apareceu (voltou para a fila, saiu, foi para o fim):
  // a mesa volta a ficar disponível para outro grupo.
  // Devolve à recepção as mesas que estavam presas a esta pessoa. As mesas são
  // soltas TODAS DE UMA VEZ: uma a uma, cada mesa era uma espera somada.
  function soltarReservaDe(pessoaId) {
    const presas = mesasLivres.filter((m) => m.reservada_para === pessoaId);
    if (!presas.length) return [];
    presas.forEach((m) => { m.reservada_para = null; });
    renderMesas();
    return presas.map((m) =>
      backend.updateMesa(m.id, { reservada_para: null })
        .catch((e) => { if (!colunaNaoExiste(e)) console.warn("Não deu para soltar a mesa:", e); }));
  }

  async function usarMesa(id) {
    // tira da lista na hora e grava depois
    mesasLivres = mesasLivres.filter((m) => m.id !== id);
    if (mesaSelecionada === id) mesaSelecionada = null;
    renderMesas();
    await backend.updateMesa(id, { status: MESAS.USADA, usada_em: new Date().toISOString() });
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
  const MAPA = { LIVRE: "livre", LIMPAR: "limpar", OCUPADA: "ocupada", RESERVADA: "reservada" };

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
    const bloco = blocoDaMesa(m);
    const corte = Math.max(...bloco.map((x) => x.liberada_em ? new Date(x.liberada_em).getTime() : 0));
    const candidatos = rows.filter((r) => r.status === STATUS.SENTADO &&
      bloco.some((x) => numeroBate(x.numero, r.mesa_numero)) &&
      new Date(r.sentou_em || r.chamado_em || r.criado_em).getTime() > corte);
    // se houver mais de um (mesa reaproveitada), vale o mais recente
    candidatos.sort((a, b) => new Date(b.sentou_em || b.criado_em) - new Date(a.sentou_em || a.criado_em));
    return candidatos[0] || null;
  }

  // Esta mesa já foi avisada à recepção?
  function mesaAvisada(m) {
    return mesasLivres.some((x) => numeroBate(m.numero, x.numeros || x.identificacao));
  }

  // Mesas juntadas compartilham o mesmo "grupo". Sozinha, a mesa é o
  // próprio bloco. O bloco é o que conta: lugares somam e a recepção
  // recebe "12 + 13".
  function blocoDaMesa(m) {
    if (!m) return [];
    if (!m.grupo) return [m];
    return mapa.filter((x) => x.grupo === m.grupo)
      .sort((a, b) => String(a.numero).localeCompare(String(b.numero), "pt-BR", { numeric: true }));
  }
  function lugaresDoBloco(m) {
    return blocoDaMesa(m).reduce((s, x) => s + (Number(x.lugares) || 0), 0);
  }
  function numerosDoBloco(m) {
    return blocoDaMesa(m).map((x) => String(x.numero));
  }
  function petDoBloco(m) {
    return blocoDaMesa(m).some((x) => x.pet);
  }

  function estadoDaMesa(m) {
    const bloco = blocoDaMesa(m);
    if (ocupanteDaMesa(m)) return "ocupada";                          // cliente da fila
    if (bloco.some((x) => x.status === MAPA.OCUPADA)) return "ocupada"; // marcada na mão
    if (bloco.some((x) => x.status === MAPA.LIMPAR)) return "limpar";
    // reserva é compromisso com um cliente que ainda vai chegar: vem antes de
    // "liberada" para ninguém oferecer a mesa por engano
    if (bloco.some((x) => x.status === MAPA.RESERVADA)) return "reservada";
    if (bloco.some(mesaAvisada)) return "avisada";
    return "livre";
  }

  // Mesa que pode ser arrastada e juntada: só as que estão realmente à mão
  // do garçom. Liberada já foi prometida à recepção; ocupada tem gente nela.
  function podeJuntar(m) {
    const e = estadoDaMesa(m);
    return e === "livre" || e === "limpar";  // reservada não entra: já tem dono
  }

  // Encerrar a mesa: some o cronômetro e ela sai do vermelho.
  // "limpar" deixa amarela; "livre" deixa verde.
  async function encerrarMesaMapa(id, status) {
    const agora = new Date().toISOString();
    const bloco = blocoDaMesa(mapa.find((x) => x.id === id));
    // pinta na hora e só depois conversa com o banco: o garçom não pode ficar
    // esperando a internet com o prato na mão
    bloco.forEach((x) => { x.status = status; x.liberada_em = agora; });
    renderMapa();
    for (const x of bloco) await backend.updateMapa(x.id, { status, liberada_em: agora });
    await refresh();
  }

  // Volta o salão inteiro para "aguardando": tira as mesas da lista da
  // Marca o salão inteiro para limpeza — o fim do serviço, quando tudo vai
  // ser recolhido de uma vez. Pega TODAS as mesas que ainda não estão
  // marcadas, inclusive as ocupadas, e tira da lista da recepção o que
  // estava oferecido: mesa suja não pode ser entregue a ninguém.
  async function marcarTodasParaLimpar() {
    const agora = new Date().toISOString();
    const gravacoes = [];
    let mexidas = 0;
    const vistos = new Set();
    for (const m of mapa) {
      if (vistos.has(m.id)) continue;
      const bloco = blocoDaMesa(m);
      bloco.forEach((x) => vistos.add(x.id));
      if (estadoDaMesa(m) === "limpar") continue;        // já está marcada
      if (estadoDaMesa(m) === "reservada") continue;     // reserva não se apaga em lote
      mexidas++;
      bloco.forEach((x) => { x.status = MAPA.LIMPAR; x.liberada_em = agora; });
      for (const x of bloco) {
        gravacoes.push(backend.updateMapa(x.id, { status: MAPA.LIMPAR, liberada_em: agora }));
        mesasLivres
          .filter((z) => numeroBate(x.numero, z.numeros || z.identificacao))
          .forEach((z) => gravacoes.push(backend.removeMesa(z.id)));
      }
    }
    if (!gravacoes.length) { avisoStaff("Todas as mesas já estão marcadas para limpar.", true); return; }
    renderMapa();
    const r = await Promise.allSettled(gravacoes);
    const falhas = r.filter((x) => x.status === "rejected").length;
    await refresh();
    avisoStaff(
      mexidas + (mexidas === 1 ? " mesa marcada" : " mesas marcadas") + " para limpar" +
      (falhas ? " • ⚠ " + falhas + " não gravou, verifique a internet" : ""),
      !falhas);
  }

  // Volta o salão inteiro para "aguardando": tira as mesas da lista da
  // recepção e apaga as marcações de limpeza e de ocupada.
  // É ação de virada de turno: pega TODAS, inclusive as ocupadas. Quem está
  // sentado continua registrado na fila — o que muda é só o mapa.
  async function voltarTodasParaAguardando() {
    const agora = new Date().toISOString();
    const gravacoes = [];
    let mexidas = 0;
    const vistos = new Set();
    for (const m of mapa) {
      if (vistos.has(m.id)) continue;
      const bloco = blocoDaMesa(m);
      bloco.forEach((x) => vistos.add(x.id));
      if (estadoDaMesa(m) === "livre") continue;         // já está aguardando
      if (estadoDaMesa(m) === "reservada") continue;     // reserva não se apaga em lote
      mexidas++;
      bloco.forEach((x) => { x.status = MAPA.LIVRE; x.liberada_em = agora; });
      for (const x of bloco) {
        gravacoes.push(backend.updateMapa(x.id, { status: MAPA.LIVRE, liberada_em: agora }));
        // tira da lista da recepção o que apontava para esta mesa
        mesasLivres
          .filter((z) => numeroBate(x.numero, z.numeros || z.identificacao))
          .forEach((z) => gravacoes.push(backend.removeMesa(z.id)));
      }
    }
    if (!gravacoes.length) { avisoStaff("Todas as mesas já estão aguardando.", true); return; }
    renderMapa();
    const r = await Promise.allSettled(gravacoes);
    const falhas = r.filter((x) => x.status === "rejected").length;
    await refresh();
    avisoStaff(
      mexidas + (mexidas === 1 ? " mesa voltou" : " mesas voltaram") + " para aguardando" +
      (falhas ? " • ⚠ " + falhas + " não gravou, verifique a internet" : ""),
      !falhas);
  }

  // O botão "liberar todas" fica disponível para o garçom só nas pontas do
  // dia: antes do horário de "até" e depois do de "volta". No meio do
  // movimento ele some, para ninguém liberar o salão inteiro sem querer.
  function dentroDaJanelaLiberar() {
    const ate = String(CFG.liberarAte || "11:00");
    const volta = String(CFG.liberarVolta || "17:00");
    const agora = new Date();
    const min = agora.getHours() * 60 + agora.getMinutes();
    const emMin = (t) => {
      const p = String(t).split(":");
      return (parseInt(p[0], 10) || 0) * 60 + (parseInt(p[1], 10) || 0);
    };
    return min < emMin(ate) || min >= emMin(volta);
  }

  // Libera de uma vez todas as mesas que estão aguardando. Não mexe nas
  // ocupadas nem nas que precisam de limpeza: liberar mesa suja ou com gente
  // sentada mandaria a recepção para o lugar errado.
  // Libera o salão inteiro para a recepção. Também é ação de virada de turno:
  // pega TODAS as mesas que ainda não estão liberadas, inclusive as ocupadas e
  // as marcadas para limpar. Mesas juntas contam como uma só.
  async function liberarTodasAsMesas() {
    const blocos = [];
    const vistos = new Set();
    for (const m of mapa) {
      if (vistos.has(m.id)) continue;
      const bloco = blocoDaMesa(m);
      bloco.forEach((x) => vistos.add(x.id));
      // a reservada fica de fora: tem cliente marcado para ela
      if (estadoDaMesa(m) !== "avisada" && estadoDaMesa(m) !== "reservada") blocos.push(bloco);
    }
    if (!blocos.length) { avisoStaff("Todas as mesas já estão liberadas.", true); return; }

    // Pinta na hora e grava tudo JUNTO. Uma a uma eram duas idas ao servidor
    // por mesa, em sequência: com o salão cheio isso levava vários segundos e
    // parecia que o botão não tinha feito nada.
    const agora = new Date().toISOString();
    const gravacoes = [];
    for (const bloco of blocos) {
      const ancora = bloco[0];
      const lugares = lugaresDoBloco(ancora);
      const pet = petDoBloco(ancora);
      const numeros = numerosDoBloco(ancora).join(" + ");
      bloco.forEach((x) => { x.status = MAPA.LIVRE; x.liberada_em = agora; });
      for (const x of bloco) {
        gravacoes.push(backend.updateMapa(x.id, { status: MAPA.LIVRE, liberada_em: agora }));
      }
      gravacoes.push(backend.addMesa({
        id: uuid(), lugares, pet, identificacao: null, numeros,
        status: MESAS.LIVRE, criado_em: agora, usada_em: null,
      }));
    }
    renderMapa();
    const r = await Promise.allSettled(gravacoes);
    const falhas = r.filter((x) => x.status === "rejected").length;
    await refresh();
    const ok = blocos.length;
    avisoStaff(
      ok + (ok === 1 ? " mesa liberada" : " mesas liberadas") + " para a recepção" +
      (falhas ? " • ⚠ " + falhas + " não gravou, verifique a internet" : ""),
      !falhas);
  }

  // Marca a mesa como ocupada na mão (cliente que sentou sem passar pela fila)
  async function marcarOcupada(id) {
    const bloco = blocoDaMesa(mapa.find((x) => x.id === id));
    bloco.forEach((x) => { x.status = MAPA.OCUPADA; });
    renderMapa();
    for (const x of bloco) await backend.updateMapa(x.id, { status: MAPA.OCUPADA });
    await refresh();
  }

  // Volta a mesa para o verde. Se ela já tinha sido avisada à recepção,
  // desfaz o aviso também — senão ela voltaria a ficar verde tracejada e a
  // recepção continuaria contando com uma mesa que o garçom retomou.
  async function voltarParaLivre(m) {
    const bloco = blocoDaMesa(m);
    for (const x of bloco) {
      const avisadas = mesasLivres.filter((z) => numeroBate(x.numero, z.numeros || z.identificacao));
      for (const z of avisadas) {
        try { await backend.removeMesa(z.id); } catch (e) { console.warn("Não deu para tirar da recepção:", e); }
      }
    }
    await encerrarMesaMapa(m.id, MAPA.LIVRE);
  }

  // Avisar a recepção: entra na lista de mesas livres, como se o garçom
  // tivesse lançado pelo botão de sempre.
  async function liberarMesaDoMapa(m) {
    const numeros = numerosDoBloco(m);
    const lugares = lugaresDoBloco(m);
    const pet = petDoBloco(m);
    const jaAvisada = blocoDaMesa(m).some(mesaAvisada);
    await encerrarMesaMapa(m.id, MAPA.LIVRE);
    if (!jaAvisada) await lancarMesa({ lugares, pet, identificacao: "", numeros });
  }

  // Juntar: a mesa arrastada entra no grupo da mesa de destino e FICA ONDE FOI
  // SOLTA. O garçom monta a formação que quiser (em linha, em L, em U) e o
  // desenho no mapa fica igual ao arranjo real do salão.
  // Encaixe: ao soltar, a mesa não fica torta onde o dedo largou — ela cola
  // certinho no lado da mesa de destino, borda com borda. O lado é escolhido
  // pela direção em que ela foi solta (direita, esquerda, acima, abaixo).
  function encaixarNaMesa(a, b, ondeSoltou) {
    const ta = tamanhoDaMesaPct(a), tb = tamanhoDaMesaPct(b);
    if (!ta || !tb || !ondeSoltou) return null;
    const piso = $("#mapaPiso").getBoundingClientRect();
    // compara em PIXELS: o piso não é quadrado, 1% na largura não é 1% na altura
    const px = ((ondeSoltou.x - (Number(b.x) || 0)) / 100) * piso.width;
    const py = ((ondeSoltou.y - (Number(b.y) || 0)) / 100) * piso.height;
    const limita = (v) => Math.max(2, Math.min(98, v));
    if (Math.abs(px) >= Math.abs(py)) {
      const lado = px >= 0 ? 1 : -1;
      return { x: limita((Number(b.x) || 0) + lado * (ta.w + tb.w) / 2), y: Number(b.y) || 0 };
    }
    const lado = py >= 0 ? 1 : -1;
    return { x: Number(b.x) || 0, y: limita((Number(b.y) || 0) + lado * (ta.h + tb.h) / 2) };
  }

  async function juntarMesas(idArrastada, idDestino, ondeSoltou) {
    const a = mapa.find((x) => x.id === idArrastada);
    const b = mapa.find((x) => x.id === idDestino);
    if (!a || !b || a.id === b.id) return;
    if (a.grupo && a.grupo === b.grupo) return;          // já estão juntas
    // só mesas à mão do garçom entram em junção
    if (!podeJuntar(a) || !podeJuntar(b)) {
      avisoStaff("Só dá para juntar mesas livres ou que precisam de limpeza.");
      return;
    }
    // juntando uma limpa com uma suja, o bloco inteiro precisa de limpeza:
    // a mesa suja continua suja mesmo encostada na outra
    const precisaLimpar = blocoDaMesa(a).concat(blocoDaMesa(b))
      .some((x) => x.status === MAPA.LIMPAR);
    const grupo = b.grupo || a.grupo || uuid();

    // quem vem junto com a arrastada mantém a formação que já tinha
    const gravacoes = [];
    const vindos = blocoDaMesa(a);
    for (const m of vindos) {
      const patch = { grupo };
      if (precisaLimpar) patch.status = MAPA.LIMPAR;
      if (m.x_ant == null) { patch.x_ant = m.x; patch.y_ant = m.y; }
      if (m.id === a.id && ondeSoltou) {
        const enc = encaixarNaMesa(a, b, ondeSoltou) || ondeSoltou;
        patch.x = enc.x; patch.y = enc.y;
      }
      Object.assign(m, patch);                            // desenho já fica certo
      gravacoes.push(backend.updateMapa(m.id, patch));
    }
    // o bloco de destino só adota o grupo (ninguém sai do lugar)
    for (const m of blocoDaMesa(b)) {
      const p2 = { grupo };
      if (precisaLimpar) p2.status = MAPA.LIMPAR;
      if (m.grupo === grupo && !precisaLimpar) continue;
      Object.assign(m, p2);
      gravacoes.push(backend.updateMapa(m.id, p2));
    }
    // O POP-UP ABRE NA HORA. A junção já está pintada na tela, e o garçom
    // ainda vai levar alguns segundos escolhendo os lugares — não faz sentido
    // ele olhar para uma tela parada esperando o banco responder. As gravações
    // seguem por baixo; a confirmação do passo 2 espera por elas antes de
    // gravar o que for dela.
    renderMapa();
    const juntas = mapa.find((x) => x.id === b.id);
    if (juntas && !mapaSoDeOlhar()) {
      abrirAcaoMesa(juntas.id);
      mostrarPasso2("juntar", juntas, { semLista: true });
    }
    gravacoesDoMapa = Promise.allSettled(gravacoes).then(() => refresh());
    await gravacoesDoMapa;
  }

  // Separar desfaz a junção E devolve as mesas para AGUARDANDO. Separar é o
  // garçom dizendo "esse conjunto não existe mais": deixar as duas metades
  // liberadas faria a recepção continuar contando com uma mesa que acabou de
  // ser desmontada. Por isso o aviso à recepção também é retirado.
  async function separarMesas(id) {
    const bloco = blocoDaMesa(mapa.find((x) => x.id === id));
    const agora = new Date().toISOString();
    for (const x of bloco) {
      const avisadas = mesasLivres.filter((z) => numeroBate(x.numero, z.numeros || z.identificacao));
      for (const z of avisadas) {
        try { await backend.removeMesa(z.id); } catch (e) { console.warn("Não deu para tirar da recepção:", e); }
      }
    }
    for (const x of bloco) {
      const patch = { grupo: null, status: MAPA.LIVRE, liberada_em: agora };
      // volta para o lugar de origem no mapa
      if (x.x_ant != null) { patch.x = x.x_ant; patch.y = x.y_ant; patch.x_ant = null; patch.y_ant = null; }
      Object.assign(x, patch);
      await backend.updateMapa(x.id, patch);
    }
    renderMapa();
    await refresh();
  }

  // Escolhe quem chamar para o tamanho/pet que estão preparados e abre a
  // confirmação. Serve tanto para o pop-up de tamanho quanto para o atalho
  // de tocar direto numa mesa livre.
  function chamarParaMesa() {
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
      ajustarBarraStaff();
      pendingCall = null;
      return;
    }
    smsg.textContent = "";
    ajustarBarraStaff();
    openCallConfirm(chosen, aceitaPet);
  }

  // A atendente toca numa mesa livre: vai DIRETO para a confirmação, já com
  // o cliente escolhido. O tamanho e o pet vêm da mesa; perguntar de novo
  // seria pedir para conferir algo que ela não tem como conferir daqui.
  function selecionarMesa(id) {
    const m = mesasLivres.find((x) => x.id === id);
    if (!m) return;
    mesaSelecionada = id;
    mesa = Math.max(MIN_P, Math.min(TETO_EQUIPE, Number(m.lugares) || 2));
    $("#fMesa").textContent = mesa;
    const alvo = $(`input[name="mesapet"][value="${m.pet ? "sim" : "nao"}"]`);
    if (alvo) alvo.checked = true;
    render();
    chamarParaMesa();
  }

  // ---------- desenho do mapa ----------
  // Uma mesa do mapa vira um quadradinho posicionado em % do piso, para
  // ficar igual em qualquer tela.
  // Desenho da mesa: o retângulo é o tampo e os risquinhos em volta são as
  // cadeiras. Até 6 lugares todo mundo senta nos lados compridos; de 7 em
  // diante entram as duas cabeceiras — é como as mesas ficam no salão.
  function cadeirasDaMesa(n) {
    const t = Math.max(1, Math.min(24, Number(n) || 1));
    // até 6 lugares a mesa é um retângulo com todo mundo nos lados compridos
    // (é como as mesas de 4 e de 6 ficam no salão); de 7 em diante entram as
    // duas cabeceiras e o resto se divide entre os lados
    if (t <= 2) return { topo: 1, base: t - 1, esq: 0, dir: 0 };
    if (t === 3) return { topo: 2, base: 1, esq: 0, dir: 0 };
    if (t <= 6) return { topo: Math.ceil(t / 2), base: Math.floor(t / 2), esq: 0, dir: 0 };
    const resto = t - 2; // as duas cabeceiras
    return { topo: Math.ceil(resto / 2), base: Math.floor(resto / 2), esq: 1, dir: 1 };
  }

  // Tamanho do desenho da mesa, em pixels — é o mesmo cálculo do CSS.
  // Serve para encaixar uma mesa na outra e para desenhar o contorno do bloco.
  const CADEIRA_FORA = 9;   // o quanto a cadeira avança para fora do tampo
  // Estados em que o desenho é o quadradinho compacto (sem cadeiras). Precisa
  // bater com o `semCadeiras` do mesaMapaHTML: é esta medida que decide se uma
  // mesa cabe ao lado da outra.
  function desenhoCompacto(m) {
    if (modoEdicaoMapa) return false;
    const e = estadoDaMesa(m);
    return e === "livre" || e === "limpar" || e === "ocupada";
  }

  function tamanhoDaMesaPx(m, lugaresDoDesenho) {
    if (desenhoCompacto(m)) return { w: 120, h: 52 };   // o quadradinho, no maior que ele fica
    const c = cadeirasDaMesa(lugaresDoDesenho == null ? m.lugares : lugaresDoDesenho);
    const lados = Math.max(c.topo, c.base);
    return {
      w: Math.max(66, 30 + lados * 22),
      h: c.esq + c.dir > 0 ? 64 : 52,
    };
  }

  // Converte o tamanho da mesa para % do piso (o piso muda de tamanho com o
  // zoom e com a tela, então a conta precisa ser feita na hora).
  //
  // Quando o desenho JÁ ESTÁ na tela, vale o que ele mede de verdade: o
  // quadradinho de aguardando cresce com o texto que tem dentro, e chutar o
  // tamanho máximo dele fazia o mapa achar que duas mesas soltas estavam
  // encostadas. Só quando não há desenho (mesa de dentro de um bloco, mapa
  // ainda não pintado) é que a medida sai da conta.
  function tamanhoDaMesaPct(m, lugaresDoDesenho) {
    const piso = $("#mapaPiso");
    const r = piso && piso.getBoundingClientRect();
    if (!r || !r.width || !r.height) return null;
    const el = piso.querySelector(`[data-mapamesa="${m.id}"]`);
    if (el) {
      const rd = el.getBoundingClientRect();
      if (rd.width && rd.height) return { w: (rd.width / r.width) * 100, h: (rd.height / r.height) * 100 };
    }
    const t = tamanhoDaMesaPx(m, lugaresDoDesenho);
    return { w: (t.w / r.width) * 100, h: (t.h / r.height) * 100 };
  }
  // ==========================================================
  //  NINGUÉM DESENHADO EM CIMA DE NINGUÉM
  // ----------------------------------------------------------
  //  Juntar duas mesas cria um desenho MAIOR — oito lugares ocupam quase o
  //  dobro da largura de quatro — e ele aparece no CENTRO entre as duas.
  //  Juntando a 1 com a 3, esse centro cai bem em cima da mesa 2: o conjunto
  //  cobre a vizinha, e some com ela e com o jeito de tocar nela.
  //
  //  Depois de juntar, então, o mapa se arruma: quem está por cima de alguém
  //  anda para o vão livre mais próximo. Quem já está num vão não sai do
  //  lugar — mexer sem necessidade confunde quem conhece o salão. E o bloco
  //  anda INTEIRO, todas as mesas o mesmo tanto, mantendo a formação.
  //
  //  A conferência é feita com o desenho JÁ no estado final (depois de
  //  liberar), senão a conta sairia com o quadradinho de aguardando e o
  //  conjunto voltaria a cobrir a vizinha assim que ganhasse as cadeiras.
  // ==========================================================

  // Onde e de que tamanho cada desenho aparece hoje no mapa. É a mesma conta
  // do renderMapa: de um bloco, um desenho só, no centro do conjunto.
  function desenhosDoMapa() {
    return mapa.filter((x) => {
      if (!x.grupo) return true;
      const b = blocoDaMesa(x);
      return b[0] && b[0].id === x.id;
    }).map((x) => {
      const b = blocoDaMesa(x);
      const junta = b.length > 1;
      const t = tamanhoDaMesaPct(x, junta ? lugaresDoBloco(x) : x.lugares);
      const c = junta ? centroDoBloco(b) : { x: Number(x.x) || 50, y: Number(x.y) || 50 };
      return t ? { bloco: b, ids: new Set(b.map((z) => z.id)), t, c } : null;
    }).filter(Boolean);
  }

  const FOLGA_MAPA = 1.5;                        // % de respiro entre os desenhos

  function desenhosSeTocam(a, b, ax, ay) {
    const x = ax == null ? a.c.x : ax, y = ay == null ? a.c.y : ay;
    return Math.abs(x - b.c.x) < (a.t.w + b.t.w) / 2 + FOLGA_MAPA &&
           Math.abs(y - b.c.y) < (a.t.h + b.t.h) / 2 + FOLGA_MAPA;
  }

  // O menor número do desenho — é por ele que a planta se ordena.
  function numeroDoDesenho(d) {
    return d.bloco.map((x) => String(x.numero))
      .sort((a, b) => a.localeCompare(b, "pt-BR", { numeric: true }))[0] || "";
  }

  // A CASA da mesa: o lugar que ela ocuparia na grade em ordem numérica —
  // 1, 2, 3… da esquerda para a direita, de cima para baixo. É a formação de
  // fábrica do mapa, a que o garçom encontra quando toca em "Organizar".
  function casaNaGrade(d, ds) {
    const ordem = ds.slice().sort((a, b) =>
      numeroDoDesenho(a).localeCompare(numeroDoDesenho(b), "pt-BR", { numeric: true }));
    const i = ordem.indexOf(d);
    if (i < 0) return null;
    return posicoesEmGrade(ordem.length)[i] || null;
  }

  // Vão livre mais perto para este desenho, ou null se ele já está num.
  //
  // A CASA VEM PRIMEIRO: se o lugar dele na ordem numérica estiver livre, é
  // para lá que ele vai — assim o salão volta sozinho para a formação em
  // sequência, que é a que se lê de relance. Só quando a casa está ocupada é
  // que vale o vão mais próximo.
  function vaoLivrePara(d, outros, ds) {
    const encosta = (px, py) => outros.some((o) => desenhosSeTocam(d, o, px, py));
    if (!encosta(d.c.x, d.c.y)) return null;
    const casa = ds ? casaNaGrade(d, ds) : null;
    if (casa && !encosta(casa.x, casa.y)) return casa;
    let melhor = null, menor = Infinity;
    for (let py = 8; py <= 92; py += 2) {
      for (let px = 6; px <= 94; px += 2) {
        if (encosta(px, py)) continue;
        const dist = Math.hypot(px - d.c.x, py - d.c.y);
        if (dist < menor) { menor = dist; melhor = { x: px, y: py }; }
      }
    }
    return melhor;
  }

  // Anda com o bloco inteiro, mantendo a formação. Só mexe na memória: quem
  // chamou grava e redesenha.
  function moverDesenho(d, vaga) {
    const dx = vaga.x - d.c.x, dy = vaga.y - d.c.y;
    d.bloco.forEach((x) => {
      x.x = Math.max(4, Math.min(96, (Number(x.x) || 50) + dx));
      x.y = Math.max(6, Math.min(94, (Number(x.y) || 50) + dy));
    });
    d.c = { x: d.c.x + dx, y: d.c.y + dy };
  }

  // Desempilha o mapa: enquanto houver dois desenhos em cima um do outro, o
  // de cima anda para o vão livre mais próximo. `idPrioritario` é a mesa que
  // acabou de mudar — ela é a primeira a ceder, porque foi ela que chegou por
  // último; o resto do salão continua onde o garçom deixou.
  async function arrumarSobreposicoes(idPrioritario) {
    const mexidos = new Map();
    for (let voltas = 0; voltas < 12; voltas++) {
      const ds = desenhosDoMapa();
      if (ds.length < 2) break;
      let par = null;
      for (let i = 0; i < ds.length && !par; i++) {
        for (let j = i + 1; j < ds.length; j++) {
          if (desenhosSeTocam(ds[i], ds[j])) { par = [ds[i], ds[j]]; break; }
        }
      }
      if (!par) break;                           // nada empilhado: acabou
      // quem cede: a mesa que acabou de mudar; senão, a maior das duas
      const area = (d) => d.t.w * d.t.h;
      let quem = par.find((d) => idPrioritario && d.ids.has(idPrioritario));
      if (!quem) quem = area(par[0]) >= area(par[1]) ? par[0] : par[1];
      const vaga = vaoLivrePara(quem, ds.filter((o) => o !== quem), ds);
      if (!vaga) break;                          // salão sem espaço: melhor não mexer
      moverDesenho(quem, vaga);
      quem.bloco.forEach((x) => mexidos.set(x.id, { x: x.x, y: x.y }));
    }
    if (!mexidos.size) return false;
    renderMapa();
    await Promise.allSettled([...mexidos].map(([id, p]) => backend.updateMapa(id, p)));
    return true;
  }

  // Lados em que esta mesa está encostada em outra do MESMO bloco. Ali não
  // desenhamos cadeira: no salão ninguém senta na emenda de duas mesas.
  function ladosColados(m) {
    if (!m.grupo) return "";
    const meu = tamanhoDaMesaPct(m);
    if (!meu) return "";
    let lados = "";
    for (const o of blocoDaMesa(m)) {
      if (o.id === m.id) continue;
      const dele = tamanhoDaMesaPct(o);
      if (!dele) continue;
      const dx = (Number(o.x) || 0) - (Number(m.x) || 0);
      const dy = (Number(o.y) || 0) - (Number(m.y) || 0);
      const larg = (meu.w + dele.w) / 2;
      const alt = (meu.h + dele.h) / 2;
      const folgaX = larg * 0.35 + 0.5;
      const folgaY = alt * 0.35 + 0.5;
      // encostada na horizontal: distância ≈ metade de cada largura e as
      // alturas se sobrepondo
      if (Math.abs(Math.abs(dx) - larg) <= folgaX && Math.abs(dy) < alt * 0.9) {
        lados += dx > 0 ? "r" : "l";
      } else if (Math.abs(Math.abs(dy) - alt) <= folgaY && Math.abs(dx) < larg * 0.9) {
        lados += dy > 0 ? "b" : "t";
      }
    }
    return lados;
  }

  function cadeirasHTML(n, esconder) {
    const c = cadeirasDaMesa(n);
    const pula = String(esconder || "");
    const fila = (qtd, lado) => {
      if (pula.indexOf(lado) >= 0) return "";
      let h = "";
      for (let i = 0; i < qtd; i++) {
        const p = ((i + 1) / (qtd + 1)) * 100;
        const eixo = (lado === "t" || lado === "b") ? "left" : "top";
        h += `<i class="${lado}" style="${eixo}:${p.toFixed(1)}%"></i>`;
      }
      return h;
    };
    return `<span class="mm-cadeiras" aria-hidden="true">${
      fila(c.topo, "t") + fila(c.base, "b") + fila(c.esq, "l") + fila(c.dir, "r")}</span>`;
  }

  // Centro do bloco: é onde o desenho único das mesas juntadas fica.
  function centroDoBloco(bloco) {
    const n = bloco.length || 1;
    return {
      x: bloco.reduce((s, m) => s + (Number(m.x) || 50), 0) / n,
      y: bloco.reduce((s, m) => s + (Number(m.y) || 50), 0) / n,
    };
  }

  function mesaMapaHTML(m, editando) {
    const est = editando ? "livre" : estadoDaMesa(m);
    const oc = editando ? null : ocupanteDaMesa(m);
    const desde = oc && (oc.sentou_em || oc.chamado_em);
    const junta = !editando && m.grupo;
    // Mesas juntadas viram UM desenho só, no meio do conjunto: "Mesa 1+4",
    // os lugares somados e o tempo de quem sentou. As outras do bloco não são
    // desenhadas — ficam sobrepostas por baixo desta. Contorno em volta não
    // precisa mais existir: o desenho único já diz que viraram uma mesa.
    const bloco = junta ? blocoDaMesa(m) : [m];
    const lugares = junta ? lugaresDoBloco(m) : m.lugares;
    const rotulo = junta ? "Mesa " + esc(numerosDoBloco(m).join("+")) : "Mesa " + esc(m.numero);
    const petBloco = junta ? petDoBloco(m) : m.pet;
    // AGUARDANDO ainda não tem tamanho: quantos lugares a mesa vai ter é o
    // garçom que informa na hora de liberar, e isso muda a cada serviço. Por
    // isso ela aparece como um quadrado limpo, sem cadeiras e sem contagem —
    // desenhar cadeira ali seria inventar informação.
    const semTamanho = !editando && est === "livre";
    // Cadeira desenhada é para a mesa que a recepção pode OFERECER: ali o
    // tamanho é a informação que decide quem sentar. Mesa suja ou com gente
    // dentro não vai ser oferecida a ninguém agora, então vira o mesmo
    // quadradinho — o mapa fica limpo e sobra espaço no salão.
    const semCadeiras = semTamanho || (!editando && (est === "limpar" || est === "ocupada"));
    const texto = `
      <b class="mm-num">${rotulo}</b>
      ${semTamanho ? (petBloco ? `<span class="mm-lug">🐾</span>` : "")
                   : `<span class="mm-lug">${lugares} lug.${petBloco ? " 🐾" : ""}</span>`}
      ${desde ? `<span class="mm-timer" data-since="${desde}">agora</span>` : ""}`;
    // as cadeiras acompanham o tamanho do conjunto — e só existem depois que
    // o tamanho é conhecido
    const miolo = (semCadeiras ? "" : cadeirasHTML(lugares)) + texto;
    const classes = `mm-mesa is-${est}${petBloco ? " is-pet" : ""}${junta ? " is-junta" : ""}${semCadeiras ? " sem-tamanho" : ""}`;
    // `--lados` é quantas cadeiras cabem no lado comprido: é o que dá a largura
    // da mesa no desenho, para uma de 8 lugares ser visivelmente maior que uma de 4
    const cad = cadeirasDaMesa(lugares);
    const lados = semCadeiras ? 2 : Math.max(cad.topo, cad.base);
    const altas = (!semCadeiras && cad.esq + cad.dir > 0) ? " tem-pontas" : "";
    const onde = junta ? centroDoBloco(bloco) : { x: Number(m.x) || 50, y: Number(m.y) || 50 };
    const posicao = `style="left:${onde.x}%;top:${onde.y}%;--lados:${lados}"`;

    // No editor a mesa é uma caixa (não um <button>), para poder ter os dois
    // botõezinhos dentro — botão dentro de botão o navegador não aceita.
    if (editando) {
      return `<div class="${classes}${altas} is-edit" ${posicao} data-mapamesa="${m.id}"
        role="button" tabindex="0" title="Mesa ${esc(m.numero)}">
        ${miolo}
        <span class="mm-tools">
          <button type="button" class="mm-tool" data-mmedit="${m.id}" title="Editar a mesa" aria-label="Editar a mesa">✏️</button>
          <button type="button" class="mm-tool mm-tool-x" data-mmdel="${m.id}" title="Excluir a mesa" aria-label="Excluir a mesa">🗑</button>
        </span>
      </div>`;
    }
    return `<button type="button" class="${classes}${altas}" ${posicao}
      data-mapamesa="${m.id}" title="Mesa ${esc(m.numero)}">${miolo}</button>`;
  }

  // O mapa pode ser desligado por perfil: tem casa que quer o mapa só na
  // mão do garçom, e tem quem queira o contrário. Quando o login está
  // desligado, ninguém tem perfil — vale a regra do garçom.
  // A atendente vê a MESMA planta do garçom, mas travada: sem botões, sem
  // arrastar, sem abrir opções. Na recepção o mapa é informação, não comando —
  // quem mexe no estado das mesas é o salão.
  function mapaSoDeOlhar() {
    return loginLigado() && !!usuario && usuario.papel === PAPEL.ATENDENTE;
  }

  function mapaVisivelPara() {
    // a versão travada tem chave própria: a atendente pode ou não ver o salão
    if (mapaSoDeOlhar()) return CFG.mapaAtendente !== false;
    const admLogado = loginLigado() && usuario && usuario.papel === PAPEL.ADM;
    return admLogado ? CFG.mapaAdm !== false : CFG.mapaGarcom !== false;
  }

  // Enquanto um dedo está em cima do mapa, ele NÃO é redesenhado. Redesenhar
  // troca todos os quadradinhos por novos; se isso acontece no meio de um
  // toque, o elemento que o dedo apertou deixa de existir e o toque se perde.
  // (o mapa se redesenha sozinho a cada 15s e a cada mudança no banco)
  let _dedoNoMapa = false;
  let _mapaPendente = false;
  let _relogioDedo = null;

  function renderMapa() {
    const card = $("#mapaCard");
    if (!card) return;
    if (_dedoNoMapa) { _mapaPendente = true; return; }
    // O mapa vive na aba "Mapa". Para o garçom é ferramenta de trabalho; para
    // a atendente é só consulta — mesma planta, mas travada.
    const vista = appEl.getAttribute("data-view");
    const soOlhar = mapaSoDeOlhar();
    card.classList.toggle("so-olhar", soOlhar);
    card.hidden = CFG.garcomAtivo === false || vista !== "mapa" ||
      semTabelaMapa || !mapaVisivelPara();
    if (card.hidden) { modoEdicaoMapa = false; return; }

    // quem pode mexer no cadastro é quem pode mexer na engrenagem
    const podeEditar = ehAdm() && !soOlhar;
    if (!podeEditar) modoEdicaoMapa = false;
    const editando = modoEdicaoMapa;

    // na versão da atendente não entra nenhum botão: ela só consulta
    const podeLote = mapa.length && !editando && !soOlhar && (ehAdm() || dentroDaJanelaLiberar());
    const mostrar = (id, cond) => { const b = $(id); if (b) b.hidden = !cond; };
    mostrar("#liberarTodasBtn", podeLote);
    mostrar("#aguardarTodasBtn", podeLote);
    mostrar("#limparTodasBtn", podeLote);
    mostrar("#mapaEditarBtn", podeEditar && !editando);
    mostrar("#mapaNova", editando);
    mostrar("#mapaVarias", editando);
    mostrar("#mapaArrumar", editando && mapa.length > 1);
    mostrar("#mapaConcluir", editando);

    card.classList.toggle("is-editando", editando);
    aplicarDobraDoMapa(editando);
    aplicarZoom();
    // mede de novo no quadro seguinte: na primeira pintada a tela ainda pode
    // estar se acomodando (fonte carregando, barra do sistema aparecendo) e a
    // altura sairia curta, deixando um vazio embaixo
    requestAnimationFrame(aplicarZoom);
    setTimeout(aplicarZoom, 300);
    // No dia a dia, um bloco de mesas juntadas aparece UMA vez: as demais ficam
    // sobrepostas por baixo do desenho único. No editor todas aparecem, porque
    // ali o trabalho é posicionar cada uma.
    const visiveis = editando ? mapa : mapa.filter((m) => {
      if (!m.grupo) return true;
      const bloco = blocoDaMesa(m);
      return bloco[0] && bloco[0].id === m.id;
    });
    $("#mapaPiso").innerHTML = visiveis.map((m) => mesaMapaHTML(m, editando)).join("");
    $("#mapaVazio").hidden = mapa.length > 0;
    _mapaPendente = false;
  }

  // Chamado quando o dedo sai do mapa: desenha o que ficou pendente.
  //
  // O CÃO DE GUARDA: quando o pop-up abre por cima do dedo, o navegador às
  // vezes engole o "pointerup" — e o mapa ficava travado PARA SEMPRE, sem
  // mostrar mesa lançada, mesa devolvida, nada, até a página ser recarregada.
  // Por isso o levantar da trava não depende só do dedo: ele tem hora marcada.
  function liberarDesenhoDoMapa() {
    clearTimeout(_relogioDedo);
    _relogioDedo = null;
    _dedoNoMapa = false;
    if (_mapaPendente) renderMapa();
  }

  // Segura o redesenho enquanto o dedo está em cima — no máximo 4 segundos.
  // Nenhum gesto de verdade dura mais que isso.
  function segurarDesenhoDoMapa() {
    _dedoNoMapa = true;
    clearTimeout(_relogioDedo);
    _relogioDedo = setTimeout(liberarDesenhoDoMapa, 4000);
  }

  // ---------- pop-up de ação (garçom toca numa mesa) ----------
  let mapaMesaAtiva = null;
  // gravações da junção que ainda estão a caminho do banco: o passo 2 espera
  // por elas antes de gravar as dele, para os dois não se atropelarem
  let gravacoesDoMapa = null;

  // ==========================================================
  //  POP-UP DA MESA — dois passos
  // ----------------------------------------------------------
  //  Passo 1: o que fazer (aguardando, limpar, ocupada, reservada,
  //           liberada, juntar).
  //  Passo 2: só para o que precisa de mais informação —
  //           "Liberada" pede quantos lugares;
  //           "Juntar" pede quais mesas E quantos lugares.
  //
  //  Os lugares são informados na hora de liberar, e não no cadastro,
  //  porque é o garçom quem sabe: mesa de quatro vira de seis com duas
  //  cadeiras a mais, e isso muda a cada serviço.
  // ==========================================================
  let mapaLugaresEscolhidos = 0;
  let mapaLugaresManual = false;
  let mapaJuntarSelecao = new Set();
  let mapaAcaoPasso2 = "";        // "liberar" | "juntar"

  function mesasParaJuntar(m) {
    // candidatas: todas as que estão aguardando e não são do bloco desta
    const meuBloco = new Set(blocoDaMesa(m).map((x) => x.id));
    return mapa
      .filter((x) => !meuBloco.has(x.id) && estadoDaMesa(x) === "livre")
      .sort((a, b) => String(a.numero).localeCompare(String(b.numero), "pt-BR", { numeric: true }));
  }

  function desenharLugaresDoMapa() {
    const lista = tamanhosDaCasa();
    $("#mapaLugaresChips").innerHTML =
      lista.map((n) => `<button type="button" class="tm-btn${!mapaLugaresManual && mapaLugaresEscolhidos === n ? " is-sel" : ""}" data-maplug="${n}">
        <b>${n}</b><span>${n === 1 ? "lugar" : "lugares"}</span>
      </button>`).join("") +
      `<button type="button" class="tm-btn tm-outro${mapaLugaresManual ? " is-sel" : ""}" data-maplug="manual"><b>✏️</b><span>outro</span></button>`;
    $("#mapaLugaresManualBox").hidden = !mapaLugaresManual;
    if (mapaLugaresManual) $("#mapaLugaresManual").textContent = mapaLugaresEscolhidos || 4;
  }

  // A lista de "quais mesas vão junto" é o MESMO teclado do pop-up de lançar
  // mesa do garçom: a mesma grade de quadradinhos com o número, do mesmo
  // tamanho. Ele já toca nesse teclado dez vezes por noite — não faz sentido
  // ele aprender outro aqui. Na tecla vai só o número, como lá: é o que o
  // garçom procura com o olho (a área pet aparece no toque demorado).
  function desenharJuntarLista(m) {
    const cands = mesasParaJuntar(m);
    const box = $("#mapaJuntarLista");
    if (!cands.length) {
      box.innerHTML = `<p class="hint">Nenhuma outra mesa está aguardando agora.</p>`;
      return;
    }
    box.innerHTML = cands.map((x) => `
      <button type="button" class="num-tecla${mapaJuntarSelecao.has(x.id) ? " is-sel" : ""}" data-mapjuntar="${x.id}"${x.pet ? ' title="Área pet"' : ""}>${esc(x.numero)}</button>`).join("");
    // eco do que foi escolhido, no formato que a recepção vai receber
    const eco = $("#mapaJuntarEco");
    if (eco) {
      const nums = numerosDoBloco(m).concat(
        cands.filter((x) => mapaJuntarSelecao.has(x.id)).map((x) => String(x.numero)));
      eco.textContent = mapaJuntarSelecao.size ? "Vai virar: Mesa " + nums.join(" + ") : "";
      eco.hidden = !mapaJuntarSelecao.size;
    }
  }

  // soma sugerida: o que a casa já tem cadastrado para as mesas escolhidas
  function lugaresSugeridos(m) {
    let soma = blocoDaMesa(m).reduce((s, x) => s + (Number(x.lugares) || 0), 0);
    mapaJuntarSelecao.forEach((id) => {
      const x = mapa.find((v) => v.id === id);
      if (x) soma += Number(x.lugares) || 0;
    });
    return soma || 4;
  }

  // `semLista` esconde o "quais mesas vão junto": quem juntou ARRASTANDO já
  // escolheu as mesas com o dedo, no mapa. Repetir a pergunta ali seria pedir
  // de novo o que acabou de ser feito — sobra só o tamanho e o pet.
  function mostrarPasso2(acao, m, opcoes) {
    mapaAcaoPasso2 = acao;
    const juntando = acao === "juntar";
    const comLista = juntando && !(opcoes && opcoes.semLista);
    mapaJuntarSelecao = new Set();
    mapaLugaresManual = false;
    mapaLugaresEscolhidos = valorDaLista(tamanhosDaCasa(), lugaresSugeridos(m));
    $("#mapaJuntarBox").hidden = !comLista;
    $("#mapaAcoes").hidden = true;
    $("#mapaAcaoRodape").hidden = true;
    $("#mapaPasso2").hidden = false;
    // O rodapé é o mesmo dos dois passos, só troca o rótulo: aqui embaixo o
    // garçom lê "Juntar" quando está juntando, e não um "liberar" que ele não
    // pediu (juntar já libera — mas o nome do botão é a ação que ele escolheu).
    const ok = $("#mapaPasso2Ok");
    ok.textContent = juntando ? "🔗 Juntar" : "🟢 Liberar";
    ok.classList.toggle("btn-roxo", juntando);
    ok.classList.toggle("btn-verde", !juntando);
    if (comLista) desenharJuntarLista(m);
    desenharLugaresDoMapa();
    // pet: começa como a mesa está hoje no cadastro; o garçom corrige se mudou
    const petAtivo = CFG.petAtivo !== false;
    $("#mapaPetField").hidden = !petAtivo;
    const querPet = petAtivo && petDoBloco(m);
    const rad = $(`input[name="mapapet"][value="${querPet ? "sim" : "nao"}"]`);
    if (rad) rad.checked = true;
  }

  function voltarAoPasso1() {
    $("#mapaPasso2").hidden = true;
    $("#mapaAcoes").hidden = false;
    $("#mapaAcaoRodape").hidden = false;
    $("#mapaAcaoMsg").textContent = "";
    mapaAcaoPasso2 = "";
  }

  function abrirAcaoMesa(id) {
    // na versão da atendente o mapa é só visualização: nenhum comando
    if (mapaSoDeOlhar()) return;
    const m = mapa.find((x) => x.id === id);
    if (!m) return;
    mapaMesaAtiva = id;
    const est = estadoDaMesa(m);
    const oc = ocupanteDaMesa(m);
    const bloco = blocoDaMesa(m);
    const juntas = bloco.length > 1;
    const lugares = lugaresDoBloco(m);
    $("#mapaAcaoTitulo").textContent = juntas
      ? "Mesas " + numerosDoBloco(m).join(" + ")
      : "Mesa " + m.numero;
    const situacao = { ocupada: "🔴 ocupada", limpar: "🟡 precisa limpar",
                       avisada: "🟢 liberada", aguardando: "🔵 aguardando",
                       reservada: "⬛ reservada", livre: "🔵 aguardando" }[est];
    // Aguardando ainda não tem tamanho: os lugares são informados na hora de
    // liberar. Então só mostramos a contagem quando ela quer dizer alguma coisa.
    const mostraLugares = est !== "livre" || juntas;
    $("#mapaAcaoInfo").innerHTML =
      (mostraLugares
        ? `${lugares} ${lugares === 1 ? "lugar" : "lugares"}${juntas ? ` (${bloco.map((x) => x.lugares).join(" + ")})` : ""} — `
        : "") +
      `${situacao}${petDoBloco(m) ? " • 🐾 área pet" : ""}` +
      (oc ? `<br><b>${esc(firstName(oc.nome))}</b> sentou às ${fmtClock(oc.sentou_em)} (há <b data-since="${oc.sentou_em}">agora</b>)` : "");

    const btn = (acao, classe, texto) =>
      `<button type="button" class="btn ${classe}${(est === acao || (acao === "liberar" && est === "avisada")) ? " is-atual" : ""}" data-macao="${acao}">${texto}</button>`;
    const btns = [
      btn("livre", "btn-azul", "🔵 Aguardando"),
      btn("limpar", "btn-amarelo", "🟡 Precisa limpar"),
      btn("ocupada", "btn-vermelho", "🔴 Ocupada"),
      btn("reservada", "btn-preto", "⬛ Reservada"),
      btn("liberar", "btn-verde", "🟢 Liberada"),
      `<button type="button" class="btn btn-roxo" data-macao="juntar">🔗 Juntar mesas</button>`,
    ];
    if (juntas) btns.push(`<button type="button" class="btn btn-neutral" data-macao="separar">✂️ Separar as mesas</button>`);
    $("#mapaAcoes").innerHTML = btns.join("");
    voltarAoPasso1();
    $("#mapaAcaoModal").hidden = false;
  }

  // Confirmação do passo 2: junta o que foi escolhido (quando for o caso),
  // grava os lugares informados e libera para a recepção.
  async function confirmarPasso2() {
    const idAtiva = mapaMesaAtiva;
    let m = mapa.find((x) => x.id === idAtiva);
    if (!m) return;
    const msg = $("#mapaAcaoMsg");
    const lugares = mapaLugaresManual
      ? Math.max(1, Math.min(60, parseInt($("#mapaLugaresManual").textContent, 10) || 0))
      : mapaLugaresEscolhidos;
    if (!lugares) {
      msg.textContent = "Escolha quantos lugares.";
      msg.className = "form-msg err";
      return;
    }
    const juntando = mapaAcaoPasso2 === "juntar";
    // Só cobra a escolha de uma mesa quando ainda não há junção nenhuma. Quem
    // chegou aqui arrastando já juntou — o que falta é o tamanho, e exigir
    // outra mesa travaria o garçom num pedido sem sentido.
    if (juntando && !mapaJuntarSelecao.size && blocoDaMesa(m).length < 2) {
      msg.textContent = "Escolha ao menos uma mesa para juntar.";
      msg.className = "form-msg err";
      return;
    }
    // o que o garçom marcar aqui é a verdade do salão: o cadastro se ajusta
    const pet = CFG.petAtivo !== false &&
      ($('input[name="mapapet"]:checked') || {}).value === "sim";
    const btn = $("#mapaPasso2Ok");
    btn.disabled = true;
    $("#mapaAcaoModal").hidden = true;
    try {
      // se a junção por arrasto ainda está gravando, espera: senão as duas
      // gravações chegam fora de ordem e o banco fica com metade de cada
      if (gravacoesDoMapa) {
        await gravacoesDoMapa;
        gravacoesDoMapa = null;
        // o refresh trocou os objetos do mapa: pega a versão nova desta mesa
        m = mapa.find((x) => x.id === idAtiva) || m;
      }
      if (juntando) {
        // uma só junção: todas as escolhidas entram no mesmo grupo
        const grupo = m.grupo || uuid();
        const entram = [...mapaJuntarSelecao].map((id) => mapa.find((x) => x.id === id)).filter(Boolean);
        const gravacoes = [];
        for (const x of blocoDaMesa(m).concat(entram)) {
          if (x.grupo === grupo) continue;
          if (x.x_ant == null) { x.x_ant = x.x; x.y_ant = x.y; }
          x.grupo = grupo;
          gravacoes.push(backend.updateMapa(x.id, { grupo, x_ant: x.x_ant, y_ant: x.y_ant }));
        }
        renderMapa();
        await Promise.allSettled(gravacoes);
      }
      // Os lugares informados valem para o BLOCO. Guardamos o total na mesa
      // âncora e zeramos as outras, para a soma do bloco bater exatamente com
      // o que o garçom digitou. O pet, ao contrário, vale para TODAS: área pet
      // é do canto do salão, não de uma mesa só.
      const bloco = blocoDaMesa(m);
      const gravaLugares = bloco.map((x, i) => {
        const valor = i === 0 ? lugares : 0;
        const patch = { lugares: valor };
        if (CFG.petAtivo !== false && !!x.pet !== pet) patch.pet = pet;
        Object.assign(x, patch);
        return backend.updateMapa(x.id, patch);
      });
      await Promise.allSettled(gravaLugares);
      await liberarMesaDoMapa(m);
      await refresh();
      // Agora sim: com o desenho no ESTADO FINAL (já liberado, já com as
      // cadeiras do tamanho novo), o mapa se desempilha. Conferir antes seria
      // medir o quadradinho de aguardando — e o conjunto voltaria a cobrir a
      // vizinha assim que ganhasse as cadeiras.
      try { await arrumarSobreposicoes(m.id); }
      catch (e) { console.warn("Não deu para arrumar o mapa:", e); }
    } catch (e) {
      console.error("Erro ao liberar a mesa:", e);
      avisoStaff("⚠ Não deu para liberar a mesa — verifique a internet.");
      await refresh();
    } finally {
      btn.disabled = false;
      mapaMesaAtiva = null;
      voltarAoPasso1();
    }
  }

  async function acaoNaMesa(acao) {
    const m = mapa.find((x) => x.id === mapaMesaAtiva);
    if (!m) return;
    // "Liberada" e "Juntar" não terminam aqui: eles abrem o passo 2, onde o
    // garçom informa quantos lugares (e, no juntar, quais mesas).
    if (acao === "liberar" || acao === "juntar") { mostrarPasso2(acao, m); return; }
    // as demais fecham já: a confirmação é a mesa mudando de cor atrás
    $("#mapaAcaoModal").hidden = true;
    mapaMesaAtiva = null;
    const msg = $("#mapaAcaoMsg");
    msg.textContent = "";
    try {
      if (acao === "limpar") await encerrarMesaMapa(m.id, MAPA.LIMPAR);
      else if (acao === "reservada") await encerrarMesaMapa(m.id, MAPA.RESERVADA);
      else if (acao === "ocupada") await marcarOcupada(m.id);
      else if (acao === "livre") await voltarParaLivre(m);
      else if (acao === "separar") await separarMesas(m.id);
    } catch (e) {
      console.error("Erro na mesa do mapa:", e);
      avisoStaff("⚠ Não deu para salvar a mesa " + m.numero + " — verifique a internet e tente de novo.");
      await refresh();          // desfaz o que foi pintado na tela
    }
  }

  // ---------- editor do mapa (engrenagem) ----------
  let mapaEditando = null;   // id da mesa aberta no pop-up de cadastro
  let mmLugares = 4;
  let mmManual = false;

  // Zoom do mapa: o desenho inteiro cresce ou encolhe, sem esticar nada.
  // Mudar a PROPORÇÃO deformava o salão, porque as mesas são guardadas em
  // porcentagem: alongar a planta alongava junto o arranjo das mesas.
  // Fica guardado neste aparelho: cada tela tem um tamanho.
  const LS_ZOOM = "fila_mapa_zoom";
  function zoomDoMapa() {
    const z = Number(localStorage.getItem(LS_ZOOM));
    return z >= 0.6 && z <= 3 ? z : 1;
  }
  // Na aba do Mapa a planta ocupa TODA a tela que sobra abaixo dos botões.
  // Num tablet em pé isso é o que o garçom quer: o salão inteiro à vista,
  // sem rolar. O zoom multiplica esse tamanho (aí sim rola, se passar).
  function aplicarZoom() {
    const piso = $("#mapaPiso"), rol = $("#mapaRolagem");
    if (!piso || !rol) return;
    const z = Math.round(zoomDoMapa() * 100);
    piso.style.aspectRatio = "auto";
    piso.style.width = z + "%";
    piso.style.height = z + "%";
    // A planta ocupa toda a tela que sobra abaixo dos botões: num tablet em
    // pé o salão inteiro fica à vista, sem rolar. Mede, ajusta e confere se
    // ainda sobrou alguma coisa embaixo (margens, barra do sistema).
    const ajusta = () => {
      const topo = rol.getBoundingClientRect().top;
      let alvo = Math.round(window.innerHeight - topo - 12);
      rol.style.height = Math.max(220, alvo) + "px";
      const sobra = document.documentElement.scrollHeight - window.innerHeight;
      if (sobra > 0) rol.style.height = Math.max(220, alvo - sobra) + "px";
    };
    ajusta();
  }
  // Dobrar o cabeçalho do mapa: título, legenda e botões saem da tela e a
  // planta cresce para ocupar o espaço. Fica guardado neste aparelho — quem
  // usa o tablet o dia todo não quer reabrir isso a cada troca de aba.
  const LS_MAPA_DOBRADO = "fila_mapa_dobrado";
  function mapaDobrado() {
    return localStorage.getItem(LS_MAPA_DOBRADO) === "1";
  }
  // `forcarAberto` = modo de edição: o cabeçalho reaparece porque é lá que
  // estão os botões, mas a preferência guardada não muda — ao concluir a
  // edição o mapa volta a ficar dobrado como estava.
  function aplicarDobraDoMapa(forcarAberto) {
    const card = $("#mapaCard"), bt = $("#mapaDobrarBtn");
    if (!card || !bt) return;
    const dobrado = mapaDobrado() && !forcarAberto;
    card.classList.toggle("mapa-dobrado", dobrado);
    bt.textContent = dobrado ? "▸" : "▾";
    bt.setAttribute("aria-expanded", dobrado ? "false" : "true");
    const rotulo = dobrado ? "Mostrar o cabeçalho do mapa" : "Esconder o cabeçalho do mapa";
    bt.title = rotulo;
    bt.setAttribute("aria-label", rotulo);
    aplicarZoom();
  }
  function alternarDobraDoMapa() {
    try { localStorage.setItem(LS_MAPA_DOBRADO, mapaDobrado() ? "0" : "1"); } catch (e) { /* ignora */ }
    aplicarDobraDoMapa();
  }

  function mudarZoom(passo) {
    const nova = Math.round((zoomDoMapa() + passo) * 10) / 10;
    if (nova < 0.6 || nova > 3) return;
    try { localStorage.setItem(LS_ZOOM, String(nova)); } catch (e) { /* ignora */ }
    aplicarZoom();
  }

  // Modo de edição do mapa: acontece na PRÓPRIA tela do garçom, para o que
  // se monta ser exatamente o que se vê depois.
  let modoEdicaoMapa = false;

  function abrirEditorMapa() {
    $("#cfgModal").hidden = true;
    modoEdicaoMapa = true;
    setView("mapa");
    renderMapa();
  }
  function fecharEditorMapa() {
    modoEdicaoMapa = false;
    $("#mapaEditMsg").textContent = "";
    renderMapa();
  }
  function desenharEditorMapa() { renderMapa(); }

  // pop-up de uma mesa do cadastro (nova ou existente)
  function abrirMesaCadastro(id) {
    const m = id ? mapa.find((x) => x.id === id) : null;
    mapaEditando = m ? id : null;
    mmLugares = m ? (Number(m.lugares) || 4) : 4;
    if (m) {
      mmManual = !tamanhosDaCasa().includes(Number(mmLugares));   // respeita o cadastro
    } else {
      mmManual = false;
      mmLugares = valorDaLista(tamanhosDaCasa(), mmLugares);
    }
    $("#mapaMesaTitulo").textContent = m ? "Mesa " + m.numero : "Nova mesa";
    $("#mmNumero").value = m ? m.numero : "";
    const alvo = $(`input[name="mmpet"][value="${m && m.pet ? "sim" : "nao"}"]`);
    if (alvo) alvo.checked = true;
    $("#mmPetField").hidden = CFG.petAtivo === false;
    $("#mmApagar").hidden = !m;
    $("#mmMsg").textContent = "";
    desenharLugaresCadastro();
    $("#mapaMesaModal").hidden = false;
    focoSePuder("#mmNumero");
  }

  function desenharLugaresCadastro() {
    $("#mmTamanhos").innerHTML =
      tamanhosDaCasa().map((n) => `<button type="button" class="tm-btn${!mmManual && mmLugares === n ? " is-sel" : ""}" data-mmtam="${n}">
        <b>${n}</b><span>${n === 1 ? "lugar" : "lugares"}</span>
      </button>`).join("") +
      `<button type="button" class="tm-btn tm-outro${mmManual ? " is-sel" : ""}" data-mmtam="manual"><b>✏️</b><span>outro</span></button>`;
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
  // ==========================================================
  //  MONTAR O SALÃO DEPRESSA
  // ----------------------------------------------------------
  //  Cadastrar mesa por mesa num restaurante de quarenta mesas é meia hora
  //  de trabalho. Aqui a casa inteira nasce de uma vez e se arruma sozinha
  //  no mapa; o ajuste fino continua sendo arrastar cada uma no lugar.
  // ==========================================================

  // Distribui N pontos numa grade que respeita o formato do piso: num salão
  // largo saem mais colunas; num estreito, mais linhas.
  function gradeDoPiso(quantas) {
    const piso = $("#mapaPiso");
    const r = piso && piso.getBoundingClientRect();
    const proporcao = r && r.height ? r.width / r.height : 1.5;
    let colunas = Math.max(1, Math.round(Math.sqrt(quantas * proporcao)));
    colunas = Math.min(colunas, quantas);
    const linhas = Math.ceil(quantas / colunas);
    return { colunas, linhas };
  }

  function posicoesEmGrade(quantas) {
    const { colunas, linhas } = gradeDoPiso(quantas);
    const margemX = 8, margemY = 10;
    const larg = 100 - margemX * 2, alt = 100 - margemY * 2;
    const pontos = [];
    for (let i = 0; i < quantas; i++) {
      const col = i % colunas, lin = Math.floor(i / colunas);
      pontos.push({
        x: +(margemX + (colunas === 1 ? larg / 2 : (col * larg) / (colunas - 1))).toFixed(2),
        y: +(margemY + (linhas === 1 ? alt / 2 : (lin * alt) / (linhas - 1))).toFixed(2),
      });
    }
    return pontos;
  }

  // "Organizar no mapa": põe todas as mesas em ordem numérica numa grade.
  async function arrumarMapa() {
    if (!mapa.length) { avisoStaff("Não há mesas para organizar.", true); return; }
    if (!confirm("Reposicionar TODAS as " + mapa.length + " mesas numa grade?\n\n" +
      "O tamanho, o número e a área pet de cada uma continuam como estão — muda só o lugar no desenho.")) return;
    const ordenadas = mapa.slice().sort((a, b) =>
      String(a.numero).localeCompare(String(b.numero), "pt-BR", { numeric: true }));
    const pontos = posicoesEmGrade(ordenadas.length);
    const gravacoes = [];
    ordenadas.forEach((m, i) => {
      const p = pontos[i];
      m.x = p.x; m.y = p.y;                       // pinta na hora
      gravacoes.push(backend.updateMapa(m.id, { x: p.x, y: p.y }));
    });
    renderMapa();
    const r = await Promise.allSettled(gravacoes);
    await refresh();
    desenharEditorMapa();
    const falhas = r.filter((x) => x.status === "rejected").length;
    avisoStaff(ordenadas.length + " mesas organizadas" +
      (falhas ? " • ⚠ " + falhas + " não gravou" : ""), !falhas);
  }

  // ---------- criar várias mesas ----------
  let mlLugares = 4;
  let mlManual = false;

  function abrirLoteMesas() {
    mlLugares = valorDaLista(tamanhosDaCasa(), 4);
    mlManual = false;
    // sugere continuar de onde a numeração parou
    const maior = mapa.reduce((n, m) => Math.max(n, parseInt(String(m.numero).replace(/\D/g, ""), 10) || 0), 0);
    $("#mlInicio").value = maior + 1;
    $("#mlQtd").value = 10;
    $("#mlPet").value = "nao";
    $("#mlPetField").hidden = CFG.petAtivo === false;
    $("#mlMsg").textContent = "";
    desenharLugaresLote();
    $("#mapaLoteModal").hidden = false;
  }

  function desenharLugaresLote() {
    $("#mlTamanhos").innerHTML =
      tamanhosDaCasa().map((n) => `<button type="button" class="tm-btn${!mlManual && mlLugares === n ? " is-sel" : ""}" data-mltam="${n}">
        <b>${n}</b><span>${n === 1 ? "lugar" : "lugares"}</span>
      </button>`).join("") +
      `<button type="button" class="tm-btn tm-outro${mlManual ? " is-sel" : ""}" data-mltam="manual"><b>✏️</b><span>outro</span></button>`;
    $("#mlLugaresField").hidden = !mlManual;
    $("#mlLugares").value = mlLugares;
    atualizarPreviaLote();
  }

  function numerosDoLote() {
    const qtd = Math.max(1, Math.min(200, parseInt($("#mlQtd").value, 10) || 0));
    const inicio = Math.max(1, parseInt($("#mlInicio").value, 10) || 1);
    const existentes = new Set(mapa.map((m) => String(m.numero).trim().toLowerCase()));
    const novos = [];
    const pulados = [];
    for (let i = 0; i < qtd; i++) {
      const n = String(inicio + i);
      if (existentes.has(n.toLowerCase())) pulados.push(n);
      else novos.push(n);
    }
    return { novos, pulados };
  }

  function atualizarPreviaLote() {
    const { novos, pulados } = numerosDoLote();
    const p = $("#mlPrevia");
    if (!p) return;
    if (!novos.length) {
      p.textContent = "Todos esses números já existem no mapa.";
      return;
    }
    p.textContent = `Vai criar ${novos.length} ${novos.length === 1 ? "mesa" : "mesas"} de ` +
      `${mlLugares} ${mlLugares === 1 ? "lugar" : "lugares"}: ${novos[0]} a ${novos[novos.length - 1]}` +
      (pulados.length ? ` (pulando ${pulados.length} que já existem)` : "") + ".";
  }

  async function criarLoteMesas() {
    const msg = $("#mlMsg");
    const { novos } = numerosDoLote();
    if (!novos.length) { msg.textContent = "Nada a criar: esses números já existem."; msg.className = "form-msg err"; return; }
    const pet = $("#mlPet").value === "sim" && CFG.petAtivo !== false;
    const btn = $("#mlCriar");
    btn.disabled = true;
    msg.textContent = "Criando…"; msg.className = "form-msg";
    // as novas entram numa grade junto com as que já existem
    const total = mapa.length + novos.length;
    const pontos = posicoesEmGrade(total);
    const agora = new Date().toISOString();
    const gravacoes = novos.map((numero, i) => {
      const p = pontos[mapa.length + i] || { x: 50, y: 50 };
      return backend.addMapa({
        id: uuid(), numero, lugares: mlLugares, pet,
        x: p.x, y: p.y, status: MAPA.LIVRE, liberada_em: null, criado_em: agora,
      });
    });
    const r = await Promise.allSettled(gravacoes);
    const falhas = r.filter((x) => x.status === "rejected").length;
    await refresh();
    desenharEditorMapa();
    btn.disabled = false;
    if (falhas) {
      msg.textContent = falhas + " de " + novos.length + " não foram criadas — verifique a internet.";
      msg.className = "form-msg err";
      return;
    }
    $("#mapaLoteModal").hidden = true;
    avisoStaff((novos.length - falhas) + " mesas criadas no mapa.", true);
  }

  function posicaoLivre() {
    for (let y = 12; y <= 88; y += 16) {
      for (let x = 10; x <= 90; x += 14) {
        const perto = mapa.some((m) => Math.abs(m.x - x) < 10 && Math.abs(m.y - y) < 12);
        if (!perto) return { x, y };
      }
    }
    return { x: 50, y: 50 };
  }

  // Excluir direto pelo botãozinho da mesa, no editor
  async function excluirMesaDoMapa(id) {
    const m = mapa.find((x) => x.id === id);
    if (!m) return;
    if (!confirm("Excluir a mesa " + m.numero + " do mapa?")) return;
    try {
      await backend.removeMapa(id);
      await refresh();
      desenharEditorMapa();
    } catch (e) {
      console.error("Erro ao excluir a mesa do mapa:", e);
      $("#mapaEditMsg").textContent = "Não deu para excluir — verifique a internet.";
      $("#mapaEditMsg").className = "form-msg err";
    }
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
  // Arrastar mesas. Serve para duas coisas diferentes:
  //   - no EDITOR (engrenagem): move a mesa e guarda a posição
  //   - no MAPA do garçom: solta em cima de outra mesa para JUNTAR
  //     (soltar em espaço vazio não muda nada, a mesa volta ao lugar)
  // Arrastar mesas. Serve para duas coisas diferentes:
  //   - no EDITOR (engrenagem): move a mesa e guarda a posição
  //   - no MAPA do garçom: solta em cima de outra mesa para JUNTAR
  //
  // O gesto é: TOQUE simples abre; PRESSIONAR E SEGURAR libera o arrasto.
  // Sem isso, no celular qualquer tremida do dedo virava arrasto e o pop-up
  // não abria — foi o que travou o garçom.
  // Trava/destrava a rolagem da página (usada enquanto uma mesa está na mão)
  let _rolagemAntes = "";
  function travarRolagem(travar) {
    if (travar) {
      _rolagemAntes = document.body.style.overflow;
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = _rolagemAntes || "";
    }
  }

  function ligarArrasto(seletor, modoBase) {
    // O mesmo piso serve para os dois usos: no dia a dia arrastar JUNTA mesas;
    // no modo de edição arrastar POSICIONA. Por isso o modo é lido na hora.
    const modo = () => (modoBase === "juntar" && modoEdicaoMapa ? "editar" : modoBase);
    const piso = $(seletor);
    if (!piso) return;
    // o menu de "copiar" do Android aparece ao segurar: aqui ele só atrapalha
    piso.addEventListener("contextmenu", (e) => e.preventDefault());
    let alvo = null, podeArrastar = false, moveu = false;
    let tocouEm = 0;          // hora do toque, para separar toque de arrasto
    // O Android manda os eventos em ordens diferentes conforme a versão
    // (ponteiro, toque, clique) e às vezes engole alguns. Em vez de depender
    // de um deles, qualquer um pode abrir — e uma trava de tempo impede que
    // dois cheguem juntos e abram duas vezes.
    let ultimoToque = 0;
    let dx = 0, dy = 0, posOriginal = null, xInicial = 0, yInicial = 0, relogio = null;
    const SEGURAR = 350;   // ms de dedo parado para liberar o arrasto
    const FOLGA = 10;      // px de tremida que ainda contam como "parado"


    // Qual mesa está neste ponto da tela. Serve de plano B: se o mapa foi
    // redesenhado entre o toque e o clique, o elemento antigo não existe mais,
    // mas o ponto continua sobre a mesma mesa.
    const mesaNoPonto = (x, y) => {
      let melhor = null, menor = Infinity;
      $$(seletor + " .mm-mesa").forEach((el) => {
        const r = el.getBoundingClientRect();
        const dentro = x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
        const d = Math.hypot(x - (r.left + r.width / 2), y - (r.top + r.height / 2));
        if (dentro && d < menor) { menor = d; melhor = el; }
      });
      return melhor;
    };

    // Abre a mesa, venha o aviso de onde vier. A trava de 500ms garante que
    // ponteiro + toque + clique do MESMO gesto abram uma vez só.
    const abrirPorToque = (id) => {
      const agora = Date.now();
      if (agora - ultimoToque < 500) return;
      ultimoToque = agora;
      if (modo() === "juntar") acaoSegura("abrir mesa do mapa", () => abrirAcaoMesa(id))();
      else abrirMesaCadastro(id);
    };

    const soltar = () => {
      piso.classList.remove("is-pegando");
      travarRolagem(false);
      setTimeout(liberarDesenhoDoMapa, 600);
      clearTimeout(relogio);
      if (alvo) alvo.classList.remove("is-arrastando", "is-pronto");
      $$(seletor + " .mm-mesa").forEach((x) => x.classList.remove("is-alvo"));
      alvo = null; podeArrastar = false; moveu = false;
    };

    // Qual mesa está embaixo da que está sendo arrastada. Comparo as posições
    // no lugar de perguntar ao navegador quem está sob o dedo: com o dedo, o
    // ponto exato erra muito; o centro da mesa não.
    // Qual mesa está EMBAIXO da que está sendo arrastada. Antes bastava chegar
    // perto (uma mesa e um terço de distância) e, com as mesas desenhadas
    // largas, isso agarrava a vizinha errada. Agora tem que estar em cima
    // mesmo: o centro da mesa arrastada precisa cair DENTRO da outra.
    const soltoEmCima = () => {
      if (!alvo) return null;
      const r = alvo.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const FOLGA_ENCAIXE = 6;   // px de tolerância, só para o dedo não ter que ser cirúrgico
      let melhor = null, menor = Infinity;
      $$(seletor + " .mm-mesa").forEach((el) => {
        if (el === alvo) return;
        if (modo() === "juntar") {
          const m = mapa.find((x) => x.id === el.dataset.mapamesa);
          if (m && !podeJuntar(m)) return;
        }
        const o = el.getBoundingClientRect();
        const dentro = cx >= o.left - FOLGA_ENCAIXE && cx <= o.right + FOLGA_ENCAIXE &&
                       cy >= o.top - FOLGA_ENCAIXE && cy <= o.bottom + FOLGA_ENCAIXE;
        if (!dentro) return;
        const dist = Math.hypot(cx - (o.left + o.width / 2), cy - (o.top + o.height / 2));
        if (dist < menor) { menor = dist; melhor = el; }
      });
      return melhor;
    };

    piso.addEventListener("pointerdown", (e) => {
      // os botõezinhos de editar/excluir não arrastam nem abrem a mesa
      if (e.target.closest("[data-mmedit],[data-mmdel]")) return;
      const el = e.target.closest("[data-mapamesa]");
      if (!el) return;
      alvo = el; podeArrastar = false; moveu = false;
      segurarDesenhoDoMapa();   // segura o redesenho em qualquer modo
      tocouEm = e.timeStamp || 0;
      xInicial = e.clientX; yInicial = e.clientY;
      posOriginal = { left: el.style.left, top: el.style.top };
      const r = el.getBoundingClientRect();
      dx = e.clientX - (r.left + r.width / 2);
      dy = e.clientY - (r.top + r.height / 2);
      try { el.setPointerCapture(e.pointerId); } catch (err) { /* sem pointer real */ }
      // No editor não existe "rolar a página": a planta ocupa a tela. Travando
      // a rolagem já no encostar do dedo, o navegador não tem como concluir no
      // meio do gesto que aquilo era rolagem e cancelar o arrasto.
      if (modo() === "editar") { piso.classList.add("is-pegando"); travarRolagem(true); }
      // liberada ou ocupada não sai do lugar: arrastar não faria sentido
      if (modo() === "juntar") {
        const eu = mapa.find((x) => x.id === el.dataset.mapamesa);
        if (eu && !podeJuntar(eu)) return;
      }
      // No editor o toque simples abre o cadastro e o movimento arrasta: não há
      // por que esperar. No dia a dia continua exigindo segurar, senão a mesa
      // sairia do lugar quando o garçom só quis abrir as opções.
      if (modo() === "editar") podeArrastar = true;
      relogio = setTimeout(() => {
        podeArrastar = true;
        // Aqui NÃO se trava a abertura: segurar sem mover continua sendo um
        // toque, e trancar isso era o que fazia o pop-up não abrir para quem
        // aperta um pouco mais devagar.
        el.classList.add("is-pronto");
        // Só agora o mapa toma conta do dedo. O touch-action sozinho não
        // resolveria: o Android decide se o gesto é rolagem no primeiro
        // toque e ignora a mudança depois. Travar a rolagem da página
        // enquanto a mesa está na mão é o que funciona nos dois.
        piso.classList.add("is-pegando");
        travarRolagem(true);
        // um toque de vibração avisa que já pode arrastar
        if (navigator.vibrate) { try { navigator.vibrate(15); } catch (err) { /* ignora */ } }
      }, SEGURAR);
    });

    window.addEventListener("pointermove", (e) => {
      if (!alvo) return;
      const longe = Math.hypot(e.clientX - xInicial, e.clientY - yInicial) > FOLGA;
      if (!podeArrastar) {
        // saiu do lugar antes de segurar: não é toque nem arrasto (é rolagem)
        if (longe) { clearTimeout(relogio); moveu = true; }
        return;
      }
      const p = piso.getBoundingClientRect();
      if (!p.width || !p.height) return;
      moveu = moveu || longe;
      const x = ((e.clientX - dx - p.left) / p.width) * 100;
      const y = ((e.clientY - dy - p.top) / p.height) * 100;
      // uma folga nas bordas para a mesa não sair do piso
      alvo.style.left = Math.max(4, Math.min(96, x)) + "%";
      alvo.style.top = Math.max(6, Math.min(94, y)) + "%";
      alvo.classList.add("is-arrastando");
      if (modo() === "juntar") {
        // Acende o destino quando a arrastada chega perto. Se ele já faz parte
        // de um bloco, acende o bloco inteiro: fica claro a que conjunto a
        // mesa vai se somar.
        const outra = soltoEmCima();
        const alvoM = outra ? mapa.find((x) => x.id === outra.dataset.mapamesa) : null;
        const ids = alvoM ? new Set(blocoDaMesa(alvoM).map((x) => x.id)) : new Set();
        $$(seletor + " .mm-mesa").forEach((x2) =>
          x2.classList.toggle("is-alvo", ids.has(x2.dataset.mapamesa)));
      }
    });

    const fim = async (e) => {
      if (!alvo) return;
      const el = alvo, arrastou = podeArrastar && moveu;
      const outra = modo() === "juntar" && arrastou ? soltoEmCima() : null;
      // O QUE DECIDE É O MOVIMENTO, NÃO O RELÓGIO. Antes o toque só valia se
      // fosse rápido (meio segundo); quem apertava um tiquinho mais não abria
      // nada, e o clique atrasado do Android caía no pop-up e trocava o estado
      // da mesa sozinho. Dedo que não saiu do lugar é toque, demore o que
      // demorar; dedo que arrastou é arrasto. Não há terceira possibilidade.
      const dist = e ? Math.hypot((e.clientX || 0) - xInicial, (e.clientY || 0) - yInicial) : 0;
      const eraToque = !moveu && dist < 24;
      const id = el.dataset.mapamesa;
      soltar();

      if (eraToque) { abrirPorToque(id); return; }
      if (!arrastou) return;                     // segurou e soltou sem mover
      ultimoToque = Date.now();

      if (modo() === "juntar") {
        // soltou no vazio: a mesa volta para onde estava
        if (!outra) {
          el.style.left = posOriginal.left;
          el.style.top = posOriginal.top;
          return;
        }
        const px = Math.round(parseFloat(el.style.left) * 10) / 10;
        const py = Math.round(parseFloat(el.style.top) * 10) / 10;
        try { await juntarMesas(id, outra.dataset.mapamesa, { x: px, y: py }); }
        catch (err) {
          console.error("Erro ao juntar mesas:", err);
          avisoStaff("Não deu para juntar as mesas — verifique a internet.");
        }
        return;
      }

      // editor: guarda a posição nova
      const x = Math.round(parseFloat(el.style.left) * 10) / 10;
      const y = Math.round(parseFloat(el.style.top) * 10) / 10;
      const m = mapa.find((v) => v.id === id);
      if (m) { m.x = x; m.y = y; }
      try { await backend.updateMapa(id, { x, y }); }
      catch (err) {
        console.error("Erro ao mover a mesa:", err);
        $("#mapaEditMsg").textContent = "Não deu para guardar a posição — verifique a internet.";
        $("#mapaEditMsg").className = "form-msg err";
      }
    };

    // Os eventos de movimento e de fim ficam na JANELA, não no piso: se o mapa
    // for redesenhado no meio do gesto, o elemento antigo some e os eventos
    // presos a ele sumiriam junto — a mesa "soltava sozinha".
    window.addEventListener("pointerup", fim);
    // Cancelamento não pode virar gesto perdido. Se a mesa estava sendo
    // arrastada, guardamos onde ela parou. Se o dedo nem saiu do lugar, aquilo
    // era um toque — e toque abre as opções, mesmo que o sistema tenha cortado
    // o gesto no meio (é o que acontecia ao segurar um pouco mais).
    window.addEventListener("pointercancel", (e) => {
      if (podeArrastar && moveu) { fim(e); return; }
      const id = alvo && alvo.dataset.mapamesa;
      const parado = !moveu;
      soltar();
      if (id && parado) abrirPorToque(id);
    });

    // Segunda rede: no Android o "touchend" chega mesmo quando os eventos de
    // ponteiro são cancelados e o clique é engolido.
    piso.addEventListener("touchend", (e) => {
      const t = e.changedTouches && e.changedTouches[0];
      if (!t) return;
      const el = document.elementFromPoint(t.clientX, t.clientY);
      const mesa = (el && el.closest && el.closest("[data-mapamesa]")) || mesaNoPonto(t.clientX, t.clientY);
      if (mesa) abrirPorToque(mesa.dataset.mapamesa);
    }, { passive: true });

    // Rede de segurança: se o navegador cancelar os eventos de dedo no meio
    // (acontece no Android quando ele acha que o gesto virou rolagem), o
    // clique ainda chega. Sem isto, o toque simples às vezes não abria nada.
    piso.addEventListener("click", (e) => {
      const edit = e.target.closest("[data-mmedit]");
      if (edit) { e.stopPropagation(); abrirMesaCadastro(edit.dataset.mmedit); return; }
      const del = e.target.closest("[data-mmdel]");
      if (del) { e.stopPropagation(); excluirMesaDoMapa(del.dataset.mmdel); return; }
      const el = e.target.closest("[data-mapamesa]") || mesaNoPonto(e.clientX, e.clientY);
      if (el) abrirPorToque(el.dataset.mapamesa);
    });
  }

  // Pop-up de ações de uma mesa livre (abre ao segurar o cartão na atendente)
  let mesaLivreAtiva = null;

  function abrirAcoesMesaLivre(id) {
    const m = mesasLivres.find((x) => x.id === id);
    if (!m) return;
    mesaLivreAtiva = id;
    const cliente = m.reservada_para ? rows.find((r) => r.id === m.reservada_para) : null;
    $("#mlTitulo").textContent = m.numeros ? "Mesa " + m.numeros : "Mesa sem número";
    $("#mlInfo").innerHTML = `${m.lugares} ${m.lugares === 1 ? "lugar" : "lugares"}${m.pet ? " • 🐾 área pet" : ""}` +
      (m.identificacao ? ` • ${esc(m.identificacao)}` : "") +
      (m.reservada_para
        ? `<br>🔔 chamada para <b>${esc(cliente ? firstName(cliente.nome) : "um cliente")}</b>, aguardando sentar`
        : "");
    // quando a mesa está reservada, a saída mais comum é o cliente ter ido
    // parar em outra mesa: sem esse botão, a mesa ficaria vermelha até alguém
    // "usar" ou excluir, e ninguém conseguiria oferecê-la a outro grupo
    const soltar = m.reservada_para
      ? `<button type="button" class="btn btn-primary" data-mlacao="soltar">↩️ O cliente sentou em outra mesa</button>` : "";
    $("#mlAcoes").innerHTML = soltar + `
      <button type="button" class="btn ${m.reservada_para ? "btn-neutral" : "btn-primary"}" data-mlacao="usei">✓ Já usei esta mesa</button>
      <button type="button" class="btn btn-edit" data-mlacao="editar">✏️ Corrigir a mesa</button>
      <button type="button" class="btn btn-azul" data-mlacao="apagar">↩️ Voltar para aguardando</button>`;
    $("#mesaLivreModal").hidden = false;
  }

  async function acaoMesaLivre(acao) {
    const id = mesaLivreAtiva;
    const m = mesasLivres.find((x) => x.id === id);
    if (!m) return;
    $("#mesaLivreModal").hidden = true;
    mesaLivreAtiva = null;
    try {
      if (acao === "soltar") {
        // solta a mesa sem mexer no cliente: ele será sentado em outra
        await backend.updateMesa(id, { reservada_para: null });
        await refresh();
      }
      else if (acao === "usei") await usarMesa(id);
      else if (acao === "editar") abrirMesaModal(id);
      else if (acao === "apagar") {
        if (confirm("Mover esta mesa de volta para aguardando?")) await apagarMesa(id);
      }
    } catch (e) {
      console.error("Ação na mesa livre falhou:", e);
      avisoStaff("Não deu para salvar — verifique a internet e tente de novo.");
    }
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
  // Uma célula de CSV, pronta para o Excel. Nome, telefone e comanda são texto
  // digitado no totem: se a célula começa com = + - @ o Excel abre como
  // FÓRMULA; o apóstrofo força a leitura como texto.
  function csvCampo(v) {
    let s = String(v == null ? "" : v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[";\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
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
    const msg = (CFG.msgPedido || MSG_PEDIDO_PADRAO)
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
    // guardado neste aparelho, ainda não chegou ao servidor
    if (staff && r._pendente) h += `<span class="q-chip chip-pendente">⏳ não enviado</span>`;
    if (r.pet) h += `<span class="q-chip chip-pet">🐾 pet</span>`;
    if (r.sem_area_pet) h += `<span class="q-chip chip-sempet">🚫 sem área pet</span>`;
    if (staff && r.mesa_numero) h += `<span class="q-chip chip-mesa">🪑 mesa ${esc(r.mesa_numero)}</span>`;
    if (staff && r.comanda) h += `<span class="q-chip">🧾 ${esc(r.comanda)}</span>`;
    if (staff && r.pager) h += `<span class="q-chip">🔔 ${esc(r.pager)}</span>`;
    return h;
  }

  // Este aviso abre o WhatsApp, ou só é registrado?
  // Quem decide é a engrenagem (`pedidoWhats`). Com o WhatsApp desligado o
  // cliente continua sendo avisado — pela notificação no celular e pelo painel
  // do totem —, só não abre conversa nenhuma na tela da atendente.
  function pedidoUsaWhats(r) {
    return CFG.pedidoWhats !== false && CFG.whatsAtivo !== false && !!r.telefone;
  }

  // Botão "pedido pronto": avisa o cliente que pode retirar.
  // Com WhatsApp é um link de verdade (e não um window.open) para o navegador
  // não bloquear; sem WhatsApp é um botão comum, que só registra.
  function pedidoBtnHTML(r) {
    if (CFG.avisoPedido === false) return "";
    // com o WhatsApp ligado e sem telefone não há o que fazer por aqui
    if (CFG.pedidoWhats !== false && (CFG.whatsAtivo === false || !r.telefone)) return "";
    const feito = !!r.pedido_em;
    const classe = `btn btn-sm btn-pedido ${feito ? "is-feito" : ""}`;
    const rotulo = feito ? "🔁 avisar de novo" : "🍽 Pedido pronto";
    const titulo = feito
      ? "Último aviso às " + fmtClock(r.pedido_em) + " — pode avisar de novo"
      : "Avisar que o pedido está pronto";
    const link = pedidoUsaWhats(r) ? waLinkPedido(r) : "";
    return link
      ? `<a class="${classe}" href="${link}" target="_blank" rel="noopener"
          data-pedido="${r.id}" title="${titulo}">${rotulo}</a>`
      : `<button type="button" class="${classe}" data-pedido="${r.id}" title="${titulo}">${rotulo}</button>`;
  }

  // ==========================================================
  //  BUSCA NA FILA (só a atendente)
  // ----------------------------------------------------------
  //  Um campo só, que procura em tudo. No corrido do serviço, escolher antes
  //  "buscar por nome / por telefone" seria um toque a mais sem ganho: os
  //  formatos quase nunca se confundem e ela reconhece o resultado na hora.
  // ==========================================================
  let busca = "";

  // Só coloca o cursor no campo em aparelho com mouse. No celular isso abriria
  // o teclado junto com o pop-up, cobrindo metade da tela sem ninguém pedir.
  const temMouse = () => {
    try { return window.matchMedia("(hover: hover) and (pointer: fine)").matches; }
    catch (e) { return true; }
  };
  function focoSePuder(seletor, ms) {
    if (!temMouse()) return;
    setTimeout(() => { const el = $(seletor); if (el) el.focus(); }, ms || 60);
  }

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

  // ONDE procurar, na tela da atendente. Sem nada marcado, o campo procura em
  // tudo (nome, telefone, comanda, pager, mesa). Marcando "só comanda", ele
  // procura APENAS entre as comandas — é o que evita achar a comanda 12 quando
  // o que se queria era a mesa 12. Marcando os dois, procura nos dois.
  const filtros = new Set();

  function desenharFiltros() {
    const box = $("#buscaFiltros");
    if (!box) return;
    $$("#buscaFiltros .bf-chip").forEach((b) => {
      // o "limpar" só aparece quando há o que limpar
      if (b.dataset.filtro === "limpar") { b.hidden = !busca.trim() && !filtros.size; return; }
      b.classList.toggle("is-on", filtros.has(b.dataset.filtro));
    });
    const campo = $("#buscaInput");
    if (campo) {
      campo.placeholder = filtros.size
        ? "Procurar " + [...filtros].map((f) => (f === "pager" ? "pager" : "comanda")).join(" ou ")
        : "Procurar por nome, telefone, comanda, pager ou mesa";
    }
  }

  function combinaBusca(r) {
    const t = semAcento(busca).trim();
    if (!t) return true;
    // escopo escolhido nos chips: procura só naquele campo
    if (filtros.size) {
      if (filtros.has("comanda") && semAcento(r.comanda).includes(t)) return true;
      if (filtros.has("pager") && semAcento(r.pager).includes(t)) return true;
      return false;
    }
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
  // Minutos até um grupo ser considerado "ficando para trás" na fila resumida
  // do garçom. Vale para qualquer grupo, preferencial ou não.
  function alertaDoResumo() {
    const v = Number(CFG.resumoAlerta);
    return isNaN(v) || v < 0 ? 30 : v;
  }

  function prazoDaFila(r) {
    if (isMesona(r)) return Number(CFG.mesonaPrazo) || 0;
    if (r.preferencial) return Number(CFG.prefPrazo) || 0;
    return Number(CFG.normalPrazo) || 0;
  }

  // HTML de um item da fila. `junto` = lista única (totem): como não há cabeçalho
  // de grupo, o tipo de cada pessoa vira selo no próprio item.
  // Veio da fila da fila e ainda não foi conferido pela recepção. Enquanto
  // estiver assim, o cartão fica ROXO em vez de entrar no semáforo de espera:
  // é um aviso de "esta pessoa acabou de entrar na fila, confira o cadastro".
  // O destaque sai sozinho quando a atendente preenche comanda ou pager.
  function recemPromovido(r) {
    if (!r.previa_em || r.status !== STATUS.AGUARDANDO) return false;
    const querComanda = CFG.campoComanda !== false;
    const querPager = CFG.campoPager !== false;
    if (!querComanda && !querPager) return false;   // nada a preencher: não destaca
    const temComanda = !!String(r.comanda || "").trim();
    const temPager = !!String(r.pager || "").trim();
    if (querComanda && temComanda) return false;
    if (querPager && temPager) return false;
    return true;
  }

  function queueItemHTML(r, i, staff, junto) {
    const meso = isMesona(r);
    const novo = staff && recemPromovido(r);
    const selosTipo = junto
      ? (r.preferencial ? `<span class="q-tag pref">★ preferencial</span>` : "") +
        (meso ? `<span class="q-tag meso">🍽 mesa grande</span>` : "")
      : (r.preferencial && meso ? `<span class="q-tag pref">★ preferencial</span>` : "");
    const perdeu = staff && r.chamadas_perdidas
      ? `<span class="q-tag perdeu">⚠️ perdeu a vez${r.chamadas_perdidas > 1 ? " (" + r.chamadas_perdidas + "×)" : ""}</span>` : "";
    // Na tela da atendente o cartão é enxuto: nome, tamanho do grupo, espera e
    // pet. Todo o resto (telefone, comanda, pager, botões) está no pop-up que
    // abre ao tocar — assim a fila inteira cabe na tela.
    const petChips = (r.pet ? `<span class="q-chip chip-pet">🐾 pet</span>` : "") +
      (r.sem_area_pet ? `<span class="q-chip chip-sempet">🚫 sem área pet</span>` : "");
    if (staff) {
      // Quem acabou de vir da fila da fila NÃO entra no semáforo de espera:
      // sem o `data-espera-since`, o relógio não pinta por cima do roxo.
      return `
      <li class="q-item is-toque ${r.preferencial ? "is-pref" : ""} ${meso ? "is-meso" : ""} ${r.chamadas_perdidas ? "is-perdeu" : ""} ${novo ? "is-daprevia" : ""}"
          data-cliente="${r.id}" role="button" tabindex="0"
          ${prazoDaFila(r) && !novo ? `data-espera-since="${r.criado_em}" data-espera-prazo="${prazoDaFila(r)}"` : ""}>
        <div class="q-pos">${i + 1}</div>
        <div class="q-main">
          <div class="q-name">${esc(r.nome)}${selosTipo}${perdeu}${novo ? `<span class="q-tag novo">🎟 confira o cadastro</span>` : ""}</div>
          <div class="q-sub">
            <span>👥 ${r.pessoas} ${r.pessoas === 1 ? "pessoa" : "pessoas"}</span>
            <span>⏱️ <b class="q-time" data-since="${r.criado_em}">agora</b></span>
            ${petChips}
          </div>
        </div>
      </li>`;
    }
    return `
      <li class="q-item ${r.preferencial ? "is-pref" : ""} ${meso ? "is-meso" : ""}">
        <div class="q-pos">${i + 1}</div>
        <div class="q-main">
          <div class="q-name">${esc(firstName(r.nome))}${selosTipo}</div>
          <div class="q-sub">
            <span>👥 ${r.pessoas} ${r.pessoas === 1 ? "pessoa" : "pessoas"}</span>
            ${CFG.mostrarHoraEntrada !== false ? `<span>🕐 ${fmtClock(r.criado_em)}</span>` : ""}
            ${CFG.mostrarTempoEspera !== false ? `<span>⏱️ esperando <b class="q-time" data-since="${r.criado_em}">agora</b></span>` : ""}
            ${petChips}
          </div>
        </div>
      </li>`;
  }

  // Ficha completa do cliente, com os botões de ação. Abre ao tocar no cartão.
  function abrirCliente(id) {
    const r = rows.find((x) => x.id === id);
    if (!r) return;
    const meso = isMesona(r);
    $("#cliNome").textContent = r.nome;
    $("#cliSelos").innerHTML =
      (r.preferencial ? `<span class="q-tag pref">★ preferencial</span>` : `<span class="q-tag">normal</span>`) +
      (meso ? `<span class="q-tag meso">🍽 mesa grande</span>` : "") +
      (r.pet ? `<span class="q-chip chip-pet">🐾 pet</span>` : "") +
      (r.sem_area_pet ? `<span class="q-chip chip-sempet">🚫 sem área pet</span>` : "") +
      (r.chamadas_perdidas ? `<span class="q-tag perdeu">⚠️ perdeu a vez ${r.chamadas_perdidas}×</span>` : "");

    const linha = (rotulo, valor) => valor ? `<dt>${rotulo}</dt><dd>${valor}</dd>` : "";
    $("#cliDados").innerHTML =
      linha("Pessoas", `${r.pessoas} ${r.pessoas === 1 ? "pessoa" : "pessoas"}`) +
      // "esperando há X" só vale para quem AINDA espera. Para quem já sentou,
      // o relógio da espera parou — mostrar o de agora seria mentira.
      linha("Entrou", r.status === STATUS.SENTADO
        ? fmtClock(entradaEm(r))
        : `${fmtClock(entradaEm(r))} — esperando há <b data-since="${entradaEm(r)}">agora</b>`) +
      linha("Sentou", r.sentou_em ? fmtClock(r.sentou_em) : "") +
      linha("Telefone", r.telefone ? esc(r.telefone) : "") +
      linha("E-mail", r.email ? esc(r.email) : "") +
      linha("Aniversário", r.aniversario ? esc(r.aniversario) : "") +
      linha("Comanda", r.comanda ? esc(r.comanda) : "") +
      linha("Pager", r.pager ? esc(r.pager) : "") +
      linha("Mesa", r.mesa_numero ? esc(r.mesa_numero) : "") +
      linha("Chamado", r.chamado_em ? fmtClock(r.chamado_em) : "");

    // Aqui o WhatsApp abre EM BRANCO, de propósito. Este botão é o "preciso
    // falar com essa pessoa" — a atendente vai escrever o que o caso pedir.
    // As mensagens prontas ficam onde têm assunto: no cartão da chamada
    // ("sua mesa está pronta") e no botão de pedido pronto.
    const wa = (CFG.whatsAtivo !== false && r.telefone && waNumber(r.telefone))
      ? `<a class="btn btn-sm ci-wa" href="https://wa.me/${waNumber(r.telefone)}" target="_blank" rel="noopener">📲 WhatsApp</a>` : "";
    // O perfil Pedidos tem uma ação só: avisar que o prato saiu. Editar ou
    // devolver à fila não é trabalho dele — e o banco também não deixaria.
    if (soPedidos()) {
      $("#cliAcoes").innerHTML = `${pedidoBtnHTML(r)}${wa}`;
      $("#clienteModal").hidden = false;
      return;
    }
    // Quem já está na mesa tem UMA ação: voltar para a fila. Qualquer correção
    // (nome, comanda, pager) a atendente faz na fila, onde o cadastro é dela.
    // Menos botão aqui é menos chance de mexer sem querer em quem já sentou.
    // Fila da fila: as ações dela são outras. Nada de chamar mesa nem de
    // pedido pronto — essa pessoa ainda nem está na fila de espera.
    if (r.status === STATUS.PREVIA) {
      const avisado = !!r.previa_avisado_em;
      $("#cliAcoes").innerHTML =
        `<button class="btn btn-sm btn-verde" data-ffpromover="${r.id}">➡ Colocar na fila de espera</button>
         <button class="btn btn-sm ${avisado ? "" : "btn-accent"}" data-ffavisar="${r.id}">${
           avisado ? "🔁 Avisar de novo" : "🔔 Avisar que abriu vaga"}</button>
         <button class="btn btn-sm" data-edit="${r.id}">✏️ Editar</button>
         <button class="btn btn-sm btn-ghost btn-danger" data-drop="${r.id}">🗑 Remover</button>`;
      $("#clienteModal").hidden = false;
      return;
    }
    if (r.status === STATUS.SENTADO) {
      $("#cliAcoes").innerHTML =
        `<button class="btn btn-sm btn-verde" data-finish="${r.id}">🏁 Finalizado</button>
         <button class="btn btn-sm" data-back="${r.id}">↩️ Voltar à fila</button>`;
      $("#clienteModal").hidden = false;
      return;
    }
    $("#cliAcoes").innerHTML = `
      <button class="btn btn-accent" data-call="${r.id}">🔔 Chamar</button>
      <button class="btn btn-primary" data-seat="${r.id}">✓ Sentou</button>
      <button class="btn btn-edit" data-edit="${r.id}">✏️ Editar</button>
      ${wa}
      ${CFG.linkAtivo === false ? "" : `<button class="btn btn-qr" data-qrcliente="${r.id}">📱 QR do cliente</button>`}
      ${pedidoBtnHTML(r)}
      <button class="btn btn-roxo" data-ffrebaixar="${r.id}">🎟 Enviar para a fila da fila</button>
      <button class="btn btn-danger" data-drop="${r.id}">✕ Saiu da fila</button>`;
    $("#clienteModal").hidden = false;
  }

  // Botão de adicionar: rótulo por aba e bloqueio quando a fila está fechada (totem)
  function updateAddBtn() {
    const btn = $("#openFormBtn");
    if (!btn) return;
    // Tem casa que não quer o cliente se cadastrando sozinho: o totem vira só
    // painel de acompanhamento e quem lança na fila é a recepção. O botão some
    // apenas no totem — a atendente e o garçom continuam com o deles.
    const soPainel = !isStaff() && !isGarcom() && !naAbaPrevia() && CFG.totemEntrada === false;
    btn.hidden = soPainel;
    // sem botão nenhum, a barra fixa de baixo some junto: senão fica uma
    // tarja cinza ocupando o pé da tela do totem
    const barra = document.querySelector(".add-bar");
    const outro = $("#freeTableBtn");
    if (barra) barra.hidden = soPainel && (!outro || outro.hidden);
    if (soPainel) return;
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
      // na atendente o botão divide a barra com o de chamar: rótulo curto
      btn.textContent = "➕ " + (isStaff() ? "Adicionar" : "Entrar na fila");
    }
  }

  function render() {
    const wTodos = waiting();
    const cTodos = called();
    const staff = isStaff();

    // busca (só na tela da atendente): esconde quem não combina, sem tirar da fila
    const buscando = staff && !!busca.trim();
    desenharFiltros();
    const w = buscando ? wTodos.filter(combinaBusca) : wTodos;
    const c = buscando ? cTodos.filter(combinaBusca) : cTodos;
    atualizarAvisoBusca(buscando, w.length + c.length, wTodos.length + cTodos.length);

    // -------- listas: mesas grandes, preferencial e normal --------
    const meso = w.filter(isMesona);
    const pref = w.filter((r) => r.preferencial && !isMesona(r));
    const norm = w.filter((r) => !r.preferencial && !isMesona(r));
    $("#statTotal").textContent = buscando ? `${w.length}/${wTodos.length}` : wTodos.length;

    // -------- contador no cabeçalho (perfil atendente) --------
    // O número que conta para a atendente é o de PESSOAS (é ele que enche o
    // salão); o de grupos vem junto, menor, porque é o que ela chama por vez.
    // A busca não mexe aqui: o cabeçalho mostra a fila inteira, sempre.
    const topo = $("#filaTopo");
    if (topo) {
      // nunca no totem: aquela tela é do cliente, não do controle do salão.
      // A fila da fila também vê: é por este número que ela sabe se já pode
      // passar alguém da antessala para a fila de espera.
      topo.hidden = (!podeVer("staff") && !podeVer("filafila")) ||
        appEl.getAttribute("data-view") === "totem";
      if (!topo.hidden) {
        const pessoasNaFila = wTodos.reduce((a, r) => a + Number(r.pessoas || 0), 0);
        topo.innerHTML = `👥 <b>${pessoasNaFila}</b> ${pessoasNaFila === 1 ? "pessoa" : "pessoas"}` +
          `<span class="ft-grupos">• ${wTodos.length} ${wTodos.length === 1 ? "grupo" : "grupos"}</span>`;
      }
    }
    $("#statPref").textContent = pref.length;
    $("#statNorm").textContent = norm.length;
    $("#statMeso").textContent = meso.length;

    // tempo de espera: sempre na aba da atendente; no totem, conforme a configuração
    $("#statAvgWrap").hidden = !staff && CFG.mostrarMedia === false;

    // filas lado a lado (só na tela da atendente; o celular empilha sozinho)
    $("#queueGroups").classList.toggle("is-colunas", staff && CFG.filasColunas !== false);

    // a espera de cada fila, para a atendente enxergar onde está apertando
    ["#avgMeso", "#avgPref", "#avgNorm"].forEach((el) => {
      const box = $(el);
      if (box) box.hidden = !staff;
    });
    atualizarEsperas();

    // -------- painel "chamando" (mostra TODAS as mesas chamadas) --------
    // Entram também os pedidos que acabaram de ficar prontos, no topo: no totem
    // para o cliente que está longe do celular, na tela da equipe para a
    // atendente saber o que ainda está no balcão esperando ser retirado.
    const callList = $("#callList");
    const callEmpty = $("#callEmpty");
    const prontosTodos = pedidosProntos();
    const prontos = buscando ? prontosTodos.filter(combinaBusca) : prontosTodos;
    const painel = prontos.concat(c.filter((r) => !prontos.some((p) => p.id === r.id)));
    callEmpty.hidden = painel.length > 0;
    callList.innerHTML = painel.map((r, i) => {
      const pronto = pedidoNoPainel(r);
      // os botões de chamada só fazem sentido para quem ainda está chamado:
      // quem já sentou e só está esperando o pedido não volta para a fila
      const acoes = staff && r.status === STATUS.CHAMADO;
      return `
      <div class="call-item ${pronto ? "pronto" : ""} ${r.preferencial && !pronto ? "pref" : ""} ${i === 0 ? "fresh" : ""}">
        ${acoes ? `<button class="ci-x staff-only" data-discard="${r.id}" aria-label="Remover">✕</button>` : ""}
        <span class="ci-label">${pronto ? "🍽️ Pedido pronto" : r.preferencial ? "★ Preferencial" : "Chamando"}</span>
        <span class="ci-name">${esc(firstName(r.nome))}</span>
        <span class="ci-meta">${pronto
          ? `Pode retirar no balcão • avisado às ${fmtClock(r.pedido_em)}`
          : `${r.pessoas} ${r.pessoas === 1 ? "pessoa" : "pessoas"} • chamado às ${fmtClock(r.chamado_em)} (há <b data-since="${r.chamado_em}">agora</b>)`}</span>
        ${callChipsHTML(r, staff)}
        ${acoes ? `<div class="ci-actions staff-only">
          ${(CFG.whatsAtivo !== false && r.telefone) ? `<a class="btn btn-sm ci-wa" href="${waLink(r)}" target="_blank" rel="noopener">📲 WhatsApp</a>` : ""}
          <button class="btn btn-sm ci-ok" data-seat="${r.id}">✓ Sentou</button>
          <button class="btn btn-sm ci-back" data-back="${r.id}">↩️ Voltar à fila</button>
          <button class="btn btn-sm ci-edit" data-edit="${r.id}">✏️ Editar</button>
          ${pedidoBtnHTML(r)}
          <button class="btn btn-sm ci-end" data-toend="${r.id}">⬇ Fim da fila</button>
        </div>` : ""}
      </div>`;
    }).join("");

    renderMesas();
    renderResumoFila();
    renderMapa();
    renderSentados();
    renderPedidos();
    renderFilaFila();

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
    // No totem a faixa é a chamada principal: se ninguém escreveu nada na
    // engrenagem, ela mesma convida a entrar na fila
    if (wb) {
      // com a entrada desligada o totem não convida ninguém a se cadastrar:
      // ali ele é painel de acompanhamento
      const semEntrada = !staff && CFG.totemEntrada === false;
      const txt = (CFG.boasVindas || "").trim() ||
        (semEntrada ? "Acompanhe a fila" : "Entre na fila aqui 👇");
      wb.textContent = txt;
      wb.hidden = false;
    }
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
    // abas do salão: somem quando o recurso está desligado ou o perfil não as alcança
    const tg = $("#tabGarcom");
    if (tg) tg.hidden = CFG.garcomAtivo === false || !podeVer("garcom");
    const tm = $("#tabMapa");
    if (tm) tm.hidden = CFG.garcomAtivo === false || !podeVer("mapa") || !mapaVisivelPara();   // idem: independe da aba do garçom

    tickTimes();
    maybeBeep(c);
  }

  // Fila resumida para o garçom: ele não precisa de nomes nem telefones —
  // precisa saber de que tamanho são os grupos e há quanto tempo esperam,
  // para escolher quais mesas liberar primeiro.
  function renderResumoFila() {
    const card = $("#filaResumoCard");
    if (!card) return;
    const vista = appEl.getAttribute("data-view");
    const noMapa = vista === "mapa";
    card.hidden = (vista !== "garcom" && !noMapa) || CFG.garcomAtivo === false;
    if (card.hidden) return;
    card.classList.toggle("em-faixa", noMapa);
    // Aqui a ordem NÃO é a da chamada: é pelo tempo de espera, quem espera há
    // mais tempo fica em cima. Assim, se um grupo começa a ficar para trás
    // (porque a mesa do tamanho dele não vaga), ele sobe sozinho na lista e
    // o semáforo de cor vai esquentando até o vermelho.
    const fila = waiting()
      .slice()
      .sort((a, b) => new Date(a.criado_em) - new Date(b.criado_em));
    // Na aba do Mapa a faixa mostra uns 6 de uma vez, mas a lista inteira está
    // lá: o garçom arrasta para o lado e vê quem vem depois. Não corta ninguém.
    const mostrados = fila;
    // o semáforo aqui é o mesmo para todos: o que importa é o tempo de espera,
    // não o tipo da fila
    const alerta = alertaDoResumo();
    $("#resumoCount").textContent = fila.length;
    $("#resumoVazio").hidden = fila.length > 0;
    $("#resumoLista").innerHTML = mostrados.map((r) => `
      <div class="resumo-item"
           ${alerta ? `data-espera-since="${r.criado_em}" data-espera-prazo="${alerta}"` : ""}>
        <b class="resumo-pes">${r.pessoas}</b>
        <span class="resumo-txt">
          <span class="resumo-lab">${r.pessoas === 1 ? "Pessoa" : "Pessoas"}${r.pet ? " 🐾" : ""}${r.preferencial ? " ♿" : ""}</span>
          <span class="resumo-tempo">⏱️ <b data-since="${r.criado_em}">agora</b></span>
        </span>
      </div>`).join("");
  }

  // ---------- aba "Pedidos": cozinha/balcão ----------
  // Aqui aparece SÓ quem está na fila esperando para sentar. Quem já foi
  // chamado ou já sentou sai da lista sozinho — senão a tela enche de gente
  // que a cozinha não tem mais o que fazer.
  let buscaPed = "";
  const filtrosPed = new Set();

  function emAtendimento() {
    return waiting();               // ordem de chegada, como a cozinha trabalha
  }

  function combinaPed(r) {
    const t = semAcento(buscaPed).trim();
    if (!t) return true;
    if (filtrosPed.size) {
      if (filtrosPed.has("comanda") && semAcento(r.comanda).includes(t)) return true;
      if (filtrosPed.has("pager") && semAcento(r.pager).includes(t)) return true;
      return false;
    }
    if ([r.nome, r.comanda, r.pager, r.mesa_numero].some((c) => semAcento(c).includes(t))) return true;
    const dig = soDigitos(t);
    return dig.length >= 3 && soDigitos(r.telefone).includes(dig);
  }

  // O botão desta tela: com telefone e WhatsApp ligado, vira o link que já
  // abre a conversa; sem telefone, ainda assim registra o aviso (o cliente
  // recebe pela notificação e vê no painel do totem).
  function botaoPedidoHTML(r) {
    const feito = !!r.pedido_em;
    // O mesmo cliente pede várias vezes: o botão NUNCA trava. Depois do
    // primeiro aviso ele só muda de cara ("de novo" + hora do último) e pode
    // ser tocado quantas vezes a atendente precisar.
    const rotulo = feito ? "🔁 avisar de novo · " + fmtClock(r.pedido_em) : "🍽 Pedido pronto";
    const classe = "btn btn-sm btn-pedido ped-acao" + (feito ? " is-feito" : "");
    const link = pedidoUsaWhats(r) ? waLinkPedido(r) : "";
    return link
      ? `<a class="${classe}" href="${link}" target="_blank" rel="noopener" data-pedido="${r.id}">${rotulo}</a>`
      : `<button type="button" class="${classe}" data-pedido="${r.id}">${rotulo}</button>`;
  }

  function renderPedidos() {
    const card = $("#pedidosCard");
    if (!card) return;
    card.hidden = appEl.getAttribute("data-view") !== "pedidos";
    if (card.hidden) return;
    $$("#pedFiltros .bf-chip").forEach((b) => {
      if (b.dataset.pfiltro === "limpar") { b.hidden = !buscaPed.trim() && !filtrosPed.size; return; }
      b.classList.toggle("is-on", filtrosPed.has(b.dataset.pfiltro));
    });
    const campo = $("#pedBusca");
    if (campo) {
      campo.placeholder = filtrosPed.size
        ? "Procurar " + [...filtrosPed].map((f) => (f === "pager" ? "pager" : "comanda")).join(" ou ")
        : "Procurar por nome, telefone, comanda, pager ou mesa";
    }
    const x = $("#pedLimpar");
    if (x) x.hidden = !buscaPed;
    const todos = emAtendimento();
    const lista = todos.filter(combinaPed);
    $("#pedCount").textContent = lista.length;
    $("#pedVazio").hidden = lista.length > 0;
    $("#pedVazio").textContent = todos.length
      ? "Nada encontrado com essa busca."
      : "Ninguém na fila no momento.";
    $("#pedLista").innerHTML = lista.map((r) => {
      const dados = [
        r.comanda ? "🧾 " + esc(r.comanda) : "",
        r.pager ? "🔔 " + esc(r.pager) : "",
        r.telefone ? "📞 " + esc(r.telefone) : "",
      ].filter(Boolean).join(" • ") || "sem comanda, pager ou telefone";
      return `
      <div class="sent-item ped-item">
        <span class="sent-txt">
          <span class="sent-nome">${esc(r.nome)}</span>
          <span class="sent-meta">${dados}</span>
        </span>
        ${botaoPedidoHTML(r)}
      </div>`;
    }).join("");
  }

  // ==========================================================
  //  FILA DA FILA (a antessala)
  // ----------------------------------------------------------
  //  A casa tem um teto de gente que consegue atender. Passado o teto, quem
  //  chega fica aqui: cadastrado, mas fora da fila de verdade. Não conta na
  //  lotação, não aparece no totem, não entra na média de espera.
  //
  //  É fila ÚNICA, sem preferencial e sem mesa grande — de propósito. A
  //  prioridade só faz sentido quando existe mesa para dar; aqui todo mundo
  //  espera a mesma coisa: uma vaga na fila.
  // ==========================================================
  let buscaPrevia = "";

  function naPrevia() {
    return rows
      .filter((r) => r.status === STATUS.PREVIA)
      .sort(byCreatedAsc);          // ordem de chegada, e só
  }

  function combinaPrevia(r) {
    const t = semAcento(buscaPrevia).trim();
    if (!t) return true;
    if (semAcento(r.nome).includes(t)) return true;
    const dig = soDigitos(t);
    return dig.length >= 3 && soDigitos(r.telefone).includes(dig);
  }

  // Quantas pessoas a fila de espera comporta ainda. É o MESMO limite que
  // fecha a fila sozinha — não inventamos um segundo número para a casa
  // manter em dia.
  function vagasNaFila() {
    const lim = Number(CFG.autoFecharQtd);
    if (!lim || isNaN(lim) || lim < 1) return null;      // sem limite definido
    const dentro = waiting().reduce((a, r) => a + Number(r.pessoas || 0), 0);
    return Math.max(0, lim - dentro);
  }

  // Passa da antessala para a fila de espera.
  // A POSIÇÃO conta a partir de agora (`criado_em`), como quem chega neste
  // instante — a fila da fila já é ordenada, então promover na ordem mantém
  // a justiça sozinho. `entrou_em` também vira agora, senão a espera dele
  // entraria na conta do tempo típico e inflaria o número do totem. A hora
  // real da antessala fica guardada em `previa_em`.
  async function promoverDaPrevia(id) {
    const agora = new Date().toISOString();
    const patch = { status: STATUS.AGUARDANDO, criado_em: agora, entrou_em: agora };
    pintarLocal(id, patch);
    try {
      await backend.update(id, patch);
    } catch (e) {
      console.error("Falha ao promover:", e);
      avisoStaff(e && e.semPermissao
        ? "⚠ O banco recusou a mudança: este perfil não tem permissão para passar alguém para a fila de espera. Rode o supabase-fila-da-fila.sql."
        : "⚠ Não deu para passar para a fila de espera. Confira a internet.");
    }
    await refresh();
  }

  // O caminho de volta: da fila de espera para a antessala.
  // Serve para quando a atendente percebe que aceitou gente demais, ou quando
  // o cliente pede para esperar mais um pouco antes de entrar de vez.
  //
  // Ele PERDE a posição — quando voltar, entra como quem chega naquele
  // momento. Não dá para ser diferente: guardar a vaga dele enquanto ele está
  // fora seria furar a fila de quem ficou. Por isso este confirma antes.
  async function rebaixarParaPrevia(id) {
    const patch = { status: STATUS.PREVIA, previa_em: new Date().toISOString(), chamado_em: null };
    pintarLocal(id, patch);
    try {
      await backend.update(id, patch);
    } catch (e) {
      console.error("Falha ao enviar para a fila da fila:", e);
      avisoStaff(e && e.semPermissao
        ? "⚠ O banco recusou: este perfil não tem permissão para isso."
        : "⚠ Não deu para enviar para a fila da fila. Confira a internet.");
    }
    await refresh();
  }

  // Avisar que já pode entrar na fila. NÃO move ninguém: a pessoa pode estar
  // longe, e ocupar vaga com quem ainda não chegou seria pior que esperar.
  async function avisarDaPrevia(id) {
    const patch = { previa_avisado_em: new Date().toISOString() };
    pintarLocal(id, patch);
    try {
      await backend.update(id, patch);
      avisarNoCelular(id, "previa");
    } catch (e) {
      console.warn("Aviso da fila da fila não registrado:", e);
    }
    await refresh();
  }

  // Link do WhatsApp avisando que a vaga abriu
  function waLinkPrevia(r) {
    const num = waNumber(r.telefone);
    if (!num) return "";
    const msg = (CFG.msgPrevia || MSG_PREVIA_PADRAO)
      .replace(/\{nome\}/g, firstName(r.nome))
      .replace(/\{restaurante\}/g, CFG.restaurante || "");
    return "https://wa.me/" + num + "?text=" + encodeURIComponent(msg);
  }

  function renderFilaFila() {
    const card = $("#filaFilaCard");
    if (!card) return;
    card.hidden = appEl.getAttribute("data-view") !== "filafila";
    if (card.hidden) return;

    const x = $("#ffLimpar");
    if (x) x.hidden = !buscaPrevia;

    const todos = naPrevia();
    const lista = todos.filter(combinaPrevia);
    $("#ffCount").textContent = lista.length;
    $("#ffVazio").hidden = lista.length > 0;
    $("#ffVazio").textContent = todos.length
      ? "Nada encontrado com essa busca."
      : "Ninguém na fila da fila.";

    // quantas pessoas ainda cabem na fila de espera: é o número que diz para
    // a atendente se ela já pode promover alguém
    const vagas = vagasNaFila();
    const lot = $("#ffLotacao");
    if (lot) {
      lot.textContent = vagas == null
        ? "Sem limite de lotação configurado na engrenagem."
        : (vagas > 0
            ? `Cabem mais ${vagas} ${vagas === 1 ? "pessoa" : "pessoas"} na fila de espera.`
            : "A fila de espera está no limite.");
      lot.className = "hint" + (vagas === 0 ? " ff-cheio" : "");
    }

    // Dois relógios, porque são duas esperas diferentes e a atendente precisa
    // das duas: quanto se espera DEPOIS de entrar na fila (para explicar ao
    // cliente o que ainda vem pela frente) e quanto se está esperando AQUI
    // (que é o tamanho do problema dela agora).
    const naFila = esperaStats();
    $("#ffEsperaFila").textContent = naFila ? "~" + fmtElapsed(naFila.meio) : "—";
    // aqui não há "chamadas concluídas" para medir: a espera é a que está
    // acontecendo. Mediana de quem está na antessala neste momento.
    const agora = Date.now();
    const emCurso = todos
      .map((r) => Math.max(0, agora - new Date(entradaEm(r)).getTime()))
      .sort((a, b) => a - b);
    $("#ffEsperaPrevia").textContent = emCurso.length
      ? "~" + fmtElapsed(percentil(emCurso, 0.5)) : "—";

    // A linha é só informação; as ações moram na ficha, que abre ao tocar.
    // Com quatro botões por linha, a lista virava um paredão e o toque errado
    // ficava fácil demais — ainda mais numa ação que promove alguém de fila.
    $("#ffLista").innerHTML = lista.map((r, i) => {
      const avisado = !!r.previa_avisado_em;
      const dados = [
        `👥 ${r.pessoas} ${Number(r.pessoas) === 1 ? "pessoa" : "pessoas"}`,
        r.telefone ? "📞 " + esc(r.telefone) : "",
        r.comanda ? "🧾 " + esc(r.comanda) : "",
        r.pager ? "🔔 " + esc(r.pager) : "",
        avisado ? "✅ avisado às " + fmtClock(r.previa_avisado_em) : "",
      ].filter(Boolean).join(" • ");
      return `
      <button type="button" class="previa-item ${avisado ? "is-avisado" : ""}" data-cliente="${r.id}">
        <span class="previa-pos">${i + 1}º</span>
        <span class="previa-txt">
          <span class="previa-nome">${esc(r.nome)}</span>
          <span class="previa-meta">${dados} • entrou ${fmtClock(entradaEm(r))}
            (há <b data-since="${entradaEm(r)}">agora</b>)</span>
        </span>
        <span class="previa-seta" aria-hidden="true">›</span>
      </button>`;
    }).join("");
  }

  // ---------- aba "Na mesa": quem já sentou ----------
  // A atendente precisa achar depressa a comanda, o pager ou a mesa de quem
  // JÁ está sentado — hoje isso sumia da tela assim que a pessoa saía da fila.
  let buscaSent = "";
  const filtrosSent = new Set();

  // Quantos aparecem na aba "Na mesa". A lista é para achar quem acabou de
  // sentar, não é histórico: passar de uma tela cheia só atrapalha.
  function quantosNaMesa() {
    const v = Number(CFG.sentadosMax);
    return isNaN(v) || v < 1 ? 10 : Math.min(200, Math.round(v));
  }

  // Sem número de mesa não existe garçom para encerrar o atendimento: ninguém
  // vai tirar essa pessoa da lista. Então ela sai sozinha depois de 4 horas.
  const SEM_MESA_MS = 4 * 3600 * 1000;

  // A mesa foi encerrada pelo garçom DEPOIS que esta pessoa sentou?
  // Marcar a mesa como limpeza, aguardando ou livre é o garçom dizendo que o
  // cliente foi embora. Os três caminhos gravam `liberada_em` na mesa, então
  // basta comparar essa hora com a hora em que a pessoa sentou. É a mesma
  // regra que o mapa já usa para tirar a mesa do vermelho.
  //
  // Mesas JUNTAS contam como uma só: o cliente está no bloco inteiro, não numa
  // mesa. Encerrar qualquer uma delas encerra o atendimento. Por isso não
  // basta procurar a mesa cujo número bate com o do cliente — é preciso abrir
  // o bloco dela e olhar todas. É o mesmo critério que o mapa usa para dizer
  // se a mesa ainda está ocupada.
  function mesaEncerradaDepoisDeSentar(r) {
    const num = String(r.mesa_numero || "").trim();
    if (!num) return false;
    const sentou = new Date(r.sentou_em || r.chamado_em || r.criado_em).getTime();
    const vistas = new Set();
    return mapa.filter((x) => numeroBate(x.numero, num)).some((m) =>
      blocoDaMesa(m).some((x) => {
        if (vistas.has(x.id)) return false;
        vistas.add(x.id);
        return x.liberada_em && new Date(x.liberada_em).getTime() > sentou;
      }));
  }

  function sentados() {
    const agora = Date.now();
    const desde = agora - 14 * 3600 * 1000;   // o serviço de hoje
    return rows
      .filter((r) => r.status === STATUS.SENTADO)
      .filter((r) => new Date(r.sentou_em || r.criado_em).getTime() >= desde)
      .filter((r) => !mesaEncerradaDepoisDeSentar(r))
      .filter((r) => String(r.mesa_numero || "").trim() ||
        agora - new Date(r.sentou_em || r.criado_em).getTime() < SEM_MESA_MS)
      .sort((a, b) => new Date(b.sentou_em || b.criado_em) - new Date(a.sentou_em || a.criado_em))
      .slice(0, quantosNaMesa());
  }

  // Mesma regra da busca da atendente: o chip escolhe ONDE procurar.
  function combinaSent(r) {
    const t = semAcento(buscaSent).trim();
    if (!t) return true;
    if (filtrosSent.size) {
      if (filtrosSent.has("comanda") && semAcento(r.comanda).includes(t)) return true;
      if (filtrosSent.has("pager") && semAcento(r.pager).includes(t)) return true;
      return false;
    }
    if ([r.nome, r.comanda, r.pager, r.mesa_numero].some((c) => semAcento(c).includes(t))) return true;
    const dig = soDigitos(t);
    return dig.length >= 3 && soDigitos(r.telefone).includes(dig);
  }

  function renderSentados() {
    const card = $("#sentadosCard");
    if (!card) return;
    card.hidden = appEl.getAttribute("data-view") !== "sentados";
    if (card.hidden) return;
    $$("#sentFiltros .bf-chip").forEach((b) => {
      if (b.dataset.sfiltro === "limpar") { b.hidden = !buscaSent.trim() && !filtrosSent.size; return; }
      b.classList.toggle("is-on", filtrosSent.has(b.dataset.sfiltro));
    });
    const campoSent = $("#sentBusca");
    if (campoSent) {
      campoSent.placeholder = filtrosSent.size
        ? "Procurar " + [...filtrosSent].map((f) => (f === "pager" ? "pager" : "comanda")).join(" ou ")
        : "Procurar por nome, telefone, comanda, pager ou mesa";
    }
    const x = $("#sentLimpar");
    if (x) x.hidden = !buscaSent;
    const todos = sentados();
    const lista = todos.filter(combinaSent);
    $("#sentCount").textContent = lista.length;
    $("#sentVazio").hidden = lista.length > 0;
    $("#sentVazio").textContent = todos.length
      ? "Nada encontrado com essa busca."
      : "Ninguém sentou ainda hoje.";
    $("#sentLista").innerHTML = lista.map((r) => {
      const mesa = String(r.mesa_numero || "").trim();
      // o que a recepção precisa de relance: mesa, tamanho do grupo, nome,
      // comanda, pager e telefone
      const dados = [
        r.pessoas + (Number(r.pessoas) === 1 ? " pessoa" : " pessoas"),
        r.comanda ? "🧾 " + esc(r.comanda) : "",
        r.pager ? "🔔 " + esc(r.pager) : "",
        r.telefone ? "📞 " + esc(r.telefone) : "",
      ].filter(Boolean).join(" • ");
      return `
      <button type="button" class="sent-item" data-cliente="${r.id}">
        <span class="sent-mesa${mesa ? "" : " sem"}">${mesa ? esc(mesa) : "—"}<small>mesa</small></span>
        <span class="sent-txt">
          <span class="sent-nome">${esc(r.nome)}</span>
          <span class="sent-meta">${dados}</span>
        </span>
      </button>`;
    }).join("");
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
    // mesas reservadas (chamadas, esperando o cliente sentar) não contam como livres
    const reservada = (m) => !!m.reservada_para;
    const quemFoiChamado = (m) => {
      const r = rows.find((x) => x.id === m.reservada_para);
      return r ? firstName(r.nome) : "cliente chamado";
    };
    $("#mesasCount").textContent = mesasLivres.filter((m) => !reservada(m)).length;
    // Na tela da atendente o cartão é só número e lugares: um toque chama.
    // As ações (usei / cancelar / corrigir) ficam no pop-up que abre ao segurar.
    $("#mesasList").innerHTML = mesasLivres.map((m) => {
      const nome = m.numeros ? "Mesa " + esc(m.numeros) : `<span class="mesa-sem-num">sem número</span>`;
      const classes = `mesa-item ${m.pet ? "is-pet" : ""} ${mesaSelecionada === m.id ? "is-sel" : ""} ${reservada(m) ? "is-reservada" : ""}`;
      if (staff) {
        return `
      <div class="${classes} is-enxuta" data-selmesa="${m.id}" role="button" tabindex="0">
        <div class="mesa-lug">${m.lugares}<small>${m.lugares === 1 ? "lugar" : "lugares"}</small></div>
        <div class="mesa-info">
          <b class="mesa-nome">${nome}</b>
          ${m.pet ? `<span class="mesa-tags"><span class="mesa-tag pet">🐾 área pet</span></span>` : ""}
          ${reservada(m) ? `<span class="mesa-reserva">🔔 chamada para ${esc(quemFoiChamado(m))} — aguardando sentar</span>` : ""}
        </div>
      </div>`;
      }
      return `
      <div class="${classes}">
        <div class="mesa-lug">${m.lugares}<small>${m.lugares === 1 ? "lugar" : "lugares"}</small></div>
        <div class="mesa-info">
          <b class="mesa-nome">${nome}</b>
          ${m.identificacao ? `<span class="mesa-obs">${esc(m.identificacao)}</span>` : ""}
          ${m.pet ? `<span class="mesa-tags"><span class="mesa-tag pet">🐾 área pet</span></span>` : ""}
        </div>
        <div class="mesa-acoes">
          <button class="btn btn-sm btn-edit" data-editmesa="${m.id}" title="Corrigir esta mesa" aria-label="Corrigir esta mesa">✏️</button>
          <button class="btn btn-sm btn-azul" data-apagarmesa="${m.id}" title="Mover para aguardando" aria-label="Mover para aguardando">↩️</button>
        </div>
      </div>`;
    }).join("");

    const vazio = $("#mesasEmpty");
    vazio.hidden = mesasLivres.length > 0;
    vazio.textContent = semTabelaMesas
      ? "⚠ O banco ainda não tem a tabela das mesas — rode o SQL do README no Supabase."
      : (staff ? "Nenhuma mesa livre. O garçom avisa por aqui quando liberar." : "Nenhuma mesa livre. Toque no botão abaixo para lançar.");
  }

  // Atualiza os "tempos" ao vivo (a cada segundo, sem redesenhar tudo)
  // Atualiza SÓ os tempos de espera. Roda a cada 1 minuto por conta própria,
  // sem redesenhar as listas: a atendente pode estar com o dedo em cima de um
  // cartão. É o que faz o número subir quando a fila trava e ninguém é chamado.
  function atualizarEsperas() {
    const staff = isStaff();
    const alvo = $("#statAvg");
    if (alvo) alvo.textContent = esperaTexto(!staff);
    const lbl = $("#statAvgLabel");
    if (lbl) lbl.textContent = staff ? "espera típica" : "espera";
    if (!staff) return;
    const box = (el, filtro) => {
      const b = $(el);
      if (!b) return;
      const m = avgWaitMs(filtro);
      // sem nenhuma chamada ainda, mostra "—": sumir com a linha seria pior,
      // a atendente ficaria procurando um número que desapareceu
      b.textContent = m == null ? "⏱️ —" : "⏱️ ~" + fmtElapsed(m);
    };
    box("#avgMeso", (r) => isMesona(r));
    box("#avgPref", (r) => r.preferencial && !isMesona(r));
    box("#avgNorm", (r) => !r.preferencial && !isMesona(r));
  }

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
  // PEDIDOS é o perfil da cozinha/balcão: só acompanha quem já está na mesa e
  // avisa quando o prato fica pronto. Não mexe na fila nem no salão.
  const PAPEL = { ADM: "adm", ATENDENTE: "atendente", GARCOM: "garcom", PEDIDOS: "pedidos", TOTEM: "totem", FILADAFILA: "atendentefiladafila" };
  const LS_TOTEM = "fila_modo_totem";
  let usuario = null;   // { email, papel, nome } — null quando não há login

  function loginLigado() {
    return CFG.loginAtivo === true && !!(backend && backend.mode === "online" && backend.client);
  }

  // Quais abas cada perfil enxerga
  function abasPermitidas() {
    if (!loginLigado()) return ["totem", "staff", "garcom", "mapa", "sentados", "pedidos", "filafila"];   // como era antes
    const p = usuario && usuario.papel;
    if (p === PAPEL.ADM) return ["totem", "staff", "garcom", "mapa", "sentados", "pedidos", "filafila"];
    // a antessala tem dono próprio: ele não mexe na fila de espera
    if (p === PAPEL.FILADAFILA) return ["filafila"];
    if (p === PAPEL.ATENDENTE) return ["staff", "mapa", "sentados"];
    if (p === PAPEL.GARCOM) return ["garcom", "mapa"];
    // Pedidos também precisa da aba "Na mesa": muita gente pede depois de
    // sentar, e sem ela o balcão não tinha como achar a comanda desse cliente.
    if (p === PAPEL.PEDIDOS) return ["pedidos", "sentados"];
    return ["totem"];   // totem (ou sem perfil definido): só a fila
  }
  function podeVer(v) { return abasPermitidas().indexOf(v) >= 0; }
  // Em qual aba cada perfil começa: quem trabalha cai direto no seu posto
  function abaInicial() {
    const p = usuario && usuario.papel;
    if (p === PAPEL.ADM) return "staff";
    if (p === PAPEL.ATENDENTE) return "staff";
    if (p === PAPEL.GARCOM) return "garcom";
    if (p === PAPEL.PEDIDOS) return "pedidos";
    if (p === PAPEL.FILADAFILA) return "filafila";
    return "totem";
  }
  // Perfil Pedidos: a tela dele é só a aba "Na mesa" e o aviso do pedido.
  function soPedidos() {
    return loginLigado() && !!usuario && usuario.papel === PAPEL.PEDIDOS;
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
      focoSePuder("#loginEmail", 80);
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
    // O mapa tem aba própria. Depende do recurso do salão estar ligado e do
    // perfil alcançar a aba — mas NÃO de ter a aba "Garçom": a atendente vê o
    // mapa (na versão travada) sem ter nada a ver com a tela do salão.
    const podeMapa = CFG.garcomAtivo !== false && podeVer("mapa") && mapaVisivelPara();
    const map = { totem: "#tabTotem", staff: "#tabStaff", garcom: "#tabGarcom", mapa: "#tabMapa", sentados: "#tabSentados", pedidos: "#tabPedidos", filafila: "#tabFilaFila" };
    Object.keys(map).forEach((v) => {
      const b = $(map[v]);
      if (!b) return;
      b.hidden = v === "garcom" ? !podeGarcom : (v === "mapa" ? !podeMapa : !podeVer(v));
    });
    // com um perfil só, nem faz sentido mostrar a barra de abas
    const visiveis = Object.keys(map).filter((v) => { const b = $(map[v]); return b && !b.hidden; });
    const sw = document.querySelector(".viewswitch");
    if (sw) sw.hidden = visiveis.length < 2;
    // a aba aberta pode ter deixado de existir (ex.: mapa desligado)
    if (visiveis.length && !visiveis.includes(appEl.getAttribute("data-view"))) setView(visiveis[0]);

    const sb = $("#sairBtn");
    if (sb) sb.hidden = !ligado;
    // configurações e relatório são do administrador
    const cb = $("#cfgBtn");
    if (cb) cb.hidden = !ehAdm();
    const rb = $("#relBtn");
    if (rb) rb.hidden = !ehAdm();
    // zerar a média mexe no número que todo mundo vê: só o administrador
    const ra = $("#resetAvgBtn");
    if (ra) ra.hidden = !ehAdm();
    // o administrador mantém os controles do cabeçalho em qualquer aba
    appEl.setAttribute("data-papel", (ligado && usuario && usuario.papel) || "");
    atualizarSeloBackup();   // o selo da cópia é só do administrador

    if (ligado && usuario) {
      $("#brandSub").textContent = (CFG.restaurante || "") +
        (usuario.papel === PAPEL.TOTEM ? "" : " • " + rotuloPapel(usuario.papel));
    }
  }
  function rotuloPapel(p) {
    return p === PAPEL.ADM ? "Administrador"
      : p === PAPEL.ATENDENTE ? "Atendente"
      : p === PAPEL.PEDIDOS ? "Pedidos"
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
        ligarRelogios();
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
  // a antessala: o formulário é o mesmo, só o destino do cadastro muda
  function naAbaPrevia() { return appEl.getAttribute("data-view") === "filafila"; }
  function isGarcom() { return appEl.getAttribute("data-view") === "garcom"; }

  // qual PIN a aba pediu (para o pop-up saber o que conferir)
  let pinAlvo = "staff";

  function setView(v) {
    // com login ligado, quem manda é o perfil — o PIN deixa de ser necessário
    if (loginLigado()) {
      if (!podeVer(v)) return;
    } else {
      if ((v === "staff" || v === "sentados") && String(CFG.pinAtendente || "") && sessionStorage.getItem(SESSION_PIN) !== "1") {
        openPin("staff");
        return;
      }
      // o garçom só precisa de PIN se o dono tiver definido um
      if ((v === "garcom" || v === "mapa") && String(CFG.pinGarcom || "") && sessionStorage.getItem(SESSION_PIN_G) !== "1") {
        openPin("garcom");
        return;
      }
    }
    appEl.setAttribute("data-view", v);
    $("#tabTotem").classList.toggle("is-active", v === "totem");
    $("#tabStaff").classList.toggle("is-active", v === "staff");
    $("#tabGarcom").classList.toggle("is-active", v === "garcom");
    $("#tabMapa").classList.toggle("is-active", v === "mapa");
    $("#tabSentados").classList.toggle("is-active", v === "sentados");
    $("#tabPedidos").classList.toggle("is-active", v === "pedidos");
    $("#tabFilaFila").classList.toggle("is-active", v === "filafila");
    $("#staffBar").hidden = v !== "staff";
    // o botão de chamar mesa acompanha a aba da atendente, na barra de baixo
    // (dá para escondê-lo na engrenagem: há casa que só chama pela mesa livre)
    const fb2 = $("#freeTableBtn");
    if (fb2) fb2.hidden = v !== "staff" || CFG.mostrarBtnChamar === false;
    ajustarBarraStaff();
    const rotulo = v === "filafila" ? "Adicionar na fila da fila"
      : (v === "staff" ? "Adicionar cliente" : "Entrar na fila");
    $("#formTitle").textContent = rotulo;
    $("#joinBtn").textContent = rotulo;
    // trocar de aba encerra qualquer gesto no mapa: nunca chegue na aba com o
    // desenho travado por um toque que ficou pendurado
    liberarDesenhoDoMapa();
    render();
  }

  function openPin(alvo) {
    pinAlvo = alvo || "staff";
    $("#pinTitulo").textContent = pinAlvo === "garcom" ? "Área do garçom" : "Área da atendente";
    $("#pinMsg").textContent = "";
    $("#pinInput").value = "";
    $("#pinModal").hidden = false;
    focoSePuder("#pinInput", 50);
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
    // "staff" aqui quer dizer "quem digita é a equipe, não o cliente". A aba
    // da fila da fila também é balcão: quem cadastra ali é funcionário nosso.
    const staff = isStaff() || naAbaPrevia();

    // A antessala pode pedir campos diferentes da fila de espera. Cada ajuste
    // dela aceita ficar VAZIO, e vazio quer dizer "igual à fila de espera" —
    // assim quem não mexer em nada continua com o comportamento de sempre, e
    // quem mexer altera só o que quis.
    const previa = naAbaPrevia();
    const daFila = (chaveFF, padrao) => {
      const v = previa ? String(CFG[chaveFF] || "") : "";
      return v || padrao;
    };

    const modoTel = daFila("ffTel", CFG.telObrigatorio !== false ? "obrigatorio" : "opcional");
    const telObrig = modoTel === "obrigatorio";
    $("#fTelField").hidden = modoTel === "nao";
    $("#fTelLabel").innerHTML = telObrig ? 'Telefone <b class="req">*</b>' : "Telefone <small>(opcional)</small>";
    $("#fTel").required = telObrig && modoTel !== "nao";
    // recado curto de propósito: cada linha a mais empurra o botão para fora
    // da tela e obriga a rolar o formulário
    $("#fTelHint").textContent = telObrig
      ? "Avisamos no WhatsApp quando a mesa ficar pronta."
      : "Se informar, avisamos no WhatsApp quando a mesa ficar pronta.";
    // e-mail: aparece no totem e no balcão conforme a engrenagem
    const modoEmail = daFila("ffEmail", CFG.campoEmail || "nao");
    $("#fEmailField").hidden = modoEmail === "nao";
    $("#fEmail").required = modoEmail === "obrigatorio";
    $("#fEmailLabel").innerHTML = modoEmail === "obrigatorio"
      ? 'E-mail <b class="req">*</b>' : "E-mail <small>(opcional)</small>";

    desenharTamanhosGrupo();
    // aniversário: mesma lógica do e-mail, só dia e mês
    const modoAniv = daFila("ffAniv", CFG.campoAniversario || "nao");
    $("#fAniversarioField").hidden = modoAniv === "nao";
    $("#fAniversario").required = modoAniv === "obrigatorio";
    $("#fAniversarioLabel").innerHTML = modoAniv === "obrigatorio"
      ? 'Aniversário <b class="req">*</b>' : "Aniversário <small>(opcional)</small>";

    const petLigado = daFila("ffPet", CFG.petAtivo !== false ? "sim" : "nao") === "sim";
    $("#petRow").hidden = !petLigado;
    // "não sentar na área pet" só faz sentido se existe área pet
    $("#semPetRow").hidden = !petLigado || CFG.campoSemPet === false;
    // a dupla de pet fica lado a lado; sem nenhuma das duas, a linha some
    $("#petRows").hidden = $("#petRow").hidden && $("#semPetRow").hidden;
    // Preferencial: a antessala é fila única, mas o que for marcado aqui
    // acompanha a pessoa quando ela passa para a fila de espera — onde a
    // prioridade volta a valer.
    const perguntaTipo = daFila("ffTipo", "sim") === "sim";
    $("#fTipoField").hidden = !perguntaTipo;
    if (!perguntaTipo) $('input[name="tipo"][value="normal"]').checked = true;
    // as regras são aceitas pelo cliente no totem; a atendente confirma no balcão
    $("#termosRow").hidden = staff || CFG.exigirTermos === false;
    // comanda e pager: só a atendente entrega, e só se estiverem ligados
    // na antessala um ajuste só liga/desliga os dois: quem quer comanda ali
    // quer pager junto, e dois seletores seriam ruído na engrenagem
    const extrasFF = daFila("ffExtras", "");
    const temComanda = staff && (extrasFF ? extrasFF === "sim" : CFG.campoComanda !== false);
    const temPager = staff && (extrasFF ? extrasFF === "sim" : CFG.campoPager !== false);
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
    // Corrigindo uma mesa já lançada, o tamanho REAL dela manda — mesmo que
    // não esteja entre os botões. Forçar para um da lista mudaria o tamanho
    // sem ninguém pedir. Só numa mesa nova é que começamos por um botão.
    if (m) {
      modoManualMesa = !tamanhosDaCasa().includes(Number(lugaresNovaMesa));
    } else {
      modoManualMesa = false;
      lugaresNovaMesa = valorDaLista(tamanhosDaCasa(), lugaresNovaMesa);
    }
    $("#mLugares").textContent = lugaresNovaMesa;
    const alvo = $(`input[name="mesapetnova"][value="${m && m.pet ? "sim" : "nao"}"]`);
    if (alvo) alvo.checked = true;
    $("#mNumero").value = "";
    const numObr = CFG.mesaNumObrigatorio !== false;
    $("#mNumeroLabel").innerHTML = numObr
      ? 'Número da mesa <b class="req">*</b>'
      : "Número da mesa <small>(opcional)</small>";
    $("#mIdent").value = (m && m.identificacao) || "";
    $("#mMsg").textContent = "";
    $("#mPetField").hidden = CFG.petAtivo === false;
    $("#mIdentField").hidden = CFG.obsMesa === false;
    $("#mesaTitulo").textContent = m ? "✏️ Corrigir mesa" : "🍽 Lançar mesa livre";
    $("#mSalvar").textContent = m ? "Salvar alterações" : "🍽 Liberar esta mesa";
    desenharTamanhosMesa();
    renderNumChips();          // já desenha o teclado de números junto
    $("#mesaModal").hidden = false;
    focoSePuder("#mNumero");
  }

  // Os mesmos tamanhos configurados na engrenagem viram botões aqui também,
  // para o garçom lançar a mesa num toque em vez de ficar no contador.
  function desenharTamanhosMesa() {
    $("#mTamanhos").innerHTML =
      tamanhosDaCasa().map((n) => `<button type="button" class="tm-btn${!modoManualMesa && Number(lugaresNovaMesa) === n ? " is-sel" : ""}" data-mtam="${n}">
        <b>${n}</b><span>${n === 1 ? "lugar" : "lugares"}</span>
      </button>`).join("") +
      `<button type="button" class="tm-btn tm-outro${modoManualMesa ? " is-sel" : ""}" data-mtam="manual">
        <b>✏️</b><span>outro</span>
      </button>`;
    $("#mLugaresField").hidden = !modoManualMesa;
    $("#mLugares").textContent = lugaresNovaMesa;
  }

  function escolherTamanhoMesa(v) {
    if (v === "manual") { modoManualMesa = true; lugaresNovaMesa = proximoDepoisDaLista(tamanhosDaCasa()); }
    else { modoManualMesa = false; lugaresNovaMesa = Number(v); }
    $("#mMsg").textContent = "";
    desenharTamanhosMesa();
  }

  // Números já adicionados (quando o garçom junta duas ou mais mesas)
  // Teclado de números de mesa: o garçom toca no número em vez de digitar.
  // As opções saem do MAPA quando ele existe (é a planta real da casa); sem
  // mapa cadastrado, vale a sequência de 1 a 50, que cobre a maioria dos salões.
  function numerosSugeridos() {
    const doMapa = mapa
      .map((m) => String(m.numero).trim())
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b, "pt-BR", { numeric: true }));
    if (doMapa.length) return [...new Set(doMapa)];
    const lista = [];
    for (let i = 1; i <= 50; i++) lista.push(String(i));
    return lista;
  }

  function renderTecladoNumeros() {
    const box = $("#mNumTeclado");
    if (!box) return;
    // uma mesa já lançada e ainda não usada não pode ser lançada de novo
    const jaLancadas = new Set(
      mesasLivres.flatMap((m) => String(m.numeros || m.identificacao || "")
        .split("+").map((s) => s.trim().toLowerCase()).filter(Boolean))
    );
    const escolhidos = new Set(numerosNovaMesa.map((n) => n.toLowerCase()));
    box.innerHTML = numerosSugeridos().map((n) => {
      const chave = n.toLowerCase();
      const sel = escolhidos.has(chave) ? " is-sel" : "";
      const ocupada = jaLancadas.has(chave) && !escolhidos.has(chave) ? " is-lancada" : "";
      const titulo = ocupada ? ' title="Já está na lista da recepção"' : "";
      return `<button type="button" class="num-tecla${sel}${ocupada}" data-numtecla="${esc(n)}"${titulo}>${esc(n)}</button>`;
    }).join("");
  }

  function renderNumChips() {
    const box = $("#mNumChips");
    if (!box) return;
    box.innerHTML = numerosNovaMesa.map((n, i) => `
      <span class="num-chip">${esc(n)}<button type="button" data-tiranum="${i}" aria-label="Tirar">✕</button></span>`)
      .join('<span class="num-mais">+</span>');
    box.hidden = !numerosNovaMesa.length;
    renderTecladoNumeros();          // o teclado marca o que já foi escolhido
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
    grupoManual = false;
    // no balcão (inclusive na fila da fila) não há teto artificial de grupo:
    // quem digita é a equipe, e ela lança o tamanho real
    const noBalcao = isStaff() || naAbaPrevia();
    pessoas = valorDaLista(tamanhosDeGrupo().filter((n) => n <= (noBalcao ? TETO_EQUIPE : (Number(CFG.maxPessoas) || MAX_P))), 2);
    $("#fPessoas").textContent = pessoas;
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
    focoSePuder("#fNome");
  }

  // Pop-up mostrado depois de entrar na fila: posição + QR + link
  function mostrarEntrou(pessoa) {
    const pos = waiting().findIndex((r) => r.id === pessoa.id) + 1;
    $("#joinedTitle").textContent = isStaff() ? `✅ ${firstName(pessoa.nome)} entrou na fila!` : "✅ Você está na fila!";
    $("#joinedPos").textContent = pos > 0 ? pos + "º" : "—";
    // este pop-up é lido pelo cliente: vai a FAIXA, não um número cravado
    const espera = esperaStats() ? esperaTexto(true) : null;
    // Quantos grupos DO MESMO TAMANHO estão na frente. É o que realmente
    // manda na espera: as mesas são chamadas pelo número de lugares, então
    // "12 grupos na fila" assusta sem querer dizer nada para quem é 2.
    const n = Number(pessoa.pessoas);
    const naFrente = waiting().filter((r, i) => i < pos - 1 && Number(r.pessoas) === n).length;
    const gente = `${n} ${n === 1 ? "pessoa" : "pessoas"}`;
    // texto neutro: o mesmo pop-up aparece para o cliente no totem e para a
    // atendente no balcão
    const frente = pos <= 1 ? "primeiro da fila"
      : (naFrente === 0
          ? `nenhum grupo de ${gente} na frente`
          : `${naFrente} ${naFrente === 1 ? "grupo" : "grupos"} de ${gente} na frente`);
    $("#joinedSub").textContent = frente +
      (espera && CFG.mostrarMedia !== false ? ` • espera ${espera}` : "");

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
    $("#tabMapa").addEventListener("click", () => setView("mapa"));
    $("#tabSentados").addEventListener("click", () => setView("sentados"));
    $("#tabPedidos").addEventListener("click", () => setView("pedidos"));
    $("#tabFilaFila").addEventListener("click", () => setView("filafila"));

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
    // teclado de números: um toque escolhe, outro tira
    $("#mNumTeclado").addEventListener("click", (e) => {
      const b = e.target.closest("[data-numtecla]");
      if (!b) return;
      const n = b.dataset.numtecla;
      const i = numerosNovaMesa.findIndex((x) => x.toLowerCase() === n.toLowerCase());
      if (i >= 0) {
        numerosNovaMesa.splice(i, 1);
      } else {
        if (numerosNovaMesa.length >= 6) {
          const msg = $("#mMsg");
          msg.textContent = "São no máximo 6 mesas juntas.";
          msg.className = "form-msg err";
          return;
        }
        numerosNovaMesa.push(n);
        $("#mNumero").value = "";           // escolheu pelo teclado: o campo limpa
      }
      $("#mMsg").textContent = "";
      renderNumChips();
    });
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
      // sem o número, a mesa não serve para nada: a atendente não sabe para
      // onde mandar o cliente e o mapa não consegue ligar a mesa a ninguém
      if (CFG.mesaNumObrigatorio !== false && !numerosNovaMesa.length) {
        msg.textContent = "Digite o número da mesa.";
        msg.className = "form-msg err";
        $("#mNumero").focus();
        return;
      }
      // Duas mesas livres com o mesmo número seriam impossíveis de distinguir:
      // a atendente não saberia qual chamar e o "Sentou" pegaria a errada.
      const repetida = numerosNovaMesa.find((n) =>
        mesasLivres.some((m) => m.id !== editandoMesaId && numeroBate(n, m.numeros || m.identificacao)));
      if (repetida) {
        // tira o número recusado da lista: se ficasse, a próxima tentativa
        // esbarraria nele de novo e o garçom não entenderia o porquê
        numerosNovaMesa = numerosNovaMesa.filter((n) => n !== repetida);
        renderNumChips();
        msg.textContent = "A mesa " + repetida + " já está liberada. Confira o número.";
        msg.className = "form-msg err";
        $("#mNumero").focus();
        return;
      }
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
          // tirar da lista de liberadas devolve a mesa para "aguardando" no mapa
          if (confirm("Mover esta mesa de volta para aguardando?")) await apagarMesa(t.dataset.apagarmesa);
        }
        else if (t.dataset.selmesa) selecionarMesa(t.dataset.selmesa);
      } catch (err) {
        console.error("Ação na mesa falhou:", err);
        const m = $("#mesasMsg");
        if (m) { m.textContent = "⚠ Não deu para salvar — verifique a internet."; m.className = "form-msg err"; }
      }
    });

    // Segurar o cartão de uma mesa livre abre as ações; toque simples chama.
    (function segurarMesa() {
      const lista = $("#mesasList");
      if (!lista) return;
      let alvo = null, relogio = null, x0 = 0, y0 = 0, abriu = false;
      lista.addEventListener("contextmenu", (e) => {
        if (e.target.closest("[data-selmesa]")) e.preventDefault();
      });
      const limpar = () => {
        clearTimeout(relogio);
        if (alvo) alvo.classList.remove("is-pronto");
        alvo = null;
      };
      lista.addEventListener("pointerdown", (e) => {
        const card = e.target.closest("[data-selmesa]");
        if (!card) return;
        alvo = card; abriu = false; x0 = e.clientX; y0 = e.clientY;
        relogio = setTimeout(() => {
          abriu = true;
          card.classList.add("is-pronto");
          if (navigator.vibrate) { try { navigator.vibrate(15); } catch (err) { /* ignora */ } }
          acaoSegura("ações da mesa", () => abrirAcoesMesaLivre(card.dataset.selmesa))();
          limpar();
        }, 450);
      });
      lista.addEventListener("pointermove", (e) => {
        if (alvo && Math.hypot(e.clientX - x0, e.clientY - y0) > 10) limpar();
      });
      lista.addEventListener("pointerup", () => { limpar(); });
      lista.addEventListener("pointercancel", limpar);
      // o clique que vem depois de um "segurar" não deve chamar a mesa
      lista.addEventListener("click", (e) => {
        if (!abriu) return;
        abriu = false;
        e.stopPropagation();
        e.preventDefault();
      }, true);
    })();

    $("#mlAcoes").addEventListener("click", (e) => {
      const b = e.target.closest("[data-mlacao]");
      if (b) acaoMesaLivre(b.dataset.mlacao);
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
      // a antessala é balcão: quem digita é a equipe, não o cliente
      const noBalcao = isStaff() || naAbaPrevia();
      const precisaTermos = !noBalcao && CFG.exigirTermos !== false;
      const msg = $("#formMsg");
      const erro = (t) => { msg.textContent = t; msg.className = "form-msg err"; };

      if (!nome) return erro("Digite o nome.");
      // a antessala pode cobrar campos diferentes: vazio = igual à fila de espera
      const ff = (chave, padrao) => (naAbaPrevia() && String(CFG[chave] || "")) || padrao;
      const modoTel = ff("ffTel", CFG.telObrigatorio !== false ? "obrigatorio" : "opcional");
      if (modoTel === "obrigatorio") {
        const dig = tel.replace(/\D/g, "");
        if (!dig) return erro("Digite o telefone (com DDD).");
        if (dig.length < 10) return erro("Telefone incompleto — digite o DDD + número.");
      }
      // e-mail: só cobra se estiver ligado na engrenagem
      const email = $("#fEmail").value.trim();
      const modoEmail = ff("ffEmail", CFG.campoEmail || "nao");
      if (modoEmail !== "nao") {
        if (modoEmail === "obrigatorio" && !email) return erro("Digite o e-mail.");
        if (email && !emailValido(email)) return erro("E-mail inválido — confira se está completo (nome@email.com).");
      }
      // aniversário: só cobra se estiver ligado na engrenagem
      const anivTxt = $("#fAniversario").value.trim();
      const modoAniv = ff("ffAniv", CFG.campoAniversario || "nao");
      if (modoAniv !== "nao") {
        if (modoAniv === "obrigatorio" && !anivTxt) return erro("Digite a data de aniversário (dia, mês e ano).");
        if (anivTxt && !normalizaAniversario(anivTxt)) return erro("Aniversário inválido — digite dia, mês e ano, como 07/03/1990.");
      }
      if (precisaTermos && !$("#fTermos").checked) return erro("É preciso aceitar as regras da fila para entrar.");
      // fila fechada NÃO impede a antessala — ela existe justamente para isso
      if (!noBalcao && CFG.filaFechada === true) return erro("A fila está fechada no momento.");

      $("#joinBtn").disabled = true;
      try {
        const pessoa = await addPerson({
          nome, telefone: tel, pessoas,
          email: modoEmail === "nao" ? "" : email,
          aniversario: modoAniv === "nao" ? "" : anivTxt,
          preferencial: tipo === "preferencial",
          pet, semAreaPet,
          comanda: noBalcao && CFG.campoComanda !== false ? $("#fComanda").value : "",
          pager: noBalcao && CFG.campoPager !== false ? $("#fPager").value : "",
          aceitouTermos: precisaTermos,
        });
        msg.textContent = "";
        $("#formModal").hidden = true;
        // O pop-up de "você está na fila" fala de posição e QR de
        // acompanhamento — nada disso vale para quem está na antessala, que
        // ainda nem tem lugar na fila. Ali basta a confirmação.
        if (naAbaPrevia()) {
          const ff = $("#ffMsg");
          if (ff) {
            ff.textContent = `✅ ${firstName(pessoa.nome)} entrou na fila da fila.`;
            ff.className = "form-msg ok";
            setTimeout(() => { ff.textContent = ""; }, 5000);
          }
        } else {
          mostrarEntrou(pessoa);
        }
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
    $("#freeTableBtn").addEventListener("click", acaoSegura("chamar próxima mesa", () => {
      // o botão da tela é sempre uma chamada nova: solta qualquer mesa que
      // tenha ficado escolhida de um toque anterior, senão ele abriria
      // travado na última mesa tocada
      if (mesaSelecionada) { mesaSelecionada = null; render(); }
      tamanhoTravado = false;
      abrirTamanho();
    }));
    $("#tamanhoOk").addEventListener("click", acaoSegura("chamar próxima mesa", () => {
      $("#tamanhoModal").hidden = true;
      chamarParaMesa();
    }));
    // O Android manda um clique atrasado depois do toque. Se o pop-up acabou
    // de abrir debaixo do dedo, esse clique cai num BOTÃO dele e muda o estado
    // da mesa sem ninguém pedir — era a "piscada" que trocava a cor. Vale para
    // os dois passos: juntando por arrasto, o passo 2 abre exatamente onde o
    // dedo largou a mesa.
    const popupRecemAberto = () => {
      const abertoEm = Number($("#mapaAcaoModal").dataset.abertoEm) || 0;
      return Date.now() - abertoEm < 450;
    };
    $("#mapaAcoes").addEventListener("click", (e) => {
      const b = e.target.closest("[data-macao]");
      if (!b || popupRecemAberto()) return;
      acaoNaMesa(b.dataset.macao);
    });
    // ---- passo 2 do pop-up da mesa ----
    $("#mapaLugaresChips").addEventListener("click", (e) => {
      const b = e.target.closest("[data-maplug]");
      if (!b || popupRecemAberto()) return;
      if (b.dataset.maplug === "manual") {
        mapaLugaresManual = true;
      } else {
        mapaLugaresManual = false;
        mapaLugaresEscolhidos = Number(b.dataset.maplug);
      }
      desenharLugaresDoMapa();
    });
    // "outro": o mesmo ± grande do pop-up do garçom. Digitar número no meio do
    // salão, de pé, é onde nasce o erro — aqui o dedo só toca.
    //
    // O ouvinte fica no PASSO 2 inteiro, e não em cada botão: assim ele
    // funciona mesmo que o conteúdo do pop-up seja redesenhado, e um toque na
    // borda do botão (onde cai o ícone, não o texto) continua contando. E aqui
    // não entra a trava do clique atrasado: mexer no número é inofensivo — o
    // garçom vê o valor na tela antes de confirmar.
    $("#mapaPasso2").addEventListener("click", (e) => {
      const b = e.target.closest("[data-mapstep]");
      if (!b) return;
      mapaLugaresManual = true;
      mapaLugaresEscolhidos = Math.max(1, Math.min(60,
        (Number(mapaLugaresEscolhidos) || 4) + Number(b.dataset.mapstep)));
      $("#mapaLugaresManual").textContent = mapaLugaresEscolhidos;
    });
    $("#mapaJuntarLista").addEventListener("click", (e) => {
      const b = e.target.closest("[data-mapjuntar]");
      if (!b || popupRecemAberto()) return;
      const id = b.dataset.mapjuntar;
      if (mapaJuntarSelecao.has(id)) mapaJuntarSelecao.delete(id);
      else mapaJuntarSelecao.add(id);
      const m = mapa.find((x) => x.id === mapaMesaAtiva);
      if (m) {
        // a sugestão de lugares acompanha o que foi escolhido
        if (!mapaLugaresManual) {
          mapaLugaresEscolhidos = valorDaLista(tamanhosDaCasa(), lugaresSugeridos(m));
        }
        desenharJuntarLista(m);
        desenharLugaresDoMapa();
      }
    });
    $("#mapaPasso2Voltar").addEventListener("click", () => { if (!popupRecemAberto()) voltarAoPasso1(); });
    $("#mapaPasso2Ok").addEventListener("click", acaoSegura("liberar a mesa", () => { if (!popupRecemAberto()) return confirmarPasso2(); }));

    // cadastro do mapa (pela engrenagem)
    $("#liberarTodasBtn").addEventListener("click", acaoSegura("liberar todas as mesas", async () => {
      const quantas = mapa.filter((m) => ["avisada", "reservada"].indexOf(estadoDaMesa(m)) < 0).length;
      if (!quantas) { avisoStaff("Todas as mesas já estão liberadas.", true); return; }
      // ação em lote: sempre confirma, para os dois perfis
      if (!confirm("Liberar TODAS as mesas para a recepção? Inclui as ocupadas e as marcadas para limpar.")) return;
      const b = $("#liberarTodasBtn");
      b.disabled = true;
      try { await liberarTodasAsMesas(); } finally { b.disabled = false; }
    }));
    $("#limparTodasBtn").addEventListener("click", acaoSegura("todas limpar", async () => {
      const quantas = mapa.filter((m) => ["limpar", "reservada"].indexOf(estadoDaMesa(m)) < 0).length;
      if (!quantas) { avisoStaff("Todas as mesas já estão marcadas para limpar.", true); return; }
      if (!confirm("Marcar TODAS as mesas para limpar? Inclui as ocupadas; elas saem da lista da recepção.")) return;
      const b = $("#limparTodasBtn");
      b.disabled = true;
      try { await marcarTodasParaLimpar(); } finally { b.disabled = false; }
    }));
    $("#aguardarTodasBtn").addEventListener("click", acaoSegura("todas aguardando", async () => {
      const quantas = mapa.filter((m) => ["livre", "reservada"].indexOf(estadoDaMesa(m)) < 0).length;
      if (!quantas) { avisoStaff("Todas as mesas já estão aguardando.", true); return; }
      if (!confirm("Devolver TODAS as mesas para aguardando? Inclui as ocupadas; elas saem da lista da recepção e as marcações de limpeza são apagadas.")) return;
      const b = $("#aguardarTodasBtn");
      b.disabled = true;
      try { await voltarTodasParaAguardando(); } finally { b.disabled = false; }
    }));
    $("#cfgMapaBtn").addEventListener("click", acaoSegura("configurar o mapa", abrirEditorMapa));
    $("#mapaNova").addEventListener("click", () => abrirMesaCadastro(null));
    $("#mapaVarias").addEventListener("click", acaoSegura("várias mesas", abrirLoteMesas));
    $("#mapaArrumar").addEventListener("click", acaoSegura("organizar o mapa", arrumarMapa));
    $("#mlCriar").addEventListener("click", acaoSegura("criar as mesas", criarLoteMesas));
    $("#mlQtd").addEventListener("input", atualizarPreviaLote);
    $("#mlInicio").addEventListener("input", atualizarPreviaLote);
    $("#mlLugares").addEventListener("input", (e) => {
      mlLugares = Math.max(1, Math.min(30, parseInt(e.target.value, 10) || 1));
      atualizarPreviaLote();
    });
    $("#mlTamanhos").addEventListener("click", (e) => {
      const b = e.target.closest("[data-mltam]");
      if (!b) return;
      if (b.dataset.mltam === "manual") { mlManual = true; }
      else { mlManual = false; mlLugares = Number(b.dataset.mltam); }
      desenharLugaresLote();
    });
    $("#mapaConcluir").addEventListener("click", fecharEditorMapa);
    $("#mapaDobrarBtn").addEventListener("click", alternarDobraDoMapa);
    $("#mapaMaior").addEventListener("click", () => mudarZoom(0.2));
    $("#mapaMenor").addEventListener("click", () => mudarZoom(-0.2));
    $("#mapaEditarBtn").addEventListener("click", acaoSegura("editar o mapa", () => {
      modoEdicaoMapa = true;
      renderMapa();
    }));
    $("#mmSalvar").addEventListener("click", salvarMesaCadastro);
    $("#mmApagar").addEventListener("click", apagarMesaCadastro);
    $("#mmNumero").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#mmSalvar").click(); });
    $("#mmTamanhos").addEventListener("click", (e) => {
      const b = e.target.closest("[data-mmtam]");
      if (!b) return;
      if (b.dataset.mmtam === "manual") { mmManual = true; mmLugares = proximoDepoisDaLista(tamanhosDaCasa()); }
      else { mmManual = false; mmLugares = Number(b.dataset.mmtam); }
      desenharLugaresCadastro();
    });
    $$(".step-btn[data-mmstep]").forEach((b) =>
      b.addEventListener("click", () => {
        mmLugares = Math.min(TETO_EQUIPE, Math.max(MIN_P, mmLugares + Number(b.dataset.mmstep)));
        $("#mmLugares").textContent = mmLugares;
      })
    );
    ligarArrasto("#mapaPiso", "juntar");

    // botões de "Quantas pessoas?" na entrada da fila
    $("#fpTamanhos").addEventListener("click", (e) => {
      const b = e.target.closest("[data-fptam]");
      if (!b) return;
      if (b.dataset.fptam === "manual") {
        grupoManual = true;
        // começa no primeiro número que os botões não cobrem: com 1..6 na
        // lista, "outro" abre em 7. Voltar para 2 obrigava a subir tudo de novo.
        const teto = isStaff() ? TETO_EQUIPE : (Number(CFG.maxPessoas) || MAX_P);
        pessoas = proximoDepoisDaLista(tamanhosDeGrupo().filter((n) => n <= teto), teto);
      } else { grupoManual = false; pessoas = Number(b.dataset.fptam); }
      prepararFormulario();
    });
    $("#tmTamanhos").addEventListener("click", (e) => {
      const b = e.target.closest("[data-tam]");
      if (!b) return;
      const v = b.dataset.tam;
      escolherTamanho(v === "manual" || v === "destravar" ? v : Number(v));
    });
    $("#callCancel").addEventListener("click", () => { $("#callModal").hidden = true; pendingCall = null;
      if (mesaSelecionada) { mesaSelecionada = null; render(); } });
    $("#callConfirm").addEventListener("click", async () => {
      const p = pendingCall;
      if (!p) { $("#callModal").hidden = true; return; }
      const btn = $("#callConfirm");
      if (btn.disabled) return;                 // já está gravando: ignora clique repetido
      const cmsg = $("#callMsg");
      btn.disabled = true;
      if (cmsg) { cmsg.textContent = "Salvando…"; cmsg.className = "form-msg"; }

      // se a chamada saiu de uma mesa do garçom, já guarda o número dela:
      // na hora do "Sentou" o campo vem preenchido sozinho
      const mesaEscolhida = mesasLivres.find((m) => m.id === mesaSelecionada);
      const numeroDaMesa = (mesaEscolhida && (mesaEscolhida.numeros || mesaEscolhida.identificacao)) || p.mesa_numero || null;
      try {
        // GRAVA PRIMEIRO: nunca avisar o cliente de uma mesa que não foi
        // registrada. A gravação da chamada e a reserva da mesa vão JUNTAS —
        // em sequência eram duas esperas somadas para a atendente.
        await Promise.all([
          callPerson(p.id, { mesa_numero: numeroDaMesa }),
          mesaSelecionada ? reservarMesa(mesaSelecionada, p.id).catch((e) => {
            console.warn("Não deu para reservar a mesa:", e);
          }) : Promise.resolve(),
        ]);
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

      // A tela já mostra o resultado sem esperar a releitura: o cliente sai da
      // fila e vai para o painel "Chamando" na hora.
      const linha = rows.find((r) => r.id === p.id);
      if (linha) {
        linha.status = STATUS.CHAMADO;
        linha.chamado_em = new Date().toISOString();
        if (numeroDaMesa) linha.mesa_numero = numeroDaMesa;
      }
      render();

      // só depois de gravado, abre o WhatsApp já com a mensagem pronta
      if (CFG.whatsAtivo !== false && CFG.whatsAuto && p.telefone) {
        const link = waLink(p);
        if (link) {
          const aba = window.open(link, "_blank");
          if (!aba) avisoStaff("Chamada registrada. O navegador bloqueou o WhatsApp — toque em 📲 WhatsApp no cartão.");
        }
      }
      refresh();      // confere com o servidor em segundo plano
    });

    // tocar no cartão da fila abre a ficha do cliente
    document.addEventListener("click", (e) => {
      const card = e.target.closest("[data-cliente]");
      if (card) acaoSegura("abrir cliente", () => abrirCliente(card.dataset.cliente))();
    });

    // ações na lista/painel (delegação)
    document.addEventListener("click", async (e) => {
      const t = e.target.closest("[data-call],[data-seat],[data-drop],[data-back],[data-discard],[data-toend],[data-edit],[data-pedido],[data-qrcliente],[data-finish],[data-ffpromover],[data-ffavisar],[data-ffrebaixar]");
      if (!t) return;
      // veio da ficha do cliente? ela sai da frente antes da ação acontecer
      if (t.closest("#clienteModal")) $("#clienteModal").hidden = true;

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
      // "pedido pronto" é um link: o WhatsApp abre sozinho, só registramos a hora.
      // O registro sai DEPOIS do clique (setTimeout): ele redesenha a lista, e
      // redesenhar no meio do clique arrancava o próprio link da tela antes do
      // navegador abrir o WhatsApp — era isso que travava o segundo aviso.
      // "Avisar que abriu vaga" é BOTÃO, não link — mas ele ainda abre o
      // WhatsApp. Por isso o window.open acontece antes de qualquer `await`:
      // o navegador só libera abrir aba se for na mesma batida do toque.
      if (t.dataset.ffavisar) {
        const idAviso = t.dataset.ffavisar;
        const p = rows.find((r) => r.id === idAviso);
        const quem = p ? firstName(p.nome) : "este cliente";
        if (!confirm(`Avisar ${quem} de que já abriu vaga na fila de espera?`)) return;
        // a fila da fila tem a escolha DELA: dá para avisar por lá sem WhatsApp
        // mesmo com o WhatsApp ligado na chamada da mesa, e vice-versa
        const abreWhats = CFG.whatsAtivo !== false && CFG.previaWhats !== false;
        const link = (p && abreWhats) ? waLinkPrevia(p) : "";
        if (link && !window.open(link, "_blank")) {
          avisoStaff("Aviso registrado. O navegador bloqueou o WhatsApp — abra a conversa na mão.");
        }
        avisarDaPrevia(idAviso);
        return;
      }
      if (t.dataset.pedido) {
        const idPedido = t.dataset.pedido;
        // Na aba Pedidos os botões ficam um embaixo do outro numa lista: é fácil
        // encostar no do vizinho e avisar o cliente errado. Ali confirma antes.
        // Se ela desistir, o link NÃO abre (preventDefault) e nada é gravado.
        if (t.classList.contains("ped-acao")) {
          const p = rows.find((r) => r.id === idPedido);
          const quem = p ? firstName(p.nome) : "este cliente";
          const jaFoi = p && p.pedido_em;
          if (!confirm(jaFoi
            ? `Avisar ${quem} DE NOVO que o pedido está pronto?`
            : `Avisar ${quem} que o pedido está pronto?`)) {
            e.preventDefault();
            return;
          }
        }
        setTimeout(() => marcarPedido(idPedido), 0);
        return;
      }

      if (t.disabled) return;
      t.disabled = true;   // evita toque duplo enquanto grava
      try {
        if (t.dataset.drop) { if (confirm("Remover este cliente da fila?")) await dropPerson(t.dataset.drop); }
        else if (t.dataset.ffpromover) {
          // avisa se a fila já está cheia, mas deixa passar: a decisão de
          // estourar o limite é da casa, não do programa
          const vagas = vagasNaFila();
          const p = rows.find((r) => r.id === t.dataset.ffpromover);
          const cabe = vagas == null || vagas >= Number((p && p.pessoas) || 1);
          if (cabe || confirm("A fila de espera já está no limite. Colocar mesmo assim?")) {
            await promoverDaPrevia(t.dataset.ffpromover);
          }
        }
        // finalizar não pergunta: a atendente já abriu a ficha daquele cliente
        // de propósito, e o erro tem conserto (é só voltar à fila)
        else if (t.dataset.ffrebaixar) {
          if (confirm("Enviar para a fila da fila? A pessoa PERDE a posição na fila de espera e, ao voltar, entra como quem chega na hora.")) {
            await rebaixarParaPrevia(t.dataset.ffrebaixar);
          }
        }
        else if (t.dataset.finish) await finalizarAtendimento(t.dataset.finish);
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

    // Marca a hora em que cada pop-up aparece. É o que permite ignorar o
    // clique atrasado do celular logo depois do toque que abriu.
    $$(".modal").forEach((m) => {
      new MutationObserver(() => {
        if (!m.hidden) m.dataset.abertoEm = String(Date.now());
      }).observe(m, { attributes: true, attributeFilter: ["hidden"] });
    });

    // fechar pop-ups: botão "X", clique fora e tecla Esc
    function closeModal(m) {
      if (!m) return;
      m.hidden = true;
      if (m.id === "callModal") {
        pendingCall = null;
        // fechar sem confirmar solta a mesa escolhida
        if (mesaSelecionada) { mesaSelecionada = null; render(); }
      }
      // fechar o pop-up de chamar solta a mesa que estava escolhida: senão ela
      // ficaria grudada numa chamada feita depois, por outro motivo
      if (m.id === "tamanhoModal" && mesaSelecionada) { mesaSelecionada = null; render(); }
      // o pager desliga a escuta e o tempo real ao sair: deixar ligado gastaria
      // bateria da base e encheria a tabela de captura à toa
      if (m.id === "pagerModal") fecharPager();
    }
    document.addEventListener("click", (e) => {
      const x = e.target.closest("[data-close]");
      if (x) { closeModal(x.closest(".modal")); return; }
      // No celular, o clique que o navegador dispara DEPOIS do toque cai em
      // cima do pop-up que o toque acabou de abrir — e o fechava na hora.
      // Por isso o fundo escuro só responde depois de um instante aberto.
      const abertoEm = Number(e.target.dataset && e.target.dataset.abertoEm) || 0;
      if (Date.now() - abertoEm < 400) return;
      // Clique no fundo escuro fecha — MENOS nos pop-ups com campos digitados.
      // Num toque errado no totem, o cliente perdia o cadastro pela metade;
      // nesses o jeito de sair é o × ou o Cancelar, que são propositais.
      if (e.target.classList && e.target.classList.contains("modal") &&
          !e.target.hasAttribute("data-fixo")) closeModal(e.target);
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        // fecha só o pop-up que está por cima
        const abertos = $$(".modal").filter((m) => !m.hidden);
        if (abertos.length) { closeModal(abertos[abertos.length - 1]); return; }
        if (modoEdicaoMapa) fecharEditorMapa();
      }
    });

    // "com pet" e "sem área pet" não podem estar marcados juntos
    sincPetForm = exclusaoPet("#fPet", "#fSemPet");
    sincPetEdit = exclusaoPet("#edPet", "#edSemPet");

    // em qual mesa o cliente sentou
    $("#sentouOk").addEventListener("click", confirmarSentou);
    // escolher a mesa dentro do pop-up de chamada: um toque marca, outro
    // desmarca. Só depois de confirmar é que a mesa fica reservada de verdade.
    $("#callModalBody").addEventListener("click", (e) => {
      const b = e.target.closest("[data-callmesa]");
      if (!b) return;
      const id = b.dataset.callmesa;
      const jaEra = mesaSelecionada === id;
      mesaSelecionada = jaEra ? null : id;
      $$("#callModalBody .sm-mesa").forEach((x) => x.classList.remove("is-sel"));
      if (!jaEra) b.classList.add("is-sel");
      renderMesas();     // a lista atrás do pop-up acompanha a escolha
    });
    // Tocar numa mesa livre preenche o número — sem ninguém decorar nada.
    // Um toque marca, OUTRO DESMARCA, igual ao pop-up de chamada: quem tocou
    // na mesa errada precisa de um jeito de voltar atrás e sentar sem mesa.
    $("#sentouMesas").addEventListener("click", (e) => {
      const b = e.target.closest("[data-sentoumesa]");
      if (!b) return;
      const jaEra = b.classList.contains("is-sel");
      $("#sentouMesa").value = jaEra ? "" : b.dataset.sentoumesa;
      marcarMesaDoSentou();
      $("#sentouMsg").textContent = "";
    });
    // apagar o número na mão também desmarca: antes o destaque continuava
    // aceso e parecia que o cliente não podia sentar sem mesa
    $("#sentouMesa").addEventListener("input", marcarMesaDoSentou);
    $("#sentouMesa").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#sentouOk").click(); });

    // editar cliente
    $("#edSave").addEventListener("click", salvarEdicao);

    // busca na fila
    // o campo nasce "somente leitura" para o navegador não preenchê-lo com o
    // login; ao tocar nele, liberamos para digitar
    $("#buscaInput").addEventListener("focus", (e) => e.target.removeAttribute("readonly"));
    // chips de filtro: marcam/desmarcam e a lista responde na hora
    // busca e filtros da aba "Na mesa"
    $("#sentBusca").addEventListener("focus", (e) => e.target.removeAttribute("readonly"));
    $("#sentBusca").addEventListener("input", (e) => { buscaSent = e.target.value; renderSentados(); });
    $("#sentLimpar").addEventListener("click", () => {
      buscaSent = "";
      $("#sentBusca").value = "";
      renderSentados();
      $("#sentBusca").focus();
    });
    // busca e filtros da aba "Pedidos"
    $("#pedBusca").addEventListener("focus", (e) => e.target.removeAttribute("readonly"));
    $("#pedBusca").addEventListener("input", (e) => { buscaPed = e.target.value; renderPedidos(); });
    // fila da fila
    $("#ffBusca").addEventListener("input", (e) => { buscaPrevia = e.target.value; renderFilaFila(); });
    $("#ffLimpar").addEventListener("click", () => {
      buscaPrevia = "";
      $("#ffBusca").value = "";
      renderFilaFila();
    });
    $("#pedLimpar").addEventListener("click", () => {
      buscaPed = "";
      $("#pedBusca").value = "";
      renderPedidos();
      $("#pedBusca").focus();
    });
    $("#pedFiltros").addEventListener("click", (e) => {
      const b = e.target.closest("[data-pfiltro]");
      if (!b) return;
      const f = b.dataset.pfiltro;
      if (f === "limpar") {
        filtrosPed.clear();
        buscaPed = "";
        $("#pedBusca").value = "";
      } else {
        const jaEra = filtrosPed.has(f);
        filtrosPed.clear();
        if (!jaEra) filtrosPed.add(f);
      }
      renderPedidos();
    });
    $("#sentFiltros").addEventListener("click", (e) => {
      const b = e.target.closest("[data-sfiltro]");
      if (!b) return;
      const f = b.dataset.sfiltro;
      if (f === "limpar") {
        filtrosSent.clear();
        buscaSent = "";
        $("#sentBusca").value = "";
      } else {
        const jaEra = filtrosSent.has(f);
        filtrosSent.clear();
        if (!jaEra) filtrosSent.add(f);
      }
      renderSentados();
    });
    $("#buscaFiltros").addEventListener("click", (e) => {
      const b = e.target.closest("[data-filtro]");
      if (!b) return;
      // Um escopo por vez: escolher "só pager" tira "só comanda". Tocar no que
      // já está marcado desliga e volta a procurar em tudo.
      const f = b.dataset.filtro;
      if (f === "limpar") {
        filtros.clear();
        busca = "";
        $("#buscaInput").value = "";
      } else {
        const jaEra = filtros.has(f);
        filtros.clear();
        if (!jaEra) filtros.add(f);
      }
      render();
    });
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

    // pager por rádio
    $("#cfgPagerBtn").addEventListener("click", acaoSegura("abrir o pager", abrirPager));
    $("#pgEscutar").addEventListener("click", acaoSegura("escutar o transmissor", async () => {
      await mandarComando("escutar");
      recadoPager("👂 Escuta ligada — digite uma chamada no seu transmissor.");
      lerEstadoDaBase();
    }));
    $("#pgParar").addEventListener("click", acaoSegura("parar a escuta", async () => {
      await mandarComando("parar");
      lerEstadoDaBase();
    }));
    $("#pgProprioBtn").addEventListener("click", acaoSegura("cadastrar o pager", cadastrarPagerProprio));
    $("#pgTestarBtn").addEventListener("click", acaoSegura("tocar o pager",
      () => tocarPager($("#pgTesteNum").value)));
    // botões das listas (elas são redesenhadas o tempo todo: delegação)
    $("#pagerModal").addEventListener("click", async (e) => {
      const t = e.target.closest("[data-capsalvar],[data-capapagar],[data-pgtocar],[data-pgapagar]");
      if (!t) return;
      if (t.dataset.capsalvar) return void await acaoSegura("guardar o pager", () => salvarCaptura(t.dataset.capsalvar))();
      if (t.dataset.pgtocar) return void await acaoSegura("tocar o pager", () => tocarPager(t.dataset.pgtocar))();
      if (t.dataset.capapagar) {
        await cli().from("fila_pager_capturas").delete().eq("id", t.dataset.capapagar);
        return void await recarregarPager();
      }
      if (t.dataset.pgapagar) {
        if (!confirm(`Apagar o código do pager ${t.dataset.pgapagar}?`)) return;
        await cli().from("fila_pagers").delete().eq("numero", t.dataset.pgapagar);
        return void await recarregarPager();
      }
    });

    // QR fixo do balcão
    $("#cfgQrBaixar").addEventListener("click", acaoSegura("baixar o QR", baixarQrFixo));
    $("#cfgQrCopiar").addEventListener("click", () => copiarLink(linkDoQrFixo(), $("#cfgQrLink")));

    // cópia em arquivo (só o administrador, só no computador)
    $("#backupBtn").addEventListener("click", acaoSegura("reativar a cópia", reativarBackup));
    $("#cfgBackupEscolher").addEventListener("click", acaoSegura("escolher o arquivo", async () => {
      await escolherArquivoBackup();
      await mostrarEstadoDoBackup();
    }));
    $("#cfgBackupDesligar").addEventListener("click", acaoSegura("desligar a cópia", async () => {
      if (!confirm("Parar de gravar a cópia neste arquivo? O que já foi gravado continua lá.")) return;
      await desligarArquivoBackup();
      await mostrarEstadoDoBackup();
    }));

    // configurações (engrenagem) — pede senha TODA vez
    $("#cfgBtn").addEventListener("click", () => {
      // Com login ligado, quem chegou aqui já é o administrador — e a senha das
      // configurações fica escrita no config.js (que é público). Então não faz
      // sentido pedi-la: o login é a garantia.
      if (loginLigado() || !String(CFG.pinConfig || "")) { openCfg(); return; }
      $("#cfgPinInput").value = "";
      $("#cfgPinMsg").textContent = "";
      $("#cfgPinModal").hidden = false;
      focoSePuder("#cfgPinInput", 50);
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
    $("#relDe").addEventListener("change", renderRelatorio);
    $("#relAte").addEventListener("change", renderRelatorio);
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
  // Janela do relatório: além dos atalhos, dá para escolher no calendário.
  // Devolve início e fim em milissegundos; fim = 0 significa "até agora".
  function janelaRelatorio() {
    const p = $("#relPeriodo").value;
    const meiaNoite = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime(); };
    const fimDoDia = (d) => { const x = new Date(d); x.setHours(23, 59, 59, 999); return x.getTime(); };
    if (p === "tudo") return { ini: 0, fim: 0 };
    if (p === "hoje") return { ini: meiaNoite(new Date()), fim: 0 };
    if (p === "ontem") {
      const o = new Date(); o.setDate(o.getDate() - 1);
      return { ini: meiaNoite(o), fim: fimDoDia(o) };
    }
    if (p === "mes") {
      const d = new Date(); d.setDate(1);
      return { ini: meiaNoite(d), fim: 0 };
    }
    if (p === "datas") {
      // As datas vêm como "2026-08-23": monto na mão para o navegador não
      // interpretar como UTC e jogar o dia para trás no nosso fuso.
      const paraData = (txt) => {
        const [a, m, d] = String(txt || "").split("-").map(Number);
        return a && m && d ? new Date(a, m - 1, d) : null;
      };
      const de = paraData($("#relDe").value);
      const ate = paraData($("#relAte").value);
      if (!de && !ate) return { ini: 0, fim: 0 };
      return {
        ini: de ? meiaNoite(de) : 0,
        fim: ate ? fimDoDia(ate) : (de ? fimDoDia(de) : 0),   // só a data inicial = aquele dia
      };
    }
    return { ini: Date.now() - Number(p) * 24 * 3600 * 1000, fim: 0 };
  }

  function relInicio() {
    return janelaRelatorio().ini;
  }

  // Texto do período, para o aviso de apagar e para o nome do arquivo
  function nomeDoPeriodo() {
    const sel = $("#relPeriodo");
    if (sel.value !== "datas") return sel.selectedOptions[0].textContent.toLowerCase();
    const de = $("#relDe").value, ate = $("#relAte").value;
    const br = (t) => t ? t.split("-").reverse().join("/") : "";
    if (de && ate && de !== ate) return `${br(de)} a ${br(ate)}`;
    return br(de || ate) || "período escolhido";
  }

  function openRelatorio() {
    $("#relMsg").textContent = "";
    $("#relModal").hidden = false;
    renderRelatorio();
  }

  async function renderRelatorio() {
    const { ini, fim } = janelaRelatorio();
    // o campo de datas só aparece quando é ele que manda
    const escolhendo = $("#relPeriodo").value === "datas";
    $("#relDatasField").hidden = !escolhendo;
    if (escolhendo && !$("#relDe").value && !$("#relAte").value) {
      const hoje = new Date();
      const iso = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
      $("#relDe").value = iso(hoje);
      $("#relAte").value = iso(hoje);
      return renderRelatorio();          // redesenha já com as datas de hoje
    }
    $("#relMsg").textContent = "Carregando…";
    $("#relMsg").className = "form-msg";
    let lista;
    try {
      // consulta própria: o relatório enxerga todo o histórico, não só o que está na tela
      lista = (await backend.listRelatorio(ini))
        .filter((r) => !fim || new Date(r.criado_em).getTime() <= fim)
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
      sentado: "✅ sentou", finalizado: "🏁 finalizado", desistiu: "✖ saiu",
      previa: "🎟 fila da fila",
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
      ["Sentaram", lista.filter((r) => r.status === STATUS.SENTADO || r.status === STATUS.FINALIZADO).length],
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
    // o arquivo leva BOM, então os acentos abrem certo no Excel
    const cab = ["Nome", "Telefone", "E-mail", "Aniversário", "Idade", "Pessoas", "Tipo", "Mesa grande", "Pet", "Comanda", "Pager",
      "Mesa", "Entrou", "Chamado", "Sentou", "Pedido avisado", "Espera até chamar (min)", "Tempo total (min)", "Perdeu a vez", "Situação"];
    const linhas = relCache.map((r) => [
      r.nome, r.telefone || "", r.email || "", r.aniversario || "", (idadeDe(r.aniversario) == null ? "" : idadeDe(r.aniversario)), r.pessoas,
      r.preferencial ? "Preferencial" : "Normal",
      isMesona(r) ? "Sim" : "Não",
      r.pet ? "Sim" : (r.sem_area_pet ? "Não — sem área pet" : "Não"),
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
    const escCSV = csvCampo;
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
    return relCache.filter((r) => r.status === STATUS.SENTADO || r.status === STATUS.FINALIZADO || r.status === STATUS.DESISTIU);
  }

  function pedirLimpeza() {
    const n = apagaveis().length;
    if (!n) {
      $("#relMsg").textContent = "Não há atendimentos finalizados para apagar nesse período.";
      $("#relMsg").className = "form-msg err";
      return;
    }
    const periodo = nomeDoPeriodo();
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
    "prazoComparecer", "msgWhats", "msgLink", "msgPedido", "msgPrevia", "avisoPedido", "pedidoWhats", "previaWhats",
    "ffTel", "ffEmail", "ffAniv", "ffTipo", "ffPet", "ffExtras", "alternancia", "regraTamanho", "whatsAtivo", "whatsAuto",
    "autoFimDaFila", "somAtivo", "filaFechada", "mostrarBtnFila", "mostrarBtnChamar", "maxPessoas", "tamanhosMesa", "tamanhosGrupo", "filasColunas", "mapaGarcom", "mapaAdm", "boasVindas",
    "restaurante", "paisDDI", "mostrarMedia", "telObrigatorio", "exigirTermos",
    "termosTexto", "petAtivo", "campoSemPet", "campoEmail", "campoAniversario", "filasJuntas", "mostrarHoraEntrada", "mostrarTempoEspera",
    "campoComanda", "campoPager", "mesonaAtiva", "mesonaMin", "mesonaPrazo", "prefPrazo", "normalPrazo", "resumoAlerta", "pedidoPainelMin", "totemEntrada", "obsMesa", "sentadosMax", "mapaAtendente",
    "autoFecharAtiva", "autoFecharQtd", "autoFecharArmado", "linkAtivo", "garcomAtivo", "perguntarMesa", "mesaNumObrigatorio", "liberarAte", "liberarVolta",
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

  // Aviso de que a configuração NÃO foi para a nuvem.
  function avisarConfigLocal() {
    const msg = $("#cfgMsgStatus");
    const texto = "⚠ Não deu para salvar na nuvem — vale só neste aparelho. " +
      "Os outros continuam com a configuração antiga. Verifique a internet e salve de novo.";
    if (msg) { msg.textContent = texto; msg.className = "form-msg err"; }
    else avisoStaff(texto);
  }

  async function saveSettings(obj) {
    // relê a nuvem ANTES de gravar: assim este aparelho não apaga, com um snapshot
    // velho, o que outro aparelho mudou (ex.: reabrir uma fila fechada pela atendente)
    aplicarConfig(await lerConfigNuvem());
    Object.assign(CFG, obj);
    const snap = settingsSnapshot();
    let naNuvem = true;
    try {
      if (backend.mode === "online" && backend.client) {
        const { error } = await backend.client.from("fila_config").upsert({ id: 1, dados: snap });
        if (error) throw error;
      } else {
        naNuvem = false;
        localStorage.setItem("fila_settings", JSON.stringify(snap));
      }
    } catch (e) {
      console.warn("Config: não salvou na nuvem. Guardado só neste aparelho.", e);
      localStorage.setItem("fila_settings", JSON.stringify(snap));
      // Guardar quieto é pior do que falhar: os aparelhos ficam cada um com uma
      // configuração e ninguém entende o porquê. Então avisa na cara.
      naNuvem = false;
    }
    applyBrand();
    render();
    return naNuvem;
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
  // ==========================================================
  //  ENGRENAGEM ORGANIZADA POR TELA
  // ----------------------------------------------------------
  //  Eram quase setenta ajustes numa rolagem só. Aqui eles são agrupados
  //  pela TELA que cada um afeta e cada grupo abre e fecha — quem entra
  //  para mexer numa coisa não precisa passar os olhos por todas as outras.
  //  A montagem é feita aqui, e não no HTML, para o formulário continuar
  //  sendo um lugar só: acrescentar um ajuste é escrever o campo e citar o
  //  id na lista abaixo.
  // ==========================================================
  const GRUPOS_CFG = [
    { id: "casa", titulo: "🏠 O restaurante", campos: ["cfgRest"] },
    { id: "totem", titulo: "🖥 Totem — entrada na fila", campos: [
      "cfgTotemEntrada", "cfgBoas", "cfgTelObrig", "cfgTermosOn", "cfgTermosTxt",
      "cfgCampoEmail", "cfgCampoAniversario", "cfgPetOn", "cfgSemPetOn",
      "cfgMaxP", "cfgTamanhosGrupo"] },
    { id: "cliente", titulo: "👀 O que o cliente enxerga", campos: [
      "cfgFilasJuntas", "cfgMostrarHora", "cfgMostrarTempo", "cfgMostrarMedia", "cfgMostrarFila"] },
    { id: "atendente", titulo: "👩‍💼 Atendente — chamada das mesas", campos: [
      "cfgPrazo", "cfgAutoFim", "cfgAlt", "cfgTamanhos", "cfgRegra", "cfgSom",
      "cfgPerguntarMesa", "cfgBtnChamar", "cfgFilasColunas"] },
    { id: "espera", titulo: "⏳ Filas e alerta de espera", campos: [
      "cfgMesoAtiva", "cfgMesoMin", "cfgMesoPrazo", "cfgPrefPrazo", "cfgNormalPrazo", "cfgResumoAlerta"] },
    { id: "salao", titulo: "🍽 Garçom e mapa do salão", campos: [
      "cfgGarcomOn", "cfgMapaGarcom", "cfgMapaAdm", "cfgMapaAtendente", "cfgMapaBtn",
      "cfgLiberarAte", "cfgLiberarVolta", "cfgMesaNumObr", "cfgObsMesa"] },
    { id: "mesa", titulo: "🧾 Comanda, pager e a aba “Na mesa”", campos: [
      "cfgComandaOn", "cfgPagerOn", "cfgSentadosMax"] },
    { id: "avisos", titulo: "📱 WhatsApp e avisos", campos: [
      "cfgWhatsMode", "cfgMsg", "cfgMsgLink", "cfgAvisoPedido", "cfgPedidoWhats", "cfgPedidoPainel", "cfgMsgPedido"] },
    { id: "filafila", titulo: "🎟 Fila da fila", campos: [
      "cfgPreviaWhats", "cfgMsgPrevia", "cfgFfTel", "cfgFfEmail", "cfgFfAniv", "cfgFfTipo", "cfgFfPet", "cfgFfExtras"] },
    { id: "fechar", titulo: "🔒 Fechamento automático da fila", campos: [
      "cfgAutoFecha", "cfgAutoFechaQtd"] },
    { id: "pager", titulo: "🔔 Pager por rádio", campos: [
      "cfgPagerBtn"] },
    { id: "qrfixo", titulo: "🔳 QR Code fixo do balcão", campos: [
      "cfgQrFixo"] },
    { id: "backup", titulo: "💾 Cópia de segurança em arquivo", campos: [
      "cfgBackupField"] },
    { id: "equipe", titulo: "👥 Equipe e acesso", campos: [
      "cfgPinAtend", "cfgPinGarcom"] },
  ];

  const LS_CFG_ABERTOS = "fila_cfg_abertos";
  function gruposAbertos() {
    try { return new Set(JSON.parse(localStorage.getItem(LS_CFG_ABERTOS)) || []); }
    catch (e) { return new Set(); }
  }
  function guardarAbertos(s) {
    try { localStorage.setItem(LS_CFG_ABERTOS, JSON.stringify([...s])); } catch (e) { /* ignora */ }
  }

  let engrenagemPronta = false;
  function organizarEngrenagem() {
    if (engrenagemPronta) return;
    // '.cfg-form' também é a classe do modal de EDITAR CLIENTE: sem prender a
    // busca à engrenagem, os ajustes iam parar dentro de um modal escondido.
    const form = document.querySelector("#cfgModal .cfg-form");
    if (!form) return;

    // o que fica FORA dos grupos (rodapé): versão e mensagem de status
    const rodape = [$("#cfgVersao"), $("#cfgMsgStatus")]
      .filter(Boolean).map((e) => e.closest("p") || e);

    // caixa que contém o campo: pode ser a linha de duas colunas, o rótulo
    // ou o próprio elemento (caso do botão de configurar o mapa)
    const caixaDe = (el) => el.closest(".two-cols") || el.closest("label") ||
      el.closest(".field") || el;

    const usados = new Set();
    const grupos = GRUPOS_CFG.map((g) => {
      const box = document.createElement("div");
      box.className = "cfg-grupo";
      box.dataset.grupo = g.id;
      const cabecalho = document.createElement("button");
      cabecalho.type = "button";
      cabecalho.className = "cfg-sec cfg-toggle";
      cabecalho.innerHTML = `<span>${g.titulo}</span><span class="cfg-seta">▾</span>`;
      const corpo = document.createElement("div");
      corpo.className = "cfg-corpo";
      g.campos.forEach((id) => {
        const el = document.getElementById(id);
        if (!el) return;
        const caixa = caixaDe(el);
        if (usados.has(caixa)) return;      // duas colunas entram uma vez só
        usados.add(caixa);
        corpo.appendChild(caixa);
      });
      box.appendChild(cabecalho);
      box.appendChild(corpo);
      return { g, box, corpo };
    });

    // o que sobrou (cabeçalhos antigos, textos soltos) sai de cena
    [...form.children].forEach((el) => {
      if (rodape.includes(el)) return;
      el.remove();
    });
    grupos.forEach(({ box, corpo }) => { if (corpo.children.length) form.appendChild(box); });
    rodape.forEach((el) => form.appendChild(el));

    // atalho para abrir/fechar tudo
    const barra = document.createElement("div");
    barra.className = "cfg-barra";
    barra.innerHTML = `<button type="button" class="btn btn-sm btn-neutral" id="cfgAbrirTudo">Abrir tudo</button>` +
      `<button type="button" class="btn btn-sm btn-neutral" id="cfgFecharTudo">Fechar tudo</button>`;
    form.insertBefore(barra, form.firstChild);

    const aplicar = () => {
      const abertos = gruposAbertos();
      $$("#cfgModal .cfg-grupo").forEach((box) => {
        box.classList.toggle("is-aberto", abertos.has(box.dataset.grupo));
      });
    };
    form.addEventListener("click", (e) => {
      const cab = e.target.closest(".cfg-toggle");
      if (cab) {
        const box = cab.closest(".cfg-grupo");
        const abertos = gruposAbertos();
        if (abertos.has(box.dataset.grupo)) abertos.delete(box.dataset.grupo);
        else abertos.add(box.dataset.grupo);
        guardarAbertos(abertos);
        aplicar();
        return;
      }
      if (e.target.id === "cfgAbrirTudo") {
        guardarAbertos(new Set(GRUPOS_CFG.map((g) => g.id)));
        aplicar();
      }
      if (e.target.id === "cfgFecharTudo") {
        guardarAbertos(new Set());
        aplicar();
      }
    });
    aplicar();
    engrenagemPronta = true;
  }

  function openCfg() {
    organizarEngrenagem();
    const vv = $("#cfgVersao");
    if (vv) vv.textContent = VERSAO;
    $("#cfgPrazo").value = CFG.prazoComparecer || 5;
    $("#cfgAutoFim").value = CFG.autoFimDaFila === false ? "nao" : "sim";
    $("#cfgAlt").value = CFG.alternancia || "1:1";
    $("#cfgRegra").value = CFG.regraTamanho || "exato";
    $("#cfgTamanhos").value = tamanhosDaCasa().join(", ");
    $("#cfgBtnChamar").value = CFG.mostrarBtnChamar === false ? "nao" : "sim";
    $("#cfgTamanhosGrupo").value = tamanhosDeGrupo().join(", ");
    $("#cfgFilasColunas").value = CFG.filasColunas === false ? "lista" : "colunas";
    $("#cfgMapaGarcom").value = CFG.mapaGarcom === false ? "nao" : "sim";
    $("#cfgMapaAdm").value = CFG.mapaAdm === false ? "nao" : "sim";
    $("#cfgLiberarAte").value = CFG.liberarAte || "11:00";
    $("#cfgLiberarVolta").value = CFG.liberarVolta || "17:00";
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
    $("#cfgPedidoWhats").value = CFG.pedidoWhats === false ? "nao" : "sim";
    $("#cfgPreviaWhats").value = CFG.previaWhats === false ? "nao" : "sim";
    mostrarEstadoDoBackup();
    desenharQrFixo();
    $("#cfgMsgPedido").value = CFG.msgPedido || MSG_PEDIDO_PADRAO;
    $("#cfgMsgPrevia").value = CFG.msgPrevia || MSG_PREVIA_PADRAO;
    $("#cfgFfTel").value = CFG.ffTel || "";
    $("#cfgFfEmail").value = CFG.ffEmail || "";
    $("#cfgFfAniv").value = CFG.ffAniv || "";
    $("#cfgFfTipo").value = CFG.ffTipo || "";
    $("#cfgFfPet").value = CFG.ffPet || "";
    $("#cfgFfExtras").value = CFG.ffExtras || "";

    $("#cfgRest").value = CFG.restaurante || "";
    $("#cfgPinAtend").value = CFG.pinAtendente || "";
    $("#cfgPerguntarMesa").value = CFG.perguntarMesa || "opcional";
    $("#cfgMesaNumObr").value = CFG.mesaNumObrigatorio === false ? "nao" : "sim";
    $("#cfgResumoAlerta").value = alertaDoResumo();
    $("#cfgTotemEntrada").value = CFG.totemEntrada === false ? "nao" : "sim";
    $("#cfgObsMesa").value = CFG.obsMesa === false ? "nao" : "sim";
    $("#cfgMapaAtendente").value = CFG.mapaAtendente === false ? "nao" : "sim";
    $("#cfgSentadosMax").value = quantosNaMesa();
    $("#cfgPedidoPainel").value = minutosDoPedidoNoPainel();
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
    // `|| pad` não serve aqui: zero é um valor legítimo (0 = desligar o prazo)
    // e seria trocado pelo padrão sem ninguém pedir.
    const num = (sel, min, max, pad) => {
      const v = parseInt($(sel).value, 10);
      return Math.max(min, Math.min(max, isNaN(v) ? pad : v));
    };
    const obj = {
      prazoComparecer: num("#cfgPrazo", 1, 60, 5),
      autoFimDaFila: $("#cfgAutoFim").value === "sim",
      alternancia: $("#cfgAlt").value,
      regraTamanho: $("#cfgRegra").value,
      // guarda já limpo (números, sem repetir, em ordem)
      filasColunas: $("#cfgFilasColunas").value === "colunas",
      mapaGarcom: $("#cfgMapaGarcom").value === "sim",
      mapaAdm: $("#cfgMapaAdm").value === "sim",
      liberarAte: $("#cfgLiberarAte").value || "11:00",
      liberarVolta: $("#cfgLiberarVolta").value || "17:00",
      tamanhosGrupo: Array.from(new Set($("#cfgTamanhosGrupo").value.split(/[^0-9]+/).map(Number)
        .filter((n) => n >= 1 && n <= 99))).sort((a, b) => a - b),
      mostrarBtnChamar: $("#cfgBtnChamar").value === "sim",
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
      pedidoWhats: $("#cfgPedidoWhats").value === "sim",
      previaWhats: $("#cfgPreviaWhats").value === "sim",
      msgPedido: $("#cfgMsgPedido").value.trim(),
      msgPrevia: $("#cfgMsgPrevia").value.trim(),
      ffTel: $("#cfgFfTel").value,
      ffEmail: $("#cfgFfEmail").value,
      ffAniv: $("#cfgFfAniv").value,
      ffTipo: $("#cfgFfTipo").value,
      ffPet: $("#cfgFfPet").value,
      ffExtras: $("#cfgFfExtras").value,

      garcomAtivo: $("#cfgGarcomOn").value === "sim",
      perguntarMesa: $("#cfgPerguntarMesa").value,
      mesaNumObrigatorio: $("#cfgMesaNumObr").value === "sim",
      resumoAlerta: num("#cfgResumoAlerta", 0, 600, 30),
      totemEntrada: $("#cfgTotemEntrada").value === "sim",
      obsMesa: $("#cfgObsMesa").value === "sim",
      mapaAtendente: $("#cfgMapaAtendente").value === "sim",
      sentadosMax: num("#cfgSentadosMax", 1, 200, 10),
      pedidoPainelMin: num("#cfgPedidoPainel", 0, 120, 10),

      restaurante: $("#cfgRest").value.trim() || CFG.restaurante,
    };
    // os PINs não vão para a nuvem: ficam só neste aparelho
    salvarPinLocal($("#cfgPinAtend").value.trim());
    salvarPinGarcomLocal($("#cfgPinGarcom").value.trim());
    const btn = $("#cfgSave");
    btn.disabled = true;
    $("#cfgMsgStatus").textContent = "Salvando…";
    $("#cfgMsgStatus").className = "form-msg";
    const naNuvem = await saveSettings(obj);
    btn.disabled = false;
    if (naNuvem === false && backend.mode === "online") {
      // guardar quieto no aparelho é pior do que falhar: os aparelhos ficariam
      // cada um com uma configuração e ninguém entenderia o porquê
      avisarConfigLocal();
      return;                    // não fecha: a atendente precisa ver o aviso
    }
    $("#cfgMsgStatus").textContent = "✅ Salvo!";
    $("#cfgMsgStatus").className = "form-msg ok";
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
    "tabGarcom", "tabMapa", "mesasCard", "mesaTitulo", "mNumero",
    "sentouModal", "cfgPerguntarMesa", "editModal", "publicQuem", "tamanhoModal", "tmTamanhos", "mTamanhos", "cfgPedidoWhats", "petRows", "backupBtn", "cfgBackupEscolher", "cfgQrFixo", "cfgQrBaixar", "pagerModal", "cfgPagerBtn", "pgProprioBtn", "semRedeBanner", "tabFilaFila", "filaFilaCard", "cfgMsgPrevia", "cfgFfTel", "ffEsperaFila", "fTelField", "fTipoField",
    "queueGroups", "avgPref", "cfgFilasColunas",
    "mapaCard", "mapaPiso", "cfgMapaBtn", "mmNumero", "mapaConcluir", "mapaEditarBtn", "mapaMaior", "limparTodasBtn", "mapaVarias", "mapaArrumar", "mlQtd",
    "fpTamanhos", "fpStepper", "cfgTamanhosGrupo", "cfgBtnChamar", "cfgMapaGarcom", "cfgMapaAdm", "mNumeroLabel", "cfgMesaNumObr", "cfgResumoAlerta", "cfgPedidoPainel", "mapaDobrarBtn", "cfgTotemEntrada", "cfgObsMesa", "cfgSentadosMax", "mIdentField", "cfgMapaAtendente",
    "loginScreen", "relBtn", "sairBtn", "tabSentados", "sentLista", "sentFiltros", "buscaFiltros", "tabPedidos", "pedLista", "pedFiltros",
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

  // Se este aparelho vai precisar de login, a tela de entrar sobe ANTES de
  // qualquer espera pela rede. Sem isso a fila aparece por um instante e
  // depois some — parece defeito, e ainda mostra a fila a quem não entrou.
  function talvezPrecisaLogin() {
    const c = window.FILA_CONFIG || {};
    if (c.loginAtivo !== true) return false;
    if (!(c.supabaseUrl && c.supabaseAnonKey && window.supabase)) return false;
    try { if (localStorage.getItem(LS_TOTEM) === "1") return false; } catch (e) { /* ignora */ }
    // Já existe sessão guardada neste aparelho? Então não mostra a tela de
    // entrar nem por um instante — quem já está logado não pode ver um
    // pedido de senha piscando na cara.
    try {
      const temSessao = Object.keys(localStorage)
        .some((k) => k.indexOf("sb-") === 0 && k.indexOf("-auth-token") > 0 && localStorage.getItem(k));
      if (temSessao) return false;
    } catch (e) { /* ignora */ }
    return true;
  }

  async function start() {
    const tela = $("#loginScreen");
    if (tela && talvezPrecisaLogin()) {
      const sub = $("#loginSub");
      if (sub) sub.textContent = (window.FILA_CONFIG && window.FILA_CONFIG.restaurante) || "";
      tela.hidden = false;
    }
    if (!(await telaEstaAtualizada())) return;
    applyBrand();
    carregarPinLocal();   // PIN da atendente: guardado só neste aparelho

    const hasSupabase = CFG.supabaseUrl && CFG.supabaseAnonKey && window.supabase;
    // ATENÇÃO ao que este trecho NÃO faz mais.
    //
    // Antes, qualquer falha aqui trocava para o modo local. Parecia prudente,
    // mas criava a pior falha possível: aberto o app sem internet, a atendente
    // via uma fila VAZIA (a do localStorage, que é outra), cadastrava a noite
    // inteira nela, e nada disso chegava ao Supabase. Sem erro, sem aviso —
    // duas filas paralelas, e a de verdade perdida.
    //
    // Agora, se o config.js aponta para a nuvem, é na nuvem que ficamos. Sem
    // conexão o app avisa e a fila de reenvio segura os cadastros até voltar.
    // Modo local só para quem NUNCA configurou o Supabase.
    backend = hasSupabase ? SupabaseBackend(CFG.supabaseUrl, CFG.supabaseAnonKey) : LocalBackend();
    try {
      await backend.init();
    } catch (e) {
      console.error("Backend não respondeu no arranque:", e);
      if (!hasSupabase) throw e;      // sem nuvem configurada, é erro de verdade
      marcarSemRede(true);            // com nuvem, é só a internet: seguimos
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

    ligarRelogios();
  }

  // Os relógios do app: tempos ao vivo, prazos, e as recargas de segurança.
  // Ficam numa função à parte porque precisam ser ligados nos DOIS caminhos —
  // quem já entra com sessão e quem digita a senha na tela de login. Antes só
  // o primeiro ligava, e quem fazia login ficava com os tempos parados.
  let _relogiosLigados = false;
  function ligarRelogios() {
    if (_relogiosLigados) return;
    _relogiosLigados = true;
    // a planta se reajusta quando a tela gira ou muda de tamanho
    window.addEventListener("resize", () => aplicarZoom());
    window.addEventListener("orientationchange", () => setTimeout(aplicarZoom, 250));

    // retoma o arquivo escolhido antes (a permissão pode ter caído: o selo avisa)
    if (temArquivoLocal()) {
      lerArquivoBackup().then((h) => { arquivoBackup = h || null; atualizarSeloBackup(); });
    }

    setInterval(tickTimes, 1000);          // tempos ao vivo
    setInterval(checkExpired, 3000);       // move sozinho quem estourou o prazo
    setInterval(atualizarEsperas, 60000);  // espera típica: recalcula a cada 1 min
    setInterval(refresh, 15000);           // rede de segurança da FILA
    setInterval(recarregarConfig, 15000);  // rede de segurança das CONFIGURAÇÕES
    // o navegador avisa quando a rede volta: nao esperamos os 15s do refresh
    window.addEventListener("online", () => { marcarSemRede(false); refresh(); });
    window.addEventListener("offline", () => marcarSemRede(true));

    // ao voltar para a tela (totem que estava em segundo plano), atualiza tudo
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") { recarregarConfig(); refresh(); }
    });
  }

  document.addEventListener("DOMContentLoaded", start);
})();
