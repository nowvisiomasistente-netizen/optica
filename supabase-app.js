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
function normalizarFila(j) {
  const fila = {
    ...j,
    marcaTemporal: j.marcaTemporal ?? j.marca_temporal,
    fechaEnvio: j.fechaEnvio ?? j.fecha_envio,
    fechaEstimada: j.fechaEstimada ?? j.fecha_estimada,
    fechaRecepcion: j.fechaRecepcion ?? j.fecha_recepcion,
    fechaEnvioSucursal: j.fechaEnvioSucursal ?? j.fecha_envio_sucursal,
    fechaRecepcionSucursal: j.fechaRecepcionSucursal ?? j.fecha_recepcion_sucursal,
    id: j.id,
    version: j.version
  };
  const estado = calcularEstatusYTiempo(fila.fechaEnvio, fila.fechaEstimada, fila.fechaRecepcion, new Date());
  return {
    ...fila,
    estatus: j.estatus ?? estado.estatus,
    estadoTiempo: estado.estadoTiempo,
    estadoMensajeria: j.estadoMensajeria ?? calcularEstadoMensajeria(estado.estatus, fila.fechaEnvioSucursal, fila.fechaRecepcionSucursal, new Date())
  };
}

// En modo Supabase, JOBS ya contiene la página recibida del servidor. No lo
// reconstruya desde la antigua fuente local vacía.
const refreshLocalLegado = refresh;
refresh = function() { renderView(); };

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
async function contarTrabajosRemotos() {
  const { count, error } = await sb.from("trabajos").select("id", { count: "exact", head: true });
  if (error) throw error;
  return count || 0;
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
  Object.assign(actual, normalizarFila(data)); refresh(); abrirDetalle(id); mostrarToast("Cambio guardado.");
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
  state.trabajosCriterio = "";
  state.trabajosFiltroEstatus = "";
  state.trabajosFiltroSucursal = "";
  state.trabajosFiltroMensajeria = "";
  state.trabajosPagina = 1;
  cerrarDetalle(); await recargarVista(); mostrarToast(`Trabajo ${data.id} registrado y visible en la lista.`);
};
restablecerDatosLocales = function() { localStorage.removeItem("optica_ui_v1"); mostrarToast("Se restablecieron únicamente preferencias locales."); };

async function recargarVista() {
  try { await cargarPagina(); refresh(); setConexion("● En línea", true); } catch (e) { setConexion("● Sin conexión", false); mostrarToast(errorSupabase(e)); }
}
async function buscarEnServidor(criterio) {
  state.buscarCriterio = criterio;
  state.trabajosCriterio = criterio;
  state.trabajosPagina = 1;
  await recargarVista();
}

const ETIQUETAS_AUDITORIA = {
  cliente: "Cliente", material: "Material", laboratorio: "Laboratorio", sucursal: "Sucursal",
  fechaEnvio: "Fecha de envío al laboratorio", fechaEstimada: "Fecha estimada de entrega",
  fechaRecepcion: "Fecha de recepción del laboratorio", fechaEnvioSucursal: "Fecha de envío a sucursal",
  fechaRecepcionSucursal: "Fecha de recepción en sucursal", mensajero: "Mensajero"
};
function valorAuditoria(valor) {
  if (valor === null || valor === undefined || valor === "") return "Vacío";
  if (typeof valor === "string") return valor;
  return JSON.stringify(valor);
}
function fechaHoraAuditoria(valor) {
  return new Intl.DateTimeFormat("es-DO", { dateStyle: "medium", timeStyle: "short" }).format(new Date(valor));
}
function renderHistorialAuditoria(movimientos) {
  if (!movimientos.length) return '<div style="font-size:12.5px;color:var(--text-muted);">Aún no hay movimientos registrados.</div>';
  return `<div style="display:flex;flex-direction:column;gap:10px;">${movimientos.map(m => {
    const esAlta = m.accion === "crear";
    const titulo = esAlta ? "Trabajo registrado" : `Editó: ${ETIQUETAS_AUDITORIA[m.campo] || m.campo || "Trabajo"}`;
    const detalle = esAlta ? "Registro creado en el sistema" : `${valorAuditoria(m.valor_anterior)} → ${valorAuditoria(m.valor_nuevo)}`;
    return `<div class="audit-item"><div class="audit-title">${esc(titulo)}</div><div class="audit-meta">${esc(detalle)}</div><div class="audit-meta">${esc(fechaHoraAuditoria(m.ocurrido_en))} · ${esc(m.usuario || "Usuario")}</div></div>`;
  }).join("")}</div>`;
}
async function cargarHistorialTrabajo(id) {
  const contenedor = document.getElementById("historial-auditoria");
  if (!contenedor) return;
  contenedor.innerHTML = '<div style="font-size:12.5px;color:var(--text-muted);">Cargando historial…</div>';
  const { data, error } = await sb.rpc("historial_trabajo", { p_id: id });
  if (!document.getElementById("historial-auditoria")) return;
  contenedor.innerHTML = error
    ? '<div style="font-size:12.5px;color:var(--text-muted);">El historial estará disponible después de aplicar la actualización de base de datos.</div>'
    : renderHistorialAuditoria(data || []);
}
const abrirDetalleLegado = abrirDetalle;
abrirDetalle = function(id) {
  abrirDetalleLegado(id);
  cargarHistorialTrabajo(id);
};
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
document.addEventListener("keydown", e => {
  if (!sb || !["buscar-input", "trabajos-input"].includes(e.target.id)) return;
  if (e.key !== "Enter") return;
  e.preventDefault();
  if (e.target.id === "buscar-input") return buscarEnServidor(e.target.value);
  window.buscarTrabajosRemoto();
});
document.addEventListener("change", e => {
  if (!sb || !["filtro-estatus", "filtro-sucursal", "filtro-mensajeria"].includes(e.target.id)) return;
  setTimeout(() => recargarVista(), 0);
});
const renderDashboardLegado = renderDashboard;
renderDashboard = function() {
  renderDashboardLegado();
  if (!sb) return;
  Promise.all([cargarResumen(), contarTrabajosRemotos()]).then(([r, total]) => {
    const n = document.querySelectorAll("#view-dashboard .kpi .n");
    if (n.length >= 8) {
      [r.pendientes, r.retrasados, r.recibidos, r.enviados].forEach((v, i) => n[i].textContent = v);
      n[7].textContent = total;
    }
  }).catch(() => {});
};
window.buscarTrabajosRemoto = async function() {
  const input = document.getElementById("trabajos-input");
  state.trabajosCriterio = input?.value.trim() || "";
  state.trabajosPagina = 1;
  await recargarVista();
};
renderBuscar = function() {
  const el = document.getElementById("view-buscar");
  const criterio = state.buscarCriterio || "";
  const resultados = criterio.trim() ? JOBS : [];
  el.innerHTML = `
    <div class="panel"><div class="panel-body">
      <div class="toolbar"><div class="search-box"><span class="ic">🔍</span>
        <input type="text" id="buscar-input" placeholder="Cliente, material, laboratorio o sucursal…" value="${escapeAttr(criterio)}" autofocus />
      </div><button class="btn primary" onclick="buscarEnServidor(document.getElementById('buscar-input').value)">Buscar</button></div>
      ${criterio.trim() ? `<div style="color:var(--text-muted);font-size:12.5px;margin-bottom:8px;">${state.totalRemoto || 0} resultado(s)</div>` : ""}
      ${renderTablaResultados(resultados, criterio.trim() ? null : "Escriba un criterio y pulse Buscar.")}
    </div></div>`;
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
