-- Ejecutar UNA SOLA VEZ en Supabase SQL Editor.
-- Corrige la asignación de trabajos a su sucursal y habilita la recepción
-- segura por el personal autorizado de cada sucursal. No elimina registros.

-- 1. Catálogo único de sucursales operativas.
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

-- 2. Busca la sucursal sin depender de mayúsculas, tildes, espacios o guiones.
create or replace function public.id_sucursal_por_nombre(p_nombre text)
returns uuid language sql security definer set search_path = public stable as $$
  select s.id
  from public.sucursales s
  where regexp_replace(lower(unaccent(trim(s.nombre))), '[^a-z0-9]+', '', 'g') =
        regexp_replace(lower(unaccent(trim(coalesce(p_nombre, '')))), '[^a-z0-9]+', '', 'g')
  limit 1;
$$;

-- 3. Repara trabajos existentes. También admite la variante antigua “Sam Isidro”.
update public.trabajos
set sucursal = case
  when regexp_replace(lower(unaccent(trim(sucursal))), '[^a-z0-9]+', '', 'g') = 'megacentro' then 'Mega Centro'
  when regexp_replace(lower(unaccent(trim(sucursal))), '[^a-z0-9]+', '', 'g') = 'romana' then 'Romana'
  when regexp_replace(lower(unaccent(trim(sucursal))), '[^a-z0-9]+', '', 'g') in ('sanisidro', 'samisidro') then 'San Isidro'
  when regexp_replace(lower(unaccent(trim(sucursal))), '[^a-z0-9]+', '', 'g') = 'plazalama' then 'Plaza Lama'
  else sucursal
end;

update public.trabajos t
set sucursal_id = public.id_sucursal_por_nombre(t.sucursal)
where public.id_sucursal_por_nombre(t.sucursal) is not null
  and t.sucursal_id is distinct from public.id_sucursal_por_nombre(t.sucursal);

-- 4. Permiso separado para confirmar recepción. Los tres roles operativos
-- pueden recibir únicamente los trabajos de su propia sucursal.
insert into public.permisos (codigo, descripcion)
values ('trabajos.recibir', 'Confirmar recepción de trabajos en su sucursal')
on conflict (codigo) do nothing;

insert into public.rol_permisos (rol, permiso) values
  ('administrativo', 'trabajos.recibir'),
  ('laboratorio', 'trabajos.recibir'),
  ('ventas', 'trabajos.recibir')
on conflict do nothing;

-- 5. Todo trabajo nuevo queda unido a la sucursal elegida. Un administrador
-- puede elegir cualquiera; los demás sólo pueden crear en su sucursal asignada.
create or replace function public.crear_trabajo(p_trabajo jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  t public.trabajos;
  destino_id uuid;
  destino_nombre text;
begin
  if not public.tiene_permiso('trabajos.crear') then
    raise exception 'Sin permiso para crear trabajos';
  end if;

  destino_id := public.id_sucursal_por_nombre(p_trabajo->>'sucursal');
  if destino_id is null then
    raise exception 'Sucursal no válida. Seleccione Mega Centro, Romana, San Isidro o Plaza Lama';
  end if;
  select nombre into destino_nombre from public.sucursales where id = destino_id;

  if not public.es_admin() and destino_id is distinct from public.sucursal_actual() then
    raise exception 'Sólo puede registrar trabajos para su propia sucursal';
  end if;

  insert into public.trabajos (
    id, marca_temporal, cliente, material, laboratorio, sucursal,
    fecha_envio, fecha_estimada, sucursal_id, creado_por, actualizado_por
  ) values (
    coalesce(p_trabajo->>'id', public.siguiente_id_trabajo()),
    coalesce((p_trabajo->>'marca_temporal')::date, current_date),
    trim(p_trabajo->>'cliente'), trim(p_trabajo->>'material'), trim(p_trabajo->>'laboratorio'), destino_nombre,
    nullif(p_trabajo->>'fecha_envio', '')::date, nullif(p_trabajo->>'fecha_estimada', '')::date,
    destino_id, auth.uid(), auth.uid()
  ) returning * into t;

  insert into public.auditoria(usuario_id, sucursal_id, accion, entidad, registro_id, valor_nuevo)
  values(auth.uid(), t.sucursal_id, 'crear', 'trabajos', t.id, to_jsonb(t));
  return public.fila_trabajo(t);
end $$;

-- 6. Sólo un administrador puede redirigir un trabajo a otra sucursal; el
-- cambio actualiza el texto visible y la relación segura en la misma operación.
create or replace function public.actualizar_trabajo_versionado(p_id text, p_version integer, p_cambios jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  anterior public.trabajos;
  nuevo public.trabajos;
  clave text;
  columna text;
  destino_id uuid;
  destino_nombre text;
begin
  if not public.tiene_permiso('trabajos.actualizar') then
    raise exception 'Sin permiso para actualizar trabajos';
  end if;
  select * into anterior from public.trabajos where id = p_id for update;
  if not found then raise exception 'Trabajo no encontrado'; end if;
  if not public.es_admin() and anterior.sucursal_id is distinct from public.sucursal_actual() then
    raise exception 'Sin acceso a esta sucursal';
  end if;
  if anterior.version <> p_version then
    raise exception 'Conflicto: este trabajo fue modificado por otro usuario';
  end if;

  destino_id := anterior.sucursal_id;
  destino_nombre := anterior.sucursal;
  if p_cambios ? 'sucursal' then
    if not public.es_admin() then raise exception 'Sólo un administrador puede cambiar la sucursal destino'; end if;
    destino_id := public.id_sucursal_por_nombre(p_cambios->>'sucursal');
    if destino_id is null then raise exception 'Sucursal no válida. Seleccione Mega Centro, Romana, San Isidro o Plaza Lama'; end if;
    select nombre into destino_nombre from public.sucursales where id = destino_id;
  end if;

  update public.trabajos set
    cliente = coalesce(p_cambios->>'cliente', cliente),
    material = coalesce(p_cambios->>'material', material),
    laboratorio = coalesce(p_cambios->>'laboratorio', laboratorio),
    sucursal = destino_nombre, sucursal_id = destino_id,
    fecha_envio = case when p_cambios ? 'fechaEnvio' then nullif(p_cambios->>'fechaEnvio','')::date else fecha_envio end,
    fecha_estimada = case when p_cambios ? 'fechaEstimada' then nullif(p_cambios->>'fechaEstimada','')::date else fecha_estimada end,
    fecha_recepcion = case when p_cambios ? 'fechaRecepcion' then nullif(p_cambios->>'fechaRecepcion','')::date else fecha_recepcion end,
    fecha_envio_sucursal = case when p_cambios ? 'fechaEnvioSucursal' then nullif(p_cambios->>'fechaEnvioSucursal','')::date else fecha_envio_sucursal end,
    fecha_recepcion_sucursal = case when p_cambios ? 'fechaRecepcionSucursal' then nullif(p_cambios->>'fechaRecepcionSucursal','')::date else fecha_recepcion_sucursal end,
    mensajero = case when p_cambios ? 'mensajero' then nullif(p_cambios->>'mensajero','') else mensajero end,
    version = version + 1, actualizado_por = auth.uid(), updated_at = now()
  where id = p_id returning * into nuevo;

  for clave in select jsonb_object_keys(p_cambios) loop
    columna := case clave
      when 'fechaEnvio' then 'fecha_envio' when 'fechaEstimada' then 'fecha_estimada'
      when 'fechaRecepcion' then 'fecha_recepcion' when 'fechaEnvioSucursal' then 'fecha_envio_sucursal'
      when 'fechaRecepcionSucursal' then 'fecha_recepcion_sucursal' else clave end;
    insert into public.auditoria(usuario_id, sucursal_id, accion, entidad, registro_id, campo, valor_anterior, valor_nuevo)
    values(auth.uid(), nuevo.sucursal_id, 'actualizar', 'trabajos', p_id, clave,
      to_jsonb(anterior)->columna, to_jsonb(nuevo)->columna);
  end loop;
  return public.fila_trabajo(nuevo);
end $$;

-- 7. La recepción exige el permiso específico y confirma que quien recibe
-- pertenece a la misma sucursal destino del trabajo.
create or replace function public.confirmar_recepcion_trabajo(p_id text, p_version integer)
returns jsonb language plpgsql security definer set search_path = public as $$
declare anterior public.trabajos; nuevo public.trabajos; nombre_receptor text;
begin
  if not public.tiene_permiso('trabajos.recibir') then raise exception 'Sin permiso para confirmar recepciones'; end if;
  select * into anterior from public.trabajos where id = p_id for update;
  if not found then raise exception 'Trabajo no encontrado'; end if;
  if not public.es_admin() and anterior.sucursal_id is distinct from public.sucursal_actual() then raise exception 'Sin acceso a esta sucursal'; end if;
  if anterior.version <> p_version then raise exception 'Conflicto: este trabajo fue modificado por otro usuario'; end if;
  if anterior.recibido_en_sucursal is not null then raise exception 'Este trabajo ya fue recibido'; end if;
  if anterior.fecha_envio_sucursal is null then raise exception 'Registre primero el envío a sucursal'; end if;
  select nombre into nombre_receptor from public.perfiles where id = auth.uid() and activo;

  update public.trabajos set
    fecha_recepcion_sucursal = current_date, recibido_en_sucursal = now(), recibido_por = auth.uid(),
    recibido_por_nombre = coalesce(nombre_receptor, 'Usuario'), sucursal_recibida = sucursal,
    version = version + 1, actualizado_por = auth.uid(), updated_at = now()
  where id = p_id returning * into nuevo;
  insert into public.auditoria(usuario_id, sucursal_id, accion, entidad, registro_id, campo, valor_anterior, valor_nuevo)
  values(auth.uid(), nuevo.sucursal_id, 'recibir', 'trabajos', p_id, 'recepcion_sucursal', null,
    jsonb_build_object('recibido_en_sucursal', nuevo.recibido_en_sucursal, 'recibido_por', nuevo.recibido_por_nombre, 'sucursal', nuevo.sucursal_recibida));
  return public.fila_trabajo(nuevo);
end $$;

grant execute on function public.id_sucursal_por_nombre(text), public.crear_trabajo(jsonb),
  public.actualizar_trabajo_versionado(text, integer, jsonb), public.confirmar_recepcion_trabajo(text, integer)
to authenticated;
