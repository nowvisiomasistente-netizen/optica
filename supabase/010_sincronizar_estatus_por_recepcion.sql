-- Ejecutar completo en Supabase: SQL Editor > New query > Run.
-- La recepción del laboratorio controla los pasos posteriores del trabajo.

alter table public.trabajos
  add column if not exists recibido_en_sucursal timestamptz,
  add column if not exists recibido_por uuid references auth.users(id),
  add column if not exists recibido_por_nombre text,
  add column if not exists sucursal_recibida text;

-- Corrige también registros antiguos que quedaron en un paso posterior sin
-- tener recepción de laboratorio.
update public.trabajos
set fecha_envio_sucursal = null,
    fecha_recepcion_sucursal = null,
    mensajero = null,
    recibido_en_sucursal = null,
    recibido_por = null,
    recibido_por_nombre = null,
    sucursal_recibida = null,
    version = version + 1,
    updated_at = now()
where fecha_recepcion is null
  and (
    fecha_envio_sucursal is not null
    or fecha_recepcion_sucursal is not null
    or mensajero is not null
    or recibido_en_sucursal is not null
    or recibido_por is not null
    or recibido_por_nombre is not null
    or sucursal_recibida is not null
  );

create or replace function public.actualizar_trabajo_versionado(
  p_id text,
  p_version integer,
  p_cambios jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  anterior public.trabajos;
  nuevo public.trabajos;
  clave text;
  columna text;
  nombre_receptor text;
  borra_recepcion_laboratorio boolean;
  borra_recepcion_sucursal boolean;
begin
  if not public.tiene_permiso('trabajos.actualizar') then
    raise exception 'Sin permiso para actualizar trabajos';
  end if;

  select * into anterior
  from public.trabajos
  where id = p_id
  for update;

  if not found then
    raise exception 'Trabajo no encontrado';
  end if;

  if not public.es_admin()
    and anterior.sucursal_id is distinct from public.sucursal_actual() then
    raise exception 'Sin acceso a esta sucursal';
  end if;

  if anterior.version <> p_version then
    raise exception 'Conflicto: este trabajo fue modificado por otro usuario';
  end if;

  borra_recepcion_laboratorio := p_cambios ? 'fechaRecepcion'
    and nullif(p_cambios->>'fechaRecepcion', '') is null;
  borra_recepcion_sucursal := p_cambios ? 'fechaRecepcionSucursal'
    and nullif(p_cambios->>'fechaRecepcionSucursal', '') is null;

  select nombre into nombre_receptor
  from public.perfiles
  where id = auth.uid() and activo;

  update public.trabajos set
    cliente = coalesce(p_cambios->>'cliente', cliente),
    material = coalesce(p_cambios->>'material', material),
    laboratorio = coalesce(p_cambios->>'laboratorio', laboratorio),
    sucursal = coalesce(p_cambios->>'sucursal', sucursal),
    fecha_envio = case when p_cambios ? 'fechaEnvio'
      then nullif(p_cambios->>'fechaEnvio', '')::date else fecha_envio end,
    fecha_estimada = case when p_cambios ? 'fechaEstimada'
      then nullif(p_cambios->>'fechaEstimada', '')::date else fecha_estimada end,
    fecha_recepcion = case when p_cambios ? 'fechaRecepcion'
      then nullif(p_cambios->>'fechaRecepcion', '')::date else fecha_recepcion end,

    fecha_envio_sucursal = case
      when borra_recepcion_laboratorio then null
      when p_cambios ? 'fechaEnvioSucursal' then nullif(p_cambios->>'fechaEnvioSucursal', '')::date
      else fecha_envio_sucursal end,
    fecha_recepcion_sucursal = case
      when borra_recepcion_laboratorio then null
      when p_cambios ? 'fechaRecepcionSucursal' then nullif(p_cambios->>'fechaRecepcionSucursal', '')::date
      else fecha_recepcion_sucursal end,
    mensajero = case
      when borra_recepcion_laboratorio then null
      when p_cambios ? 'mensajero' then nullif(p_cambios->>'mensajero', '')
      else mensajero end,
    recibido_en_sucursal = case
      when borra_recepcion_laboratorio or borra_recepcion_sucursal then null
      when p_cambios ? 'fechaRecepcionSucursal' then now()
      else recibido_en_sucursal end,
    recibido_por = case
      when borra_recepcion_laboratorio or borra_recepcion_sucursal then null
      when p_cambios ? 'fechaRecepcionSucursal' then auth.uid()
      else recibido_por end,
    recibido_por_nombre = case
      when borra_recepcion_laboratorio or borra_recepcion_sucursal then null
      when p_cambios ? 'fechaRecepcionSucursal' then coalesce(nombre_receptor, 'Usuario')
      else recibido_por_nombre end,
    sucursal_recibida = case
      when borra_recepcion_laboratorio or borra_recepcion_sucursal then null
      when p_cambios ? 'fechaRecepcionSucursal' then sucursal
      else sucursal_recibida end,
    version = version + 1,
    actualizado_por = auth.uid(),
    updated_at = now()
  where id = p_id
  returning * into nuevo;

  if borra_recepcion_laboratorio then
    insert into public.auditoria(
      usuario_id, sucursal_id, accion, entidad, registro_id,
      campo, valor_anterior, valor_nuevo
    ) values (
      auth.uid(), nuevo.sucursal_id, 'actualizar', 'trabajos', p_id,
      'reiniciar_mensajeria',
      jsonb_build_object(
        'fecha_envio_sucursal', anterior.fecha_envio_sucursal,
        'fecha_recepcion_sucursal', anterior.fecha_recepcion_sucursal,
        'mensajero', anterior.mensajero,
        'recibido_en_sucursal', anterior.recibido_en_sucursal
      ),
      null
    );
  end if;

  for clave in select jsonb_object_keys(p_cambios) loop
    columna := case clave
      when 'fechaEnvio' then 'fecha_envio'
      when 'fechaEstimada' then 'fecha_estimada'
      when 'fechaRecepcion' then 'fecha_recepcion'
      when 'fechaEnvioSucursal' then 'fecha_envio_sucursal'
      when 'fechaRecepcionSucursal' then 'fecha_recepcion_sucursal'
      else clave
    end;

    insert into public.auditoria(
      usuario_id, sucursal_id, accion, entidad, registro_id,
      campo, valor_anterior, valor_nuevo
    ) values (
      auth.uid(), nuevo.sucursal_id, 'actualizar', 'trabajos', p_id,
      clave, to_jsonb(anterior)->columna, to_jsonb(nuevo)->columna
    );
  end loop;

  return public.fila_trabajo(nuevo);
end;
$$;

revoke execute on function public.actualizar_trabajo_versionado(text, integer, jsonb)
  from public, anon;
grant execute on function public.actualizar_trabajo_versionado(text, integer, jsonb)
  to authenticated;
