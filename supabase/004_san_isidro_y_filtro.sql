-- Ejecutar en Supabase SQL Editor.
-- Repara la asignación de San Isidro y garantiza las cuatro opciones de filtro.
-- No elimina usuarios ni trabajos.

insert into public.sucursales (nombre) values
  ('Mega Centro'),
  ('Romana'),
  ('San Isidro'),
  ('Plaza Lama')
on conflict (nombre) do update set activa = true;

insert into public.opciones (tipo, valor, activa) values
  ('sucursal', 'Mega Centro', true),
  ('sucursal', 'Romana', true),
  ('sucursal', 'San Isidro', true),
  ('sucursal', 'Plaza Lama', true)
on conflict (tipo, valor) do update set activa = true;

create or replace function public.id_sucursal_por_nombre(p_nombre text)
returns uuid language sql security definer set search_path = public stable as $$
  select s.id
  from public.sucursales s
  where regexp_replace(lower(unaccent(trim(s.nombre))), '[^a-z0-9]+', '', 'g') =
        regexp_replace(lower(unaccent(trim(coalesce(p_nombre, '')))), '[^a-z0-9]+', '', 'g')
  limit 1;
$$;

-- Evita que un trabajo nuevo o editado quede ligado a otra sucursal.
-- La sucursal escrita se normaliza y su sucursal_id se actualiza automáticamente.
create or replace function public.sincronizar_sucursal_trabajo()
returns trigger language plpgsql security definer set search_path = public as $$
declare destino_id uuid; destino_nombre text;
begin
  destino_id := public.id_sucursal_por_nombre(new.sucursal);
  if destino_id is null then
    raise exception 'Sucursal no válida. Seleccione Mega Centro, Romana, San Isidro o Plaza Lama';
  end if;
  select nombre into destino_nombre from public.sucursales where id = destino_id;
  new.sucursal := destino_nombre;
  new.sucursal_id := destino_id;
  return new;
end $$;

drop trigger if exists a_sincronizar_sucursal_trabajo on public.trabajos;
create trigger a_sincronizar_sucursal_trabajo
before insert or update of sucursal on public.trabajos
for each row execute function public.sincronizar_sucursal_trabajo();

-- Acepta las variantes antiguas San Isidro y Sam Isidro.
update public.trabajos
set sucursal = 'San Isidro'
where regexp_replace(lower(unaccent(trim(sucursal))), '[^a-z0-9]+', '', 'g')
      in ('sanisidro', 'samisidro');

update public.trabajos t
set sucursal_id = public.id_sucursal_por_nombre(t.sucursal)
where public.id_sucursal_por_nombre(t.sucursal) is not null
  and t.sucursal_id is distinct from public.id_sucursal_por_nombre(t.sucursal);

insert into public.permisos (codigo, descripcion)
values ('trabajos.recibir', 'Confirmar recepción de trabajos en su sucursal')
on conflict (codigo) do nothing;

insert into public.rol_permisos (rol, permiso) values
  ('administrativo', 'trabajos.recibir'),
  ('laboratorio', 'trabajos.recibir'),
  ('ventas', 'trabajos.recibir')
on conflict do nothing;

-- Diagnóstico final: debe devolver 0 trabajos sin sucursal y mostrar las 4 sucursales.
select
  s.nombre as sucursal,
  count(t.id) as trabajos_asignados
from public.sucursales s
left join public.trabajos t on t.sucursal_id = s.id
where s.nombre in ('Mega Centro', 'Romana', 'San Isidro', 'Plaza Lama')
group by s.nombre
order by s.nombre;
