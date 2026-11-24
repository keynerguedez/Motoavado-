'use strict';
// Pruebas de la cámara (server/camara.js). Sin dependencias: `npm test` (node --test).
// Se ejecutan antes de cada despliegue para que un cambio nuevo no rompa lo que ya funciona.
// Todo es simulado: sin cámara, sin ffmpeg real y sin llamar a Anthropic.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { Readable } = require('stream');

const TOKEN = 'x'.repeat(30);
process.env.CAMARA_TOKEN = TOKEN;
process.env.CAMARA_RELEER_MS = '1'; // la relectura de un puente ocupado no espera 5 minutos
const SHIM = path.join(os.tmpdir(), 'motolavado-ffmpeg-falso.sh');
fs.writeFileSync(SHIM, '#!/bin/sh\ncat\n', { mode: 0o755 });
process.env.FFMPEG = SHIM; // "ffmpeg" que devuelve la misma imagen: el recorte ampliado se simula
const { crear } = require('../server/camara.js');

const HOY = '2026-11-20';
const ESPERA = ms => new Promise(r => setTimeout(r, ms));
let reloj = 0; const ahoraReal = Date.now; // para simular el paso del tiempo sin esperar
const conHora = async (ms, fn) => { reloj = ms; Date.now = () => ahoraReal() + reloj; try { return await fn(); } finally { Date.now = ahoraReal; reloj = 0; } };

// Arma una cámara de prueba con estado inicial. leer(jpeg, modelo, opc) y comparar(a, b) son los "modelos" simulados.
function montar(o = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'motolavado-'));
  ['fotos/hist', 'fotos/venta', 'fotos/cruce'].forEach(d => fs.mkdirSync(path.join(dir, d), { recursive: true }));
  const ahora = Date.now();
  const puentes = [1, 2, 3, 4, 5].map(n => Object.assign({ n, estado: 'libre' }, (o.puentes || {})[n] || {}));
  fs.writeFileSync(path.join(dir, 'camara.json'), JSON.stringify({ puentes, log: [], dia: HOY, vistas: 0, cruces: [] }));
  const hist = (o.historial || []).map(h => Object.assign({ dia: HOY, parcial: '', placa: '', estado: 'esperando', num: null, salida: null, real: '', llegada: new Date(ahora - 3600e3).toISOString() }, h));
  fs.writeFileSync(path.join(dir, 'camara-historial.json'), JSON.stringify(hist));
  hist.forEach(h => fs.writeFileSync(path.join(dir, 'fotos/hist', h.id + '.jpg'), Buffer.from(h.foto || 'FOTO-' + h.id)));
  (o.cruces || []).forEach(c => { fs.writeFileSync(path.join(dir, 'fotos/cruce', c.foto), Buffer.from(c.contenido || 'CRUCE')); });
  if (o.cruces) fs.writeFileSync(path.join(dir, 'camara-cruces.json'), JSON.stringify(o.cruces.map(c => ({ id: c.foto.split('-')[0], t: new Date().toISOString(), origen: 'registro', venta: { id: 'x', num: 0, placa: '' }, comps: [{ puente: c.puente || 3, misma: false, confianza: 'alta', motivo: '', foto: c.foto }], tipo: 'sin-coincidencia', puente: null, valido: null }))));
  (o.ventaFotos || []).forEach(v => fs.writeFileSync(path.join(dir, 'fotos/venta', v.id + '.jpg'), Buffer.from(v.contenido || 'VENTA')));
  const llamadas = { leer: [], comparar: [] };
  const ffAnt = process.env.FFMPEG; if (o.ffmpeg) process.env.FFMPEG = o.ffmpeg;
  const c = crear({
    DATA: dir, json: () => {}, fechaCaracas: () => HOY,
    ventasDeHoy: () => (typeof o.ventas === 'function' ? o.ventas() : o.ventas) || [],
    completarPlaca: o.completarPlaca, marcarValidada: o.marcarValidada,
    leerPlaca: async (j, m, opc) => { llamadas.leer.push(opc && opc.placaSolo ? 'zoom' : /haiku/.test(m || '') ? 'haiku' : 'full'); return (o.leer || (() => ({ moto: true, placa: '', parcial: '', motivo: 'ilegible' })))(j, m, opc || {}); },
    compararFotos: async (a, b) => { llamadas.comparar.push(String(b)); return (o.comparar || (() => ({ misma: true, confianza: 'alta', motivo: 'igual' })))(String(a), String(b)); },
  });
  process.env.FFMPEG = ffAnt;
  const ev = async (n, { presente = true, revision = false, byte = 7 } = {}) => {
    const req = Readable.from([Buffer.alloc(2000, byte)]);
    req.headers = { authorization: 'Bearer ' + TOKEN, 'content-type': 'image/jpeg' };
    req.url = '/api/camara/evento?puente=' + n + '&presente=' + (presente ? 1 : 0) + (revision ? '&revision=1' : '');
    await c.evento(req, {});
  };
  return { c, dir, ev, llamadas, pub: n => c.publico().puentes[n - 1], log: () => c.publico().log.map(l => l.txt), filas: () => c.historial(HOY).items };
}
const haiku = (siguiente) => (j, m, opc) => /haiku/.test(m || '') ? { moto: true, placa: '' } : siguiente(j, m, opc);

// ---------- que no se pierda ninguna función interna ----------
test('camara.js conserva las funciones internas que usan los flujos principales', () => {
  const src = fs.readFileSync(path.join(__dirname, '../server/camara.js'), 'utf8');
  const requeridas = ['otraMoto', 'compatibles', 'leerConfirmada', 'ampliar', 'confirmar', 'cerca', 'cercaSuave', 'parcialSuave', 'encajaVenta', 'verificar', 'cruzar', 'cruzarPuente',
    'revalidar', 'validarManual', 'liberarPuente', 'hTarde', 'ventaDeFila', 'vincularFila', 'hSalida', 'hAbrir', 'hNuevo', 'hSync', 'evaluar', 'guardarLectura', 'procesar', 'encajaPuente',
    'registradaParcial', 'coincideParcial', 'limpiarParcial', 'ffmpegJpeg', 'fotoHist', 'fotoCruce', 'fotoVenta', 'cNuevo', 'comparar'];
  const faltan = requeridas.filter(n => !new RegExp('(function\\s+(async\\s+)?' + n + '\\b|(const|let)\\s+' + n + '\\s*=)').test(src));
  assert.deepEqual(faltan, [], 'faltan definiciones: ' + faltan.join(', '));
});

// ---------- lectura de motos nuevas ----------
test('una moto nueva en un puente libre se lee (revisión) y queda en el historial', async () => {
  const t = montar({ leer: haiku(() => ({ moto: true, placa: '', parcial: '', motivo: 'ilegible' })) });
  await t.ev(1, { revision: true });
  assert.equal(t.pub(1).estado, 'esperando');
  assert.equal(t.filas().length, 1);
});

test('la placa se confirma con una segunda vista (recorte ampliado); si no coinciden queda parcial', async () => {
  const caja = { x: .4, y: .5, w: .1, h: .05 };
  const ok = montar({ leer: (j, m, o) => o.placaSolo ? { moto: true, placa: 'AR8U65M' } : { moto: true, placa: 'AR8U65M', caja } });
  await ok.ev(1);
  assert.equal(ok.pub(1).placa, 'AR8U65M');
  assert.deepEqual(ok.llamadas.leer, ['full', 'zoom']);
  const dudosa = montar({ leer: (j, m, o) => o.placaSolo ? { moto: true, placa: 'AR8U65M' } : { moto: true, placa: 'AR8U65H', caja } });
  await dudosa.ev(1);
  assert.equal(dudosa.pub(1).placa, '', 'no debe quedar una placa en la que las dos vistas no coinciden');
  assert.equal(dudosa.pub(1).parcial, 'AR8U65?');
});

test('un parcial completado por el recorte ampliado se acepta', async () => {
  const t = montar({ leer: (j, m, o) => o.placaSolo ? { moto: true, placa: 'AR8U65M' } : { moto: true, placa: '', parcial: 'AR8U65?', motivo: 'parcial', caja: { x: .4, y: .5, w: .1, h: .05 } } });
  await t.ev(1);
  assert.equal(t.pub(1).placa, 'AR8U65M');
});

test('una placa completa que casi coincide con UNA sola factura se enlaza como aproximada; con dos facturas parecidas no', async () => {
  const lee = () => ({ moto: true, placa: 'AR8U65H' });
  const a = montar({ leer: lee, ventas: [{ num: 1, placa: 'AR8U65M' }] });
  await a.ev(1);
  assert.equal(a.pub(1).estado, 'ok'); assert.equal(a.pub(1).num, 1); assert.equal(a.pub(1).aprox, 'AR8U65M');
  const b = montar({ leer: lee, ventas: [{ num: 1, placa: 'AR8U65M' }, { num: 2, placa: 'AR8U65N' }] });
  await b.ev(1);
  assert.notEqual(b.pub(1).estado, 'ok');
});

// ---------- puente ocupado: relectura, otra moto, descarte ----------
const OCUPADO = { 1: { estado: 'alerta', origen: 'alarma', placa: 'AV2S58F', parcial: '', intentos: 9, sinMoto: 0, confirmada: true, relT: 0, hid: 'mwo11111aa', desde: new Date(Date.now() - 600e3).toISOString() } };
const FILA = { id: 'mwo11111aa', puente: 1, placa: 'AV2S58F', estado: 'alerta' };

test('relectura: la misma placa se mantiene; otra placa completa abre una moto nueva', async () => {
  const igual = montar({ puentes: OCUPADO, historial: [FILA], leer: haiku(() => ({ moto: true, placa: 'AV2S58F' })) });
  await igual.ev(1, { revision: true });
  assert.equal(igual.pub(1).placa, 'AV2S58F');
  const otra = montar({ puentes: OCUPADO, historial: [FILA], leer: haiku(() => ({ moto: true, placa: 'KB9D77X' })) });
  await otra.ev(1, { revision: true });
  assert.equal(otra.pub(1).placa, 'KB9D77X');
  assert.equal(otra.filas().length, 2, 'la fila anterior se conserva y se abre otra');
});

test('una placa que no se confirma se descarta conservando su fila ("descartada") y la moto sigue en otra fila', async () => {
  const sinConfirmar = { 2: Object.assign({}, OCUPADO[1], { n: 2, confirmada: false, hid: 'mwo22222bb', placa: 'AN5B83G', estado: 'lavando' }) };
  const t = montar({ puentes: sinConfirmar, historial: [{ id: 'mwo22222bb', puente: 2, placa: 'AN5B83G', estado: 'lavando' }], leer: haiku(() => ({ moto: true, placa: '', parcial: '', motivo: 'ilegible' })) });
  await t.ev(2, { revision: true }); await ESPERA(5);
  await t.ev(2, { revision: true });
  assert.equal(t.pub(2).placa, '');
  const filas = t.filas();
  assert.ok(filas.some(f => f.placa === 'AN5B83G' && f.estado === 'descartada' && f.salida), 'la fila original debe quedar descartada con su placa');
  assert.equal(filas.length, 2);
});

test('la foto del historial no se pisa con las revisiones', async () => {
  const t = montar({ puentes: OCUPADO, historial: [Object.assign({}, FILA, { foto: 'LECTURA-ORIGINAL' })], leer: haiku(() => ({ moto: true, placa: 'AV2S58F' })) });
  await t.ev(1, { revision: true });
  assert.equal(fs.readFileSync(path.join(t.dir, 'fotos/hist/mwo11111aa.jpg')).toString(), 'LECTURA-ORIGINAL');
});

test('moto que llega justo después de otra: no hereda su fila ni su factura si la placa no encaja', async () => {
  const baja = new Date(Date.now() - 120e3).toISOString();
  const hist = [{ id: 'mwo33333cc', puente: 1, parcial: 'AD?N47R', estado: 'ok', num: 3, salida: baja }];
  const nueva = montar({ historial: hist, ventas: [{ num: 3, placa: 'AD8N47R' }], leer: () => ({ moto: true, placa: '', parcial: 'AE?183J', motivo: 'parcial' }) });
  await nueva.ev(1);
  assert.equal(nueva.pub(1).estado, 'esperando'); assert.equal(nueva.filas().length, 2);
  const misma = montar({ historial: hist, ventas: [{ num: 3, placa: 'AD8N47R' }], leer: () => ({ moto: true, placa: '', parcial: 'AD?N47R', motivo: 'parcial' }) });
  await misma.ev(1);
  assert.equal(misma.pub(1).estado, 'ok'); assert.equal(misma.filas().length, 1, 'la misma moto reabre su fila');
  const sinPlaca = montar({ historial: hist, comparar: () => ({ misma: false, confianza: 'alta' }), leer: () => ({ moto: true, placa: '', parcial: '', motivo: 'ilegible' }) });
  await sinPlaca.ev(1);
  assert.equal(sinPlaca.filas().length, 2, 'sin placa que comparar decide la foto');
});

test('un puente enlazado a una factura que deja de encajar vuelve a "esperando"', async () => {
  const t = montar({ puentes: { 1: { estado: 'ok', origen: 'alarma', placa: '', parcial: 'AE?183J', num: 3, aprox: 'AD8N47R', intentos: 1, sinMoto: 0, relT: Date.now() } }, ventas: [{ num: 3, placa: 'AD8N47R' }],
    leer: haiku(() => ({ moto: true, placa: '', parcial: 'AE?183J', motivo: 'parcial' })) });
  await t.ev(1, { revision: true });
  assert.equal(t.pub(1).estado, 'esperando'); assert.equal(t.pub(1).num, undefined);
});

test('liberar un puente a mano impide reabrir su fila', async () => {
  const baja = new Date(Date.now() - 60e3).toISOString();
  const t = montar({ puentes: OCUPADO, historial: [FILA], leer: () => ({ moto: true, placa: 'AV2S58F' }) });
  assert.equal(t.c.liberarPuente(1, 'Dueño'), true);
  assert.equal(t.pub(1).estado, 'libre');
  await t.ev(1);
  assert.equal(t.filas().length, 2, 'la moto que llega después abre fila nueva');
  void baja;
});

// ---------- alerta al bajar sin factura ----------
test('en el puente solo "en lavado"; al bajar espera 15 min; sin factura alerta; si se factura queda "facturada después"', async () => {
  const mk = (ventas) => montar({ puentes: { 1: { estado: 'esperando', origen: 'alarma', placa: 'AM2C70K', parcial: '', intentos: 9, sinMoto: 0, confirmada: true, relT: Date.now(), hid: 'mwo44444dd', desde: new Date(Date.now() - 6 * 60e3).toISOString() } },
    historial: [{ id: 'mwo44444dd', puente: 1, placa: 'AM2C70K', estado: 'esperando', llegada: new Date(Date.now() - 6 * 60e3).toISOString() }], ventas, leer: haiku(() => ({ moto: true, placa: 'AM2C70K' })) });
  const a = mk([]);
  await a.ev(1, { revision: true });
  assert.equal(a.pub(1).estado, 'lavando');
  await a.ev(1, { presente: false });
  assert.equal(a.pub(1).estado, 'libre'); assert.equal(a.filas()[0].estado, 'espera');
  await conHora(16 * 60e3, async () => assert.equal(a.filas()[0].estado, 'alerta'));
  const b = mk([]);
  await b.ev(1, { revision: true }); await b.ev(1, { presente: false });
  const venta = { num: 2, placa: 'AM2C70K', fecha: new Date(Date.now() + 1000).toISOString() };
  let ventas = []; const c2 = mk(() => ventas);
  await c2.ev(1, { revision: true }); await c2.ev(1, { presente: false });
  ventas = [venta];
  await conHora(10 * 60e3, async () => { const f = c2.filas()[0]; assert.equal(f.estado, 'tarde'); assert.equal(f.num, 2); });
});

// ---------- cruce de la foto del encargado ----------
const PUENTES_CRUCE = { 2: { estado: 'ok', placa: 'AJ002E', num: 7, confirmada: true }, 3: { estado: 'ok', placa: 'OTRA11', confirmada: true } };
const fotosPuentes = dir => [2, 3].forEach(n => fs.writeFileSync(path.join(dir, 'fotos', 'camara-puente-' + n + '.jpg'), Buffer.from('P' + n)));

test('el cruce compara la foto del encargado SOLO con el puente de la misma placa (o casi igual)', async () => {
  const v = { id: 'abc123def456', num: 7, placa: 'AJ0002E' };
  const t = montar({ puentes: PUENTES_CRUCE, ventas: [v] }); fotosPuentes(t.dir);
  const r = await t.c.cruzar(v, Buffer.alloc(2000, 1));
  assert.deepEqual(t.llamadas.comparar, ['P2']);
  assert.equal(r.puente, 2); assert.equal(r.misma, true);
  assert.equal(t.c.cruces().items[0].tipo, 'coincide');
});

test('misma placa pero otra moto: alerta "distinta"; sin puente con esa placa queda pendiente; sin placa no se cruza', async () => {
  const v = { id: 'abc123def456', num: 7, placa: 'AJ002E' };
  const t = montar({ puentes: PUENTES_CRUCE, ventas: [v], comparar: () => ({ misma: false, confianza: 'alta', motivo: 'color distinto' }) }); fotosPuentes(t.dir);
  const r = await t.c.cruzar(v, Buffer.alloc(2000, 1));
  assert.equal(r.misma, false); assert.equal(t.c.cruces().items[0].tipo, 'distinta');
  const sin = montar({ ventas: [v] });
  assert.deepEqual(await sin.c.cruzar(v, Buffer.alloc(2000, 1)), { puente: null, pendiente: true });
  assert.deepEqual(sin.llamadas.comparar, []);
  assert.deepEqual(await sin.c.cruzar({ id: 'ffffffffffff', num: 9, placa: '' }, Buffer.alloc(2000, 1)), { puente: null, sinPlaca: true });
});

test('una factura sin placa toma la placa que lee la cámara (si está enlazada con su puente)', async () => {
  const llamadas = [];
  const venta = { id: 'v3', num: 3, placa: '', sinPlaca: true };
  const t = montar({ puentes: { 3: { estado: 'ok', origen: 'alarma', placa: 'AD7E96K', parcial: '', num: 3, sinPlacaId: 'v3', confirmada: true, intentos: 1, relT: Date.now() } }, ventas: [venta],
    completarPlaca: (id, pl) => { llamadas.push([id, pl]); venta.placa = pl; venta.sinPlaca = false; return true; }, leer: haiku(() => ({ moto: true, placa: 'AD7E96K' })) });
  await t.ev(3, { revision: true });
  assert.deepEqual(llamadas, [['v3', 'AD7E96K']]);
});

test('una factura sin placa que ya tiene su moto en el historial no se asigna a la siguiente moto sin placa del mismo puente', async () => {
  const venta = { id: 'v10', num: 10, placa: '', sinPlaca: true };
  const hace = n => new Date(Date.now() - n * 60e3).toISOString();
  const t = montar({ historial: [{ id: 'mwosp000001', puente: 1, estado: 'ok', num: 10, llegada: hace(30), salida: hace(1), motivo: 'ilegible' }], ventas: [venta],
    comparar: () => ({ misma: false, confianza: 'alta', motivo: 'otra moto' }), leer: haiku(() => ({ moto: true, placa: '', parcial: '', motivo: 'ilegible' })) });
  await t.ev(1);
  const filas = t.filas().sort((a, b) => (a.llegada < b.llegada ? -1 : 1));
  assert.equal(filas.length, 2, 'la segunda moto abre una fila nueva');
  assert.equal(filas[0].num, 10);
  assert.ok(filas[1].num == null, 'la factura #10 ya tiene su moto: la nueva moto no la hereda');
  assert.equal(t.pub(1).estado, 'esperando');
  // una factura sin placa sin moto todavía sí se asigna a una moto sin placa
  const libre = montar({ ventas: [{ id: 'v11', num: 11, placa: '', sinPlaca: true }], leer: haiku(() => ({ moto: true, placa: '', parcial: '', motivo: 'ilegible' })) });
  await libre.ev(1);
  assert.equal(libre.filas()[0].num, 11);
});

test('varias facturas sin placa libres: no se adivina cuál es, queda por confirmar con las candidatas; con una sola se enlaza y se anota la razón', async () => {
  const despues = new Date(Date.now() + 60e3).toISOString(); // facturas hechas después de que llegó la moto
  const sinLeer = haiku(() => ({ moto: true, placa: '', parcial: '', motivo: 'ilegible' }));
  const dos = montar({ ventas: [{ id: 'v20', num: 20, placa: '', sinPlaca: true, fecha: despues }, { id: 'v21', num: 21, placa: '', sinPlaca: true, fecha: despues }], leer: sinLeer });
  await dos.ev(1);
  const f = dos.filas()[0]; assert.ok(f.num == null, 'con dos candidatas no se enlaza'); assert.deepEqual(f.candidatas, [20, 21]);
  assert.ok(dos.log().some(l => /podría ser la factura sin placa #20 o #21/.test(l)));
  const una = montar({ ventas: [{ id: 'v22', num: 22, placa: '', sinPlaca: true, fecha: despues }], leer: sinLeer });
  await una.ev(1);
  assert.equal(una.filas()[0].num, 22); assert.equal(una.filas()[0].razon, 'única factura sin placa');
});

test('la misma placa con dos facturas hoy: la segunda visita toma la factura libre, no la que ya tiene la primera', async () => {
  const hace = n => new Date(Date.now() - n * 60e3).toISOString();
  const leer = haiku(() => ({ moto: true, placa: 'AB123CD', parcial: '' }));
  const t = montar({ historial: [{ id: 'mwodu000001', puente: 1, placa: 'AB123CD', estado: 'ok', num: 30, llegada: hace(60), salida: hace(30) }],
    ventas: [{ id: 'v30', num: 30, placa: 'AB123CD', fecha: hace(55) }, { id: 'v31', num: 31, placa: 'AB123CD', fecha: hace(2) }], leer, comparar: () => ({ misma: false, confianza: 'alta', motivo: 'otra visita' }) });
  await t.ev(1);
  const nueva = t.filas().find(x => x.id !== 'mwodu000001'); assert.equal(nueva.num, 31); assert.equal(nueva.razon, 'placa igual');
  assert.equal(t.filas().find(x => x.id === 'mwodu000001').num, 30);
});

test('una factura solo tiene una moto activa: la segunda fila que se enlaza a la misma factura queda descartada como "misma moto"', async () => {
  const hace = n => new Date(Date.now() - n * 60e3).toISOString();
  const leer = haiku(() => ({ moto: true, placa: 'AB123CD', parcial: '' }));
  const t = montar({ historial: [{ id: 'mwodu000002', puente: 1, placa: 'AB123CD', estado: 'ok', num: 30, llegada: hace(40), salida: hace(20) }],
    ventas: [{ id: 'v30', num: 30, placa: 'AB123CD', fecha: hace(35) }], leer });
  await t.ev(5);
  const dup = t.filas().find(x => x.puente === 5); assert.equal(dup.estado, 'descartada'); assert.equal(dup.mismaDe, 30);
  assert.equal(t.filas().find(x => x.id === 'mwodu000002').estado, 'ok');
  assert.equal(t.c.cierre([{ id: 'v30', num: 30, placa: 'AB123CD', fecha: hace(35) }], HOY).motosSinFactura, 0);
});

test('placa real anotada en el historial: enlaza la moto con la factura de esa placa, o la descarta como misma moto si esa factura ya tiene otra fila; sin factura única no enlaza', () => {
  const hace = n => new Date(Date.now() - n * 60e3).toISOString();
  const v33 = { id: 'v33', num: 33, placa: 'AV2J16V', fecha: hace(30) }, v40 = { id: 'v40', num: 40, placa: 'ZZ9Z99Z', fecha: hace(20) };
  const t = montar({ historial: [
    { id: 'mworl000001', puente: 2, parcial: 'AY2J16A?', estado: 'alerta', llegada: hace(50), salida: hace(25) },
    { id: 'mworl000002', puente: 2, placa: 'AV2J16V', estado: 'tarde', num: 33, llegada: hace(24), salida: hace(10) },
    { id: 'mworl000003', puente: 3, parcial: 'QQ?Q9?Q', estado: 'alerta', llegada: hace(40), salida: hace(30) },
    { id: 'mworl000004', puente: 1, placa: 'NOHAY12', estado: 'alerta', llegada: hace(40), salida: hace(30) }], ventas: [v33, v40] });
  const ventasDe = () => [v33, v40], fila = id => t.filas().find(x => x.id === id);
  assert.equal(t.c.marcarReal('no-existe', 'X', ventasDe, 'Daniel'), false);
  // la factura #33 ya tiene su fila (la lectura buena): esta es la misma moto leída mal
  assert.deepEqual(t.c.marcarReal('mworl000001', 'av2j16v', ventasDe, 'Daniel'), { ok: true, fusionada: 33 });
  assert.equal(fila('mworl000001').estado, 'descartada'); assert.equal(fila('mworl000001').mismaDe, 33); assert.equal(fila('mworl000001').real, 'AV2J16V');
  // factura libre con esa placa: se enlaza y queda anotado quién lo hizo
  assert.deepEqual(t.c.marcarReal('mworl000003', 'ZZ9Z99Z', ventasDe, 'Daniel'), { ok: true, enlazada: 40 });
  assert.equal(fila('mworl000003').num, 40); assert.equal(fila('mworl000003').estado, 'tarde'); assert.equal(fila('mworl000003').corregida.por, 'Daniel');
  // sin factura con esa placa: solo se anota la placa real, como antes
  assert.deepEqual(t.c.marcarReal('mworl000004', 'NOHAY12', ventasDe, 'Daniel'), { ok: true });
  assert.ok(fila('mworl000004').num == null); assert.equal(fila('mworl000004').estado, 'alerta');
  // sin la función de facturas (uso antiguo) solo anota
  assert.deepEqual(t.c.marcarReal('mworl000004', 'AAAAA11'), { ok: true });
});

test('al facturar, el encargado elige la moto que la cámara ve (placa mal leída): se enlaza al momento, también si sigue en el puente, y se ofrece aunque acabe de llegar', async () => {
  const hace = n => new Date(Date.now() - n * 60e3).toISOString();
  const v = { id: 'v50', num: 50, placa: 'AV2J16V', fecha: new Date().toISOString() };
  const t = montar({ historial: [
    { id: 'mwoal000001', puente: 2, parcial: 'AY2J16A?', estado: 'esperando', llegada: hace(1) },
    { id: 'mwoal000002', puente: 1, placa: 'XX11XX1', estado: 'alerta', llegada: hace(30), salida: hace(20), num: null }],
    puentes: { 2: { estado: 'esperando', hid: 'mwoal000001', desde: hace(1), origen: 'alarma', parcial: 'AY2J16A?', intentos: 3, leidoT: Date.now() } }, ventas: [v],
    leer: haiku(() => ({ moto: true, placa: '', parcial: 'AY2J16A?', motivo: 'dañada' })) });
  const p = t.c.pendientes();
  assert.equal(p.n, 1, 'la recién llegada no cuenta para el aviso (solo la que bajó)'); assert.equal(p.todas.length, 2, 'pero sí se ofrece al facturar');
  assert.ok(t.c.enlazarAlFacturar('no-existe', v, 'Daniel').error);
  assert.deepEqual(t.c.enlazarAlFacturar('mwoal000001', v, 'Daniel'), { ok: true, num: 50 });
  const f = t.filas().find(x => x.id === 'mwoal000001'); assert.equal(f.num, 50); assert.equal(f.estado, 'ok'); assert.equal(f.real, 'AV2J16V'); assert.equal(f.corregida.por, 'Daniel'); assert.equal(f.razon, 'elegida al facturar');
  assert.equal(t.pub(2).estado, 'ok'); assert.equal(t.pub(2).num, 50);
  await t.ev(2); // una lectura posterior (otra vez parcial) no deshace el enlace
  assert.equal(t.pub(2).estado, 'ok'); assert.equal(t.filas().find(x => x.id === 'mwoal000001').num, 50);
  assert.match(t.c.enlazarAlFacturar('mwoal000001', v, 'Daniel').error, /ya tiene factura/);
  assert.deepEqual(t.c.enlazarAlFacturar('mwoal000002', { id: 'v51', num: 51, placa: '' }, 'Daniel'), { ok: true, num: 51 }); // ya bajó: queda "facturada después"
  assert.equal(t.filas().find(x => x.id === 'mwoal000002').estado, 'tarde');
});

test('cruces de fotos: filtra por día (hora de Caracas); sin día devuelve los recientes y un día sin cruces sale vacío', () => {
  const t = montar({ cruces: [{ foto: 'aaa111-p1.jpg' }, { foto: 'bbb222-p2.jpg' }] });
  const todos = t.c.cruces(); assert.equal(todos.dia, null); assert.equal(todos.items.length, todos.resumen.total);
  const hoy = t.c.cruces(HOY); assert.equal(hoy.dia, HOY); assert.equal(hoy.items.length, todos.items.length);
  const otro = t.c.cruces('2020-01-01'); assert.equal(otro.dia, '2020-01-01'); assert.equal(otro.items.length, 0); assert.equal(otro.resumen.total, 0);
  assert.equal(t.c.cruces('no-es-fecha').dia, null, 'una fecha inválida se ignora');
});

test('revalidación automática: cuando se enlaza (o baja) la moto de una factura se reintenta enseguida, sin esperar ni revalidar a mano', async () => {
  const hace = n => new Date(Date.now() - n * 60e3).toISOString();
  const v = { id: 'abcdef123459', num: 7, placa: 'AB123CD', fecha: hace(10), estado: 'pagada' };
  const t = montar({ historial: [{ id: 'mwoar000001', puente: 1, placa: 'QQ9Q9QQ', estado: 'alerta', llegada: hace(20), salida: hace(12), foto: 'MOTO' }], ventaFotos: [v], ventas: [v] });
  const r1 = await t.c.autoRevalidar(); assert.deepEqual(r1.hechos, [{ num: 7, tipo: 'ninguna' }], 'sin moto enlazada ni placa parecida no hay nada que comparar');
  assert.deepEqual((await t.c.autoRevalidar()).hechos, [], 'sin cambios espera su turno (5 min)');
  assert.equal(t.c.reasignarEnlace('mwoar000001', 7, () => [v], 'Daniel').ok, true); // se enlaza la moto a la factura
  const r3 = await t.c.autoRevalidar(); assert.deepEqual(r3.hechos, [{ num: 7, tipo: 'coincide' }], 'al enlazarse se compara enseguida');
  assert.ok(t.c.ventasValidadas().has('abcdef123459'));
});

test('pendientes: lo que se le recuerda al encargado son las motos montadas más de 5 min o ya bajadas sin factura (no las recién llegadas, falsos positivos, descartadas ni facturadas)', () => {
  const hace = n => new Date(Date.now() - n * 60e3).toISOString();
  const t = montar({ historial: [
    { id: 'mwope000001', puente: 1, placa: 'AZ6B12A', estado: 'esperando', llegada: hace(12) },
    { id: 'mwope000002', puente: 2, estado: 'esperando', llegada: hace(2) },
    { id: 'mwope000003', puente: 3, parcial: 'AB12?3C', estado: 'espera', llegada: hace(30), salida: hace(4) },
    { id: 'mwope000004', puente: 1, estado: 'esperando', llegada: hace(40), salida: hace(35) },
    { id: 'mwope000005', puente: 2, placa: 'XX1', estado: 'descartada', llegada: hace(50), salida: hace(45) },
    { id: 'mwope000006', puente: 3, placa: 'AAA111', estado: 'ok', num: 7, llegada: hace(20) },
    { id: 'mwope000007', puente: 5, estado: 'esperando', llegada: hace(20) },
  ] });
  const r = t.c.pendientes();
  assert.equal(r.n, 2);
  assert.deepEqual(r.items.map(x => [x.id, x.estado, x.puente]), [['mwope000003', 'bajo', 3], ['mwope000001', 'montada', 1]]);
  assert.equal(r.items[1].lectura, 'AZ6B12A'); assert.ok(r.items[0].bajoMin >= 4);
});

// ---------- menos llamadas a la IA ----------
test('una moto ya enlazada a una factura con placa no sigue con las lecturas lentas de su placa; una sin enlazar sí', async () => {
  const base = { estado: 'esperando', origen: 'alarma', placa: '', parcial: 'AB12?3C', intentos: 3, leidoT: Date.now() - 600e3, relT: Date.now(), desde: new Date().toISOString() };
  const v = { id: 'v5', num: 5, placa: 'AB12D3C' };
  const enlazada = montar({ puentes: { 1: Object.assign({}, base, { estado: 'ok', num: 5, aprox: 'AB12D3C' }) }, ventas: [v], leer: haiku(() => ({ moto: true, placa: '', parcial: 'AB12?3C' })) });
  await conHora(200e3, () => enlazada.ev(1));
  assert.deepEqual(enlazada.llamadas.leer, [], 'enlazada: no se vuelve a leer');
  const libre = montar({ puentes: { 1: Object.assign({}, base) }, ventas: [], leer: haiku(() => ({ moto: true, placa: '', parcial: 'AB12?3C' })) });
  await conHora(200e3, () => libre.ev(1));
  assert.ok(libre.llamadas.leer.length >= 1, 'sin enlazar: sigue leyendo');
});

test('puente libre que se ve igual que en la última revisión con la IA no vuelve a preguntar si hay moto; si cambia, o pasan 3 minutos, sí', async () => {
  const shim = path.join(os.tmpdir(), 'motolavado-ffmpeg-miniatura.sh');
  fs.writeFileSync(shim, '#!/bin/sh\ncase "$*" in\n *rawvideo*) b=$(dd bs=1 count=1 2>/dev/null | od -An -tu1 | tr -d " \\n"); cat >/dev/null; LC_ALL=C awk -v b="$b" \'BEGIN{for(i=0;i<576;i++) printf "%c", b+0}\' ;;\n *) cat ;;\nesac\n', { mode: 0o755 });
  const t = montar({ ffmpeg: shim, leer: () => ({ moto: false }) });
  await t.ev(1, { revision: true });
  assert.equal(t.llamadas.leer.length, 1, 'primera revisión: pregunta');
  await t.ev(1, { revision: true });
  assert.equal(t.llamadas.leer.length, 1, 'misma escena: no pregunta');
  await t.ev(1, { revision: true, byte: 90 });
  assert.equal(t.llamadas.leer.length, 2, 'la escena cambió: pregunta');
  await conHora(4 * 60e3, () => t.ev(1, { revision: true, byte: 90 }));
  assert.equal(t.llamadas.leer.length, 3, 'pasaron más de 3 minutos: pregunta aunque se vea igual');
  // si ffmpeg no puede sacar la miniatura, siempre pregunta (como antes)
  const sin = montar({ leer: () => ({ moto: false }) });
  await sin.ev(1, { revision: true }); await sin.ev(1, { revision: true });
  assert.equal(sin.llamadas.leer.length, 2);
});

// ---------- Revalidar y validación manual ----------
test('Revalidar: encuentra la fila por placa parecida (0/O, 1/I) y la enlaza a la factura', async () => {
  const v = { id: 'abcdef123456', num: 9, placa: 'AE0I83J', fecha: new Date().toISOString() };
  const t = montar({ historial: [{ id: 'mwo55555ee', puente: 1, parcial: 'AE0183?', estado: 'alerta', salida: new Date().toISOString() }], ventaFotos: [v], ventas: [v] });
  const r = await t.c.revalidar(v);
  assert.equal(r.tipo, 'coincide');
  const f = t.filas()[0]; assert.equal(f.estado, 'tarde'); assert.equal(f.num, 9);
});

test('Revalidar: una factura sin placa enlazada a una moto se compara solo con esa moto: coincide la valida; si es otra moto lo marca "distinta"; sin moto enlazada no gasta comparaciones', async () => {
  const v = { id: 'abcdef123457', num: 1, placa: '', sinPlaca: true, fecha: new Date().toISOString() };
  const fila = { id: 'mwosp111111', puente: 2, estado: 'ok', num: 1, llegada: new Date(Date.now() - 60e3).toISOString() };
  const si = montar({ historial: [fila], ventaFotos: [v], ventas: [v], comparar: () => ({ misma: true, confianza: 'alta', motivo: 'igual' }) });
  const r = await si.c.revalidar(v, { soloPlaca: true });
  assert.equal(r.tipo, 'coincide'); assert.equal(r.comparadas, 1); assert.equal(si.llamadas.comparar.length, 1);
  const no = montar({ historial: [fila], ventaFotos: [v], ventas: [v], comparar: () => ({ misma: false, confianza: 'alta', motivo: 'otra moto' }) });
  assert.equal((await no.c.revalidar(v, { soloPlaca: true })).tipo, 'distinta');
  const sola = montar({ historial: [Object.assign({}, fila, { num: null })], ventaFotos: [v], ventas: [v] });
  const n = await sola.c.revalidar(v, { soloPlaca: true }); assert.equal(n.tipo, 'ninguna'); assert.equal(sola.llamadas.comparar.length, 0);
});

test('Revalidar con la moto todavía en el puente: el puente también queda enlazado (no sigue "esperando") y una lectura posterior no lo deshace', async () => {
  const hace = n => new Date(Date.now() - n * 60e3).toISOString();
  const v = { id: 'abcdef123458', num: 2, placa: 'AB123CD', fecha: new Date().toISOString() };
  const t = montar({ historial: [{ id: 'mwolv000001', puente: 2, placa: 'AD1Z3CD', estado: 'esperando', llegada: hace(5) }],
    puentes: { 2: { estado: 'esperando', hid: 'mwolv000001', desde: hace(5), origen: 'alarma', placa: 'AD1Z3CD', confirmada: true, intentos: 3, leidoT: Date.now() } },
    ventaFotos: [v], ventas: [() => v].map(f => f()), comparar: () => ({ misma: true, confianza: 'alta', motivo: 'igual' }), leer: haiku(() => ({ moto: true, placa: 'AD1Z3CD', parcial: '' })) });
  const r = await t.c.revalidar(v); assert.equal(r.tipo, 'coincide');
  assert.equal(t.pub(2).estado, 'ok'); assert.equal(t.pub(2).num, 2);
  const f = t.filas()[0]; assert.equal(f.num, 2); assert.equal(f.estado, 'ok');
  await t.ev(2); // otra lectura que no encaja con la placa de la factura
  assert.equal(t.pub(2).estado, 'ok'); assert.equal(t.filas()[0].num, 2);
});

test('Revalidar: sin lecturas con esa placa busca entre todas las fotos de hoy, empezando por las más cercanas en el tiempo', async () => {
  const v = { id: 'abcdef123456', num: 4, placa: 'AJ0002E', fecha: new Date().toISOString() };
  const ruido = Array.from({ length: 30 }, (_, i) => ({ id: 'mwo9' + String(i).padStart(5, '0'), puente: 2, estado: 'esperando', llegada: new Date(Date.now() + (i + 60) * 60e3).toISOString(), foto: 'RUIDO' }));
  const t = montar({ historial: ruido, cruces: [{ foto: 'mwo77777ff-p3.jpg', contenido: 'MATCH' }], ventaFotos: [v], ventas: [v], comparar: (a, b) => b === 'MATCH' ? { misma: true, confianza: 'alta', motivo: 'misma' } : { misma: false, confianza: 'alta', motivo: 'otra' } });
  const r = await t.c.revalidar(v);
  assert.equal(r.tipo, 'coincide'); assert.equal(r.puente, 3);
  assert.ok(r.comparadas <= 24);
  const ninguna = montar({ historial: ruido.slice(0, 3), ventaFotos: [v], ventas: [v], comparar: () => ({ misma: false, confianza: 'alta' }) });
  assert.equal((await ninguna.c.revalidar(v)).tipo, 'ninguna');
  assert.ok((await montar({ ventas: [v] }).c.revalidar(v)).error, 'sin foto del encargado debe dar error');
});

test('Validar a ojo exige una nota y queda registrado con el nombre del dueño', () => {
  const v = { id: 'abcdef123456', num: 6, placa: 'AV4I96F' };
  const t = montar({ ventas: [v] });
  assert.ok(t.c.validarManual(v, 'ab', 'Raúl').error);
  assert.deepEqual(t.c.validarManual(v, 'misma moto a simple vista', 'Raúl'), { ok: true });
  const c = t.c.cruces().items[0]; assert.equal(c.tipo, 'manual'); assert.equal(c.por, 'Raúl'); assert.equal(c.valido, true);
});

// ---------- zona "fuera del puente" ----------
test('fuera del puente: el movimiento de menos de un minuto se ignora y uno sostenido pasa a leerse', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'motolavado-'));
  fs.writeFileSync(path.join(dir, 'camara-zonas.json'), JSON.stringify([{ puente: 1, x: .316, y: .46, w: .105, h: .24 }, { puente: 5, x: .19, y: .66, w: .13, h: .14 }]));
  const c = crear({ DATA: dir, json: () => {}, fechaCaracas: () => HOY, ventasDeHoy: () => [], leerPlaca: async () => ({ moto: false, placa: '' }) });
  const xml = `<?xml version="1.0"?><EventNotificationAlert><eventType>VMD</eventType><eventState>active</eventState><X>0.25</X><Y>0.72</Y><width>0.02</width><height>0.04</height></EventNotificationAlert>`;
  const alarma = async () => { const req = Readable.from([Buffer.from(xml)]); req.headers = { 'content-type': 'application/xml' }; req.url = '/api/camara/alarma?t=' + TOKEN; await c.alarma(req, {}); };
  const consola = console.log, visto = []; console.log = (...a) => visto.push(a.join(' ')); process.env.CAMARA_DEPURAR = '1';
  try {
    // CAMARA_DEPURAR se lee en cada llamada de dep(): así se observa qué hizo cada aviso
    await conHora(0, alarma); await conHora(20e3, alarma); await conHora(40e3, alarma); await ESPERA(100);
    assert.equal(visto.filter(x => /se ignora/.test(x)).length, 3, 'los tres avisos del primer minuto se ignoran');
    const antes = visto.length; await conHora(65e3, alarma); await ESPERA(100);
    assert.ok(!visto.slice(antes).some(x => /se ignora/.test(x)), 'pasado el minuto ya no se ignora');
  } finally { console.log = consola; delete process.env.CAMARA_DEPURAR; }
});

// ---------- facturas validadas / pendientes por validación ----------
test('un cruce bueno (o la validación a ojo) deja la factura marcada como validada; marcar "No" la quita', async () => {
  const marcadas = [];
  const v = { id: 'abc123def456', num: 7, placa: 'AJ002E' };
  const t = montar({ puentes: PUENTES_CRUCE, ventas: [v], marcarValidada: (id, info) => { marcadas.push([id, info.tipo]); } }); fotosPuentes(t.dir);
  await t.c.cruzar(v, Buffer.alloc(2000, 1));
  assert.deepEqual(marcadas, [['abc123def456', 'coincide']]);
  assert.ok(t.c.ventasValidadas().has('abc123def456'));
  t.c.validarCruce(t.c.cruces().items[0].id, false); // el dueño dice que Claude se equivocó
  assert.ok(!t.c.ventasValidadas().has('abc123def456'));
  const m = montar({ ventas: [{ id: 'ffffffffffff', num: 9, placa: 'XX1' }], marcarValidada: (id, info) => marcadas.push([id, info.tipo, info.por]) });
  m.c.validarManual({ id: 'ffffffffffff', num: 9, placa: 'XX1' }, 'misma moto a simple vista', 'Raúl');
  assert.deepEqual(marcadas[1], ['ffffffffffff', 'manual', 'Raúl']);
  const distinta = montar({ puentes: PUENTES_CRUCE, ventas: [v], comparar: () => ({ misma: false, confianza: 'alta' }), marcarValidada: id => marcadas.push(['NO', id]) }); fotosPuentes(distinta.dir);
  await distinta.c.cruzar(v, Buffer.alloc(2000, 1));
  assert.ok(!marcadas.some(x => x[0] === 'NO'), 'un cruce "distinta" no valida la factura');
});

// ---------- fuera del puente: solo se registra con placa legible ----------
test('fuera del puente: una moto sin placa legible no se registra ni guarda foto; con placa (o parcial) sí', async () => {
  const sin = montar({ leer: haiku(() => ({ moto: true, placa: '', parcial: '', motivo: 'ilegible' })) });
  await sin.ev(5, { revision: true });
  assert.equal(sin.pub(5).estado, 'libre'); assert.equal(sin.filas().length, 0);
  await sin.ev(5); // por aviso del agente/cámara
  assert.equal(sin.pub(5).estado, 'libre'); assert.equal(sin.filas().length, 0);
  assert.deepEqual(fs.readdirSync(path.join(sin.dir, 'fotos/hist')), [], 'no se guardó ninguna foto en el historial');
  const conPlaca = montar({ leer: haiku(() => ({ moto: true, placa: 'AB1C23D' })) });
  await conPlaca.ev(5, { revision: true });
  assert.equal(conPlaca.pub(5).estado, 'esperando'); assert.equal(conPlaca.filas().length, 1);
  const parcial = montar({ leer: haiku(() => ({ moto: true, placa: '', parcial: 'AB1C??', motivo: 'parcial' })) });
  await parcial.ev(5, { revision: true });
  assert.equal(parcial.pub(5).estado, 'esperando');
  // en un puente normal una moto sin placa legible SÍ se registra (como siempre)
  const normal = montar({ leer: haiku(() => ({ moto: true, placa: '', parcial: '', motivo: 'ilegible' })) });
  await normal.ev(1, { revision: true });
  assert.equal(normal.pub(1).estado, 'esperando');
});

test('el historial no muestra las filas antiguas de fuera del puente que no tienen placa', () => {
  const t = montar({ historial: [{ id: 'mwo1fuera01', puente: 5 }, { id: 'mwo1fuera02', puente: 5, parcial: 'AB1C??' }, { id: 'mwo1norml03', puente: 2 }] });
  assert.deepEqual(t.filas().map(f => f.id).sort(), ['mwo1fuera02', 'mwo1norml03']);
});

test('la revisión de un puente libre queda visible en el panel (última revisión y qué vio)', async () => {
  const sin = montar({ leer: () => ({ moto: false, placa: '' }) });
  await sin.ev(3, { revision: true });
  assert.equal(sin.pub(3).estado, 'libre'); assert.equal(sin.pub(3).revL.h, false);
  const con = montar({ leer: haiku(() => ({ moto: true, placa: 'AB1C23D' })) });
  await con.ev(3, { revision: true });
  assert.equal(con.pub(3).estado, 'esperando');
});

test('puente 1: un trozo de moto cortado en el borde y sin placa (la moto está fuera del puente) no se registra; entera sí', async () => {
  const cortada = montar({ leer: haiku(() => ({ moto: true, placa: '', parcial: '', motivo: 'ilegible', cortada: true })) });
  await cortada.ev(1, { revision: true }); await cortada.ev(1);
  assert.equal(cortada.pub(1).estado, 'libre'); assert.equal(cortada.filas().length, 0);
  const entera = montar({ leer: haiku(() => ({ moto: true, placa: '', parcial: '', motivo: 'ilegible', cortada: false })) });
  await entera.ev(1, { revision: true });
  assert.equal(entera.pub(1).estado, 'esperando');
  const conPlaca = montar({ leer: haiku(() => ({ moto: true, placa: 'AB1C23D', cortada: true })) });
  await conPlaca.ev(1, { revision: true });
  assert.equal(conPlaca.pub(1).estado, 'esperando', 'si se lee la placa se registra aunque salga cortada');
  const otroPuente = montar({ leer: haiku(() => ({ moto: true, placa: '', parcial: '', motivo: 'ilegible', cortada: true })) });
  await otroPuente.ev(2, { revision: true });
  assert.equal(otroPuente.pub(2).estado, 'esperando', 'el resto de puentes no cambia');
});

test('puente 1 ocupado sin placa que en realidad es un trozo de moto cortado se libera y su fila queda descartada', async () => {
  const t = montar({ puentes: { 1: { estado: 'lavando', origen: 'revision', placa: '', parcial: '', intentos: 9, sinMoto: 0, hid: 'mwo88888gg', desde: new Date(Date.now() - 300e3).toISOString() } },
    historial: [{ id: 'mwo88888gg', puente: 1, estado: 'lavando' }], leer: haiku(() => ({ moto: true, placa: '', parcial: '', motivo: 'ilegible', cortada: true })) });
  await t.ev(1, { revision: true });
  assert.equal(t.pub(1).estado, 'lavando', 'a la primera revisión todavía no');
  t.c.publico(); await conHora(60e3, async () => { await t.ev(1, { revision: true }); });
  assert.equal(t.pub(1).estado, 'libre');
  assert.equal(t.filas()[0].estado, 'descartada');
  // una moto entera con la placa ilegible NO se libera
  const entera = montar({ puentes: { 1: { estado: 'lavando', origen: 'revision', placa: '', parcial: '', intentos: 9, sinMoto: 0, hid: 'mwo99999hh', desde: new Date(Date.now() - 300e3).toISOString() } },
    historial: [{ id: 'mwo99999hh', puente: 1, estado: 'lavando' }], leer: haiku(() => ({ moto: true, placa: '', parcial: '', motivo: 'ilegible', cortada: false })) });
  await entera.ev(1, { revision: true }); await conHora(60e3, async () => { await entera.ev(1, { revision: true }); });
  assert.equal(entera.pub(1).estado, 'lavando');
});

test('la vista en vivo se renueva con cada foto que llega, como mucho una cada CAMARA_VISTA_MS', async () => {
  process.env.CAMARA_VISTA_MS = '300';
  try {
    const t = montar();
    const foto = path.join(t.dir, 'foto.jpg'); fs.writeFileSync(foto, Buffer.alloc(3000, 5));
    t.c.fotoRecibida('a.jpg', foto); await ESPERA(120);
    const t1 = t.c.publico().vista && t.c.publico().vista.t;
    assert.ok(t1, 'la primera foto genera la vista');
    t.c.fotoRecibida('b.jpg', foto); await ESPERA(120); // dentro del intervalo: no cambia
    assert.equal(t.c.publico().vista.t, t1);
    await ESPERA(300); t.c.fotoRecibida('c.jpg', foto); await ESPERA(150); // pasado el intervalo: se renueva
    assert.notEqual(t.c.publico().vista.t, t1);
  } finally { delete process.env.CAMARA_VISTA_MS; }
});

// ---------- revalidación automática ----------
const haceMin = m => new Date(Date.now() - m * 60e3).toISOString();

test('revalidación automática: valida sola una factura cuya placa ya tiene lectura de la cámara, y no repite', async () => {
  const marcadas = [];
  const v = { id: 'aaaaaaaaaaa1', num: 5, placa: 'AX0A64W', fecha: haceMin(10), estado: 'pagada' };
  const t = montar({ historial: [{ id: 'mwoauto0001', puente: 1, placa: 'AX0A64W', estado: 'alerta', salida: haceMin(8) }], ventaFotos: [v], ventas: [v], marcarValidada: (id, i) => marcadas.push([id, i.tipo]) });
  const r = await t.c.autoRevalidar();
  assert.deepEqual(r.hechos, [{ num: 5, tipo: 'coincide' }]);
  assert.deepEqual(marcadas, [['aaaaaaaaaaa1', 'coincide']]);
  assert.equal(t.c.cruces().items[0].origen, 'automática');
  assert.equal(t.filas()[0].estado, 'tarde');
  const n = t.llamadas.comparar.length;
  await t.c.autoRevalidar();
  assert.equal(t.llamadas.comparar.length, n, 'una factura ya validada no se vuelve a comparar');
});

test('revalidación automática: salta las muy recientes, las de pago pendiente, las ya validadas y las sin foto', async () => {
  const reciente = { id: 'bbbbbbbbbbb1', num: 1, placa: 'AAA111', fecha: haceMin(1), estado: 'pagada' };
  const pend = { id: 'bbbbbbbbbbb2', num: 2, placa: 'AAA112', fecha: haceMin(30), estado: 'pendiente' };
  const ya = { id: 'bbbbbbbbbbb3', num: 3, placa: 'AAA113', fecha: haceMin(30), estado: 'pagada', validada: true };
  const sinFoto = { id: 'bbbbbbbbbbb4', num: 4, placa: 'AAA114', fecha: haceMin(30), estado: 'pagada' };
  const t = montar({ ventas: [reciente, pend, ya, sinFoto], ventaFotos: [reciente, pend, ya] });
  const r = await t.c.autoRevalidar();
  assert.deepEqual(r.hechos, []); assert.equal(t.llamadas.comparar.length, 0);
});

test('revalidación automática: un intento que no compara nada no gasta cupo de la vuelta', async () => {
  const sinLecturas = Array.from({ length: 10 }, (_, i) => ({ id: 'eeeeeeeeeee' + i, num: i + 1, placa: 'QQ' + (100 + i) + 'A', fecha: haceMin(15), estado: 'pagada' }));
  const t = montar({ ventaFotos: sinLecturas, ventas: sinLecturas });
  const r = await t.c.autoRevalidar();
  assert.equal(r.hechos.length, 10, 'las 10 se intentan en la misma vuelta porque ninguna compara fotos'); assert.equal(t.llamadas.comparar.length, 0);
});

test('revalidación automática: sin lecturas de esa placa primero no busca más (barato) y, con CAMARA_AUTOREV_TODAS=1, reintenta a los 5 min con todas las fotos del día; por defecto no', async () => {
  const v = { id: 'ccccccccccc1', num: 4, placa: 'AJ0002E', fecha: haceMin(20), estado: 'pagada' };
  const t = montar({ ventaFotos: [v], ventas: [v], cruces: [{ foto: 'mwo77777ff-p3.jpg', contenido: 'MATCH' }], comparar: (a, b) => b === 'MATCH' ? { misma: true, confianza: 'alta', motivo: 'misma' } : { misma: false, confianza: 'alta' } });
  let r = await t.c.autoRevalidar();
  assert.deepEqual(r.hechos, [{ num: 4, tipo: 'ninguna' }]); assert.equal(t.llamadas.comparar.length, 0, 'primer intento: sin lecturas de esa placa no compara nada');
  r = await t.c.autoRevalidar();
  assert.deepEqual(r.hechos, [], 'aún no toca el segundo intento');
  r = await conHora(6 * 60e3, () => t.c.autoRevalidar());
  assert.deepEqual(r.hechos, [{ num: 4, tipo: 'ninguna' }], 'por defecto el segundo intento tampoco busca en todas las fotos (solo el botón Revalidar lo hace)');
  assert.equal(t.llamadas.comparar.length, 0);
  process.env.CAMARA_AUTOREV_TODAS = '1';
  try {
    const t2 = montar({ ventaFotos: [v], ventas: [v], cruces: [{ foto: 'mwo77777ff-p3.jpg', contenido: 'MATCH' }], comparar: (a, b) => b === 'MATCH' ? { misma: true, confianza: 'alta', motivo: 'misma' } : { misma: false, confianza: 'alta' } });
    await t2.c.autoRevalidar();
    r = await conHora(6 * 60e3, () => t2.c.autoRevalidar());
    assert.deepEqual(r.hechos, [{ num: 4, tipo: 'coincide' }]); assert.ok(t2.llamadas.comparar.length >= 1);
  } finally { delete process.env.CAMARA_AUTOREV_TODAS; }
});

test('revalidación automática: una "otra moto" con la misma placa se registra una vez y deja de insistir; el gasto por vuelta se limita por comparaciones', async () => {
  const ventas = Array.from({ length: 8 }, (_, i) => ({ id: 'ddddddddddd' + i, num: i + 1, placa: String.fromCharCode(65 + i) + String.fromCharCode(75 + i) + (1000 + i * 37), fecha: haceMin(15), estado: 'pagada' }));
  const t = montar({ historial: ventas.map((v, i) => ({ id: 'mwodis0000' + i, puente: 2, placa: v.placa, estado: 'alerta', salida: haceMin(10) })), ventaFotos: ventas, ventas, comparar: () => ({ misma: false, confianza: 'alta', motivo: 'otra' }) });
  let r = await t.c.autoRevalidar();
  assert.equal(r.hechos.length, 6, 'tope de 6 comparaciones por vuelta (1 por factura aquí)'); assert.ok(r.hechos.every(h => h.tipo === 'distinta'));
  r = await t.c.autoRevalidar();
  assert.equal(r.hechos.length, 2, 'las otras dos en la vuelta siguiente; las 6 primeras ya no se repiten');
  assert.equal(t.c.cruces().items.filter(x => x.tipo === 'distinta').length, 8);
});

test('tieneFotoVenta dice si el servidor ya guardó la foto del encargado de esa factura', async () => {
  const v = { id: 'abc123def456', num: 7, placa: 'AJ002E' };
  const t = montar({ ventas: [v] });
  assert.equal(t.c.tieneFotoVenta('abc123def456'), false);
  await t.c.cruzar(v, Buffer.alloc(2000, 1));
  assert.equal(t.c.tieneFotoVenta('abc123def456'), true);
  assert.equal(t.c.tieneFotoVenta('../../etc/passwd'), false);
});

test('Revalidar prueba también las lecturas de la hora de la factura con una placa que difiere en hasta 2 caracteres (0 leído como G, 8 como 6), pero no las lejanas en el tiempo ni las muy distintas', async () => {
  const ahoraIso = new Date().toISOString(), hace = m => new Date(Date.now() - m * 60e3).toISOString();
  const v = { id: 'fffffffffff1', num: 37, placa: 'AU7000F', fecha: hace(2) };
  const t = montar({
    historial: [
      { id: 'mwoapro0001', puente: 3, llegada: hace(30), salida: hace(1), placa: 'AU70GGF', estado: 'alerta' },       // 2 caracteres, a la hora: candidata
      { id: 'mwoapro0002', puente: 1, llegada: hace(20), salida: hace(3), parcial: 'AU?0GGF', estado: 'alerta' },     // parcial parecida, a la hora: candidata
      { id: 'mwoapro0003', puente: 2, llegada: hace(300), salida: hace(280), placa: 'AU70GGF', estado: 'alerta' },    // parecida pero de hace horas: no
      { id: 'mwoapro0004', puente: 3, llegada: hace(30), salida: hace(1), placa: 'XYZ9876', estado: 'alerta' },       // a la hora pero otra placa: no
    ], ventaFotos: [v], ventas: [v] });
  const r = await t.c.revalidar(v, { soloPlaca: true });
  assert.equal(r.tipo, 'coincide');
  assert.equal(t.llamadas.comparar.length, 2, 'solo se comparó con las dos candidatas');
  void ahoraIso;
});

test('validación por placa: si la foto no permite decidir pero la cámara leyó una placa compatible a la hora de la factura, la factura queda validada por placa; con "otra moto", lectura descartada o lejos en el tiempo, no', async () => {
  const hace = m => new Date(Date.now() - m * 60e3).toISOString();
  const v = { id: 'abc111def222', num: 22, placa: 'AR0F38N', fecha: hace(3) };
  const dudosa = () => ({ misma: null, confianza: 'baja', motivo: 'solo se ve la placa en primer plano' });
  const base = { puente: 1, parcial: 'AR?F36N?', estado: 'alerta', llegada: hace(20), salida: hace(2) };
  const marcadas = [];
  const ok = montar({ historial: [Object.assign({ id: 'mwoplaca001' }, base)], ventaFotos: [v], ventas: [v], comparar: dudosa, marcarValidada: (id, i) => marcadas.push([id, i.tipo]) });
  const r = await ok.c.revalidar(v);
  assert.equal(r.tipo, 'placa'); assert.deepEqual(marcadas, [['abc111def222', 'placa']]);
  assert.match(ok.c.cruces().items[0].nota, /la cámara leyó AR\?F36N\?/);
  assert.equal(ok.filas()[0].estado, 'tarde');
  assert.ok(ok.c.ventasValidadas().has('abc111def222'));

  const descartada = montar({ historial: [Object.assign({ id: 'mwoplaca002' }, base, { estado: 'descartada' })], ventaFotos: [v], ventas: [v], comparar: dudosa });
  assert.notEqual((await descartada.c.revalidar(v)).tipo, 'placa');
  const otra = montar({ historial: [Object.assign({ id: 'mwoplaca003' }, base)], ventaFotos: [v], ventas: [v], comparar: () => ({ misma: false, confianza: 'alta', motivo: 'otra moto' }) });
  assert.equal((await otra.c.revalidar(v)).tipo, 'distinta');
  const lejos = montar({ historial: [Object.assign({ id: 'mwoplaca004' }, base, { llegada: hace(300), salida: hace(280) })], ventaFotos: [v], ventas: [v], comparar: dudosa });
  assert.notEqual((await lejos.c.revalidar(v)).tipo, 'placa');
});

test('una moto que reaparece en 10 min y reabre su fila conserva su placa confirmada: dos relecturas ilegibles (tapada por los mecánicos) no la descartan', async () => {
  const hace = m => new Date(Date.now() - m * 60e3).toISOString();
  const t = montar({ historial: [{ id: 'mwoback0001', puente: 3, placa: 'AY3U84A', estado: 'alerta', llegada: hace(30), salida: hace(2), foto: 'ANTES' }],
    comparar: () => ({ misma: true, confianza: 'alta', motivo: 'igual' }), leer: haiku(() => ({ moto: true, placa: '', parcial: '', motivo: 'ilegible' })) });
  await t.ev(3, { revision: true }); // reaparece la moto: la primera lectura es ilegible y se reabre la fila anterior
  assert.equal(t.pub(3).placa, 'AY3U84A'); assert.equal(t.filas().length, 1, 'se reabrió la misma fila');
  await t.ev(3, { revision: true }); await ESPERA(5);
  await t.ev(3, { revision: true }); await ESPERA(5);
  await t.ev(3, { revision: true });
  assert.equal(t.pub(3).placa, 'AY3U84A', 'la placa que ya se había leído y confirmado no se descarta');
  assert.notEqual(t.filas()[0].estado, 'descartada');
});

// ---------- emparejamiento inverso (moto vista sin factura -> buscar su factura por foto) ----------
test('emparejamiento inverso por imagen (solo con CAMARA_INVERSO_IMAGEN=1): se compara con las facturas de esa hora y, si Claude dice que es la misma con confianza alta, se enlaza y valida', async () => {
  process.env.CAMARA_INVERSO_IMAGEN = '1';
  try { await inversoPorImagen(); } finally { delete process.env.CAMARA_INVERSO_IMAGEN; }
  const sinVariable = montar({ historial: [{ id: 'mwoinv00099', puente: 1, estado: 'alerta', llegada: haceMin(40), salida: haceMin(10) }], ventaFotos: [{ id: 'abababababa9' }], ventas: [{ id: 'abababababa9', num: 9, placa: 'ZZ0001', fecha: haceMin(25), estado: 'pagada' }] });
  await sinVariable.c.autoEmparejarInversa();
  assert.equal(sinVariable.llamadas.comparar.length, 0, 'por defecto no se compara por imagen');
});
async function inversoPorImagen() {
  const marcadas = [];
  const v = { id: 'abababababa1', num: 36, placa: 'AL9J26A', fecha: haceMin(25), estado: 'pagada' };
  const lejos = { id: 'abababababa2', num: 37, placa: 'ZZ9999Z', fecha: haceMin(400), estado: 'pagada' };
  const t = montar({ historial: [{ id: 'mwoinv00001', puente: 1, estado: 'alerta', llegada: haceMin(40), salida: haceMin(10) }], ventaFotos: [v, lejos], ventas: [v, lejos],
    marcarValidada: (id, i) => marcadas.push([id, i.tipo]) });
  const r = await t.c.autoEmparejarInversa();
  assert.deepEqual(r.hechos, [{ fila: 'mwoinv00001', puente: 1, factura: 36 }]);
  assert.deepEqual(marcadas, [['abababababa1', 'coincide']]);
  const f = t.filas()[0]; assert.equal(f.num, 36); assert.equal(f.estado, 'tarde');
  assert.equal(t.c.cruces().items[0].origen, 'automática (moto sin factura)');
  assert.equal(t.llamadas.comparar.length, 1, 'la factura de hace 400 min queda fuera de la ventana de tiempo');
  assert.deepEqual((await t.c.autoEmparejarInversa()).hechos, [], 'ya enlazada: no se repite');
}

test('emparejamiento inverso: espera 5 min tras bajar, no enlaza si Claude duda o dice otra moto, hace como mucho 2 intentos y no usa facturas ya enlazadas', async () => {
  process.env.CAMARA_INVERSO_IMAGEN = '1';
  try { await inversoIntentos(); } finally { delete process.env.CAMARA_INVERSO_IMAGEN; }
});
async function inversoIntentos() {
  const v1 = { id: 'cdcdcdcdcdc1', num: 1, placa: 'AAA111', fecha: haceMin(15), estado: 'pagada' };
  const v2 = { id: 'cdcdcdcdcdc2', num: 2, placa: 'BBB222', fecha: haceMin(16), estado: 'pagada' };
  const reciente = montar({ historial: [{ id: 'mwoinv00002', puente: 2, estado: 'alerta', llegada: haceMin(20), salida: haceMin(2) }], ventaFotos: [v1], ventas: [v1] });
  assert.deepEqual((await reciente.c.autoEmparejarInversa()).hechos, [], 'bajó hace 2 min: todavía no');
  const duda = montar({ historial: [{ id: 'mwoinv00003', puente: 2, estado: 'alerta', llegada: haceMin(30), salida: haceMin(10) }], ventaFotos: [v1, v2], ventas: [v1, v2], comparar: () => ({ misma: true, confianza: 'media', motivo: 'parecida' }) });
  let r = await duda.c.autoEmparejarInversa();
  assert.deepEqual(r.hechos, [{ fila: 'mwoinv00003', puente: 2, factura: null }]); assert.equal(duda.filas()[0].num, null);
  r = await duda.c.autoEmparejarInversa(); assert.deepEqual(r.hechos, [], 'el segundo intento no toca hasta 40 min después');
  r = await conHora(41 * 60e3, () => duda.c.autoEmparejarInversa()); assert.equal(r.hechos.length, 1);
  r = await conHora(90 * 60e3, () => duda.c.autoEmparejarInversa()); assert.deepEqual(r.hechos, [], 'máximo 2 intentos');
  const yaEnlazada = montar({ historial: [{ id: 'mwoinv00004', puente: 1, placa: 'AAA111', num: 1, estado: 'tarde', llegada: haceMin(30), salida: haceMin(12) }, { id: 'mwoinv00005', puente: 3, estado: 'alerta', llegada: haceMin(30), salida: haceMin(12) }], ventaFotos: [v1], ventas: [v1] });
  r = await yaEnlazada.c.autoEmparejarInversa(); assert.equal(yaEnlazada.llamadas.comparar.length, 0, 'la factura #1 ya tiene su moto');
}

test('emparejamiento inverso por placa: una lectura aproximada de la cámara a la hora de UNA factura de placa parecida enlaza y valida por placa; con "otra moto" o dos candidatas parecidas no', async () => {
  const marcadas = [];
  const v = { id: 'efefefefefe1', num: 36, placa: 'AL9J26A', fecha: haceMin(25), estado: 'pagada' };
  const fila = { id: 'mwoinv00010', puente: 1, parcial: 'AL9?36A?', estado: 'alerta', llegada: haceMin(40), salida: haceMin(10) };
  const dudosa = () => ({ misma: null, confianza: 'baja', motivo: 'solo se ve la placa en primer plano' });
  const ok = montar({ historial: [fila], ventaFotos: [v], ventas: [v], comparar: dudosa, marcarValidada: (id, i) => marcadas.push([id, i.tipo]) });
  const r = await ok.c.autoEmparejarInversa();
  assert.deepEqual(r.hechos, [{ fila: 'mwoinv00010', puente: 1, factura: 36 }]);
  assert.deepEqual(marcadas, [['efefefefefe1', 'placa']]); assert.equal(ok.filas()[0].num, 36);
  assert.match(ok.c.cruces().items[0].nota, /la factura #36/);
  const otra = montar({ historial: [Object.assign({}, fila, { id: 'mwoinv00011' })], ventaFotos: [v], ventas: [v], comparar: () => ({ misma: false, confianza: 'alta', motivo: 'otra moto' }) });
  assert.equal((await otra.c.autoEmparejarInversa()).hechos[0].factura, null);
  const v2 = { id: 'efefefefefe2', num: 37, placa: 'AL9J26B', fecha: haceMin(24), estado: 'pagada' }; // dos facturas igual de parecidas: no se elige ninguna por placa
  const ambigua = montar({ historial: [Object.assign({}, fila, { id: 'mwoinv00012' })], ventaFotos: [v, v2], ventas: [v, v2], comparar: dudosa });
  assert.equal((await ambigua.c.autoEmparejarInversa()).hechos[0].factura, null);
});

test('enlazar a mano una moto vista sin factura con una factura: queda validada; no se puede repetir ni usar una factura que ya tiene moto', async () => {
  const marcadas = [];
  const v = { id: 'abcabcabcab1', num: 17, placa: 'AE4D1J', fecha: haceMin(5), estado: 'pagada' };
  const v2 = { id: 'abcabcabcab2', num: 18, placa: 'ZZZ999', fecha: haceMin(4), estado: 'pagada' };
  const t = montar({ historial: [{ id: 'mwoenl00001', puente: 1, placa: 'AE4D41J', estado: 'alerta', llegada: haceMin(200), salida: haceMin(180) }, { id: 'mwoenl00002', puente: 3, placa: 'XXX111', estado: 'alerta', llegada: haceMin(100), salida: haceMin(90) }, { id: 'mwoenl00003', puente: 2, placa: 'ZZZ999', estado: 'tarde', num: 18, llegada: haceMin(60), salida: haceMin(50) }],
    ventas: [v, v2], marcarValidada: (id, i) => marcadas.push([id, i.tipo, i.por]) });
  assert.ok(t.c.enlazarFila('no-existe', v, 'Raúl').error);
  assert.deepEqual(t.c.enlazarFila('mwoenl00001', v, 'Raúl'), { ok: true });
  assert.deepEqual(marcadas, [['abcabcabcab1', 'manual', 'Raúl']]);
  const f = t.filas().find(x => x.id === 'mwoenl00001'); assert.equal(f.num, 17); assert.equal(f.estado, 'tarde');
  assert.match(t.c.cruces().items[0].nota, /moto vista AE4D41J en el puente 1 con la factura #17/);
  assert.match(t.c.enlazarFila('mwoenl00001', v, 'Raúl').error, /ya está enlazada/);
  // La factura ya tiene su moto en otra fila: la lectura es la misma moto con otra placa; se descarta del conteo sin enlazar nada.
  assert.deepEqual(t.c.enlazarFila('mwoenl00002', v, 'Raúl'), { ok: true, fusionada: true });
  const f2 = t.filas().find(x => x.id === 'mwoenl00002'); assert.equal(f2.estado, 'descartada'); assert.equal(f2.mismaDe, 17); assert.ok(f2.num == null);
  assert.equal(t.c.cierre([v, v2], f2.dia).motosSinFactura, 0);
});

test('corregir el enlace de una moto: pasa la factura a otra fila (la anterior queda sin factura), valida que exista y se puede quitar', () => {
  const v17 = { id: 'cccccccccc17', num: 17, placa: 'AD5N53J', fecha: haceMin(5), estado: 'pagada' }, v10 = { id: 'cccccccccc10', num: 10, placa: 'AAA111', fecha: haceMin(9), estado: 'pagada' };
  const t = montar({ historial: [{ id: 'mwocor00001', puente: 1, placa: 'AD5N53J', estado: 'tarde', num: 10, llegada: haceMin(200), salida: haceMin(180) }, { id: 'mwocor00002', puente: 2, placa: 'QWE789', estado: 'tarde', num: 17, llegada: haceMin(100), salida: haceMin(90) }, { id: 'mwocor00003', puente: 3, estado: 'alerta', llegada: haceMin(60), salida: haceMin(50) }], ventas: [v17, v10] });
  const ventasDe = () => [v17, v10], fila = id => t.filas().find(x => x.id === id);
  assert.ok(t.c.reasignarEnlace('no-existe', 17, ventasDe, 'Raúl').error);
  assert.match(t.c.reasignarEnlace('mwocor00001', 99, ventasDe, 'Raúl').error, /No existe la factura #99/);
  assert.deepEqual(t.c.reasignarEnlace('mwocor00001', 17, ventasDe, 'Raúl'), { ok: true, antes: 10, num: 17, liberadas: 1 });
  assert.equal(fila('mwocor00001').num, 17); assert.equal(fila('mwocor00001').estado, 'tarde'); assert.equal(fila('mwocor00001').corregida.por, 'Raúl');
  assert.ok(fila('mwocor00002').num == null); assert.equal(fila('mwocor00002').estado, 'alerta'); // quedó sin factura, a la vista
  assert.deepEqual(t.c.reasignarEnlace('mwocor00002', 10, ventasDe, 'Raúl'), { ok: true, antes: null, num: 10, liberadas: 0 });
  assert.deepEqual(t.c.reasignarEnlace('mwocor00003', null, ventasDe, 'Raúl'), { ok: true, antes: null, num: null, liberadas: 0 });
  assert.equal(fila('mwocor00003').estado, 'alerta');
  assert.equal(t.c.reasignarEnlace('mwocor00001', null, ventasDe, 'Raúl').ok, true); assert.ok(fila('mwocor00001').num == null);
});

// ---------- llamadas a la API: esfuerzo bajo con respaldo y consumo registrado ----------
test('leerPlaca manda el esfuerzo de razonamiento configurado a Sonnet (no a Haiku), registra el consumo y, si la API rechaza el parámetro, reintenta sin él y deja de mandarlo', async () => {
  const https = require('https'), original = https.request, EventEmitter = require('events');
  const enviados = [];
  let rechazar = false;
  https.request = (opts, cb) => {
    const req = new EventEmitter();
    req.end = body => {
      const j = JSON.parse(body); enviados.push({ modelo: j.model, esfuerzo: j.output_config && j.output_config.effort, thinking: j.thinking && j.thinking.type });
      const res = new EventEmitter(); res.statusCode = (rechazar && j.output_config) ? 400 : 200; cb(res);
      res.emit('data', (rechazar && j.output_config) ? JSON.stringify({ error: { message: 'output_config.effort: no soportado' } })
        : JSON.stringify({ model: j.model, content: [{ type: 'text', text: '{"moto":true,"placa":"AB1C23D","segura":true}' }], usage: { input_tokens: 800, output_tokens: 60 } }));
      res.emit('end');
    };
    return req;
  };
  const clave0 = process.env.ANTHROPIC_API_KEY; process.env.ANTHROPIC_API_KEY = 'clave-de-prueba';
  try {
    const registros = [];
    const c = crear({ DATA: fs.mkdtempSync(path.join(os.tmpdir(), 'motolavado-api-')), json: () => {}, fechaCaracas: () => HOY, ventasDeHoy: () => [], registrarUso: r => registros.push(r) });
    const r1 = await c.leerPlaca(Buffer.alloc(100, 1));
    assert.equal(r1.placa, 'AB1C23D');
    assert.deepEqual(enviados[0], { modelo: 'claude-sonnet-5-5', esfuerzo: 'medium', thinking: undefined });
    assert.equal(registros[0].funcion, 'lectura-placa'); assert.equal(registros[0].usage.output_tokens, 60);
    await c.leerPlaca(Buffer.alloc(100, 1), 'claude-haiku-5-5');
    assert.deepEqual(enviados[1], { modelo: 'claude-haiku-5-5', esfuerzo: undefined, thinking: 'disabled' }, 'Haiku no lleva esfuerzo');
    // la API rechaza el parámetro: se reintenta sin él y la lectura sigue funcionando
    rechazar = true; enviados.length = 0;
    const r2 = await c.leerPlaca(Buffer.alloc(100, 1));
    assert.equal(r2.placa, 'AB1C23D'); assert.equal(enviados.length, 2); assert.equal(enviados[0].esfuerzo, 'medium'); assert.equal(enviados[1].esfuerzo, undefined);
    enviados.length = 0; await c.leerPlaca(Buffer.alloc(100, 1));
    assert.equal(enviados.length, 1); assert.equal(enviados[0].esfuerzo, undefined, 'tras el rechazo ya no se manda el parámetro');
  } finally { https.request = original; if (clave0 === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = clave0; }
});

// ---------- resumen del cierre del día ----------
test('cierre: cuenta las motos distintas de verdad (sin falsos positivos ni duplicados, sumando las descartadas que eran facturas), lista las sin factura y los puntos a revisar', () => {
  const hace = m => new Date(Date.now() - m * 60e3).toISOString();
  const fac = (num, placa, extra) => Object.assign({ id: 'cccccccccc' + String(num).padStart(2, '0'), num, placa, fecha: hace(100 - num), estado: 'pagada', moneda: 'Bs', esperado: 5045, monto: 5100, total: 5 }, extra || {});
  const ventas = [fac(1, 'AAA111', { validada: true }), fac(2, 'BBB222'), fac(3, 'CCC333'), fac(4, 'AAA111'), fac(5, 'DDD555', { monto: 9000 }), fac(6, 'EEE666', { fecha: hace(10) })];
  const row = (id, puente, extra) => Object.assign({ id: 'mwocie' + id, puente, estado: 'alerta', llegada: hace(300), salida: hace(290) }, extra);
  const t = montar({ ventas, historial: [
    row('0001', 1, { placa: 'AAA111', num: 1, estado: 'tarde' }), row('0002', 1, { placa: 'AAA111', num: 1, estado: 'tarde', llegada: hace(280), salida: hace(270) }), // dos filas de la factura #1
    row('0003', 3, { placa: 'BBB222', num: 2, estado: 'ok' }),
    row('0004', 3, { placa: 'CCC333', estado: 'descartada' }),                                                // descartada que era la factura #3
    row('0005', 2, { estado: 'esperando', llegada: hace(200), salida: hace(198) }),                           // falso positivo de 2 min
    row('0006', 1, { parcial: 'ZZ9?81Q', llegada: hace(200), salida: hace(190) }), row('0007', 1, { parcial: 'ZZ9?81?', llegada: hace(185), salida: hace(175) }), // la misma moto leída dos veces
    row('0008', 3, { placa: 'YYY777', llegada: hace(150), salida: hace(140) }),
  ] });
  const r = t.c.cierre(ventas, HOY);
  assert.equal(r.filas, 8); assert.equal(r.falsosPositivos, 1); assert.equal(r.descartadas, 1); assert.equal(r.reales, 6);
  assert.equal(r.motosConFactura, 3, 'facturas #1 (2 filas), #2 y #3 (por su lectura descartada)');
  assert.equal(r.motosSinFactura, 2, 'ZZ9?81Q/ZZ9?81? cuenta una vez y YYY777 otra'); assert.equal(r.motosDistintas, 5);
  assert.deepEqual(r.sinFactura.map(x => x.lectura).sort(), ['YYY777', 'ZZ9?81Q']);
  assert.deepEqual(r.facturasSinMoto.map(x => x.num).sort(), [4, 5, 6]);
  assert.deepEqual(r.repetidas, [{ placa: 'AAA111', facturas: [1, 4] }]);
  assert.deepEqual(r.diferencias.map(x => [x.num, x.dif]), [[5, 9000 - 5045]]);
  assert.equal(r.pendientes.length, 5, 'solo #1 está validada'); assert.equal(r.validadas, 1);
});
