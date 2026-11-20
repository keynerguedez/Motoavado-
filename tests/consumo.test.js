'use strict';
// Pruebas del registro de consumo de la API (server/consumo.js). Sin llamadas externas.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { crear } = require('../server/consumo.js');

const ESPERA = ms => new Promise(r => setTimeout(r, ms));
function montar(hoy = '2026-11-20') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'motolavado-co-'));
  return { dir, c: crear({ DATA: dir, fechaCaracas: () => hoy }) };
}

test('registrar guarda la llamada y el resumen calcula el costo con los precios por millón de tokens', async () => {
  const { c } = montar();
  c.registrar({ funcion: 'moto-haiku', modelo: 'claude-haiku-5-5', usage: { input_tokens: 1000000, output_tokens: 1000000 } });
  c.registrar({ funcion: 'lectura-placa', modelo: 'claude-sonnet-5-5', usage: { input_tokens: 500000, output_tokens: 100000 } });
  c.registrar({ funcion: 'lectura-placa', modelo: 'claude-sonnet-5-5', usage: null }); // llamada sin uso (error): cuenta como llamada, no suma tokens
  await ESPERA(80);
  const r = c.resumen();
  assert.equal(r.delDia.llamadas, 3);
  const haiku = r.delDia.filas.find(f => f.modelo === 'claude-haiku-5-5');
  assert.ok(Math.abs(haiku.costo - 0.60) < 1e-9, 'haiku: 1M entrada ($0,10) + 1M salida ($0,50)');
  const sonnet = r.delDia.filas.find(f => f.modelo === 'claude-sonnet-5-5');
  assert.equal(sonnet.llamadas, 2);
  assert.ok(Math.abs(sonnet.costo - 2.00) < 1e-9, 'sonnet: 0,5M entrada ($2/M) + 0,1M salida ($10/M)');
  assert.equal(sonnet.etiqueta, 'Leer la placa');
  assert.ok(Math.abs(r.delDia.costo - 2.60) < 1e-9);
});

test('el resumen separa el día elegido del mes completo y proyecta el mes en curso', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'motolavado-co-'));
  const lineas = [
    { t: 'x', dia: '2026-11-18', modelo: 'claude-haiku-5-5', funcion: 'moto-haiku', in: 1000000, out: 0, cr: 0, cw: 0 },
    { t: 'x', dia: '2026-11-20', modelo: 'claude-haiku-5-5', funcion: 'moto-haiku', in: 3000000, out: 0, cr: 0, cw: 0 },
  ];
  fs.writeFileSync(path.join(dir, 'api-consumo-2026-11.jsonl'), lineas.map(l => JSON.stringify(l)).join('\n') + '\n');
  const c = crear({ DATA: dir, fechaCaracas: () => '2026-11-20' });
  const r = c.resumen('2026-11-18');
  assert.equal(r.delDia.llamadas, 1); assert.ok(Math.abs(r.delDia.costo - 0.10) < 1e-9);
  assert.equal(r.delMes.llamadas, 2); assert.ok(Math.abs(r.delMes.costo - 0.40) < 1e-9);
  assert.ok(Math.abs(r.proyeccion - 0.40 / 20 * 30) < 1e-9, 'proyección = costo del mes / días transcurridos × días del mes');
  assert.equal(c.resumen('2026-10-05').delMes.llamadas, 0);
  assert.equal(c.resumen('../../etc').dia, '2026-11-20', 'una fecha no válida cae en hoy');
});

test('un modelo sin precio se marca "sin precio" y el archivo de precios del dueño manda sobre los de fábrica', async () => {
  const { c, dir } = montar();
  c.registrar({ funcion: 'moto-haiku', modelo: 'modelo-desconocido', usage: { input_tokens: 10, output_tokens: 10 } });
  await ESPERA(80);
  assert.equal(c.resumen().delDia.filas[0].sinPrecio, true);
  fs.writeFileSync(path.join(dir, 'api-precios.json'), JSON.stringify({ 'modelo-desconocido': { in: 1, out: 1 } }));
  const f = c.resumen().delDia.filas[0];
  assert.equal(f.sinPrecio, false); assert.ok(Math.abs(f.costo - 20 / 1e6) < 1e-12);
});

test('las dos llamadas a la API de camara.js siguen registrando su consumo', () => {
  const src = fs.readFileSync(path.join(__dirname, '../server/camara.js'), 'utf8');
  assert.match(src, /usoApi\(opc\.placaSolo \? 'lectura-ampliada' : \/haiku\/\.test\(modelo\) \? 'moto-haiku' : 'lectura-placa', modelo, t\)/);
  assert.match(src, /usoApi\('comparar-fotos'/);
  assert.equal((src.match(/hostname: 'api\.anthropic\.com'/g) || []).length, 2, 'si se añade otra llamada a la API hay que registrar su consumo');
});
