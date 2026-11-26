'use strict';
// Archivo de Excel (.xlsx) sin dependencias: una hoja con el logo y el título arriba, una tabla con formato (encabezado, filtro, bandas,
// montos y fechas) y, si se pide, una fila de totales. Un .xlsx es un ZIP con unos XML dentro; aquí se arma sin compresión.
// Los textos van como texto (nunca como fórmula) y los números como número.
const TABLA = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
function crc32(b) { let c = -1; for (let i = 0; i < b.length; i++) c = TABLA[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function zip(archivos) {
  const partes = [], central = []; let pos = 0;
  archivos.forEach(([nombre, contenido]) => {
    const n = Buffer.from(nombre), d = Buffer.isBuffer(contenido) ? contenido : Buffer.from(contenido, 'utf8'), crc = crc32(d);
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
const CAB = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>', MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main', REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

// ---------- estilos (colores del logo). El orden de cellXfs define los números que se usan en las celdas ----------
const TIPOS = ['texto', 'dinero', 'entero', 'decimal', 'fecha', 'euro', 'bs'], FORMATO = { texto: 0, dinero: 164, entero: 3, decimal: 4, fecha: 165, euro: 166, bs: 167 };
const TITULO = 1, SUBTITULO = 2, DETALLE = 3, ENCABEZADO = 4;
const estiloDato = (tipo, banda) => 5 + TIPOS.indexOf(tipo) * 2 + (banda ? 1 : 0);
const estiloTotal = tipo => 5 + TIPOS.length * 2 + TIPOS.indexOf(tipo);
function estilos() {
  const fuente = (extra, tam, color) => '<font>' + extra + '<sz val="' + tam + '"/><color rgb="' + color + '"/><name val="Calibri"/><family val="2"/></font>';
  const relleno = color => '<fill><patternFill patternType="solid"><fgColor rgb="' + color + '"/><bgColor indexed="64"/></patternFill></fill>';
  const lado = (n, color) => '<' + n + ' style="thin"><color rgb="' + color + '"/></' + n + '>';
  const borde = color => '<border>' + lado('left', color) + lado('right', color) + lado('top', color) + lado('bottom', color) + '<diagonal/></border>';
  const xf = (num, font, fill, border, alinear) => '<xf numFmtId="' + num + '" fontId="' + font + '" fillId="' + fill + '" borderId="' + border + '" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"' + (alinear ? ' applyAlignment="1"><alignment ' + alinear + '/></xf>' : '/>');
  const celdas = [xf(0, 0, 0, 0), xf(0, 1, 0, 0, 'vertical="center"'), xf(0, 2, 0, 0, 'vertical="center"'), xf(0, 3, 0, 0, 'vertical="center"'), xf(0, 4, 2, 1, 'horizontal="center" vertical="center" wrapText="1"')];
  TIPOS.forEach(t => [0, 3].forEach(banda => celdas.push(xf(FORMATO[t], 0, banda, 1, t === 'texto' ? 'vertical="top" wrapText="1"' : t === 'fecha' ? 'horizontal="center" vertical="top"' : 'vertical="top"'))));
  TIPOS.forEach(t => celdas.push(xf(FORMATO[t], 5, 4, 1, 'vertical="center"')));
  return CAB + '<styleSheet xmlns="' + MAIN + '"><numFmts count="4"><numFmt numFmtId="164" formatCode="&quot;$&quot;#,##0.00"/><numFmt numFmtId="165" formatCode="dd/mm/yyyy"/><numFmt numFmtId="166" formatCode="#,##0.00 &quot;€&quot;"/><numFmt numFmtId="167" formatCode="&quot;Bs&quot; #,##0.00"/></numFmts>'
    + '<fonts count="6">' + fuente('', 11, 'FF11202B') + fuente('<b/>', 20, 'FF0B6E6A') + fuente('<b/>', 13, 'FF11202B') + fuente('', 10, 'FF5A6B78') + fuente('<b/>', 11, 'FFFFFFFF') + fuente('<b/>', 11, 'FF04302E') + '</fonts>'
    + '<fills count="5"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' + relleno('FF0B6E6A') + relleno('FFEAF8F7') + relleno('FFBFEDEA') + '</fills>'
    + '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>' + borde('FFC9DEDD') + '</borders>'
    + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="' + celdas.length + '">' + celdas.join('') + '</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
}

const esFecha = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v + 'T00:00:00Z'));
const serial = d => Math.round((Date.parse(d + 'T00:00:00Z') - Date.UTC(1899, 11, 30)) / 864e5);
const tamanoPng = b => ({ w: b.readUInt32BE(16), h: b.readUInt32BE(20) });

// opc: { hoja, titulo, subtitulo, detalle, totales: [índices de columnas a sumar], logo: Buffer PNG }
function crear(columnas, filas, opc) {
  opc = opc || {};
  // Cada columna es de dinero según su nombre ("$" o "USD", "€", "Bs"); si no, entera o decimal según sus valores.
  const tipos = columnas.map((n, c) => {
    const nums = filas.map(f => f[c]).filter(v => typeof v === 'number' && Number.isFinite(v));
    return /\$|usd/i.test(n) ? 'dinero' : /€/.test(n) ? 'euro' : /\bbs\b/i.test(n) ? 'bs' : nums.every(Number.isInteger) ? 'entero' : 'decimal';
  });
  const largo = (v, c) => v == null ? 0 : esFecha(v) ? 10 : typeof v === 'number' && ['dinero', 'euro', 'bs'].includes(tipos[c]) ? v.toFixed(2).length + 3 : String(v).length;
  const anchos = columnas.map((n, c) => Math.min(42, Math.max(9, Math.min(24, String(n).length + 4), ...filas.slice(0, 500).map(f => largo(f[c], c) + 3))));
  if (opc.logo && anchos.length && anchos.length <= 6) anchos[0] = Math.max(anchos[0], 18); // en tablas angostas la primera columna alcanza para el logo y el título queda al lado
  const celda = (ref, v, estilo) => '<c r="' + ref + '" s="' + estilo + '"' + (typeof v === 'number' && Number.isFinite(v) ? '><v>' + v + '</v></c>' : v == null || v === '' ? '/>' : ' t="inlineStr"><is><t xml:space="preserve">' + xml(String(v).slice(0, 32000)) + '</t></is></c>');
  const fila = (n, celdas, alto) => '<row r="' + n + '"' + (alto ? ' ht="' + alto + '" customHeight="1"' : '') + '>' + celdas + '</row>';

  // Encabezado de la página: logo a la izquierda y los textos a partir de la primera columna que queda libre del logo.
  const logo = opc.logo || null, altoLogo = 100, anchoLogo = logo ? Math.round(altoLogo * tamanoPng(logo).w / tamanoPng(logo).h) : 0;
  let colTexto = 0, ocupado = 0; while (logo && ocupado < anchoLogo + 14) { ocupado += (colTexto < anchos.length ? anchos[colTexto] : 9) * 7 + 5; colTexto++; }
  const textos = [[opc.titulo || 'Moto Lavado R1', TITULO, 30], [opc.subtitulo || '', SUBTITULO, 22], [opc.detalle || '', DETALLE, 18], [opc.pie || '', DETALLE, 18]];
  let datos = textos.map((t, i) => fila(i + 1, t[0] ? celda(letra(colTexto) + (i + 1), t[0], t[1]) : '', t[2])).join('') + fila(5, '', 8);

  const CABECERA = 6, ultima = letra(columnas.length - 1), finDatos = CABECERA + filas.length;
  datos += fila(CABECERA, columnas.map((n, c) => celda(letra(c) + CABECERA, String(n), ENCABEZADO)).join(''), 22);
  datos += filas.map((f, i) => {
    const n = CABECERA + 1 + i;
    return fila(n, columnas.map((_, c) => {
      const v = f[c], tipo = esFecha(v) ? 'fecha' : typeof v === 'number' ? tipos[c] : 'texto';
      return celda(letra(c) + n, tipo === 'fecha' ? serial(v) : v, estiloDato(tipo, i % 2 === 1));
    }).join(''));
  }).join('');
  const totales = (opc.totales || []).filter(c => c >= 0 && c < columnas.length);
  if (totales.length && filas.length) {
    const n = finDatos + 1;
    datos += fila(n, columnas.map((_, c) => {
      if (!totales.includes(c)) return celda(letra(c) + n, c === 0 ? 'TOTAL' : '', estiloTotal('texto'));
      const suma = Math.round(filas.reduce((a, f) => a + (Number(f[c]) || 0), 0) * 100) / 100;
      // SUBTOTAL suma solo lo que queda visible al filtrar.
      return '<c r="' + letra(c) + n + '" s="' + estiloTotal(tipos[c]) + '"><f>SUBTOTAL(109,' + letra(c) + (CABECERA + 1) + ':' + letra(c) + finDatos + ')</f><v>' + suma + '</v></c>';
    }).join(''), 20);
  }

  const nombre = String(opc.hoja || 'Datos').replace(/[\\/?*[\]:']/g, ' ').trim().slice(0, 31) || 'Datos';
  const tipo = 'application/vnd.openxmlformats-officedocument.';
  const relaciones = l => CAB + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + l.map((r, i) => '<Relationship Id="rId' + (i + 1) + '" Type="' + REL + '/' + r[0] + '" Target="' + r[1] + '"/>').join('') + '</Relationships>';
  const hoja = CAB + '<worksheet xmlns="' + MAIN + '" xmlns:r="' + REL + '"><sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>'
    + '<sheetViews><sheetView workbookViewId="0" showGridLines="0"><pane ySplit="' + CABECERA + '" topLeftCell="A' + (CABECERA + 1) + '" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/>'
    + '<cols>' + anchos.map((a, i) => '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + a + '" customWidth="1"/>').join('') + '</cols><sheetData>' + datos + '</sheetData>'
    + '<autoFilter ref="A' + CABECERA + ':' + ultima + finDatos + '"/>'
    + '<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.6" header="0.3" footer="0.3"/><pageSetup paperSize="1" orientation="' + (anchos.reduce((a, b) => a + b, 0) > 90 ? 'landscape' : 'portrait') + '" fitToWidth="1" fitToHeight="0"/>'
    + '<headerFooter><oddFooter>&amp;LMoto Lavado R1&amp;RPágina &amp;P de &amp;N</oddFooter></headerFooter>' + (logo ? '<drawing r:id="rId1"/>' : '') + '</worksheet>';
  const archivos = [
    ['[Content_Types].xml', CAB + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' + (logo ? '<Default Extension="png" ContentType="image/png"/><Override PartName="/xl/drawings/drawing1.xml" ContentType="' + tipo + 'drawing+xml"/>' : '') + '<Override PartName="/xl/workbook.xml" ContentType="' + tipo + 'spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="' + tipo + 'spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="' + tipo + 'spreadsheetml.styles+xml"/></Types>'],
    ['_rels/.rels', relaciones([['officeDocument', 'xl/workbook.xml']])],
    ['xl/workbook.xml', CAB + '<workbook xmlns="' + MAIN + '" xmlns:r="' + REL + '"><sheets><sheet name="' + xml(nombre) + '" sheetId="1" r:id="rId1"/></sheets><definedNames>'
      + '<definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">\'' + xml(nombre) + '\'!$A$' + CABECERA + ':$' + ultima + '$' + finDatos + '</definedName>'
      + '<definedName name="_xlnm.Print_Titles" localSheetId="0">\'' + xml(nombre) + '\'!$' + CABECERA + ':$' + CABECERA + '</definedName></definedNames></workbook>'], // el encabezado de la tabla se repite en cada página impresa
    ['xl/_rels/workbook.xml.rels', relaciones([['worksheet', 'worksheets/sheet1.xml'], ['styles', 'styles.xml']])],
    ['xl/styles.xml', estilos()],
    ['xl/worksheets/sheet1.xml', hoja],
  ];
  if (logo) {
    const emu = px => px * 9525;
    archivos.push(
      ['xl/worksheets/_rels/sheet1.xml.rels', relaciones([['drawing', '../drawings/drawing1.xml']])],
      ['xl/drawings/drawing1.xml', CAB + '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="' + REL + '"><xdr:oneCellAnchor><xdr:from><xdr:col>0</xdr:col><xdr:colOff>' + emu(4) + '</xdr:colOff><xdr:row>0</xdr:row><xdr:rowOff>' + emu(6) + '</xdr:rowOff></xdr:from><xdr:ext cx="' + emu(anchoLogo) + '" cy="' + emu(altoLogo) + '"/>'
        + '<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="2" name="Logo" descr="Moto Lavado R1"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill><xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="' + emu(anchoLogo) + '" cy="' + emu(altoLogo) + '"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic><xdr:clientData/></xdr:oneCellAnchor></xdr:wsDr>'],
      ['xl/drawings/_rels/drawing1.xml.rels', relaciones([['image', '../media/logo.png']])],
      ['xl/media/logo.png', logo]);
  }
  return zip(archivos);
}
module.exports = { crear };
