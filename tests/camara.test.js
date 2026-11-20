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
  const c = crear({
    DATA: dir, json: () => {}, fechaCaracas: () => HOY,
    ventasDeHoy: () => (typeof o.ventas === 'function' ? o.ventas() : o.ventas) || [],
    completarPlaca: o.completarPlaca, marcarValidada: o.marcarValidada,
    leerPlaca: async (j, m, opc) => { llamadas.leer.push(opc && opc.placaSolo ? 'zoom' : /haiku/.test(m || '') ? 'haiku' : 'full'); return (o.leer || (() => ({ moto: true, placa: '', parcial: '', motivo: 'ilegible' })))(j, m, opc || {}); },
    compararFotos: async (a, b) => { llamadas.comparar.push(String(b)); return (o.comparar || (() => ({ misma: true, confianza: 'alta', motivo: 'igual' })))(String(a), String(b)); },
  });
  const ev = async (n, { presente = true, revision = false } = {}) => {
    const req = Readable.from([Buffer.alloc(2000, 7)]);
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

// ---------- Revalidar y validación manual ----------
test('Revalidar: encuentra la fila por placa parecida (0/O, 1/I) y la enlaza a la factura', async () => {
  const v = { id: 'abcdef123456', num: 9, placa: 'AE0I83J', fecha: new Date().toISOString() };
  const t = montar({ historial: [{ id: 'mwo55555ee', puente: 1, parcial: 'AE0183?', estado: 'alerta', salida: new Date().toISOString() }], ventaFotos: [v], ventas: [v] });
  const r = await t.c.revalidar(v);
  assert.equal(r.tipo, 'coincide');
  const f = t.filas()[0]; assert.equal(f.estado, 'tarde'); assert.equal(f.num, 9);
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
