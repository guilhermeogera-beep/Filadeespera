// =====================================================================
//  CONFIGURAÇÃO DA FILA DE ESPERA — Quinta do Aveiro
// =====================================================================
//
//  Estes são os valores INICIAIS (de fábrica). Depois que a atendente
//  salvar as configurações na engrenagem ⚙, o que vale é o que está
//  guardado na nuvem (tabela `fila_config`) — igual em todos os aparelhos.
//
//  Enquanto os campos do Supabase estiverem VAZIOS, o app roda em MODO
//  LOCAL (a fila fica guardada só neste aparelho — ótimo para testar).
// =====================================================================

// Texto padrão das REGRAS DA FILA (o cliente precisa aceitar no totem).
// Pode ser reescrito na engrenagem ⚙ → "Texto das regras".
window.TERMOS_PADRAO =
`Ao entrar na fila de espera do {restaurante}, você concorda com as regras abaixo:

1. CHAMADA E PRAZO DE {prazo} MINUTOS — Quando a sua mesa estiver pronta, você será chamado(a) pelo nome no painel. É necessário comparecer à recepção em até {prazo} minutos. Passado esse prazo, o seu nome volta para o fim da fila.

2. GRUPO PRESENTE (50%) — Para ocupar a mesa, pelo menos metade (50%) das pessoas do seu grupo precisa estar presente no local no momento da chamada. Não é permitido ocupar a mesa e aguardar o restante do grupo.

3. TAMANHO DO GRUPO — As mesas são liberadas de acordo com o número de pessoas informado na entrada. Se o grupo aumentar, será necessário aguardar uma mesa compatível, o que pode alterar a sua posição e o tempo de espera.

4. TEMPO DE ESPERA — O tempo informado é apenas uma estimativa e pode variar conforme a rotatividade das mesas, o tamanho do grupo e a preferência legal (idosos, gestantes, pessoas com deficiência e crianças de colo).

5. AUSÊNCIA E DESISTÊNCIA — O não comparecimento após a chamada pode levar à perda da vez ou à retirada do seu nome da fila. Se desistir, avise a recepção.

6. USO DOS SEUS DADOS (LGPD) — O nome e o telefone informados serão usados apenas para organizar a fila e avisar sobre a sua mesa, conforme a Lei nº 13.709/2018 (LGPD). Os dados não são vendidos nem usados para propaganda sem a sua autorização, e você pode pedir a exclusão a qualquer momento na recepção.

Ao marcar "Li e concordo", você declara estar ciente e de acordo com estas regras.`;

window.FILA_CONFIG = {
  // Marca do produto (mostrada em destaque no topo)
  marca: "Fila Fácil",

  // Estabelecimento (mostrado como subtítulo)
  restaurante: "Quinta do Aveiro",

  // ATENÇÃO: este arquivo vai para o ar junto com o app. Qualquer pessoa que
  // abra o endereço consegue ler tudo o que está escrito aqui — por isso não
  // guardamos nenhuma senha nele. Quem protege as abas hoje é o LOGIN POR
  // PERFIL (loginAtivo, mais abaixo), que confere a senha no servidor.
  //
  // Os PINs abaixo só entram em cena se você DESLIGAR o login. Nesse caso,
  // defina-os na própria engrenagem (⚙ -> Equipe e acesso): ficam guardados
  // no aparelho, sem passar por este arquivo. Vazio = abre sem PIN.
  pinAtendente: "",
  pinConfig: "",

  // --- Chamada das mesas ---
  regraTamanho: "exato",  // "exato" = só chama grupos com o número exato de lugares
  alternancia: "1:1",     // 1 preferencial, depois 1 normal...
  prazoComparecer: 5,     // minutos para o cliente comparecer antes de perder a vez
  autoFimDaFila: true,    // true = ao estourar o prazo, manda sozinho para o fim da fila
  somAtivo: true,         // som/beep quando alguém é chamado

  // --- Mesas grandes ("mesonas") ---
  mesonaAtiva: true,      // mostra os grupos grandes numa lista separada
  mesonaMin: 8,           // a partir de quantas pessoas é "mesa grande"
  mesonaPrazo: 20,        // minutos: na tela da atendente vai de verde a vermelho até esse tempo

  // --- Alerta de espera das outras filas (0 = não colorir) ---
  prefPrazo: 0,           // minutos até a fila PREFERENCIAL ficar vermelha
  normalPrazo: 0,         // minutos até a fila NORMAL ficar vermelha
  totemEntrada: true,     // mostra o botão "Entrar na fila" no totem
  obsMesa: true,          // campo "Observação" no pop-up de lançar mesa (garçom)
  sentadosMax: 10,        // quantos aparecem na aba "Na mesa"
  pedidoPainelMin: 10,     // minutos que o "pedido pronto" fica à mostra (totem, atendente e link do cliente)
  resumoAlerta: 30,       // minutos até o grupo ficar destacado na fila do garçom

  // --- Entrada na fila (totem) ---
  telObrigatorio: true,   // exige telefone para entrar na fila
  exigirTermos: true,     // exige aceitar as regras (termos) no totem
  termosTexto: "",        // vazio = usa o TERMOS_PADRAO acima
  petAtivo: true,         // mostra a opção "estou com pet" no totem
  campoSemPet: true,      // mostra "não sentar na área pet" (alergia/receio de animais)
  campoEmail: "nao",      // "nao" | "opcional" | "obrigatorio" — pede o e-mail do cliente
  campoAniversario: "nao", // "nao" | "opcional" | "obrigatorio" — pede dia e mês de aniversário
  filasColunas: true,   // true = filas lado a lado na tela da atendente
  filasJuntas: true,      // true = totem e página do cliente mostram TUDO numa lista só
                          // (a atendente vê sempre separado: mesas grandes / preferencial / normal)
  mostrarHoraEntrada: true, // mostra "entrou HH:MM" no totem e na página do cliente
  mostrarTempoEspera: true, // mostra "esperando há X" no totem e na página do cliente
  mostrarMedia: true,     // mostra o tempo médio de espera no TOTEM (na atendente aparece sempre)
  maxPessoas: 20,         // máximo de pessoas por grupo

  // Tamanhos de mesa da casa: viram os botões do pop-up "Chamar próxima mesa".
  // Dá para mudar pela engrenagem, sem mexer neste arquivo.
  tamanhosMesa: [2, 4, 6, 8],

  // Tamanhos de grupo mais comuns: viram os botões de "Quantas pessoas?"
  // na entrada da fila. Também dá para mudar pela engrenagem.
  tamanhosGrupo: [1, 2, 3, 4, 5, 6],

  // Mapa do salão: dá para ocultar por perfil (o cadastro continua na engrenagem)
  mapaGarcom: true,
  mapaAdm: true,
  mapaAtendente: true,   // aba "Mapa" (só consulta) para a atendente

  // Formato da planta do salão: largura ÷ altura (1.5 = 3 por 2)
  mapaProporcao: 1.5,

  // O garçom precisa informar o número da mesa ao liberar?
  mesaNumObrigatorio: true,

  // Janela em que o garçom enxerga o botão "liberar todas as mesas"
  // (fora dela o botão some para ele; para o adm fica sempre visível)
  liberarAte: "11:00",
  liberarVolta: "17:00",

  // Botão "Chamar mesa" na barra de baixo da atendente
  mostrarBtnChamar: true,
  boasVindas: "",         // mensagem de boas-vindas no topo do totem (vazio = escondido)

  // --- Fechamento da fila ---
  filaFechada: false,     // true = pausa novas entradas no totem
  mostrarBtnFila: true,   // mostra o botão de abrir/fechar fila no cabeçalho da atendente
  autoFecharAtiva: false, // fecha a fila sozinha quando encher
  autoFecharQtd: 30,      // ... ao chegar nesta quantidade de pessoas aguardando
  autoFecharArmado: true, // controle interno: só fecha de novo depois de esvaziar

  // --- Comanda e pager (a atendente preenche ao adicionar e ao chamar) ---
  campoComanda: true,
  campoPager: true,

  // --- Aviso via WhatsApp (grátis, com 1 toque) ---
  paisDDI: "55",          // código do país (Brasil = 55)
  whatsAtivo: true,       // false = não usa WhatsApp (some o botão e o envio)
  whatsAuto: true,        // true = ao confirmar a chamada, abre o WhatsApp já com a mensagem
  linkAtivo: true,        // oferece o link/QR de acompanhamento ao entrar na fila
  msgWhats: "Olá {nome}! Sua mesa na {restaurante} está pronta 🍽️ Por favor, compareça à recepção em até {prazo} minutos para não perder a vez. Obrigado!",
  msgLink: "Olá {nome}! Você entrou na fila da {restaurante} 🍽️ Sua posição no momento: {posicao}. Acompanhe a fila em tempo real por aqui: {link}",

  // --- LOGIN por perfil (adm / atendente / garçom) ---
  // false = app funciona como sempre (com os PINs). Só ligue DEPOIS de criar
  // os usuários no Supabase e testar a entrada — veja o README.
  loginAtivo: true,

  // A equipe digita só "atendente", "garcom" ou "adm". O app completa com o
  // domínio abaixo para formar o e-mail que o Supabase exige.
  //   atendente  ->  atendente@filafacil.local
  dominioLogin: "filafacil.local",

  // Final acrescentado à senha digitada. Vazio = a senha vai como foi digitada
  // (é o caso aqui: as contas foram criadas com a senha inteira no painel).
  // Só serve se um dia você quiser senhas curtas na tela: com "-filafacil",
  // quem digita "4321" envia "4321-filafacil" (o Supabase exige 6+ caracteres).
  sufixoSenha: "",

  // --- Aba do GARÇOM (lança as mesas que vagaram) ---
  garcomAtivo: true,      // mostra a aba "Garçom" e o painel de mesas livres
  pinGarcom: "",          // veja a observação sobre PINs no topo do arquivo

  // --- Aviso de "pedido pronto" (botão na aba da atendente) ---
  previaWhats: true,      // abrir o WhatsApp ao avisar que abriu vaga (fila da fila)
  avisoPedido: true,      // mostra o botão "🍽 Pedido pronto" junto de Chamar/Sentou/Saiu
  msgPedido: "Olá {nome}! Seu pedido na {restaurante} está pronto 🍽️ Pode retirar no balcão quando quiser. Bom apetite!",

  // --- Preencher para ativar o modo nuvem (Supabase) ---
  pushChavePublica: "BK_poMjebMFL7wkUsMzNJhGf4cXOuUlGG8Ph11qlKUFoU4x95u8cat1yE-s0Xn08lDpR9bVKm0IFBxI-_V2VMAA",
  supabaseUrl: "https://xmnrzjuvgegfdalbgpwb.supabase.co",
  supabaseAnonKey: "sb_publishable_egn2eVf5KSLsPRfHiKgkiQ_jJTvnNZY",
};
