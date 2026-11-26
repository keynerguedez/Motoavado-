'use strict';
// Archivo de Excel (.xlsx) mínimo y sin dependencias: una hoja con encabezado en negrita. Un .xlsx es un ZIP con unos XML dentro;
// aquí se arma sin compresión. Los textos van como texto (nunca como fórmula) y los números como número.
const TABLA = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
function crc32(b) { let c = -1; for (let i = 0; i < b.length; i++) c = TABLA[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function zip(archivos) {
  const partes = [], central = []; let pos = 0;
  archivos.forEach(([nombre, texto]) => {
    const n = Buffer.from(nombre), d = Buffer.from(texto, 'utf8'), crc = crc32(d);
    const l = Buffer.alloc(30); l.writeUInt32LE(0x04034b50, 0); l.writeUInt16LE(20, 4); l.writeUInt16LE(0x0800, 6); l.writeUInt16LE(0x21, 12); l.writeUInt32LE(crc, 14); l.writeUInt32LE(d.length, 18); l.writeUInt32LE(d.length, 22); l.writeUInt16LE(n.length, 26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(0x21, 14); c.writeUInt32LE(crc, 16); c.writeUInt32LE(d.length, 20); c.writeUInt32LE(d.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(pos, 42);
    partes.push(l, n, d); central.push(c, n); pos += 30 + n.length + d.length;
  });
  const dir = Buffer.concat(central), fin = Buffer.alloc(22);
  fin.writeUInt32LE(0x06054b50, 0); fin.writeUInt16LE(archivos.length, 8); fin.writeUInt16LE(archivos.length, 10); fin.writeUInt32LE(dir.length, 12); fin.writeUInt32LE(pos, 16);
  return Buffer.concat(partes.concat(dir, fin));
}
const xml = s => String(s).replace(/[^\t\n\r\x20-퟿-�\u{10000}-\u{10FFFF}]/gu, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const letra = i => (i >= 26 ? letra(Math.floor(i / 26) - 1) : '') + String.fromCharCode(65 + (i % 26));
function crear(columnas, filas, hoja) {
  const celda = (v, f, c, estilo) => {
    const r = letra(c) + (f + 1), s = estilo ? ' s="' + estilo + '"' : '';
    if (typeof v === 'number' && Number.isFinite(v)) return '<c r="' + r + '"' + s + '><v>' + v + '</v></c>';
    if (v == null || v === '') return '';
    return '<c r="' + r + '"' + s + ' t="inlineStr"><is><t xml:space="preserve">' + xml(String(v).slice(0, 32000)) + '</t></is></c>';
  };
  const todas = [columnas].concat(filas);
  const anchos = columnas.map((_, c) => Math.min(60, Math.max(8, ...todas.slice(0, 500).map(f => String(f[c] == null ? '' : f[c]).length)) + 2));
  const datos = todas.map((f, i) => '<row r="' + (i + 1) + '">' + columnas.map((_, c) => celda(f[c], i, c, i ? 0 : 1)).join('') + '</row>').join('');
  const nombre = xml(String(hoja || 'Datos').replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Datos');
  const cab = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>', main = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main', rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const tipo = 'application/vnd.openxmlformats-officedocument.spreadsheetml.';
  return zip([
    ['[Content_Types].xml', cab + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="' + tipo + 'sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="' + tipo + 'worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="' + tipo + 'styles+xml"/></Types>'],
    ['_rels/.rels', cab + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="' + rel + '/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ['xl/workbook.xml', cab + '<workbook xmlns="' + main + '" xmlns:r="' + rel + '"><sheets><sheet name="' + nombre + '" sheetId="1" r:id="rId1"/></sheets></workbook>'],
    ['xl/_rels/workbook.xml.rels', cab + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="' + rel + '/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="' + rel + '/styles" Target="styles.xml"/></Relationships>'],
    ['xl/styles.xml', cab + '<styleSheet xmlns="' + main + '"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf xfId="0"/><xf fontId="1" applyFont="1" xfId="0"/></cellXfs></styleSheet>'],
    ['xl/worksheets/sheet1.xml', cab + '<worksheet xmlns="' + main + '"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>' + anchos.map((a, i) => '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + a + '" customWidth="1"/>').join('') + '</cols><sheetData>' + datos + '</sheetData></worksheet>'],
  ]);
}
module.exports = { crear };
