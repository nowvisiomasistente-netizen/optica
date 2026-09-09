-- Ejecutar una sola vez en Supabase SQL Editor.
-- No borra trabajos, usuarios ni movimientos existentes.
create or replace function public.historial_trabajo(p_id text)
returns table(ocurrido_en timestamptz, accion text, campo text, valor_anterior jsonb, valor_nuevo jsonb, usuario text)
language sql security definer set search_path=public stable as $$
 select a.ocurrido_en,a.accion,a.campo,a.valor_anterior,a.valor_nuevo,coalesce(p.nombre,'Usuario')
 from auditoria a
 left join perfiles p on p.id=a.usuario_id
 where a.entidad='trabajos' and a.registro_id=p_id
   and public.tiene_permiso('trabajos.ver')
   and (public.es_admin() or a.sucursal_id=public.sucursal_actual())
 order by a.ocurrido_en desc,a.id desc;
$$;

revoke execute on function public.historial_trabajo(text) from public, anon;
grant execute on function public.historial_trabajo(text) to authenticated;
