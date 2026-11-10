-- OPCIONAL · Columnas de envío y guía para bru_pedidos
-- La tienda ya guarda el envío (contra entrega) dentro de "notas", así que los
-- pedidos llegan completos al dashboard aunque no corras esto. Correrlo agrega
-- columnas propias para el envío y hace que el N° de guía / link de rastreo
-- que escribes en el dashboard quede guardado en la nube.
-- Supabase → SQL Editor → pegar y Run. No borra ni cambia datos existentes.
alter table public.bru_pedidos add column if not exists envio numeric default 0;
alter table public.bru_pedidos add column if not exists "envioZona" text;
alter table public.bru_pedidos add column if not exists "envioModo" text;
alter table public.bru_pedidos add column if not exists guia text;
alter table public.bru_pedidos add column if not exists guia_url text;
notify pgrst, 'reload schema';
