-- Ejecutar en Supabase SQL Editor como propietario del proyecto.
-- No ejecute service_role ni contraseñas en el navegador.
create extension if not exists pgcrypto;
create extension if not exists unaccent;
create extension if not exists pg_trgm;

do $$ begin
  if not exists (select 1 from pg_type where typname = 'rol_sistema' and typnamespace = 'public'::regnamespace) then
    create type public.rol_sistema as enum ('administrador','administrativo','laboratorio','ventas');
  end if;
end $$;
create table if not exists public.sucursales (
  id uuid primary key default gen_random_uuid(), nombre text not null unique,
  activa boolean not null default true, created_at timestamptz not null default now()
);
create table if not exists public.laboratorios (
  id uuid primary key default gen_random_uuid(), nombre text not null unique,
  activo boolean not null default true, created_at timestamptz not null default now()
);
create table if not exists public.perfiles (
  id uuid primary key references auth.users(id) on delete restrict,
  nombre text not null, rol public.rol_sistema not null default 'ventas', sucursal_id uuid references public.sucursales(id),
  activo boolean not null default true, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists public.permisos (
  codigo text primary key, descripcion text not null
);
insert into public.permisos(codigo,descripcion) values
 ('trabajos.ver','Consultar trabajos'),('trabajos.crear','Registrar trabajos'),('trabajos.actualizar','Editar trabajos'),
 ('informes.ver','Consultar y exportar informes'),('catalogos.administrar','Administrar listas'),
 ('usuarios.administrar','Administrar usuarios y roles'),('auditoria.ver','Consultar auditoría') on conflict do nothing;
create table if not exists public.rol_permisos (rol public.rol_sistema not null, permiso text not null references public.permisos(codigo), primary key(rol,permiso));
insert into public.rol_permisos select 'administrador',codigo from public.permisos on conflict do nothing;
insert into public.rol_permisos values
 ('administrativo','trabajos.ver'),('administrativo','trabajos.crear'),('administrativo','trabajos.actualizar'),('administrativo','informes.ver'),
 ('laboratorio','trabajos.ver'),('laboratorio','trabajos.actualizar'),('ventas','trabajos.ver'),('ventas','trabajos.crear'),('ventas','informes.ver') on conflict do nothing;

create table if not exists public.trabajos (
  id text primary key check (id ~ '^[A-Za-z0-9_-]+$'),
  marca_temporal date not null default current_date, cliente text not null, material text not null, laboratorio text not null,
  fecha_envio date, fecha_estimada date, fecha_recepcion date, sucursal text not null,
  fecha_envio_sucursal date, mensajero text, fecha_recepcion_sucursal date,
  recibido_en_sucursal timestamptz, recibido_por uuid references auth.users(id),
  recibido_por_nombre text, sucursal_recibida text,
  sucursal_id uuid references public.sucursales(id), version integer not null default 1,
  creado_por uuid references auth.users(id), actualizado_por uuid references auth.users(id),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  search_text text not null default '',
  constraint fechas_trabajo_validas check (fecha_estimada is null or fecha_envio is null or fecha_estimada >= fecha_envio)
);
create index if not exists trabajos_busqueda_trgm on public.trabajos using gin (search_text gin_trgm_ops);
create index if not exists trabajos_sucursal_estado_fecha on public.trabajos (sucursal_id, fecha_estimada desc);
create index if not exists trabajos_fechas on public.trabajos (fecha_envio_sucursal, fecha_recepcion, fecha_estimada);
create or replace function public.preparar_busqueda_trabajo() returns trigger language plpgsql set search_path=public as $$
begin new.search_text := lower(unaccent(concat_ws(' ',new.id,new.cliente,new.material,new.laboratorio,new.sucursal))); return new; end $$;
create trigger trabajos_busqueda_antes_de_guardar before insert or update of id,cliente,material,laboratorio,sucursal on public.trabajos for each row execute function public.preparar_busqueda_trabajo();

create table if not exists public.opciones (
  id uuid primary key default gen_random_uuid(), tipo text not null check(tipo in ('material','laboratorio','sucursal')),
  valor text not null, activa boolean not null default true, created_at timestamptz not null default now(), unique(tipo,valor)
);
create table if not exists public.auditoria (
  id bigint generated always as identity primary key, ocurrido_en timestamptz not null default now(), usuario_id uuid references auth.users(id),
  sucursal_id uuid references public.sucursales(id), accion text not null, entidad text not null, registro_id text,
  campo text, valor_anterior jsonb, valor_nuevo jsonb, origen text not null default 'web'
);
revoke all on public.auditoria from anon, authenticated;

create or replace function public.mi_perfil() returns table(nombre text,rol text,sucursal_nombre text,activo boolean,permisos text[])
language sql security definer set search_path=public stable as $$
 select p.nombre,p.rol::text,s.nombre,p.activo,
 coalesce(array_agg(rp.permiso) filter(where rp.permiso is not null),array[]::text[])
 from perfiles p left join sucursales s on s.id=p.sucursal_id left join rol_permisos rp on rp.rol=p.rol
 where p.id=auth.uid() group by p.id,s.nombre;
$$;
create or replace function public.tiene_permiso(p_codigo text) returns boolean language sql security definer set search_path=public stable as $$
 select exists(select 1 from perfiles p where p.id=auth.uid() and p.activo and (p.rol='administrador' or exists(select 1 from rol_permisos rp where rp.rol=p.rol and rp.permiso=p_codigo)));
$$;
create or replace function public.es_admin() returns boolean language sql security definer set search_path=public stable as $$ select exists(select 1 from perfiles where id=auth.uid() and activo and rol='administrador'); $$;
create or replace function public.sucursal_actual() returns uuid language sql security definer set search_path=public stable as $$ select sucursal_id from perfiles where id=auth.uid() and activo; $$;

create or replace function public.estatus_trabajo(t public.trabajos) returns text language sql immutable as $$
 select case when t.fecha_recepcion is not null then 'Recibido' when t.fecha_estimada < current_date then 'Retrasado' when t.fecha_envio is not null then 'Enviado' else 'Pendiente' end;
$$;
create or replace function public.estado_mensajeria(t public.trabajos) returns text language sql stable as $$
 select case when t.fecha_recepcion_sucursal is not null then 'Entregado en Sucursal'
 when t.fecha_envio_sucursal is not null and t.fecha_envio_sucursal < current_date then 'Retrasado en Tránsito'
 when t.fecha_envio_sucursal is not null then 'En Tránsito a Sucursal'
 when t.fecha_recepcion is not null then 'Listo para Enviar' else 'N/A' end;
$$;
create or replace function public.fila_trabajo(t public.trabajos, total bigint default null) returns jsonb language sql stable as $$
 select to_jsonb(t) || jsonb_build_object('marcaTemporal',t.marca_temporal,'fechaEnvio',t.fecha_envio,'fechaEstimada',t.fecha_estimada,'fechaRecepcion',t.fecha_recepcion,'fechaEnvioSucursal',t.fecha_envio_sucursal,'fechaRecepcionSucursal',t.fecha_recepcion_sucursal,'estatus',public.estatus_trabajo(t),'estadoMensajeria',public.estado_mensajeria(t),'total_count',total);
$$;

create or replace function public.buscar_trabajos(p_criterio text default null,p_estatus text default null,p_sucursal text default null,p_mensajeria text default null,p_limite int default 50,p_offset int default 0,p_orden text default 'marcaTemporal',p_direccion text default 'desc') returns setof jsonb
language plpgsql security invoker set search_path=public as $$
declare q text; begin
 if not public.tiene_permiso('trabajos.ver') then raise exception 'Sin permiso para consultar trabajos'; end if;
 if p_limite not between 1 and 100 then raise exception 'Límite inválido'; end if;
 q := $sql$select public.fila_trabajo(t,count(*) over()) from trabajos t where (public.es_admin() or t.sucursal_id=public.sucursal_actual()) and ($1 is null or t.search_text like '%'||lower(unaccent($1))||'%') and ($2 is null or public.estatus_trabajo(t)=$2) and ($3 is null or t.sucursal=$3) and ($4 is null or public.estado_mensajeria(t)=$4) order by $sql$ || case when p_orden in ('marcaTemporal','fechaEstimada','cliente','sucursal') then case p_orden when 'marcaTemporal' then 'marca_temporal' when 'fechaEstimada' then 'fecha_estimada' else p_orden end else 'marca_temporal' end || case when lower(p_direccion)='asc' then ' asc' else ' desc' end || ' nulls last limit $5 offset $6';
 return query execute q using nullif(trim(p_criterio),''),p_estatus,p_sucursal,p_mensajeria,p_limite,p_offset;
end $$;
create or replace function public.resumen_trabajos() returns table(pendientes bigint,retrasados bigint,recibidos bigint,enviados bigint) language sql security invoker set search_path=public as $$
 select count(*) filter(where estatus_trabajo(t)='Pendiente'),count(*) filter(where estatus_trabajo(t)='Retrasado'),count(*) filter(where estatus_trabajo(t)='Recibido'),count(*) filter(where estatus_trabajo(t) in('Enviado','Retrasado','Recibido')) from trabajos t where es_admin() or t.sucursal_id=sucursal_actual();
$$;
create sequence if not exists public.trabajo_numero_seq;
create or replace function public.siguiente_id_trabajo() returns text language sql security definer set search_path=public as $$ select 'N-'||to_char(now(),'YYYYMMDD')||'-'||lpad(nextval('trabajo_numero_seq')::text,6,'0'); $$;
create or replace function public.crear_trabajo(p_trabajo jsonb) returns jsonb language plpgsql security definer set search_path=public as $$
declare t trabajos; begin
 if not tiene_permiso('trabajos.crear') then raise exception 'Sin permiso para crear trabajos'; end if;
 insert into trabajos(id,marca_temporal,cliente,material,laboratorio,sucursal,fecha_envio,fecha_estimada,sucursal_id,creado_por,actualizado_por)
 values(coalesce(p_trabajo->>'id',siguiente_id_trabajo()),coalesce((p_trabajo->>'marca_temporal')::date,current_date),trim(p_trabajo->>'cliente'),trim(p_trabajo->>'material'),trim(p_trabajo->>'laboratorio'),trim(p_trabajo->>'sucursal'),nullif(p_trabajo->>'fecha_envio','')::date,nullif(p_trabajo->>'fecha_estimada','')::date,sucursal_actual(),auth.uid(),auth.uid()) returning * into t;
 insert into auditoria(usuario_id,sucursal_id,accion,entidad,registro_id,valor_nuevo) values(auth.uid(),t.sucursal_id,'crear','trabajos',t.id,to_jsonb(t));
 return fila_trabajo(t); end $$;
create or replace function public.actualizar_trabajo_versionado(p_id text,p_version integer,p_cambios jsonb) returns jsonb language plpgsql security definer set search_path=public as $$
declare anterior trabajos; nuevo trabajos; clave text; columna text; begin
 if not tiene_permiso('trabajos.actualizar') then raise exception 'Sin permiso para actualizar trabajos'; end if;
 select * into anterior from trabajos where id=p_id for update; if not found then raise exception 'Trabajo no encontrado'; end if;
 if not es_admin() and anterior.sucursal_id is distinct from sucursal_actual() then raise exception 'Sin acceso a esta sucursal'; end if;
 if anterior.version <> p_version then raise exception 'Conflicto: este trabajo fue modificado por otro usuario'; end if;
 update trabajos set cliente=coalesce(p_cambios->>'cliente',cliente),material=coalesce(p_cambios->>'material',material),laboratorio=coalesce(p_cambios->>'laboratorio',laboratorio),sucursal=coalesce(p_cambios->>'sucursal',sucursal),fecha_envio=case when p_cambios ? 'fechaEnvio' then nullif(p_cambios->>'fechaEnvio','')::date else fecha_envio end,fecha_estimada=case when p_cambios ? 'fechaEstimada' then nullif(p_cambios->>'fechaEstimada','')::date else fecha_estimada end,fecha_recepcion=case when p_cambios ? 'fechaRecepcion' then nullif(p_cambios->>'fechaRecepcion','')::date else fecha_recepcion end,fecha_envio_sucursal=case when p_cambios ? 'fechaEnvioSucursal' then nullif(p_cambios->>'fechaEnvioSucursal','')::date else fecha_envio_sucursal end,fecha_recepcion_sucursal=case when p_cambios ? 'fechaRecepcionSucursal' then nullif(p_cambios->>'fechaRecepcionSucursal','')::date else fecha_recepcion_sucursal end,mensajero=case when p_cambios ? 'mensajero' then nullif(p_cambios->>'mensajero','') else mensajero end,version=version+1,actualizado_por=auth.uid(),updated_at=now() where id=p_id returning * into nuevo;
 for clave in select jsonb_object_keys(p_cambios) loop columna := case clave when 'fechaEnvio' then 'fecha_envio' when 'fechaEstimada' then 'fecha_estimada' when 'fechaRecepcion' then 'fecha_recepcion' when 'fechaEnvioSucursal' then 'fecha_envio_sucursal' when 'fechaRecepcionSucursal' then 'fecha_recepcion_sucursal' else clave end; insert into auditoria(usuario_id,sucursal_id,accion,entidad,registro_id,campo,valor_anterior,valor_nuevo) values(auth.uid(),nuevo.sucursal_id,'actualizar','trabajos',p_id,clave,to_jsonb(anterior)->columna,to_jsonb(nuevo)->columna); end loop;
 return fila_trabajo(nuevo); end $$;

-- Confirma la recepción final en el servidor. La hora y el usuario no se
-- aceptan desde el navegador, por lo que el registro no puede ser alterado.
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

alter table public.trabajos enable row level security; alter table public.opciones enable row level security; alter table public.perfiles enable row level security; alter table public.sucursales enable row level security; alter table public.laboratorios enable row level security; alter table public.auditoria enable row level security;
create policy trabajos_lectura on public.trabajos for select to authenticated using (public.tiene_permiso('trabajos.ver') and (public.es_admin() or sucursal_id=public.sucursal_actual()));
create policy opciones_lectura on public.opciones for select to authenticated using (public.tiene_permiso('trabajos.ver'));
create policy perfiles_propio on public.perfiles for select to authenticated using (id=auth.uid() or public.es_admin());
create policy catalogos_lectura on public.sucursales for select to authenticated using (public.tiene_permiso('trabajos.ver'));
create policy labs_lectura on public.laboratorios for select to authenticated using (public.tiene_permiso('trabajos.ver'));
create policy auditoria_admin on public.auditoria for select to authenticated using (public.es_admin() and public.tiene_permiso('auditoria.ver'));
grant usage on schema public to authenticated; grant select on public.trabajos,public.opciones,public.sucursales,public.laboratorios to authenticated; grant execute on all functions in schema public to authenticated;
alter publication supabase_realtime add table public.trabajos;
