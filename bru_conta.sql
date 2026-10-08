-- B.R.U · Contabilidad: tabla única de documentos contables (no permite borrar desde la página)
create table if not exists public.bru_conta (
  id text primary key,
  tipo text not null,
  fecha date,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists bru_conta_tipo_idx on public.bru_conta (tipo);
alter table public.bru_conta enable row level security;
drop policy if exists bru_conta_leer on public.bru_conta;
drop policy if exists bru_conta_crear on public.bru_conta;
drop policy if exists bru_conta_editar on public.bru_conta;
create policy bru_conta_leer on public.bru_conta for select to anon, authenticated using (true);
create policy bru_conta_crear on public.bru_conta for insert to anon, authenticated with check (true);
create policy bru_conta_editar on public.bru_conta for update to anon, authenticated using (true) with check (true);
grant select, insert, update on public.bru_conta to anon, authenticated;
