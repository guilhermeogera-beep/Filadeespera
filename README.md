# Fila Fácil — Quinta do Aveiro

PWA (app instalável) para controlar a fila de espera de um restaurante, feito para
rodar num **totem** e no **celular da atendente** ao mesmo tempo.

- **Totem**: o cliente digita nome, telefone, nº de pessoas e escolhe Normal/Preferencial.
- **Atendente** (protegida por PIN): libera mesas, chama clientes e gerencia a fila.
- Quando a atendente libera uma **mesa para X pessoas**, o sistema chama o próximo grupo
  de **exatamente X pessoas**, alternando **1 preferencial : 1 normal**.
- A tela mostra a **ordem** da fila e o **tempo de espera ao vivo** de cada pessoa.

---

## 🟢 Dois modos de funcionamento

| Modo | Quando | Sincroniza entre aparelhos? |
|------|--------|------------------------------|
| **Local** | `config.js` sem as chaves do Supabase | ❌ Não (só o aparelho atual) |
| **Nuvem** | `config.js` com Supabase preenchido | ✅ Sim, em tempo real |

> ⚠️ O GitHub Pages só hospeda o **app** (arquivos). Ele **não guarda dados** e não
> sincroniza aparelhos. Para o totem e o celular verem a **mesma fila em tempo real**,
> é obrigatório ligar o Supabase (grátis) — veja abaixo. Sem isso, cada aparelho tem a
> sua própria fila separada.

---

## 🚀 Publicar no GitHub Pages

1. Suba todos os arquivos desta pasta para o repositório `Filadeespera`.
2. No GitHub: **Settings → Pages → Build and deployment → Source: `Deploy from a branch`**,
   branch `main`, pasta `/ (root)`. Salve.
3. Em ~1 minuto o app fica no ar em:
   **https://guilhermeogera-beep.github.io/Filadeespera/**
4. Abra esse link no totem e no celular. Para **instalar como app**:
   - **Android/Chrome**: botão “⬇ Instalar app” ou menu → “Instalar aplicativo”.
   - **iPhone/Safari**: botão “Como instalar no iPhone?” (Compartilhar → Adicionar à Tela de Início).

---

## ☁️ Ligar o Supabase (sincronização em tempo real)

### 1. Criar a tabela
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
  chamadas_perdidas int not null default 0     -- quantas vezes foi chamado e não compareceu
);

alter table public.fila_espera enable row level security;

-- Totem público: qualquer visitante pode ler, entrar na fila e a atendente gerenciar.
create policy "fila_ler"      on public.fila_espera for select using (true);
create policy "fila_inserir"  on public.fila_espera for insert with check (true);
create policy "fila_atualizar" on public.fila_espera for update using (true) with check (true);
create policy "fila_apagar"   on public.fila_espera for delete using (true);

-- Ativa o tempo real
alter publication supabase_realtime add table public.fila_espera;

-- Tabela de CONFIGURAÇÕES (compartilhadas entre totem e celular)
create table if not exists public.fila_config (
  id int primary key default 1,
  dados jsonb not null default '{}'::jsonb
);
insert into public.fila_config (id, dados) values (1, '{}'::jsonb) on conflict (id) do nothing;
alter table public.fila_config enable row level security;
create policy "cfg_ler"     on public.fila_config for select using (true);
create policy "cfg_inserir" on public.fila_config for insert with check (true);
create policy "cfg_gravar"  on public.fila_config for update using (true) with check (true);
alter publication supabase_realtime add table public.fila_config;
```

### 2. Preencher o `config.js`
Em **Project Settings → API**, copie a **Project URL** e a chave **anon / publishable**
e cole em `config.js`:

```js
supabaseUrl: "https://SEUPROJETO.supabase.co",
supabaseAnonKey: "eyJhbGci...",   // chave anon (pode ficar pública)
```

Salve, dê `commit`/`push`. Pronto: o topo do app passa de **“● Local”** para **“● Nuvem”**
e o totem + celular ficam sincronizados.

> 🔒 **Segurança**: as políticas acima liberam edição para qualquer pessoa com o link
> (adequado a um totem interno de restaurante). Para restringir os controles da atendente,
> dá para usar Supabase Auth depois — a área da atendente já é protegida por PIN no app.

---

## ⚙️ Configurações (`config.js`)

| Campo | O que faz |
|-------|-----------|
| `marca` | Nome em destaque no topo (“Fila Fácil”) |
| `restaurante` | Subtítulo (“Quinta do Aveiro”) |
| `pinAtendente` | PIN para abrir a área da atendente (padrão `4321`) |
| `regraTamanho` | `"exato"` = chama só grupos do tamanho exato da mesa |
| `alternancia` | `"1:1"` (1 pref : 1 normal), `"2:1"` ou `"pref"` (preferencial sempre 1º) |
| `supabaseUrl` / `supabaseAnonKey` | Ativam o modo nuvem |

---

## 🧪 Testar no computador (sem publicar)

Basta abrir o `index.html` no navegador (modo local). Para testar o comportamento de
app instalável/Service Worker, use um servidor local em `http://localhost`.

## 📁 Arquivos

```
index.html            Estrutura da página
styles.css            Visual (paleta azul/teal da marca)
app.js                Lógica (fila, chamadas, tempo real, PWA)
config.js             Configurações + chaves do Supabase
manifest.webmanifest  Dados do PWA (instalação)
sw.js                 Service worker (cache do app / offline)
icons/                Ícones do app
```
