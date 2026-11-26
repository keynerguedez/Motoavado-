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
