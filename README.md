# Fila Fácil — Quinta do Aveiro

PWA (app instalável) para controlar a fila de espera de um restaurante, feito para
rodar num **totem** e no **celular da atendente** ao mesmo tempo.

- **Totem**: o cliente digita nome, telefone, nº de pessoas, escolhe Normal/Preferencial,
  marca se está **com pet** e aceita as **regras da fila**.
- **Atendente** (protegida por PIN): libera mesas, chama clientes, anota **comanda** e **pager**,
  e gerencia a fila.
- **Cliente** (`fila.html`): página só de leitura, aberta pelo **QR Code** ou por um **link no WhatsApp**,
  com a fila inteira e as mesas sendo chamadas em tempo real.
- Quando a atendente libera uma **mesa para X pessoas**, o sistema chama o próximo grupo
  de **exatamente X pessoas**, alternando **1 preferencial : 1 normal**.

---

## ⚠️ ATUALIZAÇÃO DO BANCO (rode isto uma vez)

Esta versão usa **colunas novas** na tabela `fila_espera`. Enquanto o SQL abaixo não for
rodado, o app continua funcionando, mas **sem** pet, comanda, pager e sem o tempo até sentar
no relatório (a engrenagem ⚙ avisa quais colunas estão faltando).

No painel do Supabase → **SQL Editor** → cole e rode. Pode rodar quantas vezes quiser:

```sql
alter table public.fila_espera add column if not exists pet boolean not null default false;
alter table public.fila_espera add column if not exists sem_area_pet boolean not null default false;
alter table public.fila_espera add column if not exists pedido_em timestamptz;
alter table public.fila_espera add column if not exists comanda text;
alter table public.fila_espera add column if not exists pager text;
alter table public.fila_espera add column if not exists sentou_em timestamptz;
alter table public.fila_espera add column if not exists termos_em timestamptz;
alter table public.fila_espera add column if not exists entrou_em timestamptz;
alter table public.fila_espera add column if not exists chamadas_perdidas int not null default 0;

-- hora real de chegada de quem já está na fila (quem perde a vez tem o criado_em reescrito)
update public.fila_espera set entrou_em = criado_em where entrou_em is null;
```

---

## 🟢 Dois modos de funcionamento

| Modo | Quando | Sincroniza entre aparelhos? |
|------|--------|------------------------------|
| **Local** | `config.js` sem as chaves do Supabase | ❌ Não (só o aparelho atual) |
| **Nuvem** | `config.js` com Supabase preenchido | ✅ Sim, em tempo real |

> ⚠️ O GitHub Pages só hospeda o **app** (arquivos). Ele **não guarda dados** e não
> sincroniza aparelhos. Para o totem e o celular verem a **mesma fila em tempo real**,
> é obrigatório ligar o Supabase (grátis) — veja abaixo.

---

## 🚀 Publicar no GitHub Pages

1. Suba todos os arquivos desta pasta para o repositório `Filadeespera`.
2. No GitHub: **Settings → Pages → Build and deployment → Source: `Deploy from a branch`**,
   branch `main`, pasta `/ (root)`. Salve.
3. Em ~1 minuto o app fica no ar em:
   **https://guilhermeogera-beep.github.io/Filadeespera/**
4. Abra esse link no totem e no celular. Para **instalar como app**:
   - **Android/Chrome**: botão “⬇ Instalar” ou menu → “Instalar aplicativo”.
   - **iPhone/Safari**: Compartilhar → Adicionar à Tela de Início.

---

## ☁️ Ligar o Supabase (sincronização em tempo real)

### 1. Criar as tabelas
No painel do Supabase → **SQL Editor** → cole e rode:

```sql
create table if not exists public.fila_espera (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  telefone text,
  pessoas int not null default 1,
  preferencial boolean not null default false,
  status text not null default 'aguardando',   -- aguardando | chamado | sentado | desistiu
  criado_em timestamptz not null default now(),
  chamado_em timestamptz,
  entrou_em timestamptz,                       -- hora real de chegada (não muda ao perder a vez)
  sentou_em timestamptz,                       -- quando a mesa foi ocupada (relatório)
  termos_em timestamptz,                       -- quando o cliente aceitou as regras
  pet boolean not null default false,          -- cliente está com animal de estimação
  sem_area_pet boolean not null default false, -- cliente NÃO quer sentar na área pet
  pedido_em timestamptz,                       -- quando avisamos que o pedido estava pronto
  comanda text,                                -- nº da comanda (preenchido ao chamar)
  pager text,                                  -- nº do pager (preenchido ao chamar)
  chamadas_perdidas int not null default 0     -- quantas vezes foi chamado e não compareceu
);

alter table public.fila_espera enable row level security;

-- Totem público: qualquer visitante pode ler, entrar na fila e a atendente gerenciar.
-- (o "drop policy if exists" antes permite rodar este script mais de uma vez)
drop policy if exists "fila_ler"       on public.fila_espera;
drop policy if exists "fila_inserir"   on public.fila_espera;
drop policy if exists "fila_atualizar" on public.fila_espera;
drop policy if exists "fila_apagar"    on public.fila_espera;
create policy "fila_ler"       on public.fila_espera for select using (true);
create policy "fila_inserir"   on public.fila_espera for insert with check (true);
create policy "fila_atualizar" on public.fila_espera for update using (true) with check (true);
create policy "fila_apagar"    on public.fila_espera for delete using (true);

-- Tabela de CONFIGURAÇÕES (compartilhadas entre totem e celular)
create table if not exists public.fila_config (
  id int primary key default 1,
  dados jsonb not null default '{}'::jsonb
);
insert into public.fila_config (id, dados) values (1, '{}'::jsonb) on conflict (id) do nothing;
alter table public.fila_config enable row level security;
drop policy if exists "cfg_ler"     on public.fila_config;
drop policy if exists "cfg_inserir" on public.fila_config;
drop policy if exists "cfg_gravar"  on public.fila_config;
create policy "cfg_ler"     on public.fila_config for select using (true);
create policy "cfg_inserir" on public.fila_config for insert with check (true);
create policy "cfg_gravar"  on public.fila_config for update using (true) with check (true);

-- Ativa o tempo real (só adiciona se ainda não estiver ligado — senão o Postgres
-- dá erro e cancela todo o resto do script)
do $$
begin
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'fila_espera')
  then alter publication supabase_realtime add table public.fila_espera; end if;
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'fila_config')
  then alter publication supabase_realtime add table public.fila_config; end if;
end $$;
```

### 2. Preencher o `config.js`
Em **Project Settings → API**, copie a **Project URL** e a chave **anon / publishable**
e cole em `config.js`.

> 🔒 **Segurança — leia com atenção.** As políticas acima liberam **leitura e escrita para
> qualquer pessoa que tenha o link**, inclusive apagar a fila inteira. Antes isso era aceitável
> porque só o totem interno abria o app; agora o link de acompanhamento (`fila.html`) é enviado
> aos clientes por QR Code e WhatsApp, e ele carrega a mesma chave pública.
>
> Na prática, para um restaurante, o risco é baixo (é preciso ter conhecimento técnico e vontade
> de atrapalhar), e o app já reduz o que vaza: a página do cliente só baixa nome, tamanho do
> grupo e horário — **nunca telefone, comanda ou pager** — e o PIN da atendente fica guardado
> só no aparelho dela.
>
> Se quiser fechar isso de verdade, o caminho é: criar um usuário no **Supabase Auth** para o
> balcão, fazer a área da atendente entrar com ele (hoje o PIN só esconde os botões) e restringir
> `update`/`delete` a `auth.role() = 'authenticated'`, deixando o público só com `select` em uma
> **view** anonimizada. É um trabalho à parte — peça quando quiser fazer.

> 🔑 **Sobre os PINs**: o `config.js` fica publicado junto com o site, então os valores que
> estão escritos nele (`pinAtendente` e `pinConfig`) podem ser lidos por quem abrir o arquivo.
> Troque o **PIN da atendente** pela engrenagem ⚙ no aparelho dela: o PIN digitado ali fica
> guardado **só naquele aparelho** e não é publicado nem enviado para a nuvem.
> O PIN só protege contra o cliente curioso no totem — não é uma senha de verdade.

---

## ⚙️ O que dá para configurar (engrenagem ⚙, senha `12345678`)

**Chamada das mesas**
- Tempo máximo após chamar (minutos) e se manda para o fim da fila automaticamente.
- Prioridade (1:1, 2:1, 3:1 ou preferencial sempre primeiro).
- Tipo de chamado: só tamanho exato, ou exato/menor.
- Som ao chamar.

**Mesas grandes (“mesonas”)**
- Liga/desliga a lista separada; a partir de quantas pessoas conta como mesa grande.
- **Alerta de espera**: na tela da atendente a mesa grande vai de **verde a vermelho**
  conforme se aproxima desse tempo — para priorizar quem é mais difícil de encaixar.
- A ordem de chamada **não muda**: elas continuam sendo chamadas na ordem de chegada.

**Entrada na fila (totem)**
- Telefone obrigatório ou opcional.
- Pedir (ou não) o aceite das **regras da fila**, com o texto editável — o padrão já avisa
  sobre o prazo de comparecimento e a regra dos **50% do grupo presente**, além da LGPD.
- Perguntar se está **com pet**.
- Mostrar ou ocultar o **tempo médio de espera** no totem (na aba da atendente aparece sempre).
- Mensagem de boas-vindas e máximo de pessoas por grupo.

**Fechamento automático da fila**
- Fecha a fila sozinha ao chegar em X pessoas aguardando. Para reabrir é **sempre manual** —
  e ela só volta a fechar sozinha depois que a fila baixar do limite.

**Comanda, pager e WhatsApp**
- Mostrar/ocultar os campos de comanda e pager no pop-up de chamada.
- Aviso de mesa pronta pelo WhatsApp e mensagem do link de acompanhamento.

**📊 Relatório** (botão dentro da engrenagem)
- Filtro por período (hoje / 7 / 30 dias / tudo), resumo com médias e tabela completa.
- **⬇ Exportar CSV** (abre no Excel) e **🗑 Limpar dados** (apaga só os atendimentos
  já finalizados; quem está na fila nunca é apagado).

---

## 🔗 Página do cliente (`fila.html`)

- Ao entrar na fila, aparece um pop-up com a **posição**, um **QR Code** e o botão
  **📲 Enviar link no WhatsApp**.
- A página mostra **tudo junto na ordem de chegada** (preferencial, normal e mesas grandes),
  as mesas sendo chamadas e, para quem abriu o próprio link, um cartão grande com a sua posição
  (que vira “🔔 É a sua vez!” quando é chamado).
- É só leitura: o cliente não consegue mexer na fila.
- Para deixar um QR fixo no balcão, use ⚙ → **🔗 Página do cliente**.

---

## 📁 Arquivos

```
index.html            Totem + área da atendente
fila.html             Página pública de acompanhamento (só leitura)
styles.css            Visual (paleta azul/teal da marca)
app.js                Lógica (fila, chamadas, relatório, tempo real, PWA)
fila.js               Lógica da página pública
qr.js                 Gerador de QR Code (sem bibliotecas externas)
config.js             Configurações iniciais + chaves do Supabase
manifest.webmanifest  Dados do PWA (instalação)
sw.js                 Service worker (cache do app / offline)
icons/                Ícones do app
```
