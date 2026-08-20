-- =====================================================================
--  FILA FÁCIL — Quinta do Aveiro
--  BANCO DE DADOS COMPLETO (Supabase / PostgreSQL)
-- =====================================================================
--
--  COMO USAR: abra o painel do Supabase -> SQL Editor -> New query,
--  cole ESTE ARQUIVO INTEIRO e clique em RUN.
--
--  Pode rodar quantas vezes quiser, em qualquer situação:
--    - banco vazio        -> cria tudo do zero
--    - banco já em uso    -> só acrescenta o que falta
--  NENHUM dado da fila é apagado por este script.
--
--  Ao terminar, o último comando mostra uma tabelinha de conferência
--  dizendo se está tudo certo.
-- =====================================================================


-- ---------------------------------------------------------------------
--  1. FILA DE ESPERA (os clientes)
-- ---------------------------------------------------------------------
create table if not exists public.fila_espera (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  telefone text,
  pessoas int not null default 1,
  preferencial boolean not null default false,
  status text not null default 'aguardando',   -- aguardando | chamado | sentado | desistiu
  criado_em timestamptz not null default now(),
  chamado_em timestamptz
);

-- Colunas acrescentadas nas versões novas do app.
-- (se a tabela já existir sem elas, estas linhas completam)
alter table public.fila_espera add column if not exists entrou_em         timestamptz;
alter table public.fila_espera add column if not exists sentou_em         timestamptz;
alter table public.fila_espera add column if not exists termos_em         timestamptz;
alter table public.fila_espera add column if not exists pedido_em         timestamptz;
alter table public.fila_espera add column if not exists pet               boolean not null default false;
alter table public.fila_espera add column if not exists sem_area_pet      boolean not null default false;
alter table public.fila_espera add column if not exists comanda           text;
alter table public.fila_espera add column if not exists pager             text;
alter table public.fila_espera add column if not exists mesa_numero       text;
alter table public.fila_espera add column if not exists chamadas_perdidas int not null default 0;

-- Quem já estava na fila não tinha "entrou_em": copia da data de criação.
-- (o criado_em é reescrito quando alguém perde a vez; o entrou_em guarda a
--  hora REAL de chegada, usada no relatório e na média de espera)
update public.fila_espera set entrou_em = criado_em where entrou_em is null;


-- ---------------------------------------------------------------------
--  2. CONFIGURAÇÕES (a engrenagem ⚙, compartilhada entre os aparelhos)
-- ---------------------------------------------------------------------
create table if not exists public.fila_config (
  id int primary key default 1,
  dados jsonb not null default '{}'::jsonb
);

insert into public.fila_config (id, dados)
values (1, '{}'::jsonb)
on conflict (id) do nothing;


-- ---------------------------------------------------------------------
--  3. MESAS LIVRES (o garçom avisa quais mesas vagaram)
-- ---------------------------------------------------------------------
create table if not exists public.mesas_livres (
  id uuid primary key default gen_random_uuid(),
  lugares int not null default 2,
  pet boolean not null default false,          -- mesa fica na área que aceita animais
  identificacao text,                          -- nº ou nome da mesa (opcional)
  numeros text,                                -- números das mesas juntadas (ex.: "12 + 13")
  status text not null default 'livre',        -- livre | usada
  criado_em timestamptz not null default now(),
  usada_em timestamptz
);

-- (para quem já tinha criado a tabela numa versão anterior)
alter table public.mesas_livres add column if not exists numeros text;


-- ---------------------------------------------------------------------
--  4. ÍNDICES (deixam as consultas do app rápidas)
-- ---------------------------------------------------------------------
create index if not exists fila_espera_status_idx  on public.fila_espera (status);
create index if not exists fila_espera_criado_idx  on public.fila_espera (criado_em desc);
create index if not exists mesas_livres_status_idx on public.mesas_livres (status);
create index if not exists mesas_livres_criado_idx on public.mesas_livres (criado_em desc);


-- ---------------------------------------------------------------------
--  5. PERMISSÕES DE ACESSO (RLS)
-- ---------------------------------------------------------------------
--  ATENÇÃO: como está aqui, QUALQUER PESSOA com o endereço do app pode ler
--  e alterar os dados — inclusive apagar a fila. É o mínimo para o totem
--  funcionar sem login. Para fechar isso de verdade é preciso criar um
--  usuário no Supabase Auth para o balcão (conversamos sobre isso).
--
--  O "drop policy if exists" antes de cada regra é o que permite rodar
--  este arquivo mais de uma vez sem dar erro.

alter table public.fila_espera  enable row level security;
alter table public.fila_config  enable row level security;
alter table public.mesas_livres enable row level security;

-- fila de espera
drop policy if exists "fila_ler"       on public.fila_espera;
drop policy if exists "fila_inserir"   on public.fila_espera;
drop policy if exists "fila_atualizar" on public.fila_espera;
drop policy if exists "fila_apagar"    on public.fila_espera;
create policy "fila_ler"       on public.fila_espera for select using (true);
create policy "fila_inserir"   on public.fila_espera for insert with check (true);
create policy "fila_atualizar" on public.fila_espera for update using (true) with check (true);
create policy "fila_apagar"    on public.fila_espera for delete using (true);

-- configurações
drop policy if exists "cfg_ler"     on public.fila_config;
drop policy if exists "cfg_inserir" on public.fila_config;
drop policy if exists "cfg_gravar"  on public.fila_config;
create policy "cfg_ler"     on public.fila_config for select using (true);
create policy "cfg_inserir" on public.fila_config for insert with check (true);
create policy "cfg_gravar"  on public.fila_config for update using (true) with check (true);

-- mesas livres
drop policy if exists "mesas_ler"       on public.mesas_livres;
drop policy if exists "mesas_inserir"   on public.mesas_livres;
drop policy if exists "mesas_atualizar" on public.mesas_livres;
drop policy if exists "mesas_apagar"    on public.mesas_livres;
create policy "mesas_ler"       on public.mesas_livres for select using (true);
create policy "mesas_inserir"   on public.mesas_livres for insert with check (true);
create policy "mesas_atualizar" on public.mesas_livres for update using (true) with check (true);
create policy "mesas_apagar"    on public.mesas_livres for delete using (true);


-- ---------------------------------------------------------------------
--  6. TEMPO REAL (é o que sincroniza totem, atendente e garçom na hora)
-- ---------------------------------------------------------------------
--  Só adiciona a tabela se ela ainda não estiver na publicação: repetir
--  um "alter publication ... add table" dá erro e cancelaria o script.
do $$
begin
  -- a publicação já vem pronta no Supabase, mas se faltar, criamos
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;

  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public'
                   and tablename = 'fila_espera')
  then alter publication supabase_realtime add table public.fila_espera; end if;

  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public'
                   and tablename = 'fila_config')
  then alter publication supabase_realtime add table public.fila_config; end if;

  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public'
                   and tablename = 'mesas_livres')
  then alter publication supabase_realtime add table public.mesas_livres; end if;

exception when others then
  -- se esta parte falhar, o resto do banco já está pronto: dá para ligar o
  -- tempo real na mão em Database > Replication (a conferência abaixo avisa)
  raise notice 'Não deu para configurar o tempo real automaticamente: %', sqlerrm;
end $$;


-- =====================================================================
--  CONFERÊNCIA — o resultado desta consulta deve vir tudo "OK"
-- =====================================================================
select
  item,
  case when ok then '✅ OK' else '❌ FALTOU' end as situacao
from (
  select 'tabela fila_espera' as item,
         to_regclass('public.fila_espera') is not null as ok
  union all
  select 'tabela fila_config',
         to_regclass('public.fila_config') is not null
  union all
  select 'tabela mesas_livres',
         to_regclass('public.mesas_livres') is not null
  union all
  select 'colunas novas da fila (10)',
         (select count(*) from information_schema.columns
           where table_schema = 'public' and table_name = 'fila_espera'
             and column_name in ('entrou_em','sentou_em','termos_em','pedido_em','mesa_numero',
                                 'pet','sem_area_pet','comanda','pager','chamadas_perdidas')) = 10
  union all
  select 'colunas das mesas (8)',
         (select count(*) from information_schema.columns
           where table_schema = 'public' and table_name = 'mesas_livres'
             and column_name in ('id','lugares','pet','identificacao','numeros',
                                 'status','criado_em','usada_em')) = 8
  union all
  select 'linha de configuração (id=1)',
         exists (select 1 from public.fila_config where id = 1)
  union all
  select 'permissões da fila (4)',
         (select count(*) from pg_policies
           where schemaname = 'public' and tablename = 'fila_espera') >= 4
  union all
  select 'permissões da config (3)',
         (select count(*) from pg_policies
           where schemaname = 'public' and tablename = 'fila_config') >= 3
  union all
  select 'permissões das mesas (4)',
         (select count(*) from pg_policies
           where schemaname = 'public' and tablename = 'mesas_livres') >= 4
  union all
  select 'tempo real ligado (3 tabelas)',
         (select count(*) from pg_publication_tables
           where pubname = 'supabase_realtime' and schemaname = 'public'
             and tablename in ('fila_espera','fila_config','mesas_livres')) = 3
) t
order by ok, item;
