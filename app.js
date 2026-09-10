"use strict";

/* ============================================================
   ESTADO Y PERSISTENCIA
   - data.json trae la base real (6,199 trabajos) como solo lectura.
   - Todo cambio (ediciones, mensajería, trabajos nuevos) se guarda
     en localStorage como una capa de "overrides" encima de la base,
     igual que una hoja de cálculo con "columnas nuevas": nunca se
     reescribe el archivo original.
   ============================================================ */
const LS_OVERRIDES = "optica_overrides_v1";
const LS_NUEVOS = "optica_nuevos_v1";
const LS_OPCIONES = "optica_opciones_v1";

const CAMPOS_LISTA = { material: "Material", laboratorio: "Laboratorio", sucursal: "Sucursal" };
let OPCIONES = {}; // { material: {agregadas:[], eliminadas:[]}, laboratorio:{...}, sucursal:{...} }

function cargarOpciones() {
  try { OPCIONES = JSON.parse(localStorage.getItem(LS_OPCIONES) || "{}"); } catch { OPCIONES = {}; }
  Object.keys(CAMPOS_LISTA).forEach(c => {
    OPCIONES[c] = OPCIONES[c] || { agregadas: [], eliminadas: [] };
  });
}
function guardarOpciones() { localStorage.setItem(LS_OPCIONES, JSON.stringify(OPCIONES)); }

/* Lista final de opciones para un campo: valores reales de los trabajos + agregadas
   a mano, menos las que el usuario decidió eliminar de la lista de sugerencias. */
function opcionesUnicas(campo) {
  const deBase = [...new Set(JOBS.map(j => j[campo]).filter(Boolean))];
  const agregadas = OPCIONES[campo]?.agregadas || [];
  const eliminadas = new Set((OPCIONES[campo]?.eliminadas || []).map(v => v.toLowerCase()));
  return [...new Set([...deBase, ...agregadas])]
    .filter(v => !eliminadas.has(v.toLowerCase()))
    .sort((a, b) => a.localeCompare(b));
}
function agregarOpcion(campo, valor) {
  valor = (valor || "").trim();
  if (!valor) return;
  const yaExiste = opcionesUnicas(campo).some(v => v.toLowerCase() === valor.toLowerCase());
  if (!yaExiste) {
    OPCIONES[campo].agregadas.push(valor);
    OPCIONES[campo].eliminadas = OPCIONES[campo].eliminadas.filter(v => v.toLowerCase() !== valor.toLowerCase());
    guardarOpciones();
  }
}
function eliminarOpcion(campo, valor) {
  if (!OPCIONES[campo].eliminadas.some(v => v.toLowerCase() === valor.toLowerCase())) {
    OPCIONES[campo].eliminadas.push(valor);
  }
  OPCIONES[campo].agregadas = OPCIONES[campo].agregadas.filter(v => v.toLowerCase() !== valor.toLowerCase());
  guardarOpciones();
}

const CORREOS_INFORME = ["labnowsion@gmail.com", "fralvarado@gmail.com", "nowvisiomasistente@gmail.com"];
const UMBRAL_HORAS_MENSAJERIA = 24;

let BASE = [];
let OVERRIDES = {};
let NUEVOS = [];
let JOBS = []; // BASE + OVERRIDES + NUEVOS, recalculado en cada refresh()

const state = {
  view: "dashboard",
  buscarCriterio: "",
  trabajosCriterio: "",
  trabajosFiltroEstatus: "",
  trabajosFiltroSucursal: "",
  trabajosFiltroMensajeria: "",
  trabajosPagina: 1,
  trabajosPorPagina: 50,
  trabajosOrden: { campo: "marcaTemporal", dir: "desc" },
  informeTab: "critico",
  informeFecha: "",
};

/* ============================================================ */
function cargarOverrides() {
  try { OVERRIDES = JSON.parse(localStorage.getItem(LS_OVERRIDES) || "{}"); } catch { OVERRIDES = {}; }
  try { NUEVOS = JSON.parse(localStorage.getItem(LS_NUEVOS) || "[]"); } catch { NUEVOS = []; }
}
function guardarOverrides() { localStorage.setItem(LS_OVERRIDES, JSON.stringify(OVERRIDES)); }
function guardarNuevos() { localStorage.setItem(LS_NUEVOS, JSON.stringify(NUEVOS)); }

function actualizarCampo(id, campo, valor) {
  const esNuevo = NUEVOS.find(j => j.id === id);
  if (esNuevo) {
    esNuevo[campo] = valor || null;
    guardarNuevos();
  } else {
    OVERRIDES[id] = OVERRIDES[id] || {};
    OVERRIDES[id][campo] = valor || null;
    guardarOverrides();
  }
  refresh();
}

/* ============================================================
   LÓGICA DE NEGOCIO (misma que el sistema original)
   ============================================================ */
function calcularEstatusYTiempo(fechaEnvio, fechaEstimada, fechaRecepcion, hoy) {
  let estatus = "Pendiente";
  if (fechaRecepcion) estatus = "Recibido";
  else if (fechaEstimada && new Date(fechaEstimada) < hoy) estatus = "Retrasado";
  else if (fechaEnvio) estatus = "Enviado";

  let estadoTiempo;
  if (estatus === "Recibido") estadoTiempo = "Listo";
  else if (estatus === "Retrasado") estadoTiempo = "Retrasado";
  else if (estatus === "Enviado" && fechaEstimada) {
    const dias = Math.ceil((new Date(fechaEstimada) - hoy) / 86400000);
    estadoTiempo = (dias <= 2 && dias >= 0) ? "Próximo a Vencer" : "En Tiempo";
  } else estadoTiempo = "En Tiempo";
  return { estatus, estadoTiempo };
}

function calcularEstadoMensajeria(estatusLab, fechaEnvioSuc, fechaRecepcionSuc, ahora) {
  if (estatusLab !== "Recibido") return "N/A";
  if (fechaRecepcionSuc) return "Entregado en Sucursal";
  if (fechaEnvioSuc) {
    const horas = (ahora - new Date(fechaEnvioSuc)) / 3600000;
    return horas > UMBRAL_HORAS_MENSAJERIA ? "Retrasado en Tránsito" : "En Tránsito a Sucursal";
  }
  return "Listo para Enviar";
}

function normalizarTexto(v) {
  return String(v || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ").trim().toLowerCase();
}
function formatearFecha(iso) {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}
function formatearFechaHora(valor) {
  if (!valor) return "—";
  return new Intl.DateTimeFormat("es-DO", { dateStyle: "short", timeStyle: "short" }).format(new Date(valor));
}
function hoyISO() { return new Date().toISOString().slice(0, 10); }

/* Recalcula estatus/estadoTiempo/estadoMensajeria para TODOS los trabajos */
function refresh() {
  const hoy = new Date();
  const base = BASE.map(j => ({ ...j, ...(OVERRIDES[j.id] || {}) }));
  JOBS = base.concat(NUEVOS).map(j => {
    const { estatus, estadoTiempo } = calcularEstatusYTiempo(j.fechaEnvio, j.fechaEstimada, j.fechaRecepcion, hoy);
    const estadoMensajeria = calcularEstadoMensajeria(estatus, j.fechaEnvioSucursal, j.fechaRecepcionSucursal, hoy);
    return { ...j, estatus, estadoTiempo, estadoMensajeria };
  });
  renderView();
}

/* ============================================================
   PILLS DE ESTADO
   ============================================================ */
const PILL_CLASS = {
  Recibido: "green", Enviado: "blue", Retrasado: "red", Pendiente: "gray",
  Listo: "green", "En Tiempo": "blue", "Próximo a Vencer": "amber",
  "Entregado en Sucursal": "green", "En Tránsito a Sucursal": "blue",
  "Retrasado en Tránsito": "red", "Listo para Enviar": "amber", "N/A": "gray",
};
function pill(texto) {
  const cls = String(texto).startsWith("Recibido por:") ? "green" : (PILL_CLASS[texto] || "gray");
  return `<span class="pill ${cls}">${texto}</span>`;
}

/* ============================================================
   NAVEGACIÓN
   ============================================================ */
function irA(vista) {
  state.view = vista;
  document.querySelectorAll(".nav-item").forEach(b => b.classList.toggle("active", b.dataset.view === vista));
  document.querySelectorAll(".view").forEach(v => v.classList.toggle("active", v.id === "view-" + vista));
  renderView();
}

function renderView() {
  if (state.view === "dashboard") renderDashboard();
  else if (state.view === "buscar") renderBuscar();
  else if (state.view === "trabajos") renderTrabajos();
  else if (state.view === "informe") renderInforme();
}

/* ============================================================
   DASHBOARD
   ============================================================ */
function renderDashboard() {
  const el = document.getElementById("view-dashboard");
  const totalPendientes = JOBS.filter(j => j.estatus === "Pendiente").length;
  const totalRetrasados = JOBS.filter(j => j.estatus === "Retrasado").length;
  const totalRecibidos = JOBS.filter(j => j.estatus === "Recibido").length;
  const totalEnviados = JOBS.filter(j => ["Enviado", "Retrasado", "Recibido"].includes(j.estatus)).length;

  const porLab = {};
  JOBS.forEach(j => {
    if (!j.laboratorio) return;
    porLab[j.laboratorio] = porLab[j.laboratorio] || { pendientes: 0, retrasados: 0, total: 0 };
    porLab[j.laboratorio].total++;
    if (j.estatus === "Pendiente") porLab[j.laboratorio].pendientes++;
    if (j.estatus === "Retrasado") porLab[j.laboratorio].retrasados++;
  });
  const labsOrdenados = Object.entries(porLab).sort((a, b) => b[1].total - a[1].total);

  const listosParaEnviar = JOBS.filter(j => j.estadoMensajeria === "Listo para Enviar").length;
  const enTransito = JOBS.filter(j => j.estadoMensajeria === "En Tránsito a Sucursal").length;
  const retrasadosMsj = JOBS.filter(j => j.estadoMensajeria === "Retrasado en Tránsito").length;

  el.innerHTML = `
    <div class="kpi-row">
      <div class="kpi pendientes"><div class="n">${totalPendientes}</div><div class="l">Pendientes (laboratorio)</div></div>
      <div class="kpi retrasados"><div class="n">${totalRetrasados}</div><div class="l">Retrasados (laboratorio)</div></div>
      <div class="kpi recibidos"><div class="n">${totalRecibidos}</div><div class="l">Recibidos</div></div>
      <div class="kpi enviados"><div class="n">${totalEnviados}</div><div class="l">Enviados totales</div></div>
    </div>

    <div class="kpi-row">
      <div class="kpi" style="border-left-color:var(--amber-txt)"><div class="n">${listosParaEnviar}</div><div class="l">Listos para enviar a sucursal</div></div>
      <div class="kpi" style="border-left-color:var(--blue-txt)"><div class="n">${enTransito}</div><div class="l">En tránsito a sucursal</div></div>
      <div class="kpi" style="border-left-color:var(--red-txt)"><div class="n">${retrasadosMsj}</div><div class="l">Retrasados en tránsito</div></div>
      <div class="kpi" style="border-left-color:var(--primary)"><div class="n">${JOBS.length}</div><div class="l">Trabajos totales en el sistema</div></div>
    </div>

    <div class="grid-2">
      <div class="panel">
        <div class="panel-head"><h2>Trabajos por laboratorio</h2></div>
        <div class="panel-body">
          <div class="table-wrap"><table>
            <thead><tr><th>Laboratorio</th><th>Total</th><th>Pendientes</th><th>Retrasados</th></tr></thead>
            <tbody>
              ${labsOrdenados.map(([lab, s]) => `<tr><td>${lab}</td><td>${s.total}</td><td>${s.pendientes}</td><td>${s.retrasados}</td></tr>`).join("")}
            </tbody>
          </table></div>
        </div>
      </div>
      <div class="panel">
        <div class="panel-head"><h2>Acciones rápidas</h2></div>
        <div class="panel-body" style="display:flex;flex-direction:column;gap:10px;">
          <button class="btn primary" onclick="irA('informe')">Ver informe crítico</button>
          <button class="btn" onclick="irATrabajosConFiltroMensajeria('Listo para Enviar')">Ver envíos pendientes hoy</button>
          <button class="btn" onclick="irA('trabajos')">Ver todos los trabajos</button>
          <button class="btn" onclick="abrirFormularioNuevo()">+ Registrar trabajo nuevo</button>
        </div>
      </div>
    </div>
  `;
}

/* ============================================================
   BÚSQUEDA
   ============================================================ */
function coincide(job, criterio) {
  const c = normalizarTexto(criterio);
  const cliente = normalizarTexto(job.cliente), material = normalizarTexto(job.material);
  const lab = normalizarTexto(job.laboratorio), suc = normalizarTexto(job.sucursal);
  return { exacto: cliente === c, parcial: cliente.includes(c) || material.includes(c) || lab.includes(c) || suc.includes(c) };
}

function renderBuscar() {
  const el = document.getElementById("view-buscar");
  const criterio = state.buscarCriterio;
  let resultados = [];
  if (criterio.trim()) {
    const exactos = [], parciales = [];
    JOBS.forEach(j => {
      const m = coincide(j, criterio);
      if (m.exacto) exactos.push(j); else if (m.parcial) parciales.push(j);
    });
    resultados = exactos.concat(parciales).slice(0, 300);
  }

  el.innerHTML = `
    <div class="panel">
      <div class="panel-body">
        <div class="toolbar">
          <div class="search-box">
            <span class="ic">🔍</span>
            <input type="text" id="buscar-input" placeholder="Cliente, material, laboratorio o sucursal…" value="${escapeAttr(criterio)}" autofocus />
          </div>
        </div>
        ${criterio.trim() ? `<div style="color:var(--text-muted);font-size:12.5px;margin-bottom:8px;">${resultados.length} resultado(s)${resultados.length === 300 ? " (mostrando los primeros 300)" : ""}</div>` : ""}
        ${renderTablaResultados(resultados, criterio.trim() ? null : "Escriba arriba para buscar entre los " + JOBS.length + " trabajos registrados.")}
      </div>
    </div>
  `;
  const input = document.getElementById("buscar-input");
  input.addEventListener("input", (e) => { state.buscarCriterio = e.target.value; renderBuscar(); preservarFoco("buscar-input"); });
}

function renderTablaResultados(rows, vacioMsg) {
  if (!rows.length) {
    return `<div class="empty-state"><div class="big">Sin resultados</div>${vacioMsg ? `<div>${vacioMsg}</div>` : "<div>Pruebe con otro nombre, material, laboratorio o sucursal.</div>"}</div>`;
  }
  return `<div class="table-wrap"><table>
    <thead><tr><th>Cliente</th><th>Material</th><th>Laboratorio</th><th>Sucursal</th><th>Estatus</th><th>Estado tiempo</th><th>Mensajería</th><th></th></tr></thead>
    <tbody>
      ${rows.map(j => `<tr>
        <td>${esc(j.cliente)}</td><td>${esc(j.material)}</td><td>${esc(j.laboratorio)}</td><td>${esc(j.sucursal)}</td>
        <td>${pill(j.estatus)}</td><td>${pill(j.estadoTiempo)}</td><td>${pill(j.estadoMensajeria)}</td>
        <td><button class="btn small" onclick="abrirDetalle('${j.id}')">Ver</button></td>
      </tr>`).join("")}
    </tbody>
  </table></div>`;
}

/* ============================================================
   TRABAJOS (tabla completa, paginada, filtrable)
   ============================================================ */
function renderTrabajos() {
  const el = document.getElementById("view-trabajos");
  let filas = JOBS.slice();

  if (state.trabajosCriterio.trim()) {
    const c = state.trabajosCriterio;
    filas = filas.filter(j => coincide(j, c).exacto || coincide(j, c).parcial);
  }
  if (state.trabajosFiltroEstatus) filas = filas.filter(j =>
    j.estatus === state.trabajosFiltroEstatus ||
    (state.trabajosFiltroEstatus === "Recibido" && String(j.estatus).startsWith("Recibido por:"))
  );
  if (state.trabajosFiltroSucursal) filas = filas.filter(j => j.sucursal === state.trabajosFiltroSucursal);
  if (state.trabajosFiltroMensajeria) filas = filas.filter(j => j.estadoMensajeria === state.trabajosFiltroMensajeria);

  const { campo, dir } = state.trabajosOrden;
  filas.sort((a, b) => {
    let va = a[campo] || "", vb = b[campo] || "";
    if (va < vb) return dir === "asc" ? -1 : 1;
    if (va > vb) return dir === "asc" ? 1 : -1;
    return 0;
  });

  const total = state.totalRemoto ?? filas.length;
  const totalPaginas = Math.max(1, Math.ceil(total / state.trabajosPorPagina));
  state.trabajosPagina = Math.min(state.trabajosPagina, totalPaginas);
  const inicio = (state.trabajosPagina - 1) * state.trabajosPorPagina;
  const pagina = state.totalRemoto == null ? filas.slice(inicio, inicio + state.trabajosPorPagina) : filas;

  const sucursales = [...new Set(JOBS.map(j => j.sucursal).filter(Boolean))].sort();

  el.innerHTML = `
    <div class="panel">
      <div class="panel-body">
        <div class="toolbar">
          <div class="search-box"><span class="ic">🔍</span>
            <input type="text" id="trabajos-input" placeholder="Buscar en la tabla…" value="${escapeAttr(state.trabajosCriterio)}" /></div>
          <button class="btn" onclick="buscarTrabajosRemoto()">Buscar</button>
          <select id="filtro-estatus">
            <option value="">Todos los estatus</option>
            ${["Pendiente", "Enviado", "Retrasado", "Recibido"].map(s => `<option value="${s}" ${state.trabajosFiltroEstatus === s ? "selected" : ""}>${s}</option>`).join("")}
          </select>
          <select id="filtro-sucursal">
            <option value="">Todas las sucursales</option>
            ${sucursales.map(s => `<option value="${esc(s)}" ${state.trabajosFiltroSucursal === s ? "selected" : ""}>${esc(s)}</option>`).join("")}
          </select>
          <select id="filtro-mensajeria">
            <option value="">Toda la mensajería</option>
            ${["Listo para Enviar", "En Tránsito a Sucursal", "Retrasado en Tránsito", "Entregado en Sucursal", "N/A"].map(s => `<option value="${s}" ${state.trabajosFiltroMensajeria === s ? "selected" : ""}>${s}</option>`).join("")}
          </select>
          <button class="btn accent" onclick="abrirFormularioNuevo()">+ Nuevo trabajo</button>
          <button class="btn" onclick="exportarCSV()">Exportar CSV</button>
        </div>
        <div style="color:var(--text-muted);font-size:12.5px;margin-bottom:8px;">${total} trabajo(s) encontrados</div>
        <div class="table-wrap"><table>
          <thead><tr>
            <th onclick="ordenarPor('cliente')">Cliente ⇅</th>
            <th onclick="ordenarPor('material')">Material ⇅</th>
            <th onclick="ordenarPor('laboratorio')">Laboratorio ⇅</th>
            <th onclick="ordenarPor('sucursal')">Sucursal ⇅</th>
            <th onclick="ordenarPor('fechaEstimada')">Fecha estimada ⇅</th>
            <th>Estatus</th><th>Estado tiempo</th><th>Mensajería</th><th></th>
          </tr></thead>
          <tbody>
            ${pagina.map(j => `<tr>
              <td>${esc(j.cliente)}</td><td>${esc(j.material)}</td><td>${esc(j.laboratorio)}</td><td>${esc(j.sucursal)}</td>
              <td>${formatearFecha(j.fechaEstimada)}</td>
              <td>${pill(j.estatus)}</td><td>${pill(j.estadoTiempo)}</td><td>${pill(j.estadoMensajeria)}</td>
              <td><div class="table-actions">
                <button class="btn small" onclick="abrirDetalle('${j.id}')">Ver / Editar</button>
                ${j.recibidoEnSucursal
                  ? `<button class="btn small received" disabled title="${escapeAttr(`Recibido el ${formatearFechaHora(j.recibidoEnSucursal)} en ${j.sucursalRecibida || j.sucursal}`)}">✓ Recibido</button>`
                  : j.fechaEnvioSucursal
                    ? `<button class="btn small receive" onclick="confirmarRecepcionTrabajo('${j.id}')" title="Confirmar recepción en sucursal">Recibir trabajo</button>`
                    : `<button class="btn small" disabled title="Aún no se ha enviado a la sucursal">Pendiente de envío</button>`}
              </div></td>
            </tr>`).join("") || `<tr><td colspan="9" style="text-align:center;color:var(--text-muted);padding:30px;">Sin resultados con estos filtros.</td></tr>`}
          </tbody>
        </table></div>
        <div class="pagination">
          <span>Página ${state.trabajosPagina} de ${totalPaginas}</span>
          <button class="btn small" ${state.trabajosPagina <= 1 ? "disabled" : ""} onclick="cambiarPagina(-1)">◀ Anterior</button>
          <button class="btn small" ${state.trabajosPagina >= totalPaginas ? "disabled" : ""} onclick="cambiarPagina(1)">Siguiente ▶</button>
        </div>
      </div>
    </div>
  `;

  document.getElementById("filtro-estatus").addEventListener("change", e => { state.trabajosFiltroEstatus = e.target.value; state.trabajosPagina = 1; renderTrabajos(); });
  document.getElementById("filtro-sucursal").addEventListener("change", e => { state.trabajosFiltroSucursal = e.target.value; state.trabajosPagina = 1; renderTrabajos(); });
  document.getElementById("filtro-mensajeria").addEventListener("change", e => { state.trabajosFiltroMensajeria = e.target.value; state.trabajosPagina = 1; renderTrabajos(); });
}
function irATrabajosConFiltroMensajeria(valor) {
  state.trabajosFiltroMensajeria = valor;
  state.trabajosFiltroEstatus = ""; state.trabajosFiltroSucursal = ""; state.trabajosCriterio = ""; state.trabajosPagina = 1;
  irA("trabajos");
}
function ordenarPor(campo) {
  if (state.trabajosOrden.campo === campo) state.trabajosOrden.dir = state.trabajosOrden.dir === "asc" ? "desc" : "asc";
  else state.trabajosOrden = { campo, dir: "asc" };
  renderTrabajos();
}
function cambiarPagina(delta) { state.trabajosPagina += delta; renderTrabajos(); }

/* ============================================================
   INFORME (crítico + envíos del día) — envío por correo
   ============================================================ */
function trabajosCriticos() {
  const hoy = new Date();
  const proximos = [], retrasados = [];
  JOBS.forEach(j => {
    if (!j.fechaRecepcion && j.fechaEstimada) {
      const dias = Math.ceil((new Date(j.fechaEstimada) - hoy) / 86400000);
      if (dias <= 1 && dias >= 0) proximos.push(j);
      else if (new Date(j.fechaEstimada) < hoy) retrasados.push(j);
    } else if (j.estatus === "Retrasado") {
      retrasados.push(j);
    }
  });
  return { proximos, retrasados };
}

function trabajosEnviadosEnFecha(fechaISO) {
  return JOBS.filter(j => j.fechaEnvioSucursal === fechaISO)
    .sort((a, b) => (a.sucursal || "").localeCompare(b.sucursal || ""));
}

function renderInforme() {
  const el = document.getElementById("view-informe");
  if (!state.informeFecha) state.informeFecha = hoyISO();

  if (state.informeTab === "critico") {
    const { proximos, retrasados } = trabajosCriticos();
    const total = proximos.length + retrasados.length;
    el.innerHTML = `
      ${tabsInforme()}
      <div class="panel">
        <div class="panel-head">
          <h2>Informe de trabajos críticos</h2>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <button class="btn accent" onclick="copiarInformeCritico()" ${total === 0 ? "disabled" : ""}>📋 Copiar con formato</button>
            <button class="btn" onclick="abrirGmailInforme('critico')" ${total === 0 ? "disabled" : ""}>✉️ Abrir Gmail</button>
            <button class="btn" onclick="descargarInformeCriticoHTML()" ${total === 0 ? "disabled" : ""}>⬇️ Descargar</button>
          </div>
        </div>
        <div class="panel-body">
          <div style="color:var(--text-muted);font-size:12.5px;margin-bottom:14px;">
            Destinatarios: ${CORREOS_INFORME.join(", ")} — total de trabajos críticos: <strong>${total}</strong>
            · <button class="btn small" onclick="mostrarToast('Copia el informe con el botón de arriba, abre Gmail, y pega (Ctrl+V) dentro del cuerpo del correo — mantiene colores y formato.')">¿Cómo envío esto?</button>
          </div>
          ${total === 0 ? `<div class="empty-state"><div class="big">✅ Sin trabajos críticos</div><div>No hay retrasos ni vencimientos próximos por reportar hoy.</div></div>` : htmlInformeCritico(retrasados, proximos, true)}
        </div>
      </div>
    `;
  } else {
    const envios = trabajosEnviadosEnFecha(state.informeFecha);
    el.innerHTML = `
      ${tabsInforme()}
      <div class="panel">
        <div class="panel-head">
          <h2>Envíos a sucursal del día</h2>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
            <input type="date" id="informe-fecha" value="${state.informeFecha}">
            <button class="btn accent" onclick="copiarInformeDiario()" ${envios.length === 0 ? "disabled" : ""}>📋 Copiar con formato</button>
            <button class="btn" onclick="abrirGmailInforme('diario')" ${envios.length === 0 ? "disabled" : ""}>✉️ Abrir Gmail</button>
            <button class="btn" onclick="descargarInformeDiarioHTML()" ${envios.length === 0 ? "disabled" : ""}>⬇️ Descargar</button>
          </div>
        </div>
        <div class="panel-body">
          <div style="color:var(--text-muted);font-size:12.5px;margin-bottom:14px;">
            Destinatarios: ${CORREOS_INFORME.join(", ")} — trabajos despachados a sucursal el ${formatearFecha(state.informeFecha)}: <strong>${envios.length}</strong>
          </div>
          ${envios.length === 0 ? `<div class="empty-state"><div class="big">Sin envíos registrados este día</div><div>Nadie ha marcado "Fecha de envío a sucursal" con esta fecha todavía.</div></div>` : htmlInformeDiario(envios, state.informeFecha, true)}
        </div>
      </div>
    `;
    document.getElementById("informe-fecha").addEventListener("change", e => { state.informeFecha = e.target.value; renderInforme(); });
  }
}
function tabsInforme() {
  return `<div class="toolbar" style="margin-bottom:16px;">
    <button class="btn ${state.informeTab === "critico" ? "primary" : ""}" onclick="cambiarTabInforme('critico')">🔴 Crítico</button>
    <button class="btn ${state.informeTab === "diario" ? "primary" : ""}" onclick="cambiarTabInforme('diario')">🚚 Envíos del día</button>
  </div>`;
}
function cambiarTabInforme(tab) { state.informeTab = tab; renderInforme(); }

/* ============================================================
   GENERACIÓN DE INFORMES CON FORMATO VISUAL (estilo tarjetas)
   El mismo HTML sirve para: mostrarlo en pantalla, copiarlo con
   formato al portapapeles (pegable en Gmail) y descargarlo.
   ============================================================ */
function tarjetaTrabajo(j, colorBorde, colorTitulo) {
  const campos = [
    ["Cliente", j.cliente], ["Material", j.material], ["Laboratorio", j.laboratorio],
    ["Sucursal", j.sucursal], ["Fecha de envío", formatearFecha(j.fechaEnvio)],
    ["Fecha estimada", formatearFecha(j.fechaEstimada)], ["Fecha de recepción", formatearFecha(j.fechaRecepcion)],
    ["Estatus", j.estatus], ["Estado de tiempo", j.estadoTiempo], ["Mensajería", j.estadoMensajeria],
  ];
  return `<div style="background:#f5f5f5;border-left:4px solid ${colorBorde};padding:14px 16px;margin:12px 0;border-radius:4px;font-family:Arial,Helvetica,sans-serif;">
    <div style="font-weight:bold;font-size:14px;color:${colorTitulo};margin-bottom:8px;">${esc(j.cliente)} — ${esc(j.material)}</div>
    <table style="width:100%;border-collapse:collapse;font-size:12.5px;color:#333;">
      ${campos.slice(2).map(([k, v]) => `<tr><td style="padding:2px 8px 2px 0;font-weight:bold;color:#555;white-space:nowrap;">${k}:</td><td style="padding:2px 0;">${esc(v || "N/A")}</td></tr>`).join("")}
    </table>
  </div>`;
}
function htmlInformeCritico(retrasados, proximos, paraPantalla) {
  const encabezado = paraPantalla ? "" : `
    <h2 style="color:#d32f2f;font-family:Arial,Helvetica,sans-serif;margin-bottom:4px;">📋 Informe de Trabajos Críticos — Óptica</h2>
    <p style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#333;"><strong>Fecha del informe:</strong> ${new Date().toLocaleDateString("es-DO")}</p>`;
  let html = encabezado;
  if (retrasados.length) {
    html += `<h3 style="color:#d32f2f;font-family:Arial,Helvetica,sans-serif;">🔴 Trabajos Retrasados (${retrasados.length})</h3>`;
    html += retrasados.map(j => tarjetaTrabajo(j, "#d32f2f", "#d32f2f")).join("");
  }
  if (proximos.length) {
    html += `<h3 style="color:#f57c00;font-family:Arial,Helvetica,sans-serif;">🟡 Próximos a Vencer (${proximos.length})</h3>`;
    html += proximos.map(j => tarjetaTrabajo(j, "#f57c00", "#f57c00")).join("");
  }
  html += `<p style="font-family:Arial,Helvetica,sans-serif;font-size:11.5px;color:#888;margin-top:16px;">Total de trabajos críticos: ${retrasados.length + proximos.length} · Generado desde la app Óptica.</p>`;
  return html;
}
function htmlInformeDiario(envios, fechaISO, paraPantalla) {
  const encabezado = paraPantalla ? "" : `
    <h2 style="color:#1F3864;font-family:Arial,Helvetica,sans-serif;margin-bottom:4px;">🚚 Informe de Envíos a Sucursal — Óptica</h2>
    <p style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#333;"><strong>Fecha del envío:</strong> ${formatearFecha(fechaISO)}</p>`;
  const porSucursal = {};
  envios.forEach(j => { (porSucursal[j.sucursal || "Sin sucursal"] ??= []).push(j); });
  let html = encabezado;
  Object.entries(porSucursal).forEach(([sucursal, arr]) => {
    html += `<h3 style="color:#1F3864;font-family:Arial,Helvetica,sans-serif;">📍 ${esc(sucursal)} (${arr.length})</h3>`;
    html += arr.map(j => tarjetaTrabajo(j, "#2E86AB", "#1F3864")).join("");
  });
  html += `<p style="font-family:Arial,Helvetica,sans-serif;font-size:11.5px;color:#888;margin-top:16px;">Total despachado: ${envios.length} · Generado desde la app Óptica.</p>`;
  return html;
}
function htmlStandalone(titulo, contenido) {
  return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>${titulo}</title></head><body style="margin:0;padding:20px;background:#fff;">${contenido}</body></html>`;
}

async function copiarHTMLAlPortapapeles(html, textoPlano) {
  try {
    if (navigator.clipboard && window.ClipboardItem) {
      const item = new ClipboardItem({
        "text/html": new Blob([html], { type: "text/html" }),
        "text/plain": new Blob([textoPlano], { type: "text/plain" }),
      });
      await navigator.clipboard.write([item]);
      mostrarToast("✅ Copiado con formato — abre Gmail y pega (Ctrl+V) en el cuerpo del correo.");
    } else {
      await navigator.clipboard.writeText(textoPlano);
      mostrarToast("Se copió como texto (este navegador no admite copiar con formato).");
    }
  } catch (err) {
    mostrarToast("No se pudo copiar automáticamente — use 'Descargar' y ábralo para copiar a mano.");
  }
}
function abrirGmailInforme(tipo) {
  const asunto = tipo === "critico"
    ? `Alerta: trabajos críticos en óptica — ${new Date().toLocaleDateString("es-DO")}`
    : `Envíos a sucursal del ${formatearFecha(state.informeFecha)} — Óptica`;
  const url = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(CORREOS_INFORME.join(","))}&su=${encodeURIComponent(asunto)}`;
  window.open(url, "_blank");
  mostrarToast("Se abrió Gmail — pega (Ctrl+V) el informe copiado dentro del cuerpo del correo.");
}
function copiarInformeCritico() {
  const { proximos, retrasados } = trabajosCriticos();
  copiarHTMLAlPortapapeles(htmlInformeCritico(retrasados, proximos, false), textoInforme());
}
function descargarInformeCriticoHTML() {
  const { proximos, retrasados } = trabajosCriticos();
  const blob = new Blob([htmlStandalone("Informe de Trabajos Críticos", htmlInformeCritico(retrasados, proximos, false))], { type: "text/html;charset=utf-8" });
  descargarBlob(blob, `informe-criticos-${hoyISO()}.html`);
}
function copiarInformeDiario() {
  const envios = trabajosEnviadosEnFecha(state.informeFecha);
  copiarHTMLAlPortapapeles(htmlInformeDiario(envios, state.informeFecha, false), textoInformeDiario(state.informeFecha));
}
function descargarInformeDiarioHTML() {
  const envios = trabajosEnviadosEnFecha(state.informeFecha);
  const blob = new Blob([htmlStandalone("Informe de Envíos a Sucursal", htmlInformeDiario(envios, state.informeFecha, false))], { type: "text/html;charset=utf-8" });
  descargarBlob(blob, `envios-sucursal-${state.informeFecha}.html`);
}
function textoInforme(maxItems) {
  const { proximos, retrasados } = trabajosCriticos();
  let out = `INFORME DE TRABAJOS CRÍTICOS — ÓPTICA\nFecha: ${new Date().toLocaleDateString("es-DO")}\n`;
  out += `Total: ${retrasados.length + proximos.length} (Retrasados: ${retrasados.length}, Próximos a vencer: ${proximos.length})\n\n`;
  const listar = (arr, titulo) => {
    if (!arr.length) return "";
    let t = `${titulo} (${arr.length})\n${"-".repeat(40)}\n`;
    arr.forEach((j, i) => {
      t += `${i + 1}. ${j.cliente} — ${j.material} | Lab: ${j.laboratorio} | Sucursal: ${j.sucursal} | Fecha estimada: ${formatearFecha(j.fechaEstimada)} | Estatus: ${j.estatus}\n`;
    });
    return t + "\n";
  };
  out += listar(retrasados, "RETRASADOS");
  out += listar(proximos, "PRÓXIMOS A VENCER");
  return out;
}

function textoInformeDiario(fechaISO) {
  const envios = trabajosEnviadosEnFecha(fechaISO);
  let out = `INFORME DE ENVÍOS A SUCURSAL — ÓPTICA\nFecha del envío: ${formatearFecha(fechaISO)}\n`;
  out += `Total despachado: ${envios.length}\n\n`;
  if (!envios.length) { out += "No se registraron envíos a sucursal en esta fecha.\n"; return out; }
  const porSucursal = {};
  envios.forEach(j => { (porSucursal[j.sucursal || "Sin sucursal"] ??= []).push(j); });
  Object.entries(porSucursal).forEach(([sucursal, arr]) => {
    out += `${sucursal} (${arr.length})\n${"-".repeat(40)}\n`;
    arr.forEach((j, i) => { out += `${i + 1}. ${j.cliente} — ${j.material} | Mensajero: ${j.mensajero || "N/D"} | Estado: ${j.estadoMensajeria}\n`; });
    out += "\n";
  });
  return out;
}

/* ============================================================
   DETALLE / EDICIÓN (drawer lateral)
   ============================================================ */
function abrirDetalle(id) {
  const j = JOBS.find(x => x.id === id);
  if (!j) return;
  const body = document.getElementById("drawer-body");
  document.getElementById("drawer-title").textContent = j.cliente;
  document.getElementById("drawer-sub").textContent = `${j.id} · ${j.material}`;

  body.innerHTML = `
    <div class="badge-row">${pill(j.estatus)}${pill(j.estadoTiempo)}${pill(j.estadoMensajeria)}</div>
    <div class="divider"></div>

    <div class="section-label">Historial del trabajo (única fuente)</div>
    <div id="historial-auditoria">${renderLineaDeTiempo(j)}</div>
    <div class="divider"></div>

    <div class="section-label">1 · Recepción en laboratorio</div>
    ${campoConSugerenciasInline("dt-material-" + j.id, "Material", "material", j.material, j.id)}
    ${campoConSugerenciasInline("dt-laboratorio-" + j.id, "Laboratorio", "laboratorio", j.laboratorio, j.id)}
    <div class="field"><label>Fecha de envío al laboratorio</label>
      <input type="date" value="${j.fechaEnvio || ""}" onchange="actualizarCampo('${j.id}','fechaEnvio',this.value)"></div>
    <div class="field"><label>Fecha estimada de entrega</label>
      <input type="date" value="${j.fechaEstimada || ""}" onchange="actualizarCampo('${j.id}','fechaEstimada',this.value)"></div>
    <div class="field"><label>Fecha de recepción del laboratorio</label>
      <input type="date" value="${j.fechaRecepcion || ""}" onchange="actualizarCampo('${j.id}','fechaRecepcion',this.value)"></div>

    <div class="divider"></div>
    <div class="section-label">2 · Mensajería a sucursal</div>
    ${campoConSugerenciasInline("dt-sucursal-" + j.id, "Sucursal destino", "sucursal", j.sucursal, j.id)}
    ${j.estatus !== "Recibido" ? `<div style="color:var(--text-muted);font-size:12.5px;">Este trabajo aún no está "Recibido" del laboratorio — la mensajería a sucursal se habilita automáticamente en cuanto lo esté.</div>` : `
    <div class="field"><label>Fecha de envío a sucursal</label>
      <input type="date" value="${j.fechaEnvioSucursal || ""}" onchange="actualizarCampo('${j.id}','fechaEnvioSucursal',this.value)"></div>
    <div class="field"><label>Mensajero</label>
      <input type="text" placeholder="Nombre del mensajero" value="${escapeAttr(j.mensajero || "")}" onchange="actualizarCampo('${j.id}','mensajero',this.value)"></div>
    <div class="field"><label>Fecha de recepción en sucursal</label>
      <input type="date" value="${j.fechaRecepcionSucursal || ""}" onchange="actualizarCampo('${j.id}','fechaRecepcionSucursal',this.value)"></div>
    `}
  `;
  document.getElementById("overlay").classList.add("open");
}

/* Línea de tiempo única: todos los movimientos de ESTE trabajo, en un solo lugar */
function renderLineaDeTiempo(j) {
  const pasos = [
    { etiqueta: "Registrado", fecha: j.marcaTemporal, detalle: "" },
    { etiqueta: "Enviado al laboratorio", fecha: j.fechaEnvio, detalle: j.laboratorio },
    { etiqueta: "Recibido del laboratorio", fecha: j.fechaRecepcion, detalle: "" },
    { etiqueta: "Enviado a sucursal", fecha: j.fechaEnvioSucursal, detalle: j.mensajero ? `Mensajero: ${j.mensajero}` : "" },
    { etiqueta: "Recibido en sucursal", fecha: j.recibidoEnSucursal || j.fechaRecepcionSucursal, detalle: j.recibidoEnSucursal ? `${j.recibidoPorNombre || "Usuario"} · ${j.sucursalRecibida || j.sucursal}` : j.sucursal },
  ];
  return `<div style="display:flex;flex-direction:column;gap:0;">
    ${pasos.map((p, i) => `
      <div style="display:flex;gap:10px;">
        <div style="display:flex;flex-direction:column;align-items:center;">
          <div style="width:10px;height:10px;border-radius:50%;background:${p.fecha ? "var(--accent)" : "var(--border)"};margin-top:3px;"></div>
          ${i < pasos.length - 1 ? `<div style="width:2px;flex:1;background:var(--border);min-height:22px;"></div>` : ""}
        </div>
        <div style="padding-bottom:14px;">
          <div style="font-size:13px;font-weight:600;color:${p.fecha ? "var(--text)" : "var(--text-muted)"};">${p.etiqueta}</div>
          <div style="font-size:12px;color:var(--text-muted);">${p.fecha ? (String(p.fecha).includes("T") ? formatearFechaHora(p.fecha) : formatearFecha(p.fecha)) : "Pendiente"}${p.detalle ? " · " + esc(p.detalle) : ""}</div>
        </div>
      </div>
    `).join("")}
  </div>`;
}
function cerrarDetalle() { document.getElementById("overlay").classList.remove("open"); }

/* ============================================================
   NUEVO TRABAJO
   ============================================================ */
/* Campo de texto con sugerencias: el usuario puede escribir libremente
   (no se queda "atascado" como con un <select>) y a la vez ve sugerencias
   de lo que ya existe, filtradas mientras escribe (comportamiento nativo
   del navegador vía <datalist>). */
function campoConSugerencias(id, etiqueta, campo, obligatorio, valorActual) {
  const opciones = opcionesUnicas(campo);
  return `<div class="field"><label>${etiqueta}${obligatorio ? " *" : ""}</label>
    <input type="text" id="${id}" list="dl-${id}" autocomplete="off"
      placeholder="Escriba o elija de la lista…" value="${escapeAttr(valorActual || "")}">
    <datalist id="dl-${id}">
      ${opciones.map(o => `<option value="${escapeAttr(o)}"></option>`).join("")}
    </datalist>
  </div>`;
}
/* Igual, pero para editar un trabajo ya existente: guarda el cambio y aprende la opción nueva */
function campoConSugerenciasInline(id, etiqueta, campo, valorActual, jobId) {
  const opciones = opcionesUnicas(campo);
  return `<div class="field"><label>${etiqueta}</label>
    <input type="text" id="${id}" list="dl-${id}" autocomplete="off" value="${escapeAttr(valorActual || "")}"
      onchange="agregarOpcion('${campo}', this.value); actualizarCampo('${jobId}','${campo}', this.value)">
    <datalist id="dl-${id}">
      ${opciones.map(o => `<option value="${escapeAttr(o)}"></option>`).join("")}
    </datalist>
  </div>`;
}

/* ============================================================
   ⚙️ ADMINISTRAR LISTAS (Material / Laboratorio / Sucursal)
   Permite agregar y eliminar opciones que aparecen como sugerencias
   al registrar o editar un trabajo.
   ============================================================ */
function abrirAdministrarListas(campoActivo) {
  campoActivo = campoActivo || "material";
  const body = document.getElementById("drawer-body");
  document.getElementById("drawer-title").textContent = "Administrar listas";
  document.getElementById("drawer-sub").textContent = "Agregar o quitar opciones de Material, Laboratorio y Sucursal";

  body.innerHTML = `
    <div class="toolbar" style="margin-bottom:14px;">
      ${Object.entries(CAMPOS_LISTA).map(([campo, etiqueta]) =>
        `<button class="btn ${campo === campoActivo ? "primary" : ""}" onclick="abrirAdministrarListas('${campo}')">${etiqueta}</button>`).join("")}
    </div>
    <div class="field">
      <label>Agregar nueva opción a "${CAMPOS_LISTA[campoActivo]}"</label>
      <div style="display:flex;gap:8px;">
        <input type="text" id="admin-nuevo-valor" placeholder="Escriba el nuevo valor…" style="flex:1;">
        <button class="btn accent" onclick="adminAgregar('${campoActivo}')">Agregar</button>
      </div>
    </div>
    <div class="divider"></div>
    <div class="section-label">Opciones actuales (${opcionesUnicas(campoActivo).length})</div>
    <div style="display:flex;flex-direction:column;gap:6px;max-height:50vh;overflow-y:auto;">
      ${opcionesUnicas(campoActivo).map(o => `
        <div style="display:flex;justify-content:space-between;align-items:center;border:1px solid var(--border);border-radius:var(--radius);padding:7px 10px;">
          <span style="font-size:13px;">${esc(o)}</span>
          <button class="btn small" title="Quitar de la lista de sugerencias" onclick="adminEliminar('${campoActivo}','${escapeAttr(o).replace(/'/g, "\\'")}')">✕</button>
        </div>
      `).join("")}
    </div>
    <div style="color:var(--text-muted);font-size:11.5px;margin-top:12px;">
      Quitar una opción solo la saca de la lista de sugerencias — no borra los trabajos que ya la usan.
    </div>
  `;
  document.getElementById("overlay").classList.add("open");
  document.getElementById("admin-nuevo-valor").addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); adminAgregar(campoActivo); }
  });
}
function adminAgregar(campo) {
  const input = document.getElementById("admin-nuevo-valor");
  if (!input.value.trim()) return;
  agregarOpcion(campo, input.value);
  abrirAdministrarListas(campo);
  mostrarToast("Opción agregada.");
}
function adminEliminar(campo, valor) {
  eliminarOpcion(campo, valor);
  abrirAdministrarListas(campo);
}

function abrirFormularioNuevo() {
  const body = document.getElementById("drawer-body");
  document.getElementById("drawer-title").textContent = "Registrar trabajo nuevo";
  document.getElementById("drawer-sub").textContent = "Se guarda de forma centralizada en el sistema";
  body.innerHTML = `
    <div class="field"><label>Cliente *</label><input type="text" id="nf-cliente"></div>
    ${campoConSugerencias("nf-material", "Material", "material", false)}
    ${campoConSugerencias("nf-laboratorio", "Laboratorio", "laboratorio", false)}
    ${campoConSugerencias("nf-sucursal", "Sucursal destino", "sucursal", false)}
    <div class="field"><label>Fecha de envío al laboratorio</label><input type="date" id="nf-envio" value="${hoyISO()}"></div>
    <div class="field"><label>Fecha estimada de entrega</label><input type="date" id="nf-estimada"></div>
    <button class="btn primary" style="width:100%;margin-top:6px;" onclick="guardarNuevoTrabajo()">Guardar trabajo</button>
    <div style="text-align:center;margin-top:10px;">
      <button class="btn small" onclick="abrirAdministrarListas('material')">⚙️ Administrar listas de Material / Laboratorio / Sucursal</button>
    </div>
  `;
  document.getElementById("overlay").classList.add("open");
}
function guardarNuevoTrabajo() {
  const cliente = document.getElementById("nf-cliente").value.trim();
  if (!cliente) { mostrarToast("El nombre del cliente es obligatorio."); return; }
  const material = document.getElementById("nf-material").value.trim();
  const laboratorio = document.getElementById("nf-laboratorio").value.trim();
  const sucursal = document.getElementById("nf-sucursal").value.trim();
  // aprende automáticamente cualquier valor nuevo escrito a mano, para sugerirlo la próxima vez
  if (material) agregarOpcion("material", material);
  if (laboratorio) agregarOpcion("laboratorio", laboratorio);
  if (sucursal) agregarOpcion("sucursal", sucursal);

  const nuevoId = "N-" + Date.now().toString(36).toUpperCase();
  NUEVOS.push({
    id: nuevoId, marcaTemporal: hoyISO(), cliente, material, laboratorio, sucursal,
    fechaEnvio: document.getElementById("nf-envio").value || null,
    fechaEstimada: document.getElementById("nf-estimada").value || null,
    fechaRecepcion: null, fechaEnvioSucursal: null, mensajero: null, fechaRecepcionSucursal: null,
  });
  guardarNuevos();
  cerrarDetalle();
  refresh();
  mostrarToast("Trabajo registrado.");
}

/* ============================================================
   EXPORTAR / UTILIDADES
   ============================================================ */
function exportarCSV() {
  const cols = ["id","cliente","material","laboratorio","fechaEnvio","fechaEstimada","fechaRecepcion","sucursal","estatus","estadoTiempo","fechaEnvioSucursal","mensajero","fechaRecepcionSucursal","estadoMensajeria"];
  const filas = [cols.join(",")].concat(JOBS.map(j => cols.map(c => csvEscape(j[c])).join(",")));
  const blob = new Blob(["\uFEFF" + filas.join("\n")], { type: "text/csv;charset=utf-8" });
  descargarBlob(blob, `trabajos-optica-${hoyISO()}.csv`);
}
function csvEscape(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function descargarBlob(blob, nombre) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = nombre; document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
}
function restablecerDatosLocales() {
  if (!confirm("Esto borrará todas las ediciones y trabajos nuevos guardados en este navegador. ¿Continuar?")) return;
  localStorage.removeItem(LS_OVERRIDES); localStorage.removeItem(LS_NUEVOS);
  cargarOverrides(); refresh();
  mostrarToast("Datos locales restablecidos.");
}
function esc(s) { return String(s ?? "").replace(/[&<>"']/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m])); }
function escapeAttr(s) { return esc(s).replace(/"/g, "&quot;"); }
function preservarFoco(id) { const el = document.getElementById(id); if (el) { el.focus(); el.selectionStart = el.selectionEnd = el.value.length; } }
let toastTimer;
function mostrarToast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg; t.classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), 3200);
}

/* ============================================================
   ARRANQUE
   ============================================================ */
async function iniciar() {
  cargarOverrides();
  cargarOpciones();
  try {
    if (window.__OPTICA_DATA__) {
      BASE = window.__OPTICA_DATA__;
    } else {
      const resp = await fetch("data.json");
      BASE = await resp.json();
    }
  } catch (err) {
    document.getElementById("view-dashboard").innerHTML = `<div class="empty-state"><div class="big">No se pudo cargar la base de datos</div><div>Verifique que "data.json" esté junto a index.html y que la app se esté sirviendo desde un servidor web (no abierta directamente como archivo).</div></div>`;
    return;
  }
  refresh();
  irA("dashboard");

  if ("serviceWorker" in navigator && !window.__OPTICA_DATA__) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}
// El arranque lo controla supabase-app.js. Se conserva este archivo para no
// reescribir las pantallas, cálculos, exportaciones ni informes existentes.
