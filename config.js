// =====================================================================
//  CONFIGURAÇÃO DA FILA DE ESPERA — Quinta do Aveiro
// =====================================================================
//
//  Enquanto os campos abaixo estiverem VAZIOS, o app roda em MODO LOCAL
//  (a fila fica guardada só neste aparelho/navegador — ótimo para testar).
//
//  Para ligar a SINCRONIZAÇÃO entre o totem e o celular da atendente,
//  preencha as duas chaves do seu projeto Supabase:
//
//    supabaseUrl      -> URL do projeto  (ex.: https://xxxx.supabase.co)
//    supabaseAnonKey  -> chave "anon/publishable" (pode ficar pública)
//
//  Depois de preencher, salve, dê commit/push no GitHub e pronto:
//  o app passa automaticamente para o MODO NUVEM (tempo real).
// =====================================================================

window.FILA_CONFIG = {
  // Marca do produto (mostrada em destaque no topo)
  marca: "Fila Fácil",

  // Estabelecimento (mostrado como subtítulo)
  restaurante: "Quinta do Aveiro",

  // PIN para desbloquear a área da ATENDENTE (troque para o que quiser)
  pinAtendente: "4321",

  // Senha para abrir as CONFIGURAÇÕES (pedida toda vez que clicar na engrenagem)
  pinConfig: "12345678",

  // Regra de chamada: "exato" = só chama grupos com o número exato de lugares
  regraTamanho: "exato",

  // Alternância preferencial/normal: chama 1 preferencial, depois 1 normal...
  alternancia: "1:1",

  // --- Aviso via WhatsApp (grátis, com 1 toque) ---
  paisDDI: "55",          // código do país (Brasil = 55)
  whatsAtivo: true,       // false = não usa WhatsApp (some o botão e o envio)
  whatsAuto: true,        // true = ao confirmar a chamada, abre o WhatsApp já com a mensagem
  prazoComparecer: 5,     // minutos para o cliente comparecer antes de perder a vez
  autoFimDaFila: true,    // true = ao estourar o prazo, manda sozinho para o fim da fila
  somAtivo: true,         // som/beep quando alguém é chamado
  filaFechada: false,     // true = pausa novas entradas no totem (fila fechada)
  mostrarBtnFila: true,   // mostra o botão de abrir/fechar fila no cabeçalho da atendente
  maxPessoas: 20,         // máximo de pessoas por grupo
  boasVindas: "",         // mensagem de boas-vindas no topo do totem (vazio = escondido)
  msgWhats: "Olá {nome}! Sua mesa na {restaurante} está pronta 🍽️ Por favor, compareça à recepção em até {prazo} minutos para não perder a vez. Obrigado!",

  // --- Preencher para ativar o modo nuvem (Supabase) ---
  supabaseUrl: "https://xmnrzjuvgegfdalbgpwb.supabase.co",
  supabaseAnonKey: "sb_publishable_egn2eVf5KSLsPRfHiKgkiQ_jJTvnNZY",
};
