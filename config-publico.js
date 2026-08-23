// =====================================================================
//  CONFIGURAÇÃO PÚBLICA — usada só pela página do cliente (fila.html)
// =====================================================================
//
//  Esta página é aberta por QUALQUER PESSOA que receber o QR Code ou o
//  link no WhatsApp. Por isso ela NÃO carrega o `config.js` do app:
//  aquele arquivo tem os PINs e outros ajustes internos.
//
//  Aqui fica só o mínimo para a página funcionar. O resto (nome do
//  restaurante, se mostra a média, mesas grandes...) vem da nuvem.
//
//  ⚠ Se um dia você trocar a chave do Supabase no `config.js`,
//     troque também aqui — são os mesmos dois valores.
// =====================================================================

window.FILA_CONFIG = {
  marca: "Fila Fácil",
  restaurante: "Quinta do Aveiro",

  // Chave PÚBLICA das notificações (pode ficar à vista: é ela que o celular
  // usa para aceitar avisos deste site). A chave privada fica só no Supabase.
  pushChavePublica: "BK_poMjebMFL7wkUsMzNJhGf4cXOuUlGG8Ph11qlKUFoU4x95u8cat1yE-s0Xn08lDpR9bVKm0IFBxI-_V2VMAA",

  supabaseUrl: "https://xmnrzjuvgegfdalbgpwb.supabase.co",
  supabaseAnonKey: "sb_publishable_egn2eVf5KSLsPRfHiKgkiQ_jJTvnNZY",
};
