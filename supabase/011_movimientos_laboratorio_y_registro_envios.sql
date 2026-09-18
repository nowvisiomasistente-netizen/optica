-- Movimientos rápidos exclusivos de administradores y registro histórico de envíos.
-- Ejecutar completo en Supabase → SQL Editor.

create table if not exists public.envios_sucursal_registro (
  id bigint generated always as identity primary key,
  trabajo_id text not null,
  fecha_envio date not null,
  enviado_en timestamptz not null default now(),
  enviado_por uuid references auth.users(id),
  enviado_por_nombre text,
  cliente text not null,
  material text not null,
  laboratorio text not null,
  sucursal text not null,
  mensajero text
);

create unique index if not exists envios_sucursal_registro_trabajo_fecha_unico
  on public.envios_sucursal_registro(trabajo_id, fecha_envio);
create index if not exists envios_sucursal_registro_fecha_busqueda
  on public.envios_sucursal_registro(fecha_envio desc, sucursal, cliente);

-- Conserva los envíos que ya existían antes de instalar este registro.
insert into public.envios_sucursal_registro (
  trabajo_id, fecha_envio, enviado_en, enviado_por, cliente, material, laboratorio, sucursal, mensajero
)
select id, fecha_envio_sucursal, coalesce(updated_at, created_at, now()), actualizado_por,
       cliente, material, laboratorio, sucursal, mensajero
from public.trabajos
where fecha_envio_sucursal is not null
on conflict (trabajo_id, fecha_envio) do nothing;

alter table public.envios_sucursal_registro enable row level security;
revoke all on public.envios_sucursal_registro from anon, authenticated;

-- Estas dos fechas son hitos administrativos; impide que un usuario no
-- administrador los altere desde un formulario o una llamada manual.
create or replace function public.proteger_hitos_administrativos()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (new.fecha_recepcion is distinct from old.fecha_recepcion
      or new.fecha_envio_sucursal is distinct from old.fecha_envio_sucursal)
     and not public.es_admin() then
    raise exception 'Sólo un administrador puede registrar recepción de laboratorio o envío a sucursal';
  end if;
  return new;
end;
$$;

drop trigger if exists trabajos_proteger_hitos_administrativos on public.trabajos;
create trigger trabajos_proteger_hitos_administrativos
before update of fecha_recepcion, fecha_envio_sucursal on public.trabajos
for each row execute function public.proteger_hitos_administrativos();

-- También registra envíos creados desde ediciones antiguas, para que ningún
-- envío futuro dependa de que se use una pantalla específica.
create or replace function public.registrar_envio_a_sucursal()
returns trigger language plpgsql security definer set search_path = public as $$
declare nombre_usuario text;
begin
  if new.fecha_envio_sucursal is not null
     and new.fecha_envio_sucursal is distinct from old.fecha_envio_sucursal then
    select nombre into nombre_usuario from public.perfiles where id = auth.uid() and activo;
    insert into public.envios_sucursal_registro(
      trabajo_id, fecha_envio, enviado_por, enviado_por_nombre,
      cliente, material, laboratorio, sucursal, mensajero
    ) values (
      new.id, new.fecha_envio_sucursal, auth.uid(), coalesce(nombre_usuario, 'Administrador'),
      new.cliente, new.material, new.laboratorio, new.sucursal, new.mensajero
    ) on conflict (trabajo_id, fecha_envio) do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists trabajos_registrar_envio_a_sucursal on public.trabajos;
create trigger trabajos_registrar_envio_a_sucursal
after update of fecha_envio_sucursal on public.trabajos
for each row execute function public.registrar_envio_a_sucursal();

create or replace function public.recibir_de_laboratorio(p_id text, p_version integer)
returns jsonb language plpgsql security definer set search_path = public as $$
declare anterior public.trabajos; nuevo public.trabajos;
begin
  if not public.es_admin() then raise exception 'Sólo un administrador puede recibir del laboratorio'; end if;
  select * into anterior from public.trabajos where id = p_id for update;
  if not found then raise exception 'Trabajo no encontrado'; end if;
  if anterior.version <> p_version then raise exception 'Conflicto: este trabajo fue modificado por otro usuario'; end if;
  if anterior.fecha_recepcion is not null then raise exception 'Este trabajo ya fue recibido del laboratorio'; end if;
  update public.trabajos set fecha_recepcion = current_date, version = version + 1,
    actualizado_por = auth.uid(), updated_at = now() where id = p_id returning * into nuevo;
  insert into public.auditoria(usuario_id, sucursal_id, accion, entidad, registro_id, campo, valor_anterior, valor_nuevo)
  values (auth.uid(), nuevo.sucursal_id, 'recibir_laboratorio', 'trabajos', p_id,
    'fechaRecepcion', to_jsonb(anterior.fecha_recepcion), to_jsonb(nuevo.fecha_recepcion));
  return public.fila_trabajo(nuevo);
end;
$$;

create or replace function public.enviar_a_sucursal(p_id text, p_version integer)
returns jsonb language plpgsql security definer set search_path = public as $$
declare anterior public.trabajos; nuevo public.trabajos; nombre_usuario text;
begin
  if not public.es_admin() then raise exception 'Sólo un administrador puede enviar a sucursal'; end if;
  select * into anterior from public.trabajos where id = p_id for update;
  if not found then raise exception 'Trabajo no encontrado'; end if;
  if anterior.version <> p_version then raise exception 'Conflicto: este trabajo fue modificado por otro usuario'; end if;
  if anterior.fecha_recepcion is null then raise exception 'Registre primero la recepción del laboratorio'; end if;
  if anterior.fecha_envio_sucursal is not null then raise exception 'Este trabajo ya fue enviado a la sucursal'; end if;
  select nombre into nombre_usuario from public.perfiles where id = auth.uid() and activo;
  update public.trabajos set fecha_envio_sucursal = current_date, version = version + 1,
    actualizado_por = auth.uid(), updated_at = now() where id = p_id returning * into nuevo;
  insert into public.envios_sucursal_registro(trabajo_id, fecha_envio, enviado_por, enviado_por_nombre,
    cliente, material, laboratorio, sucursal, mensajero)
  values (nuevo.id, nuevo.fecha_envio_sucursal, auth.uid(), coalesce(nombre_usuario, 'Administrador'),
    nuevo.cliente, nuevo.material, nuevo.laboratorio, nuevo.sucursal, nuevo.mensajero)
  on conflict (trabajo_id, fecha_envio) do nothing;
  insert into public.auditoria(usuario_id, sucursal_id, accion, entidad, registro_id, campo, valor_anterior, valor_nuevo)
  values (auth.uid(), nuevo.sucursal_id, 'enviar_sucursal', 'trabajos', p_id,
    'fechaEnvioSucursal', to_jsonb(anterior.fecha_envio_sucursal), to_jsonb(nuevo.fecha_envio_sucursal));
  return public.fila_trabajo(nuevo);
end;
$$;

create or replace function public.envios_sucursal_por_fecha(p_fecha date, p_criterio text default null)
returns setof jsonb language sql security definer set search_path = public stable as $$
  select jsonb_build_object(
    'id', e.trabajo_id, 'cliente', e.cliente, 'material', e.material,
    'laboratorio', e.laboratorio, 'sucursal', e.sucursal,
    'mensajero', coalesce(j.mensajero, e.mensajero),
    'fechaEnvioSucursal', e.fecha_envio, 'fechaRecepcionSucursal', j.fecha_recepcion_sucursal,
    'recibidoEnSucursal', j.recibido_en_sucursal, 'recibidoPorNombre', j.recibido_por_nombre,
    'sucursalRecibida', j.sucursal_recibida,
    'estatus', case when j.recibido_en_sucursal is not null then 'Recibido' else 'Enviado' end,
    'estadoMensajeria', case
      when j.recibido_en_sucursal is not null or j.fecha_recepcion_sucursal is not null then 'Entregado en Sucursal'
      when e.fecha_envio < current_date then 'Retrasado en Tránsito'
      else 'En Tránsito a Sucursal' end
  )
  from public.envios_sucursal_registro e
  left join public.trabajos j on j.id = e.trabajo_id
  where public.tiene_permiso('informes.ver')
    and (public.es_admin() or j.sucursal_id = public.sucursal_actual())
    and e.fecha_envio = p_fecha
    and (nullif(trim(p_criterio), '') is null or lower(unaccent(concat_ws(' ',
      e.trabajo_id, e.cliente, e.material, e.laboratorio, e.sucursal, e.mensajero)))
      like '%' || lower(unaccent(trim(p_criterio))) || '%')
  order by e.sucursal, e.cliente, e.id;
$$;

revoke execute on function public.recibir_de_laboratorio(text, integer) from public, anon;
revoke execute on function public.enviar_a_sucursal(text, integer) from public, anon;
revoke execute on function public.envios_sucursal_por_fecha(date, text) from public, anon;
grant execute on function public.recibir_de_laboratorio(text, integer) to authenticated;
grant execute on function public.enviar_a_sucursal(text, integer) to authenticated;
grant execute on function public.envios_sucursal_por_fecha(date, text) to authenticated;
