-- Ejecutar una vez en Supabase SQL Editor.
-- Crea las sucursales, asigna cada trabajo a su sucursal elegida y vincula
-- el estado de recepción a la fecha de recepción en sucursal.

insert into public.sucursales(nombre) values
  ('Mega Centro'), ('Romana'), ('Sam Isidro'), ('Plaza Lama')
on conflict (nombre) do nothing;

insert into public.opciones(tipo, valor) values
  ('sucursal', 'Mega Centro'), ('sucursal', 'Romana'), ('sucursal', 'Sam Isidro'), ('sucursal', 'Plaza Lama')
on conflict (tipo, valor) do nothing;

-- Corrige trabajos ya existentes según la sucursal escrita en cada registro.
update public.trabajos t
set sucursal_id = s.id, sucursal = s.nombre
from public.sucursales s
where lower(trim(t.sucursal)) = lower(s.nombre)
  and s.nombre in ('Mega Centro', 'Romana', 'Sam Isidro', 'Plaza Lama');

alter table public.trabajos add column if not exists recibido_en_sucursal timestamptz;
alter table public.trabajos add column if not exists recibido_por uuid references auth.users(id);
alter table public.trabajos add column if not exists recibido_por_nombre text;
alter table public.trabajos add column if not exists sucursal_recibida text;

create or replace function public.confirmar_recepcion_trabajo(p_id text,p_version integer) returns jsonb
language plpgsql security definer set search_path=public as $$
declare anterior trabajos; nuevo trabajos; nombre_receptor text;
begin
  if not tiene_permiso('trabajos.actualizar') then raise exception 'Sin permiso para confirmar recepciones'; end if;
  select * into anterior from trabajos where id=p_id for update;
  if not found then raise exception 'Trabajo no encontrado'; end if;
  if not es_admin() and anterior.sucursal_id is distinct from sucursal_actual() then raise exception 'Sin acceso a esta sucursal'; end if;
  if anterior.version <> p_version then raise exception 'Conflicto: este trabajo fue modificado por otro usuario'; end if;
  if anterior.recibido_en_sucursal is not null then raise exception 'Este trabajo ya fue recibido'; end if;
  if anterior.fecha_envio_sucursal is null then raise exception 'Registre primero el envío a sucursal'; end if;
  select nombre into nombre_receptor from perfiles where id=auth.uid() and activo;
  update trabajos set fecha_recepcion_sucursal=current_date,recibido_en_sucursal=now(),recibido_por=auth.uid(),
    recibido_por_nombre=coalesce(nombre_receptor,'Usuario'),sucursal_recibida=sucursal,version=version+1,
    actualizado_por=auth.uid(),updated_at=now() where id=p_id returning * into nuevo;
  insert into auditoria(usuario_id,sucursal_id,accion,entidad,registro_id,campo,valor_anterior,valor_nuevo)
  values(auth.uid(),nuevo.sucursal_id,'recibir','trabajos',p_id,'recepcion_sucursal',null,
    jsonb_build_object('recibido_en_sucursal',nuevo.recibido_en_sucursal,'recibido_por',nuevo.recibido_por_nombre,'sucursal',nuevo.sucursal_recibida));
  return fila_trabajo(nuevo);
end $$;

create or replace function public.crear_trabajo(p_trabajo jsonb) returns jsonb
language plpgsql security definer set search_path=public as $$
declare t trabajos; destino_id uuid; destino_nombre text;
begin
  if not tiene_permiso('trabajos.crear') then raise exception 'Sin permiso para crear trabajos'; end if;
  select id, nombre into destino_id, destino_nombre
  from sucursales
  where lower(nombre) = lower(trim(p_trabajo->>'sucursal')) and activa
  limit 1;
  if destino_id is null then raise exception 'Seleccione una sucursal válida'; end if;
  if not es_admin() and destino_id is distinct from sucursal_actual() then
    raise exception 'Solo puede registrar trabajos para su sucursal';
  end if;
  insert into trabajos(id,marca_temporal,cliente,material,laboratorio,sucursal,fecha_envio,fecha_estimada,sucursal_id,creado_por,actualizado_por)
  values(
    coalesce(p_trabajo->>'id',siguiente_id_trabajo()),
    coalesce((p_trabajo->>'marca_temporal')::date,current_date),
    trim(p_trabajo->>'cliente'),trim(p_trabajo->>'material'),trim(p_trabajo->>'laboratorio'),destino_nombre,
    nullif(p_trabajo->>'fecha_envio','')::date,nullif(p_trabajo->>'fecha_estimada','')::date,
    destino_id,auth.uid(),auth.uid()
  ) returning * into t;
  insert into auditoria(usuario_id,sucursal_id,accion,entidad,registro_id,valor_nuevo)
  values(auth.uid(),t.sucursal_id,'crear','trabajos',t.id,to_jsonb(t));
  return fila_trabajo(t);
end $$;

create or replace function public.actualizar_trabajo_versionado(p_id text,p_version integer,p_cambios jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare anterior trabajos; nuevo trabajos; clave text; columna text; nombre_receptor text;
begin
  if not tiene_permiso('trabajos.actualizar') then raise exception 'Sin permiso para actualizar trabajos'; end if;
  select * into anterior from trabajos where id=p_id for update;
  if not found then raise exception 'Trabajo no encontrado'; end if;
  if not es_admin() and anterior.sucursal_id is distinct from sucursal_actual() then raise exception 'Sin acceso a esta sucursal'; end if;
  if anterior.version <> p_version then raise exception 'Conflicto: este trabajo fue modificado por otro usuario'; end if;
  select nombre into nombre_receptor from perfiles where id=auth.uid() and activo;
  update trabajos set
    cliente=coalesce(p_cambios->>'cliente',cliente), material=coalesce(p_cambios->>'material',material),
    laboratorio=coalesce(p_cambios->>'laboratorio',laboratorio), sucursal=coalesce(p_cambios->>'sucursal',sucursal),
    fecha_envio=case when p_cambios ? 'fechaEnvio' then nullif(p_cambios->>'fechaEnvio','')::date else fecha_envio end,
    fecha_estimada=case when p_cambios ? 'fechaEstimada' then nullif(p_cambios->>'fechaEstimada','')::date else fecha_estimada end,
    fecha_recepcion=case when p_cambios ? 'fechaRecepcion' then nullif(p_cambios->>'fechaRecepcion','')::date else fecha_recepcion end,
    fecha_envio_sucursal=case when p_cambios ? 'fechaEnvioSucursal' then nullif(p_cambios->>'fechaEnvioSucursal','')::date else fecha_envio_sucursal end,
    fecha_recepcion_sucursal=case when p_cambios ? 'fechaRecepcionSucursal' then nullif(p_cambios->>'fechaRecepcionSucursal','')::date else fecha_recepcion_sucursal end,
    mensajero=case when p_cambios ? 'mensajero' then nullif(p_cambios->>'mensajero','') else mensajero end,
    recibido_en_sucursal=case when p_cambios ? 'fechaRecepcionSucursal' then case when nullif(p_cambios->>'fechaRecepcionSucursal','') is null then null else now() end else recibido_en_sucursal end,
    recibido_por=case when p_cambios ? 'fechaRecepcionSucursal' then case when nullif(p_cambios->>'fechaRecepcionSucursal','') is null then null else auth.uid() end else recibido_por end,
    recibido_por_nombre=case when p_cambios ? 'fechaRecepcionSucursal' then case when nullif(p_cambios->>'fechaRecepcionSucursal','') is null then null else coalesce(nombre_receptor,'Usuario') end else recibido_por_nombre end,
    sucursal_recibida=case when p_cambios ? 'fechaRecepcionSucursal' then case when nullif(p_cambios->>'fechaRecepcionSucursal','') is null then null else sucursal end else sucursal_recibida end,
    version=version+1, actualizado_por=auth.uid(), updated_at=now()
  where id=p_id returning * into nuevo;
  for clave in select jsonb_object_keys(p_cambios) loop
    columna := case clave when 'fechaEnvio' then 'fecha_envio' when 'fechaEstimada' then 'fecha_estimada'
      when 'fechaRecepcion' then 'fecha_recepcion' when 'fechaEnvioSucursal' then 'fecha_envio_sucursal'
      when 'fechaRecepcionSucursal' then 'fecha_recepcion_sucursal' else clave end;
    insert into auditoria(usuario_id,sucursal_id,accion,entidad,registro_id,campo,valor_anterior,valor_nuevo)
    values(auth.uid(),nuevo.sucursal_id,'actualizar','trabajos',p_id,clave,to_jsonb(anterior)->columna,to_jsonb(nuevo)->columna);
  end loop;
  return fila_trabajo(nuevo);
end $$;

revoke execute on function public.confirmar_recepcion_trabajo(text,integer) from public, anon;
grant execute on function public.confirmar_recepcion_trabajo(text,integer) to authenticated;
revoke execute on function public.crear_trabajo(jsonb) from public, anon;
grant execute on function public.crear_trabajo(jsonb) to authenticated;
revoke execute on function public.actualizar_trabajo_versionado(text,integer,jsonb) from public, anon;
grant execute on function public.actualizar_trabajo_versionado(text,integer,jsonb) to authenticated;
