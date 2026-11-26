'use strict';
// Nómina: el dueño sube su Excel y aquí se lee la pestaña de sueldos (los valores ya calculados que guarda Excel, con su formato).
// Sin dependencias: un .xlsx es un ZIP con unos XML. El archivo y los sueldos quedan solo en data/, nunca en el repositorio.
const zlib = require('zlib');
const MAX_XML = 4e6, MAX_FILAS = 300, MAX_COLS = 30;
class ErrorNomina extends Error {}
const malo = () => new ErrorNomina('No se pudo leer el archivo. Guárdalo en Excel como .xlsx e inténtalo de nuevo.');

function abrirZip(b) {
  let fin = -1; for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) if (b.readUInt32LE(i) === 0x06054b50) { fin = i; break; }
  if (fin < 0) throw malo();
  const indice = new Map(), n = b.readUInt16LE(fin + 10); let p = b.readUInt32LE(fin + 16);
  for (let i = 0; i < Math.min(n, 1000); i++) {
    if (b.readUInt32LE(p) !== 0x02014b50) throw malo();
    const metodo = b.readUInt16LE(p + 10), tam = b.readUInt32LE(p + 20), ln = b.readUInt16LE(p + 28), extra = b.readUInt16LE(p + 30), com = b.readUInt16LE(p + 32), pos = b.readUInt32LE(p + 42);
    indice.set(b.toString('utf8', p + 46, p + 46 + ln), { metodo, tam, pos }); p += 46 + ln + extra + com;
  }
  return nombre => {
    const e = indice.get(nombre); if (!e) return '';
    const ini = e.pos + 30 + b.readUInt16LE(e.pos + 26) + b.readUInt16LE(e.pos + 28), d = b.subarray(ini, ini + e.tam);
    if (e.metodo !== 0 && e.metodo !== 8) throw malo();
    const r = e.metodo === 8 ? zlib.inflateRawSync(d, { maxOutputLength: MAX_XML }) : d; // el tope evita un archivo que se infla sin fin
    if (r.length > MAX_XML) throw malo();
    return r.toString('utf8');
  };
}
const texto = s => String(s).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (t, e) => e[0] === '#' ? String.fromCodePoint(Math.min(0x10ffff, parseInt(e.slice(e[1] === 'x' ? 2 : 1), e[1] === 'x' ? 16 : 10))) : { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e.toLowerCase()]);
const atributo = (s, n) => { const m = new RegExp('(?:^|\\s)' + n + '="([^"]*)"').exec(s); return m ? texto(m[1]) : ''; };
const todos = (xml, etiqueta) => [...xml.matchAll(new RegExp('<' + etiqueta + '(?=[\\s/>])([^>]*?)(?:/>|>([\\s\\S]*?)</' + etiqueta + '>)', 'g'))].map(m => ({ a: m[1], c: m[2] || '' }));
const seccion = (xml, etiqueta) => (todos(xml, etiqueta)[0] || { c: '' }).c;
const textos = xml => todos(xml.replace(/<rPh[\s\S]*?<\/rPh>/g, ''), 't').map(t => texto(t.c)).join('');
const columna = ref => [...ref.replace(/\d+/g, '')].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
const filaDe = ref => parseInt(ref.replace(/\D+/g, ''), 10);

const n2 = (v, min) => v.toLocaleString('es-VE', { minimumFractionDigits: min, maximumFractionDigits: 2 });
function formatear(v, id, codigo) {
  if (id === 9 || id === 10 || /%/.test(codigo)) return n2(v * 100, 0) + ' %';
  const sinTexto = codigo.replace(/"[^"]*"|\[[^\]]*\]|\\./g, '');
  if ((id >= 14 && id <= 22) || /[dy]/i.test(sinTexto)) return new Date(Date.UTC(1899, 11, 30) + v * 864e5).toLocaleDateString('es-VE', { timeZone: 'UTC', day: '2-digit', month: '2-digit', year: 'numeric' });
  const unidad = /Bs/.test(codigo) ? 'Bs.' : /€/.test(codigo) ? '€' : /\$(?!-)/.test(codigo) ? '$' : '';
  return unidad ? n2(v, 2) + ' ' + unidad : n2(v, id === 4 || id === 2 ? 2 : 0);
}

function leer(archivo) {
  let abrir; try { abrir = abrirZip(archivo); } catch (e) { throw e instanceof ErrorNomina ? e : malo(); }
  try {
    const libro = abrir('xl/workbook.xml'), rels = {};
    todos(abrir('xl/_rels/workbook.xml.rels'), 'Relationship').forEach(r => { const t = atributo(r.a, 'Target'); rels[atributo(r.a, 'Id')] = t.startsWith('/') ? t.slice(1) : 'xl/' + t; });
    const hojas = todos(libro, 'sheet').map(h => ({ nombre: atributo(h.a, 'name'), ruta: rels[atributo(h.a, 'r:id')] }));
    if (!hojas.length) throw malo();
    const hoja = hojas.find(h => /n[oó]mina|sueldo/i.test(h.nombre));
    if (!hoja) throw new ErrorNomina('El archivo no tiene una pestaña de nómina o sueldos. Tiene: ' + hojas.map(h => h.nombre).join(', ') + '.');
    const compartidos = todos(abrir('xl/sharedStrings.xml'), 'si').map(s => textos(s.c));
    const estilos = abrir('xl/styles.xml'), codigos = {};
    todos(seccion(estilos, 'numFmts'), 'numFmt').forEach(f => { codigos[atributo(f.a, 'numFmtId')] = atributo(f.a, 'formatCode'); });
    const negritas = todos(seccion(estilos, 'fonts'), 'font').map(f => /<b(\s*\/>|\s+val="(1|true)"|>)/.test(f.c));
    const xfs = todos(seccion(estilos, 'cellXfs'), 'xf').map(x => ({ num: +atributo(x.a, 'numFmtId') || 0, b: !!negritas[+atributo(x.a, 'fontId') || 0] }));
    const xml = abrir(hoja.ruta); if (!xml) throw malo();
    const unidas = new Map(), tapadas = new Set();
    todos(xml, 'mergeCell').slice(0, 500).forEach(m => {
      const [a, z] = atributo(m.a, 'ref').split(':'); if (!z) return;
      const f1 = filaDe(a), f2 = Math.min(filaDe(z), f1 + MAX_FILAS), c1 = columna(a), c2 = Math.min(columna(z), MAX_COLS - 1);
      unidas.set(a, { cs: c2 - c1 + 1, rs: f2 - f1 + 1 });
      for (let f = f1; f <= f2; f++) for (let c = c1; c <= c2; c++) if (f !== f1 || c !== c1) tapadas.add(f + ':' + c);
    });
    const filas = new Map();
    todos(seccion(xml, 'sheetData'), 'c').forEach(x => {
      const ref = atributo(x.a, 'r'), f = filaDe(ref), c = columna(ref);
      if (!(f > 0 && f <= MAX_FILAS && c >= 0 && c < MAX_COLS) || tapadas.has(f + ':' + c)) return;
      const tipo = atributo(x.a, 't'), estilo = xfs[+atributo(x.a, 's') || 0] || { num: 0, b: false };
      const crudo = (todos(x.c, 'v')[0] || {}).c;
      let v = '', num = false, valor;
      if (tipo === 'inlineStr') v = textos(x.c);
      else if (crudo == null || crudo === '') return;
      else if (tipo === 's') v = compartidos[+crudo] || '';
      else if (tipo === 'str' || tipo === 'e') v = texto(crudo);
      else if (tipo === 'b') v = crudo === '1' ? 'Sí' : 'No';
      else if (Number.isFinite(+crudo)) { valor = +crudo; v = formatear(valor, estilo.num, codigos[estilo.num] || ''); num = true; }
      v = v.trim().slice(0, 600); if (!v) return;
      const u = unidas.get(ref) || { cs: 1, rs: 1 };
      if (!filas.has(f)) filas.set(f, []);
      filas.get(f).push(Object.assign({ c, v, num, b: estilo.b, cs: u.cs, rs: u.rs }, num ? { r: valor } : {}));
    });
    if (!filas.size) throw new ErrorNomina('La pestaña "' + hoja.nombre + '" está vacía.');
    return { hoja: hoja.nombre, filas: [...filas.keys()].sort((a, b) => a - b).map(n => ({ n, celdas: filas.get(n).sort((a, b) => a.c - b.c) })) };
  } catch (e) { throw e instanceof ErrorNomina ? e : malo(); }
}
module.exports = { leer, ErrorNomina };
