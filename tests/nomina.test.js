'use strict';
// Pruebas de la lectura de la nómina (server/nomina.js) con un Excel armado aquí (datos inventados).
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');
const { leer, ErrorNomina } = require('../server/nomina.js');

// ZIP comprimido, como el que guarda Excel.
function zip(archivos) {
  const partes = [], central = []; let pos = 0;
  Object.entries(archivos).forEach(([nombre, texto]) => {
    const n = Buffer.from(nombre), d = zlib.deflateRawSync(Buffer.from(texto));
    const l = Buffer.alloc(30); l.writeUInt32LE(0x04034b50, 0); l.writeUInt16LE(8, 8); l.writeUInt32LE(d.length, 18); l.writeUInt16LE(n.length, 26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(8, 10); c.writeUInt32LE(d.length, 20); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(pos, 42);
    partes.push(l, n, d); central.push(c, n); pos += 30 + n.length + d.length;
  });
  const dir = Buffer.concat(central), fin = Buffer.alloc(22);
  fin.writeUInt32LE(0x06054b50, 0); fin.writeUInt16LE(central.length / 2, 10); fin.writeUInt32LE(dir.length, 12); fin.writeUInt32LE(pos, 16);
  return Buffer.concat(partes.concat(dir, fin));
}
const libro = (hoja, datos) => zip({
  'xl/workbook.xml': '<workbook><sheets><sheet name="Precios" sheetId="1" r:id="rId1"/><sheet name="' + hoja + '" sheetId="2" r:id="rId2"/></sheets></workbook>',
  'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml"/></Relationships>',
  'xl/sharedStrings.xml': '<sst><si><t>TOTAL N&#211;MINA</t></si><si><r><t>Trabajador </t></r><r><t>&amp; cargo</t></r></si></sst>',
  'xl/styles.xml': '<styleSheet><numFmts count="2"><numFmt numFmtId="164" formatCode="#,##0.00 &quot;Bs.&quot;"/><numFmt numFmtId="165" formatCode="#,##0.00 &quot;€&quot;"/></numFmts><fonts><font><sz val="11"/></font><font><b/><sz val="11"/></font></fonts><cellXfs><xf numFmtId="0" fontId="0"/><xf numFmtId="164" fontId="1"/><xf numFmtId="165" fontId="0"/><xf numFmtId="9" fontId="0"/></cellXfs></styleSheet>',
  'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>precio</t></is></c></row></sheetData></worksheet>',
  'xl/worksheets/sheet2.xml': '<worksheet><sheetData>' + datos + '</sheetData><mergeCells><mergeCell ref="A1:C1"/></mergeCells></worksheet>',
});

test('nómina: lee la pestaña de sueldos con formatos, celdas unidas y valores calculados', () => {
  const r = leer(libro('Sueldos y Nómina', '<row r="1"><c r="A1" s="0" t="s"><v>0</v></c><c r="B1" s="0"/></row><row r="3"><c r="A3" t="s"><v>1</v></c><c r="B3" s="2"><v>123</v></c><c r="C3" s="1"><f>B3*10</f><v>1230.5</v></c><c r="D3" s="3"><v>0.02</v></c><c r="E3"/></row>'));
  assert.equal(r.hoja, 'Sueldos y Nómina');
  assert.deepEqual(r.filas.map(f => f.n), [1, 3]);
  assert.deepEqual([r.filas[0].celdas[0].v, r.filas[0].celdas[0].cs], ['TOTAL NÓMINA', 3]);
  assert.deepEqual(r.filas[1].celdas.map(c => c.v), ['Trabajador & cargo', '123,00 €', '1.230,50 Bs.', '2 %']);
  assert.equal(r.filas[1].celdas[2].b, true);
});

test('nómina: sin pestaña de sueldos o con un archivo que no es Excel, avisa claramente', () => {
  assert.throws(() => leer(libro('Inventario', '')), e => e instanceof ErrorNomina && /Precios, Inventario/.test(e.message));
  assert.throws(() => leer(Buffer.from('esto no es un excel, solo texto largo de prueba')), ErrorNomina);
  assert.throws(() => leer(Buffer.alloc(0)), ErrorNomina);
});

// ---------- sistema de nómina ----------
const fs = require('fs'), os = require('os'), path = require('path');
const { crear, SERVICIOS_PAGO } = require('../server/nomina-sistema.js');
const venta = (usuario, lavador, ids, total) => ({ usuario, lavador, total, dia: '2026-11-05', servicios: ids.map(id => ({ id })) });
const VENTAS = [venta('Ana', 'Keive', ['lp'], 100), venta('Ana', 'Keive', ['cg', 'kit'], 200), venta('Luis', 'Darwin', ['pg'], 100)];
function montar() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nomina-'));
  const ventas = VENTAS.slice(); let tasa = 1000;
  const n = crear({ DATA: dir, fechaCaracas: () => '2026-11-26', tasa: () => tasa, ventasDeMes: m => m === '2026-11' ? ventas : [] });
  const gente = n.guardarTrabajadores([{ nombre: 'Admin', tipo: 'fijo', base: 100 }, { nombre: 'Enc', tipo: 'encargado', base: 50 }, { nombre: 'Sec', tipo: 'secador', base: 999 }, { nombre: 'Lav', tipo: 'lavador', lavador: 'keive' }]).trabajadores;
  return { n, dir, ventas, gente, ids: Object.fromEntries(gente.map(t => [t.nombre, t.id])), tasa: v => { tasa = v; } };
}

test('nómina: calcula fijo, encargado (2 % de lo vendido), secador y lavador con 10 % de productos, préstamo y guardias', () => {
  const t = montar();
  const r = t.n.mes({ mes: '2026-11', accion: 'calcular', tasaUsd: '1200', entradas: { [t.ids.Sec]: { dias: '20' }, [t.ids.Lav]: { guardias: '2', prestamo: '1' }, [t.ids.Admin]: { ajuste: '-10' } } });
  const L = Object.fromEntries(r.lineas.map(l => [l.nombre, l]));
  assert.equal(L.Admin.netoEur, 90);
  assert.deepEqual([L.Enc.ventas, L.Enc.comision, L.Enc.netoEur], [400, 8, 58]);
  assert.deepEqual([L.Sec.base, L.Sec.netoEur], [140, 140]);
  // Keive: lavado (lp) + combo = 2 lavados y 1 pulitura → 3,50 €; productos 0,35; préstamo 1 → 2,15 € y 2 guardias = $10
  assert.deepEqual([L.Lav.lavados, L.Lav.pulituras, L.Lav.comision, L.Lav.productos, L.Lav.netoEur, L.Lav.guardiasUsd], [2, 1, 3.5, 0.35, 2.15, 10]);
  assert.equal(L.Lav.totalBs, 2.15 * 1000 + 10 * 1200);
  assert.equal(r.totales.netoEur, 290.15);
  assert.ok(r.avisos.some(a => /Darwin/.test(a) && /no está en la nómina/.test(a)), 'avisa de un lavador sin pagar');
  assert.ok(!fs.readFileSync(path.join(t.dir, 'nomina-datos.json'), 'utf8').includes('"entradas"'), 'calcular no guarda');
});

test('nómina: cifras corregidas a mano, préstamo mayor que lo disponible y comisión de un solo encargado', () => {
  const t = montar();
  t.n.guardarTrabajadores(t.gente.map(x => x.nombre === 'Enc' ? Object.assign({}, x, { usuario: 'Ana' }) : x));
  const r = t.n.mes({ mes: '2026-11', accion: 'calcular', entradas: { [t.ids.Lav]: { lavados: '10', pulituras: '', prestamo: '500' } } });
  const L = Object.fromEntries(r.lineas.map(l => [l.nombre, l]));
  assert.equal(L.Enc.comision, 6);
  assert.deepEqual([L.Lav.lavados, L.Lav.pulituras, L.Lav.netoEur, L.Lav.prestamo], [10, 1, 0, 10.35]);
  assert.ok(r.avisos.some(a => /Préstamo de Lav/.test(a)));
});

test('nómina: una nómina cerrada no cambia aunque cambien ventas, reglas o tasa, y solo se edita al reabrirla', () => {
  const t = montar();
  const c = t.n.mes({ mes: '2026-11', accion: 'cerrar', entradas: {} }, 'Dueño');
  assert.equal(c.estado, 'cerrada'); assert.equal(c.cerradas[0].por, 'Dueño');
  t.ventas.push(venta('Ana', 'Keive', ['lp'], 5000)); t.tasa(9999); t.n.guardarReglas({ encPct: 50, lavPago: 'abc' });
  assert.equal(t.n.reglas().lavPago, 1, 'un valor no numérico no cambia la regla');
  assert.deepEqual(t.n.mes({ mes: '2026-11' }).totales, c.totales);
  assert.throws(() => t.n.mes({ mes: '2026-11', accion: 'guardar' }), /cerrada/);
  const x = t.n.archivoExcel('2026-11'); assert.equal(x.nombre, 'nomina-2026-11.xlsx'); assert.equal(x.buffer.readUInt32LE(0), 0x04034b50);
  assert.equal(t.n.mes({ mes: '2026-11', accion: 'reabrir' }).totales.comision > c.totales.comision, true);
  assert.throws(() => t.n.mes({ mes: '2026-13' }), /Mes/);
});

test('nómina: importa trabajadores y reglas desde el Excel', () => {
  const t = montar(), s = (ref, v) => '<c r="' + ref + '" t="inlineStr"><is><t>' + v + '</t></is></c>', v = (ref, x) => '<c r="' + ref + '"><v>' + x + '</v></c>';
  const datos = '<row r="5">' + s('A5', 'Comisión Encargado por Servicio Vendido') + v('C5', 0.03) + '</row><row r="6">' + s('A6', 'Pago Lavador por Moto Lavada') + v('C6', 1.2) + '</row><row r="7">' + s('A7', 'Pago Lavador por Pulitura') + v('C7', 1.8) + '</row>'
    + '<row r="9">' + s('A9', 'Cargo / Rol') + s('B9', 'Trabajador') + s('C9', 'Esquema') + s('D9', 'Sueldo Base') + '</row>'
    + '<row r="10">' + s('A10', 'Encargado') + s('B10', 'Enc') + s('C10', 'Fijo + %') + v('D10', 70) + '</row><row r="11">' + s('A11', 'Lavador') + s('B11', 'Lav') + s('C11', '1 € Lavado | Guardia') + v('D11', 0) + '</row><row r="12">' + s('A12', 'TOTAL NÓMINA') + v('D12', 70) + '</row>';
  const r = t.n.importar(libro('Nómina', datos));
  assert.equal(r.importados, 2);
  assert.deepEqual(r.trabajadores.map(x => [x.nombre, x.tipo, x.base, x.lavador]), [['Enc', 'encargado', 70, ''], ['Lav', 'lavador', 0, 'keive']]);
  assert.equal(r.trabajadores[1].id, t.ids.Lav, 'quien se llama igual conserva su identidad y su enlace');
  assert.deepEqual([r.reglas.encPct, r.reglas.lavPago, r.reglas.pulPago, r.reglas.prodPct], [3, 1.2, 1.8, 10]);
});

test('nómina: un archivo de datos dañado no se reemplaza, y los servicios pagados coinciden con el catálogo de la pantalla', () => {
  const t = montar(), f = path.join(t.dir, 'nomina-datos.json');
  fs.writeFileSync(f, '{roto');
  assert.throws(() => t.n.guardarReglas({ encPct: 1 })); assert.equal(fs.readFileSync(f, 'utf8'), '{roto');
  const web = fs.readFileSync(path.join(__dirname, '../web/index.html'), 'utf8');
  const catalogo = Object.fromEntries([...web.matchAll(/\{id:"([a-z0-9]+)",cod:"[^"]*",name:"[^"]*"[^}]*?pay:"(lav|pul|combo)"\}/g)].map(m => [m[1], m[2]]));
  assert.deepEqual(SERVICIOS_PAGO, catalogo);
});
