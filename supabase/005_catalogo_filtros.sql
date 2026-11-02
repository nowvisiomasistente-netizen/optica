-- Ejecutar en Supabase SQL Editor.
-- Garantiza que el catálogo de filtros incluya las cuatro sucursales.
insert into public.opciones (tipo, valor, activa) values
  ('sucursal', 'Mega Centro', true),
  ('sucursal', 'Romana', true),
  ('sucursal', 'Sam Isidro', true),
  ('sucursal', 'Plaza Lama', true)
on conflict (tipo, valor) do update set activa = true;

update public.opciones
set activa = false
where tipo = 'sucursal'
  and valor = 'San Isidro';
