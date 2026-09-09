// Deploy: supabase functions deploy admin-users --no-verify-jwt
// Secrets required in Supabase: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.8";
const cors = { "Access-Control-Allow-Origin": "https://TU-DOMINIO.pages.dev", "Access-Control-Allow-Headers": "authorization, content-type" };
Deno.serve(async req => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const auth = req.headers.get("Authorization");
  if (!auth) return Response.json({ error: "No autenticado" }, { status: 401, headers: cors });
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const token = auth.replace(/^Bearer\s+/i, ""); const { data: usuario } = await admin.auth.getUser(token);
  if (!usuario.user) return Response.json({ error: "Sesión inválida" }, { status: 401, headers: cors });
  const { data: solicitante } = await admin.from("perfiles").select("rol,activo").eq("id", usuario.user.id).single();
  if (!solicitante?.activo || solicitante.rol !== "administrador") return Response.json({ error: "Sin permiso" }, { status: 403, headers: cors });
  const body = await req.json();
  if (body.accion === "crear") {
    const { email, password, nombre, rol, sucursal_id } = body;
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (error) return Response.json({ error: error.message }, { status: 400, headers: cors });
    const { error: perfilError } = await admin.from("perfiles").insert({ id:data.user.id, nombre, rol, sucursal_id, activo:true });
    if (perfilError) { await admin.auth.admin.deleteUser(data.user.id); return Response.json({ error: perfilError.message }, { status:400, headers:cors }); }
    return Response.json({ id:data.user.id }, { headers:cors });
  }
  if (body.accion === "actualizar") {
    const permitidos = (({ nombre, rol, sucursal_id, activo }) => ({ nombre, rol, sucursal_id, activo }))(body);
    const { error } = await admin.from("perfiles").update(permitidos).eq("id", body.id);
    return error ? Response.json({ error:error.message },{status:400,headers:cors}) : Response.json({ ok:true },{headers:cors});
  }
  return Response.json({ error:"Acción inválida" }, { status:400,headers:cors });
});
