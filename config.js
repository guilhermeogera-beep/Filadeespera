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

  // Regra de chamada: "exato" = só chama grupos com o número exato de lugares
  regraTamanho: "exato",

  // Alternância preferencial/normal: chama 1 preferencial, depois 1 normal...
  alternancia: "1:1",

  // --- Preencher para ativar o modo nuvem (Supabase) ---
  supabaseUrl: "https://xmnrzjuvgegfdalbgpwb.supabase.co",
  supabaseAnonKey: "sb_publishable_egn2eVf5KSLsPRfHiKgkiQ_jJTvnNZY",
};
