'use strict';
// Sistema de nómina de los dueños: trabajadores, reglas de pago, nómina de cada mes (borrador o cerrada) y su Excel.
// Los montos del sistema están en "tarifa euro" (€); las guardias se pagan en dólares ($). Todo queda en data/nomina-datos.json.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const excel = require('./nomina'), xlsx = require('./xlsx');

const REGLAS = { encPct: 2, lavPago: 1, pulPago: 1.5, prodPct: 10, guardia: 5, diaSecador: 7 };
const TIPOS = ['fijo', 'encargado', 'secador', 'lavador'];
// Qué paga al lavador cada servicio del catálogo (web/index.html, campo "pay"). Una prueba comprueba que coincidan.
const SERVICIOS_PAGO = { lp: 'lav', la: 'lav', rp: 'lav', ra: 'lav', pp: 'pul', pg: 'pul', px: 'pul', cp: 'combo', cg: 'combo', cx: 'combo' };
const MES = /^\d{4}-(0[1-9]|1[0-2])$/;
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const r2 = n => Math.round((n + Number.EPSILON) * 100) / 100;
const numero = (v, max) => { const n = Number(v); return Number.isFinite(n) && n >= 0 && n <= max ? n : 0; };
const opcional = (v, max) => v === '' || v == null ? null : numero(v, max);
const texto = (v, max) => String(v == null ? '' : v).replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
const igual = (a, b) => texto(a, 60).toLowerCase() === texto(b, 60).toLowerCase();
const nombreMes = m => MESES[+m.slice(5) - 1] + ' ' + m.slice(0, 4);
class ErrorNomina extends excel.ErrorNomina {}

function crear(ctx) {
  const archivo = path.join(ctx.DATA, 'nomina-datos.json');
  function leerDatos() {
    let t; try { t = fs.readFileSync(archivo, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return { reglas: Object.assign({}, REGLAS), trabajadores: [], periodos: {} }; throw e; }
    const d = JSON.parse(t); // si el archivo está dañado se avisa con error: nunca se reemplaza por uno vacío
    return { reglas: Object.assign({}, REGLAS, d.reglas), trabajadores: d.trabajadores || [], periodos: d.periodos || {} };
  }
  function guardarDatos(d) {
    try { fs.copyFileSync(archivo, archivo + '.anterior'); } catch (e) {}
    fs.writeFileSync(archivo + '.tmp', JSON.stringify(d), { mode: 0o600 }); fs.renameSync(archivo + '.tmp', archivo);
  }
  const reglasValidas = (base, nuevas) => {
    const r = Object.assign({}, base);
    Object.keys(REGLAS).forEach(k => { const v = nuevas && nuevas[k]; if (v !== '' && v != null && Number.isFinite(+v) && +v >= 0 && +v <= (/Pct/.test(k) ? 100 : 10000)) r[k] = +v; });
    return r;
  };
  function limpiarTrabajadores(lista) {
    if (!Array.isArray(lista) || lista.length > 60) throw new ErrorNomina('La lista de trabajadores no es válida.');
    const usados = new Set();
    return lista.map(t => {
      const nombre = texto(t && t.nombre, 60); if (!nombre) throw new ErrorNomina('Cada trabajador necesita un nombre.');
      let id = /^[a-z0-9]{8,20}$/.test(t.id || '') && !usados.has(t.id) ? t.id : crypto.randomBytes(6).toString('hex'); usados.add(id);
      const tipo = TIPOS.includes(t.tipo) ? t.tipo : 'fijo';
      return { id, nombre, cargo: texto(t.cargo, 60), tipo, base: tipo === 'secador' ? 0 : r2(numero(t.base, 100000)), lavador: tipo === 'lavador' ? texto(t.lavador, 40) : '', usuario: tipo === 'encargado' ? texto(t.usuario, 60) : '', activo: t.activo !== false };
    });
  }
  const limpiarEntradas = e => {
    const r = {};
    Object.keys(e && typeof e === 'object' ? e : {}).slice(0, 80).forEach(id => {
      const x = e[id] || {}, aj = Number(x.ajuste);
      r[id] = { dias: numero(x.dias, 31), guardias: numero(x.guardias, 62), lavados: opcional(x.lavados, 100000), pulituras: opcional(x.pulituras, 100000), prestamo: r2(numero(x.prestamo, 100000)), ajuste: Number.isFinite(aj) && Math.abs(aj) <= 100000 ? r2(aj) : 0, nota: texto(x.nota, 120) };
    });
    return r;
  };

  // Lo que dicen las facturas del mes: lavados y pulituras de cada lavador y lo vendido por cada quien (igual que la pantalla de Comisiones: cuenta toda factura del mes).
  function delSistema(ventas) {
    const lav = new Map(), usuarios = new Map(); let total = 0;
    ventas.forEach(v => {
      total += Number(v.total) || 0;
      usuarios.set(v.usuario || '', (usuarios.get(v.usuario || '') || 0) + (Number(v.total) || 0));
      const k = texto(v.lavador, 40); if (!k) return;
      const c = lav.get(k.toLowerCase()) || { nombre: k, lavados: 0, pulituras: 0 };
      (v.servicios || []).forEach(s => { const p = SERVICIOS_PAGO[s.id]; if (p === 'lav' || p === 'combo') c.lavados++; if (p === 'pul' || p === 'combo') c.pulituras++; });
      lav.set(k.toLowerCase(), c);
    });
    return { lav, usuarios, total: r2(total) };
  }

  function calcular(d, mes, per) {
    const R = d.reglas, s = delSistema(ctx.ventasDeMes(mes)), entradas = per.entradas || {}, avisos = [];
    const tasaEur = per.tasaEur > 0 ? per.tasaEur : numero(ctx.tasa(), 1e9), tasaUsd = per.tasaUsd > 0 ? per.tasaUsd : tasaEur;
    const lineas = d.trabajadores.filter(t => t.activo || entradas[t.id]).map(t => {
      const e = Object.assign({ dias: 0, guardias: 0, lavados: null, pulituras: null, prestamo: 0, ajuste: 0, nota: '' }, entradas[t.id]);
      const l = { id: t.id, nombre: t.nombre, cargo: t.cargo, tipo: t.tipo, base: t.base || 0, entradas: e, ventas: 0, autoLavados: 0, autoPulituras: 0, lavados: 0, pulituras: 0, dias: 0, guardias: 0, comision: 0, productos: 0 };
      if (t.tipo === 'encargado') {
        l.ventas = t.usuario ? r2([...s.usuarios].filter(([n]) => igual(n, t.usuario)).reduce((a, x) => a + x[1], 0)) : s.total;
        l.comision = r2(l.ventas * R.encPct / 100);
      } else if (t.tipo === 'secador') { l.dias = e.dias; l.base = r2(e.dias * R.diaSecador); }
      else if (t.tipo === 'lavador') {
        const c = (t.lavador && s.lav.get(t.lavador.toLowerCase())) || { lavados: 0, pulituras: 0 };
        if (!t.lavador) avisos.push('Elige en "Trabajadores" qué lavador del sistema es ' + t.nombre + '; si no, sus motos salen en cero.');
        l.autoLavados = c.lavados; l.autoPulituras = c.pulituras;
        l.lavados = e.lavados == null ? c.lavados : e.lavados; l.pulituras = e.pulituras == null ? c.pulituras : e.pulituras; l.guardias = e.guardias;
        l.comision = r2(l.lavados * R.lavPago + l.pulituras * R.pulPago);
        l.productos = r2(l.comision * R.prodPct / 100);
      }
      const disponible = Math.max(0, r2(l.base + l.comision - l.productos + e.ajuste));
      l.ajuste = e.ajuste; l.prestamo = r2(Math.min(e.prestamo, disponible));
      if (e.prestamo > disponible) avisos.push('Préstamo de ' + t.nombre + ': solo alcanza para descontar ' + disponible.toFixed(2) + ' €; quedan ' + r2(e.prestamo - disponible).toFixed(2) + ' € pendientes.');
      l.netoEur = r2(disponible - l.prestamo); l.guardiasUsd = r2(l.guardias * R.guardia);
      l.totalBs = r2(l.netoEur * tasaEur + l.guardiasUsd * tasaUsd);
      return l;
    });
    // Que nadie se quede sin pagar ni se pague dos veces.
    const enlazados = d.trabajadores.filter(t => t.activo && t.tipo === 'lavador' && t.lavador).map(t => t.lavador.toLowerCase());
    s.lav.forEach((c, k) => { if (!enlazados.includes(k) && c.lavados + c.pulituras > 0) avisos.push(c.nombre + ' tiene ' + c.lavados + ' lavados y ' + c.pulituras + ' pulituras este mes y no está en la nómina.'); });
    [...new Set(enlazados.filter((k, i) => enlazados.indexOf(k) !== i))].forEach(k => avisos.push('Hay dos trabajadores enlazados al mismo lavador (' + (s.lav.get(k) || { nombre: k }).nombre + '): se le estaría pagando dos veces.'));
    if (!tasaEur) avisos.push('No hay tasa del día: escribe la tasa en bolívares.');
    const suma = k => r2(lineas.reduce((a, l) => a + l[k], 0));
    return { mes, estado: 'borrador', tasaEur, tasaUsd, tasaFija: { eur: per.tasaEur > 0 ? per.tasaEur : null, usd: per.tasaUsd > 0 ? per.tasaUsd : null }, reglas: Object.assign({}, R), ventas: s.total, lineas, avisos,
      totales: { base: suma('base'), comision: suma('comision'), productos: suma('productos'), prestamo: suma('prestamo'), ajuste: suma('ajuste'), netoEur: suma('netoEur'), guardiasUsd: suma('guardiasUsd'), totalBs: suma('totalBs') } };
  }
  const cerradas = d => Object.keys(d.periodos).filter(m => d.periodos[m].cerrada).sort().reverse().map(m => { const c = d.periodos[m].cerrada; return { mes: m, totalBs: c.totales.totalBs, fecha: c.cierre.fecha, por: c.cierre.por }; });

  function datos() {
    const d = leerDatos(), hoy = ctx.fechaCaracas(new Date()), antes = new Date(Date.parse(hoy.slice(0, 7) + '-01T12:00:00Z') - 864e5).toISOString().slice(0, 7);
    const s = delSistema(ctx.ventasDeMes(antes).concat(ctx.ventasDeMes(hoy.slice(0, 7))));
    return { reglas: d.reglas, trabajadores: d.trabajadores, cerradas: cerradas(d), lavadores: [...s.lav.values()].map(x => x.nombre), usuarios: [...s.usuarios.keys()].filter(Boolean) };
  }
  function guardarReglas(nuevas) { const d = leerDatos(); d.reglas = reglasValidas(d.reglas, nuevas); guardarDatos(d); return { reglas: d.reglas }; }
  function guardarTrabajadores(lista) { const d = leerDatos(); d.trabajadores = limpiarTrabajadores(lista); guardarDatos(d); return datos(); }
  const reglas = () => leerDatos().reglas;

  // accion: ver (lo guardado), calcular (vista previa sin guardar), guardar, cerrar, reabrir.
  function mes(p, quien) {
    p = p || {};
    if (!MES.test(p.mes || '')) throw new ErrorNomina('Mes no válido.');
    const d = leerDatos(), guardado = d.periodos[p.mes] || {}, accion = p.accion || 'ver';
    const devolver = r => Object.assign({}, r, { cerradas: cerradas(d) });
    if (accion === 'reabrir') {
      if (!guardado.cerrada) throw new ErrorNomina('Ese mes no está cerrado.');
      delete guardado.cerrada; guardarDatos(d); return devolver(calcular(d, p.mes, guardado));
    }
    if (guardado.cerrada) { if (accion !== 'ver') throw new ErrorNomina('La nómina de ese mes está cerrada. Reábrela para cambiarla.'); return devolver(guardado.cerrada); }
    if (accion === 'ver') return devolver(calcular(d, p.mes, guardado));
    if (!['calcular', 'guardar', 'cerrar'].includes(accion)) throw new ErrorNomina('Acción no válida.');
    const per = { entradas: limpiarEntradas(p.entradas), tasaEur: opcional(p.tasaEur, 1e9), tasaUsd: opcional(p.tasaUsd, 1e9) }, r = calcular(d, p.mes, per);
    if (accion === 'calcular') return devolver(r);
    if (accion === 'cerrar') {
      if (!r.lineas.length) throw new ErrorNomina('No hay trabajadores en la nómina.');
      if (!(r.tasaEur > 0)) throw new ErrorNomina('Escribe la tasa en bolívares antes de cerrar.');
      // La nómina cerrada queda como foto fija: no cambia aunque cambien las ventas, las reglas o la tasa.
      per.cerrada = Object.assign({}, r, { estado: 'cerrada', cierre: { fecha: new Date().toISOString(), por: texto(quien, 60) } });
    }
    d.periodos[p.mes] = per; guardarDatos(d);
    return devolver(per.cerrada || r);
  }

  function archivoExcel(m) {
    const r = mes({ mes: m, accion: 'ver' });
    const cols = ['Trabajador', 'Cargo', 'Sueldo base €', 'Lavados', 'Pulituras', 'Días', 'Guardias', 'Comisión €', 'Productos €', 'Préstamo €', 'Ajuste €', 'Neto €', 'Guardias $', 'Total Bs', 'Nota'];
    const filas = r.lineas.map(l => [l.nombre, l.cargo, l.base, l.lavados, l.pulituras, l.dias, l.guardias, l.comision, l.productos, l.prestamo, l.ajuste, l.netoEur, l.guardiasUsd, l.totalBs, l.entradas.nota]);
    const n = v => v.toLocaleString('es-VE', { maximumFractionDigits: 2 });
    const buffer = xlsx.crear(cols, filas, { hoja: 'Nómina ' + m, subtitulo: 'Nómina de ' + nombreMes(m) + (r.estado === 'cerrada' ? '' : ' (borrador)'), detalle: 'Tasa €: Bs ' + n(r.tasaEur) + ' · Tasa $: Bs ' + n(r.tasaUsd),
      pie: r.estado === 'cerrada' ? 'Cerrada el ' + new Date(r.cierre.fecha).toLocaleDateString('es-VE', { timeZone: 'America/Caracas' }) + ' por ' + r.cierre.por : 'Borrador: todavía puede cambiar', totales: [2, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13], logo: ctx.logo });
    return { nombre: 'nomina-' + m + (r.estado === 'cerrada' ? '' : '-borrador') + '.xlsx', buffer };
  }

  // Toma del Excel los trabajadores y las reglas. Reemplaza la lista actual (conserva el enlace de quien tenga el mismo nombre); las nóminas ya cerradas no cambian.
  function importar(binario) {
    const h = excel.leer(binario), d = leerDatos();
    const cab = h.filas.find(f => f.celdas.some(c => /^trabajador/i.test(c.v)) && f.celdas.some(c => /cargo/i.test(c.v)));
    if (!cab) throw new ErrorNomina('No encontré en la pestaña la tabla con las columnas "Cargo" y "Trabajador".');
    const col = re => (cab.celdas.find(c => re.test(c.v)) || {}).c, cCargo = col(/cargo/i), cNombre = col(/^trabajador/i), cBase = col(/sueldo base/i), cEsquema = col(/esquema|modalidad/i);
    const lista = []; let fila = cab.n;
    for (const f of h.filas.filter(f => f.n > cab.n)) {
      if (f.n > fila + 1 || f.celdas.some(c => /^total/i.test(c.v))) break;
      fila = f.n;
      const celda = c => f.celdas.find(x => x.c === c) || {}, nombre = celda(cNombre).v, cargo = celda(cCargo).v || ''; if (!nombre) continue;
      const clave = cargo + ' ' + (celda(cEsquema).v || ''), tipo = /secador/i.test(cargo) ? 'secador' : /lavador/i.test(cargo) ? 'lavador' : /encargad/i.test(clave) ? 'encargado' : 'fijo';
      const antes = d.trabajadores.find(t => igual(t.nombre, nombre)) || {};
      lista.push({ id: antes.id, nombre, cargo, tipo, base: tipo === 'fijo' || tipo === 'encargado' ? celda(cBase).r : 0, lavador: antes.lavador, usuario: antes.usuario });
    }
    if (!lista.length) throw new ErrorNomina('La tabla de trabajadores está vacía.');
    const nuevas = {};
    [['encPct', /comisi[oó]n.*encargado/i], ['diaSecador', /sueldo diario.*secador/i], ['lavPago', /por moto lavada/i], ['pulPago', /por pulitura/i], ['guardia', /bono.*guardia/i]].forEach(([k, re]) => {
      for (const f of h.filas) {
        const etiqueta = f.celdas.find(c => re.test(c.v) && c.r === undefined); if (!etiqueta) continue;
        const valor = f.celdas.find(c => c.c > etiqueta.c && c.r !== undefined); if (!valor) continue;
        nuevas[k] = k === 'encPct' && valor.r < 1 ? r2(valor.r * 100) : valor.r; return;
      }
    });
    d.trabajadores = limpiarTrabajadores(lista); d.reglas = reglasValidas(d.reglas, nuevas); guardarDatos(d);
    return Object.assign(datos(), { importados: lista.length });
  }
  return { datos, reglas, guardarReglas, guardarTrabajadores, mes, archivoExcel, importar };
}
module.exports = { crear, ErrorNomina: excel.ErrorNomina, SERVICIOS_PAGO };
