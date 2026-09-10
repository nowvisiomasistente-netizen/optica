-- Rol ventas: únicamente consultar/buscar y confirmar recepción.
delete from public.rol_permisos
where rol = 'ventas';

insert into public.rol_permisos(rol, permiso)
values
  ('ventas', 'trabajos.ver'),
  ('ventas', 'trabajos.recibir')
on conflict do nothing;
