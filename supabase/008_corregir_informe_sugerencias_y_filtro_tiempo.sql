-- Ejecutar completo en Supabase: SQL Editor > New query > Run.
-- Corrige la persistencia de sugerencias, el informe crítico y añade
-- el filtro Estado tiempo directamente desde la base de datos.

alter table public.trabajos
  add column if not exists recibido_en_sucursal timestamptz;

create or replace function public.estado_tiempo_trabajo(t public.trabajos)
returns text
language sql
stable
set search_path = public
as $$
  select case
    when t.recibido_en_sucursal is not null or t.fecha_recepcion is not null then 'Listo'
    when t.fecha_estimada is not null and t.fecha_estimada < current_date then 'Retrasado'
    when t.fecha_envio is not null
      and t.fecha_estimada is not null
      and t.fecha_estimada <= current_date + 2 then 'Próximo a Vencer'
    else 'En Tiempo'
  end;
$$;

create or replace function public.fila_trabajo(
  t public.trabajos,
  total bigint default null
)
returns jsonb
language sql
stable
set search_path = public
as $$
  select to_jsonb(t) || jsonb_build_object(
    'marcaTemporal', t.marca_temporal,
    'fechaEnvio', t.fecha_envio,
    'fechaEstimada', t.fecha_estimada,
    'fechaRecepcion', t.fecha_recepcion,
    'fechaEnvioSucursal', t.fecha_envio_sucursal,
    'fechaRecepcionSucursal', t.fecha_recepcion_sucursal,
    'estatus', public.estatus_trabajo(t),
    'estadoTiempo', public.estado_tiempo_trabajo(t),
    'estadoMensajeria', public.estado_mensajeria(t),
    'total_count', total
  );
$$;

create or replace function public.guardar_opcion(
  p_tipo text,
  p_valor text,
  p_activa boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  valor_limpio text := trim(p_valor);
begin
  if not public.tiene_permiso('catalogos.administrar') then
    raise exception 'Sin permiso para administrar listas';
  end if;

  if p_tipo not in ('material', 'laboratorio', 'sucursal')
    or nullif(valor_limpio, '') is null then
    raise exception 'Opción inválida';
  end if;

  update public.opciones
  set activa = p_activa,
      valor = valor_limpio
  where tipo = p_tipo
    and lower(trim(valor)) = lower(valor_limpio);

  if not found then
    insert into public.opciones(tipo, valor, activa)
    values (p_tipo, valor_limpio, p_activa);
  end if;
end;
$$;

create or replace function public.trabajos_criticos()
returns setof jsonb
language sql
security definer
set search_path = public
stable
as $$
  select public.fila_trabajo(t)
  from public.trabajos t
  where public.tiene_permiso('informes.ver')
    and (public.es_admin() or t.sucursal_id = public.sucursal_actual())
    and t.fecha_recepcion is null
    and t.fecha_estimada is not null
    and t.fecha_estimada <= current_date + 1
  order by t.fecha_estimada asc, t.marca_temporal desc;
$$;

drop function if exists public.buscar_trabajos(
  text, text, text, text, integer, integer, text, text
);

create function public.buscar_trabajos(
  p_criterio text default null,
  p_estatus text default null,
  p_sucursal text default null,
  p_mensajeria text default null,
  p_estado_tiempo text default null,
  p_limite integer default 50,
  p_offset integer default 0,
  p_orden text default 'marcaTemporal',
  p_direccion text default 'desc'
)
returns setof jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  consulta text;
begin
  if not public.tiene_permiso('trabajos.ver') then
    raise exception 'Sin permiso para consultar trabajos';
  end if;

  if p_limite not between 1 and 100 then
    raise exception 'Límite inválido';
  end if;

  consulta := $sql$
    select public.fila_trabajo(t, count(*) over())
    from public.trabajos t
    where (public.es_admin() or t.sucursal_id = public.sucursal_actual())
      and ($1 is null or t.search_text like '%' || lower(unaccent($1)) || '%')
      and ($2 is null or public.estatus_trabajo(t) = $2)
      and ($3 is null or t.sucursal = $3)
      and ($4 is null or public.estado_mensajeria(t) = $4)
      and ($5 is null or public.estado_tiempo_trabajo(t) = $5)
    order by $sql$
    || case
      when p_orden in ('marcaTemporal', 'fechaEstimada', 'cliente', 'sucursal') then
        case p_orden
          when 'marcaTemporal' then 'marca_temporal'
          when 'fechaEstimada' then 'fecha_estimada'
          else p_orden
        end
      else 'marca_temporal'
    end
    || case when lower(p_direccion) = 'asc' then ' asc' else ' desc' end
    || ' nulls last limit $6 offset $7';

  return query execute consulta using
    nullif(trim(p_criterio), ''),
    p_estatus,
    p_sucursal,
    p_mensajeria,
    p_estado_tiempo,
    p_limite,
    p_offset;
end;
$$;

revoke execute on function public.guardar_opcion(text, text, boolean)
  from public, anon;
grant execute on function public.guardar_opcion(text, text, boolean)
  to authenticated;

revoke execute on function public.trabajos_criticos()
  from public, anon;
grant execute on function public.trabajos_criticos()
  to authenticated;

revoke execute on function public.buscar_trabajos(
  text, text, text, text, text, integer, integer, text, text
) from public, anon;
grant execute on function public.buscar_trabajos(
  text, text, text, text, text, integer, integer, text, text
) to authenticated;
