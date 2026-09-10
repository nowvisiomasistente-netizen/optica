-- Ejecutar una vez en Supabase SQL Editor para instalaciones que ya existen.
-- No modifica ni elimina trabajos anteriores.
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

revoke execute on function public.confirmar_recepcion_trabajo(text,integer) from public, anon;
grant execute on function public.confirmar_recepcion_trabajo(text,integer) to authenticated;
