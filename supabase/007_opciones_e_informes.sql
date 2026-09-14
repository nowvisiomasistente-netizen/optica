-- Opciones compartidas y consulta completa de trabajos críticos.
create or replace function public.guardar_opcion(p_tipo text, p_valor text, p_activa boolean)
returns void language plpgsql security definer set search_path=public as $$
begin
  if not public.tiene_permiso('catalogos.administrar') then raise exception 'Sin permiso para administrar listas'; end if;
  if p_tipo not in ('material','laboratorio','sucursal') or nullif(trim(p_valor),'') is null then raise exception 'Opción inválida'; end if;
  insert into public.opciones(tipo,valor,activa) values(p_tipo,trim(p_valor),p_activa)
  on conflict(tipo,valor) do update set activa=excluded.activa;
end $$;

create or replace function public.trabajos_criticos() returns setof jsonb
language sql security invoker set search_path=public stable as $$
  select public.fila_trabajo(t)
  from public.trabajos t
  where public.tiene_permiso('informes.ver')
    and (public.es_admin() or t.sucursal_id = public.sucursal_actual())
    and t.fecha_recepcion is null
    and t.fecha_estimada is not null
    and t.fecha_estimada <= current_date + 1
  order by t.fecha_estimada asc, t.marca_temporal desc;
$$;

revoke execute on function public.guardar_opcion(text,text,boolean) from public, anon;
grant execute on function public.guardar_opcion(text,text,boolean) to authenticated;
revoke execute on function public.trabajos_criticos() from public, anon;
grant execute on function public.trabajos_criticos() to authenticated;
