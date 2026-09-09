"use strict";
/* Adaptador incremental: mantiene las funciones y pantallas de app.js, pero
   sustituye data.json/localStorage por Supabase. */
let sb, perfilActual, realtimeChannel;
let debounceBusqueda;

function configuracionValida() {
  return window.OPTICA_SUPABASE && /^https:\/\//.test(OPTICA_SUPABASE.url) && OPTICA_SUPABASE.anonKey;
}
function setConexion(texto, conectado) {
  const el = document.getElementById("connection-status");
  if (el) { el.textContent = texto; el.style.color = conectado ? "#8ee6a5" : "#ffd18b"; }
}
function errorSupabase(error) { return error?.message || "No se pudo completar la operación."; }
function mostrarLogin(error = "") {
  document.getElementById("auth-overlay").hidden = false;
  document.getElementById("auth-error").textContent = error;
}
function ocultarLogin() { document.getElementById("auth-overlay").hidden = true; }
function puede(permiso) { return perfilActual?.rol === "administrador" || (perfilActual?.permisos || []).includes(permiso); }
function fechaISO(valor) { return valor || null; }
function normalizarFila(j) { return { ...j, id: j.id, version: j.version }; }

async function cargarPagina({ buscar = state.trabajosCriterio, pagina = state.trabajosPagina, porPagina = state.trabajosPorPagina } = {}) {
  const { data, error } = await sb.rpc("buscar_trabajos", {
    p_criterio: buscar || null, p_estatus: state.trabajosFiltroEstatus || null,
    p_sucursal: state.trabajosFiltroSucursal || null, p_mensajeria: state.trabajosFiltroMensajeria || null,
    p_limite: porPagina, p_offset: (pagina - 1) * porPagina,
    p_orden: state.trabajosOrden.campo, p_direccion: state.trabajosOrden.dir
  });
  if (error) throw error;
  JOBS = (data || []).map(normalizarFila);
  state.totalRemoto = Number(data?.[0]?.total_count || 0);
  return state.totalRemoto;
}
async function cargarResumen() {
  const { data, error } = await sb.rpc("resumen_trabajos");
  if (error) throw error;
  return data?.[0] || { pendientes: 0, retrasados: 0, recibidos: 0, enviados: 0 };
}
async function cargarOpcionesRemotas() {
  const { data, error } = await sb.from("opciones").select("tipo,valor").eq("activa", true).order("valor");
  if (error) throw error;
  OPCIONES = { material:{agregadas:[],eliminadas:[]}, laboratorio:{agregadas:[],eliminadas:[]}, sucursal:{agregadas:[],eliminadas:[]} };
  (data || []).forEach(x => { if (OPCIONES[x.tipo]) OPCIONES[x.tipo].agregadas.push(x.valor); });
}

/* Escritura atómica con control optimista: el RPC sólo actualiza si la versión
   continúa siendo la que el usuario abrió. */
actualizarCampo = async function(id, campo, valor) {
  if (!puede("trabajos.actualizar")) return mostrarToast("No tiene permiso para modificar trabajos.");
  const actual = JOBS.find(x => x.id === id);
  if (!actual) return;
  const { data, error } = await sb.rpc("actualizar_trabajo_versionado", {
    p_id: id, p_version: actual.version, p_cambios: { [campo]: valor || null }
  });
  if (error) return manejarErrorEdicion(error, id);
  Object.assign(actual, data); refresh(); abrirDetalle(id); mostrarToast("Cambio guardado.");
};
function manejarErrorEdicion(error, id) {
  if (error.code === "P0001" && /conflicto/i.test(error.message)) {
    mostrarToast("Este trabajo cambió en otra sesión. Se recargó para evitar sobrescribirlo.");
    cargarDetalleActualizado(id); return;
  }
  mostrarToast(errorSupabase(error));
}
async function cargarDetalleActualizado(id) {
  const { data, error } = await sb.from("trabajos").select("*").eq("id", id).single();
  if (!error) { const i = JOBS.findIndex(x => x.id === id); if (i >= 0) JOBS[i] = normalizarFila(data); refresh(); abrirDetalle(id); }
}
guardarNuevoTrabajo = async function() {
  if (!puede("trabajos.crear")) return mostrarToast("No tiene permiso para crear trabajos.");
  const cliente = document.getElementById("nf-cliente").value.trim();
  const material = document.getElementById("nf-material").value.trim();
  const laboratorio = document.getElementById("nf-laboratorio").value.trim();
  const sucursal = document.getElementById("nf-sucursal").value.trim();
  if (!cliente || !material || !laboratorio || !sucursal) return mostrarToast("Complete cliente, material, laboratorio y sucursal.");
  const { data, error } = await sb.rpc("crear_trabajo", { p_trabajo: {
    cliente, material, laboratorio, sucursal, fecha_envio: fechaISO(document.getElementById("nf-envio").value),
    fecha_estimada: fechaISO(document.getElementById("nf-estimada").value)
  }});
  if (error) return mostrarToast(errorSupabase(error));
  cerrarDetalle(); await recargarVista(); mostrarToast(`Trabajo ${data.id} registrado.`);
};
restablecerDatosLocales = function() { localStorage.removeItem("optica_ui_v1"); mostrarToast("Se restablecieron únicamente preferencias locales."); };

async function recargarVista() {
  try { await cargarPagina(); refresh(); setConexion("● En línea", true); } catch (e) { setConexion("● Sin conexión", false); mostrarToast(errorSupabase(e)); }
}
async function buscarEnServidor(criterio) {
  state.trabajosCriterio = criterio; state.trabajosPagina = 1;
  await recargarVista();
}
function suscribirRealtime() {
  realtimeChannel?.unsubscribe();
  realtimeChannel = sb.channel("trabajos-visibles")
    .on("postgres_changes", { event: "*", schema: "public", table: "trabajos" }, () => {
      clearTimeout(debounceBusqueda); debounceBusqueda = setTimeout(recargarVista, 300);
    }).subscribe(status => setConexion(status === "SUBSCRIBED" ? "● En línea" : "● Reconectando…", status === "SUBSCRIBED"));
}
/* La tabla conserva su HTML original; estas acciones cambian la página remota
   antes de redibujarla, en vez de filtrar los 6,199 registros en el navegador. */
const ordenarPorLegado = ordenarPor;
ordenarPor = async function(campo) {
  if (state.trabajosOrden.campo === campo) state.trabajosOrden.dir = state.trabajosOrden.dir === "asc" ? "desc" : "asc";
  else state.trabajosOrden = { campo, dir: "asc" };
  state.trabajosPagina = 1; await recargarVista();
};
cambiarPagina = async function(delta) { state.trabajosPagina += delta; await recargarVista(); };
document.addEventListener("input", e => {
  if (!sb || !["buscar-input", "trabajos-input"].includes(e.target.id)) return;
  clearTimeout(debounceBusqueda);
  debounceBusqueda = setTimeout(async () => { state.trabajosCriterio = e.target.value; state.trabajosPagina = 1; await recargarVista(); }, 300);
});
document.addEventListener("change", e => {
  if (!sb || !["filtro-estatus", "filtro-sucursal", "filtro-mensajeria"].includes(e.target.id)) return;
  setTimeout(() => recargarVista(), 0);
});
const renderDashboardLegado = renderDashboard;
renderDashboard = function() {
  renderDashboardLegado();
  if (!sb) return;
  cargarResumen().then(r => {
    const n = document.querySelectorAll("#view-dashboard .kpi .n");
    if (n.length >= 4) [r.pendientes,r.retrasados,r.recibidos,r.enviados].forEach((v,i) => n[i].textContent = v);
  }).catch(() => {});
};
async function iniciarSupabase() {
  if (!configuracionValida() || !window.supabase) {
    document.getElementById("view-dashboard").innerHTML = '<div class="empty-state"><div class="big">Falta configurar Supabase</div><div>Copie <code>supabase-config.example.js</code> como <code>supabase-config.js</code> y complete URL y anon key.</div></div>';
    return;
  }
  sb = window.supabase.createClient(OPTICA_SUPABASE.url, OPTICA_SUPABASE.anonKey, { auth: { persistSession: true, autoRefreshToken: true } });
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return mostrarLogin();
  await entrar(session.user);
}
async function entrar(usuario) {
  const { data, error } = await sb.rpc("mi_perfil");
  if (error || !data?.[0]?.activo) return mostrarLogin(error ? errorSupabase(error) : "Su usuario no está activo.");
  perfilActual = { ...data[0], permisos: data[0].permisos || [] };
  document.getElementById("session-user").textContent = `${perfilActual.nombre || usuario.email} · ${perfilActual.rol} · ${perfilActual.sucursal_nombre || "Sin sucursal"}`;
  document.getElementById("logout-button").hidden = false; ocultarLogin();
  await cargarOpcionesRemotas(); await recargarVista(); suscribirRealtime(); irA("dashboard");
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
}
document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("login-form").addEventListener("submit", async e => {
    e.preventDefault(); const email = document.getElementById("login-email").value; const password = document.getElementById("login-password").value;
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) return mostrarLogin(errorSupabase(error)); await entrar(data.user);
  });
  document.getElementById("logout-button").addEventListener("click", async () => { await sb.auth.signOut(); location.reload(); });
  iniciarSupabase().catch(e => mostrarLogin(errorSupabase(e)));
});
