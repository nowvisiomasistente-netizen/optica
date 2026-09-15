-- Ejecutar completo en Supabase: SQL Editor > New query > Run.
-- La eliminación es permanente y sólo la puede ejecutar un administrador.
-- Se conserva una copia del trabajo en auditoría antes de eliminarlo.

insert into public.permisos(codigo, descripcion)
values ('trabajos.eliminar', 'Eliminar trabajos de forma permanente')
on conflict (codigo) do nothing;

insert into public.rol_permisos(rol, permiso)
values ('administrador', 'trabajos.eliminar')
on conflict do nothing;

create or replace function public.eliminar_trabajo(
  p_id text,
  p_version integer
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  anterior public.trabajos;
begin
  if not public.es_admin() then
    raise exception 'Sólo los administradores pueden eliminar trabajos';
  end if;

  select * into anterior
  from public.trabajos
  where id = p_id
  for update;

  if not found then
    raise exception 'Trabajo no encontrado';
  end if;

  if anterior.version <> p_version then
    raise exception 'Conflicto: este trabajo fue modificado por otro usuario';
  end if;

  insert into public.auditoria(
    usuario_id,
    sucursal_id,
    accion,
    entidad,
    registro_id,
    valor_anterior,
    valor_nuevo
  )
  values (
    auth.uid(),
    anterior.sucursal_id,
    'eliminar',
    'trabajos',
    anterior.id,
    to_jsonb(anterior),
    null
  );

  delete from public.trabajos
  where id = anterior.id;
end;
$$;

revoke execute on function public.eliminar_trabajo(text, integer)
  from public, anon;
grant execute on function public.eliminar_trabajo(text, integer)
  to authenticated;
