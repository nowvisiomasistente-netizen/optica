/* Uso local, una sola vez:
   $env:SUPABASE_URL='...'; $env:SUPABASE_SECRET_KEY='sb_secret_...'; node scripts/importar-data.mjs .\\data.legacy.json
   La secret key nunca se copia a GitHub, Cloudflare ni al navegador. */
import { readFile } from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";

const [archivo] = process.argv.slice(2);
const claveSecreta = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!archivo || !process.env.SUPABASE_URL || !claveSecreta) {
  throw new Error("Uso: SUPABASE_URL=... SUPABASE_SECRET_KEY=... node scripts/importar-data.mjs data.legacy.json");
}
const sb = createClient(process.env.SUPABASE_URL, claveSecreta, { auth: { persistSession: false } });
const datos = JSON.parse(await readFile(archivo, "utf8"));
if (!Array.isArray(datos)) throw new Error("El JSON debe ser un arreglo de trabajos.");
const fecha = v => v || null;
const filas = datos.map(x => ({
  id: String(x.id), marca_temporal: fecha(x.marcaTemporal), cliente: x.cliente?.trim(), material: x.material?.trim(),
  laboratorio: x.laboratorio?.trim(), fecha_envio: fecha(x.fechaEnvio), fecha_estimada: fecha(x.fechaEstimada),
  fecha_recepcion: fecha(x.fechaRecepcion), sucursal: x.sucursal?.trim(),
  fecha_envio_sucursal: fecha(x.fechaEnvioSucursal), fecha_recepcion_sucursal: fecha(x.fechaRecepcionSucursal), mensajero: x.mensajero?.trim() || null
}));
if (new Set(filas.map(x => x.id)).size !== filas.length) throw new Error("Hay IDs duplicados; corríjalos antes de importar.");
const sucursales = [...new Set(filas.map(x => x.sucursal).filter(Boolean))].map(nombre => ({ nombre }));
const laboratorios = [...new Set(filas.map(x => x.laboratorio).filter(Boolean))].map(nombre => ({ nombre }));
const opciones = [
  ...[...new Set(filas.map(x => x.material).filter(Boolean))].map(valor => ({ tipo:"material", valor })),
  ...laboratorios.map(x => ({ tipo:"laboratorio", valor:x.nombre })), ...sucursales.map(x => ({ tipo:"sucursal", valor:x.nombre }))
];
for (const [tabla, rows] of [["sucursales",sucursales],["laboratorios",laboratorios],["opciones",opciones]]) {
  const { error } = await sb.from(tabla).upsert(rows, { onConflict: tabla === "opciones" ? "tipo,valor" : "nombre" });
  if (error) throw error;
}
const { data: sucursalesDb, error: errorSucursales } = await sb.from("sucursales").select("id,nombre");
if (errorSucursales) throw errorSucursales;
const sucursalPorNombre = new Map(sucursalesDb.map(x => [x.nombre, x.id]));
filas.forEach(x => { x.sucursal_id = sucursalPorNombre.get(x.sucursal) ?? null; });
for (let i=0; i<filas.length; i+=500) {
  const lote = filas.slice(i,i+500);
  const { error } = await sb.from("trabajos").upsert(lote, { onConflict:"id" });
  if (error) throw error;
  console.log(`Importados ${Math.min(i + lote.length, filas.length)}/${filas.length}`);
}
console.log(`Listo: ${filas.length} trabajos preservando sus IDs.`);
