# Óptica — migración a Supabase, ejecutable en GitHub Pages

Esta entrega parte de `PROGRAMITA 1.2`: conserva el HTML, CSS, cálculos de estatus, flujo de detalle, mensajería, exportación CSV, informes y PWA. `data.legacy.json` es la copia inmutable de los 6,199 trabajos fuente; no se publica ni se cachea en producción.

El archivo `.gitignore` impide que `data.legacy.json` y `node_modules` se suban a GitHub. Primero importe los trabajos y luego publíquelos sólo desde Supabase.

## Puesta en marcha

1. Cree un proyecto en Supabase y ejecute `supabase/001_schema.sql` en SQL Editor.
2. En una computadora administrativa, ejecute `npm install` y luego el comando indicado al inicio de `scripts/importar-data.mjs`. La Secret Key se usa sólo en esa computadora y se elimina de la terminal/historial al terminar.
3. Cree el primer usuario en **Authentication > Users**. Después asigne su perfil desde SQL, por ejemplo: `insert into perfiles(id,nombre,rol,activo) values ('UUID-DE-AUTH','Nombre','administrador',true);`.
4. Copie `supabase-config.example.js` a `supabase-config.js` y complete URL y Publishable Key. Esa clave es pública por diseño; RLS controla los datos.
5. Cree un repositorio nuevo en GitHub, suba **el contenido de esta carpeta** a la rama `main` y haga push. El workflow `.github/workflows/deploy-pages.yml` publicará la app automáticamente.
6. En el repositorio abra **Settings → Pages** y seleccione **GitHub Actions** como fuente. Al terminar la acción, GitHub mostrará la URL pública. Configure respaldos antes de producción.

GitHub Pages aloja y ejecuta la interfaz/PWA. No almacena una base de datos ni contraseñas: Supabase guarda usuarios y los trabajos centralizados de forma segura. Esto permite que varias sucursales usen la URL de GitHub sin servidor local.

## Operación y seguridad

- La fuente empresarial pasa a ser PostgreSQL. `localStorage` queda reservado para preferencias de interfaz; no almacena trabajos.
- Las funciones `crear_trabajo` y `actualizar_trabajo_versionado` validan permisos y la segunda exige la versión que vio el usuario. Si cambió, devuelve conflicto sin sobrescribirlo.
- Realtime vuelve a consultar la página al detectar cambios de `trabajos`. RLS limita filas por sucursal salvo administradores.
- La tabla `auditoria` no concede escritura ni borrado a `authenticated`; las funciones registran cambios de campo. Para auditoría también de altas y administración de usuarios, añada los mismos patrones de función, no permisos directos.
- El service worker sólo cachea la carcasa de la app: excluye Supabase y métodos no GET.

`supabase/functions/admin-users/index.ts` contiene el endpoint seguro para crear, activar/desactivar y cambiar perfiles: comprueba el JWT y que quien llama sea administrador antes de usar la clave de servicio que vive sólo en Supabase. Fije el dominio real en la constante CORS antes de desplegarlo.

## Respaldos

Programe copias lógicas de PostgreSQL (por ejemplo `pg_dump` desde una tarea CI con secreto protegido) y pruebe una restauración mensual. Exporte además un CSV de `trabajos` y conserve retención fuera de Supabase. Los planes gratuitos cambian: valide cuotas de base, Auth, Realtime y Pages antes de operar.
