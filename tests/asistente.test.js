'use strict';
// Pruebas del asistente de IA (server/asistente.js) y del archivo de Excel. Sin llamar a la API: las respuestas del modelo son simuladas.
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');
const { crear } = require('../server/asistente.js');
const xlsx = require('../server/xlsx.js');
process.env.ANTHROPIC_API_KEY = 'clave-de-prueba';

const V = (num, dia, extra) => Object.assign({ num, dia, fecha: dia + 'T15:30:00.000Z', placa: 'AB123C' + num, cliente: 'Cliente ' + num, telefono: '0414000000' + num, servicios: [{ nombre: 'Lavado moto pequeña', precio: 5 }], total: 5, lavador: 'Keive', usuario: 'Daniel', estado: 'pagada', tipo: 'normal', metodo: 'Efectivo $', moneda: '$', monto: 5 }, extra);
const VENTAS = [V(1, '2026-11-02'), V(2, '2026-11-02', { metodo: 'Mixto', pagos: [{ metodo: 'Efectivo $', moneda: '$', monto: 2, usd: 2 }, { metodo: 'Pago móvil', moneda: 'Bs', monto: 3000, usd: 3 }] }), V(3, '2026-11-10', { estado: 'pendiente', metodo: '' })];
function montar(respuestas) {
  const llamadas = [], usos = [];
  const a = crear({ fechaCaracas: () => '2026-11-26', registrarUso: u => usos.push(u), clientes: () => [{ nombre: 'Cliente 1', telefono: '04140000001', motos: [{ placa: 'AB123C1' }], visitas: 4, gastado: 20, ultima: '2026-11-02T15:00:00Z' }],
    camara: dia => ({ dia, filas: 0 }), ventas: (d, h) => VENTAS.filter(v => v.dia >= d && v.dia <= h),
    llamarApi: async (cuerpo, beta) => { llamadas.push({ cuerpo: JSON.parse(JSON.stringify(cuerpo)), beta }); return respuestas.shift() || null; } });
  return { a, llamadas, usos };
}
const usa = (name, input, id = 't1') => ({ status: 200, j: { model: 'claude-opus-5-5', stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: 'thinking', thinking: '', signature: 'x' }, { type: 'tool_use', id, name, input }] } });
const dice = texto => ({ status: 200, j: { model: 'claude-opus-5-5', stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: 'text', text: texto }] } });
// Lee las entradas de un ZIP sin compresión y comprueba el CRC de cada una.
function leerZip(b) {
  const r = {}; let p = 0;
  while (b.readUInt32LE(p) === 0x04034b50) {
    const n = b.readUInt16LE(p + 26), len = b.readUInt32LE(p + 18), nombre = b.slice(p + 30, p + 30 + n).toString(), d = b.slice(p + 30 + n, p + 30 + n + len);
    if (zlib.crc32) assert.equal(b.readUInt32LE(p + 14), zlib.crc32(d));
    r[nombre] = d.toString('utf8'); p += 30 + n + len;
  }
  return r;
}

test('asistente: consulta las ventas con la herramienta, devuelve la respuesta y registra el consumo', async () => {
  const t = montar([usa('consultar_ventas', { desde: '2026-11-01', hasta: '2026-11-30', agrupar_por: 'metodo', detalle: true }), dice('Se cobraron $10.')]);
  const r = await t.a.responder([{ rol: 'asistente', texto: 'saludo viejo' }, { rol: 'usuario', texto: '¿Cuánto se vendió?' }]);
  assert.equal(r.respuesta, 'Se cobraron $10.');
  const [primera, segunda] = t.llamadas;
  assert.equal(primera.cuerpo.model, 'claude-opus-5-5'); assert.equal(primera.beta, 'server-side-fallback-2026-07-01'); assert.equal(primera.cuerpo.fallbacks, 'default');
  assert.equal(primera.cuerpo.messages[0].role, 'user', 'la conversación empieza con una pregunta');
  assert.equal(segunda.cuerpo.messages[1].content[0].type, 'thinking', 'el contenido del modelo vuelve tal cual');
  const res = segunda.cuerpo.messages[2].content[0];
  assert.equal(res.tool_use_id, 't1');
  const d = JSON.parse(res.content);
  assert.deepEqual(d.totales, { motos: 3, cobrado_usd: 10, por_cobrar_usd: 5, facturas_pendientes: 1 });
  assert.equal(d.grupos.find(g => g.grupo === 'Efectivo $').cobrado_usd, 7);
  assert.deepEqual(d.grupos.find(g => g.grupo === 'Pago móvil').recibido, { Bs: 3000 });
  assert.ok(!JSON.stringify(t.llamadas).includes('04140000001'), 'los teléfonos no se envían al modelo');
  assert.equal(t.usos.length, 2); assert.equal(t.usos[0].funcion, 'asistente');
});

test('asistente: exportar crea un Excel con los teléfonos, que al modelo solo le dice el nombre del archivo', async () => {
  const t = montar([usa('exportar_detalle', { que: 'ventas', nombre: 'Ventas de Noviembre', desde: '2026-11-01', hasta: '2026-11-30' }), usa('crear_archivo', { nombre: 'resumen', columnas: ['Lavador', 'Motos'], filas: [['=1+1 <Keive>', 3]] }, 't2'), dice('Listo.')]);
  const r = await t.a.responder([{ rol: 'usuario', texto: 'expórtalo' }]);
  assert.deepEqual(r.archivos.map(a => a.nombre), ['ventas-de-noviembre.xlsx', 'resumen.xlsx']);
  const hoja = leerZip(Buffer.from(r.archivos[0].base64, 'base64'))['xl/worksheets/sheet1.xml'];
  assert.ok(hoja.includes('04140000001') && hoja.includes('<v>5</v>'), 'teléfono como texto y total como número');
  const libro = leerZip(Buffer.from(r.archivos[0].base64, 'base64'));
  assert.ok(libro['xl/media/logo.png'] && hoja.includes('<drawing r:id="rId1"/>'), 'el archivo lleva el logo');
  assert.ok(hoja.includes('Ventas del 01/11/2026 al 30/11/2026') && hoja.includes('cobrado $10.00 · por cobrar $5.00'));
  assert.ok(hoja.includes('<f>SUBTOTAL(109,J7:J9)</f><v>15</v>'), 'fila de total del monto');
  assert.ok(hoja.includes('<v>' + Math.round((Date.UTC(2026, 10, 2) - Date.UTC(1899, 11, 30)) / 864e5) + '</v>'), 'el día va como fecha');
  const otra = leerZip(Buffer.from(r.archivos[1].base64, 'base64'))['xl/worksheets/sheet1.xml'];
  assert.ok(otra.includes('=1+1 &lt;Keive&gt;') && !otra.includes('<f>'), 'un texto nunca se vuelve fórmula');
  assert.ok(!JSON.stringify(t.llamadas).includes('04140000001'));
});

test('asistente: errores de herramienta, de la API y sin clave no rompen nada', async () => {
  const t = montar([usa('consultar_ventas', { desde: 'ayer', hasta: '2026-11-30' }), usa('consultar_camara', { dia: '2026-11-01' }, 't2'), dice('No hay datos.')]);
  await t.a.responder([{ rol: 'usuario', texto: 'x' }]);
  assert.equal(t.llamadas[1].cuerpo.messages[2].content[0].is_error, true);
  assert.ok(t.llamadas[2].cuerpo.messages[4].content[0].content.includes('No hay registro'));
  assert.match((await montar([]).a.responder([{ rol: 'usuario', texto: 'x' }])).error, /conexión/);
  assert.match((await montar([{ status: 429, j: {} }]).a.responder([{ rol: 'usuario', texto: 'x' }])).error, /ocupada/);
  assert.match((await montar([]).a.responder([])).error, /pregunta/);
  const repite = montar(Array.from({ length: 20 }, () => usa('consultar_camara', { dia: '2026-11-01' })));
  await repite.a.responder([{ rol: 'usuario', texto: 'x' }]);
  assert.equal(repite.llamadas.length, 8, 'hay un tope de pasos por pregunta');
  const clave = process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_API_KEY;
  try { assert.match((await montar([]).a.responder([{ rol: 'usuario', texto: 'x' }])).error, /no está configurado/); } finally { process.env.ANTHROPIC_API_KEY = clave; }
});

test('excel: columnas más allá de la Z, montos con formato y sin logo ni total si no se piden', () => {
  const cols = Array.from({ length: 28 }, (_, i) => 'c' + i).concat('Cobrado $');
  const z = leerZip(xlsx.crear(cols, [cols.map((_, i) => i)], { hoja: "Mi 'hoja' / [1]" }));
  const hoja = z['xl/worksheets/sheet1.xml'];
  assert.ok(hoja.includes('r="AC7" s="7"'), 'la columna con $ usa el formato de dinero');
  assert.ok(!hoja.includes('<f>') && !hoja.includes('<drawing') && !z['xl/media/logo.png']);
  assert.match(z['xl/workbook.xml'], /name="Mi +hoja +1"/, 'el nombre de la hoja queda sin caracteres que Excel rechaza');
});
