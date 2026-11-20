'use strict';
// Consumo de la API de Anthropic: cada llamada deja una línea con modelo, función y tokens (los que devuelve la propia API en `usage`);
// de ahí sale el costo estimado por día y por mes. Los precios son USD por millón de tokens y se pueden cambiar en data/api-precios.json.
const fs = require('fs'), path = require('path');

const PRECIOS_BASE = {
  'claude-haiku-5-5': { in: 0.10, out: 0.50 },
  'claude-sonnet-5-5': { in: 2.00, out: 10.00, cr: 0.10 },
  'claude-sonnet-5': { in: 2.00, out: 10.00 },
  'claude-opus-5-5': { in: 4.00, out: 20.00 },
  'claude-haiku-4-5': { in: 1.00, out: 5.00 },
};
const ETIQUETAS = { 'moto-haiku': '¿Hay moto? (revisión barata)', 'lectura-placa': 'Leer la placa', 'lectura-ampliada': 'Leer la placa ampliada', 'comparar-fotos': 'Comparar fotos' };

function crear(ctx) {
  const archivo = mes => path.join(ctx.DATA, 'api-consumo-' + mes + '.jsonl');
  const PRECIOS_ARCHIVO = path.join(ctx.DATA, 'api-precios.json');
  function precios() {
    let extra = {}; try { extra = JSON.parse(fs.readFileSync(PRECIOS_ARCHIVO, 'utf8')) || {}; } catch (e) {}
    return Object.assign({}, PRECIOS_BASE, extra);
  }
  // usage: el objeto `usage` de la respuesta de la API (null si la llamada no devolvió uso, p. ej. por un error).
  function registrar(d) {
    try {
      const u = d.usage || {}, hoy = ctx.fechaCaracas(new Date());
      const r = { t: new Date().toISOString(), dia: hoy, modelo: String(d.modelo || ''), funcion: String(d.funcion || ''), in: u.input_tokens || 0, out: u.output_tokens || 0, cr: u.cache_read_input_tokens || 0, cw: u.cache_creation_input_tokens || 0 };
      if (!d.usage) r.sinUso = true;
      fs.appendFile(archivo(hoy.slice(0, 7)), JSON.stringify(r) + '\n', { mode: 0o600 }, () => {});
    } catch (e) {}
  }
  function costo(r, P) {
    const p = P[r.modelo]; if (!p) return null;
    const cr = p.cr != null ? p.cr : p.in * 0.1, cw = p.cw != null ? p.cw : p.in * 1.25;
    return (r.in * p.in + r.out * p.out + r.cr * cr + r.cw * cw) / 1e6;
  }
  function agrupar(regs, P) {
    const A = { llamadas: 0, entrada: 0, salida: 0, costo: 0, sinPrecio: false, filas: [] }, M = {};
    regs.forEach(r => {
      const c = costo(r, P), k = r.funcion + '|' + r.modelo;
      const f = M[k] || (M[k] = { funcion: r.funcion, etiqueta: ETIQUETAS[r.funcion] || r.funcion, modelo: r.modelo, llamadas: 0, entrada: 0, salida: 0, costo: 0, sinPrecio: false });
      f.llamadas++; f.entrada += r.in + r.cr + r.cw; f.salida += r.out;
      if (c == null) f.sinPrecio = true; else f.costo += c;
      A.llamadas++; A.entrada += r.in + r.cr + r.cw; A.salida += r.out;
      if (c == null) A.sinPrecio = true; else A.costo += c;
    });
    A.filas = Object.keys(M).map(k => M[k]).sort((a, b) => b.costo - a.costo);
    return A;
  }
  function resumen(diaPedido) {
    const hoy = ctx.fechaCaracas(new Date());
    const dia = /^\d{4}-\d{2}-\d{2}$/.test(diaPedido || '') ? diaPedido : hoy, mes = dia.slice(0, 7), P = precios();
    let regs = []; try { regs = fs.readFileSync(archivo(mes), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean); } catch (e) {}
    const delDia = agrupar(regs.filter(r => r.dia === dia), P), delMes = agrupar(regs, P);
    let proyeccion = null;
    if (mes === hoy.slice(0, 7)) { // el mes en curso: costo del mes / días transcurridos * días del mes
      const y = +mes.slice(0, 4), m = +mes.slice(5, 7), diasMes = new Date(y, m, 0).getDate(), transcurridos = +hoy.slice(8, 10);
      proyeccion = transcurridos ? delMes.costo / transcurridos * diasMes : null;
    }
    const usados = {}; regs.forEach(r => { if (P[r.modelo]) usados[r.modelo] = P[r.modelo]; });
    return { dia, mes, delDia, delMes, proyeccion, precios: usados };
  }
  return { registrar, resumen };
}
module.exports = { crear, PRECIOS_BASE };
