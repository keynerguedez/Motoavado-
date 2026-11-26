// Moto Lavado · servidor. Etapa 2a: entrada con correo y clave, usuarios y roles.
// Sin dependencias externas: solo módulos propios de Node.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const PORT = Number(process.env.PORT || 3000);
const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'web');
const DATA = process.env.MOTOLAVADO_DATA || path.join(ROOT, 'data');
const USUARIOS = path.join(DATA, 'usuarios.json');
const SECRETO = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const INICIO = new Date();
const DIAS_SESION = 14;
const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
const PUBLICAS = new Set(['/logo.png', '/icono.png', '/base.css', '/entrar', '/entrar.html', '/health', '/favicon.ico']);
const SOLO_DUENO = new Set(['/usuarios', '/usuarios.html', '/_instalacion.log']);
const SOLO_DUENO_ESTRICTO = new Set(['/_instalacion.log', '/whatsapp', '/whatsapp.html']);

fs.mkdirSync(DATA, { recursive: true });

function version() {
  try { return execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim(); } catch (e) { return 'desconocida'; }
}

// ---------- usuarios (archivo en data/, fuera del repositorio) ----------
function leerUsuarios() { try { return JSON.parse(fs.readFileSync(USUARIOS, 'utf8')); } catch (e) { return []; } }
function guardarUsuarios(lista) {
  const tmp = USUARIOS + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(lista, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, USUARIOS);
}
function cifrar(clave, sal) { return crypto.scryptSync(String(clave), sal, 64).toString('hex'); }
function claveCorrecta(u, clave) {
  const a = Buffer.from(cifrar(clave, u.sal), 'hex'), b = Buffer.from(u.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const PERMISOS = ['tablet', 'comisiones', 'gastos', 'clientes', 'admin', 'vigilante', 'autorizar', 'usuarios'];
const BASE_ENC = ['tablet', 'comisiones', 'gastos'];
// El dueño siempre tiene todo. Al encargado se le marca qué puede ver y hacer.
function permisos(u) { return u.rol === 'dueno' ? PERMISOS.slice() : (Array.isArray(u.permisos) ? u.permisos.filter(x => PERMISOS.includes(x)) : BASE_ENC.slice()); }
function puede(u, p) { return !!u && permisos(u).includes(p); }
function publico(u) { return { id: u.id, nombre: u.nombre, correo: u.correo, rol: u.rol, permisos: permisos(u), creado: u.creado }; }
function validar(d, lista, pedirClave) {
  const nombre = String(d.nombre || '').trim(), correo = String(d.correo || '').trim().toLowerCase(), clave = String(d.clave || '');
  if (nombre.length < 2 || nombre.length > 60) return { error: 'Escribe el nombre.' };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo) || correo.length > 120) return { error: 'El correo no es válido.' };
  if (lista.some(u => u.correo === correo)) return { error: 'Ya existe un usuario con ese correo.' };
  if (pedirClave && (clave.length < 8 || clave.length > 200)) return { error: 'La clave debe tener al menos 8 caracteres.' };
  return { nombre, correo, clave };
}
function nuevoUsuario(v, rol) {
  const sal = crypto.randomBytes(16).toString('hex');
  return { id: crypto.randomBytes(6).toString('hex'), nombre: v.nombre, correo: v.correo, rol, sal, hash: cifrar(v.clave, sal), creado: new Date().toISOString() };
}

// ---------- sesión: cookie firmada ----------
function firmar(txt) { return crypto.createHmac('sha256', SECRETO).update(txt).digest('base64url'); }
function cookieSesion(u) {
  const cuerpo = Buffer.from(JSON.stringify({ u: u.id, h: u.hash.slice(0, 12), x: Date.now() + DIAS_SESION * 864e5 })).toString('base64url');
  return 'ml_s=' + cuerpo + '.' + firmar(cuerpo) + '; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=' + DIAS_SESION * 86400;
}
function sesion(req) {
  const m = /(?:^|;\s*)ml_s=([^;]+)/.exec(req.headers.cookie || '');
  if (!m) return null;
  const [cuerpo, firma] = m[1].split('.');
  if (!cuerpo || !firma) return null;
  const a = Buffer.from(firma), b = Buffer.from(firmar(cuerpo));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let d; try { d = JSON.parse(Buffer.from(cuerpo, 'base64url').toString()); } catch (e) { return null; }
  if (!d || d.x < Date.now()) return null;
  const u = leerUsuarios().find(x => x.id === d.u);
  // Si le cambian la clave o lo borran, la sesión deja de servir.
  return u && u.hash.slice(0, 12) === d.h ? u : null;
}

// ---------- ventas y base de datos de clientes (archivos en data/) ----------
const CLIENTES = path.join(DATA, 'clientes.json');
function leerClientes() { try { return JSON.parse(fs.readFileSync(CLIENTES, 'utf8')); } catch (e) { return {}; } }
function guardarClientes(c) { const tmp = CLIENTES + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(c), { mode: 0o600 }); fs.renameSync(tmp, CLIENTES); }
function limpio(v, max) { return String(v == null ? '' : v).replace(/[\r\n\t]+/g, ' ').trim().slice(0, max); }
function dinero(v) { const n = Math.round(Number(v) * 100) / 100; return n >= 0 && n < 100000 ? n : null; }
function fechaCaracas(d) { return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Caracas' }).format(d); }
const METODOS_PAGO = ['Pago móvil', 'Binance', 'Efectivo $', 'Efectivo Bs', 'Zelle'];
// Pago dividido en dos métodos (por ejemplo mitad en efectivo y mitad en pago móvil): cada parte lleva su método, su referencia, la moneda en que se recibió y su equivalente en dólares; los dólares suman el total de la factura.
function limpiarPagos(pagos, total) {
  if (pagos == null) return null;
  if (!Array.isArray(pagos) || pagos.length !== 2) return { error: 'El pago dividido debe tener dos partes.' };
  const partes = pagos.map(x => ({ metodo: limpio(x && x.metodo, 20), ref: limpio(x && x.ref, 30), moneda: limpio(x && x.moneda, 6), monto: dinero(x && x.monto), usd: dinero(x && x.usd) }));
  if (partes.some(x => !METODOS_PAGO.includes(x.metodo) || !x.usd || x.usd <= 0 || x.monto == null)) return { error: 'Cada parte del pago necesita su método y su monto.' };
  if (partes[0].metodo === partes[1].metodo) return { error: 'Elige dos métodos distintos para dividir el pago.' };
  if (Math.abs(partes[0].usd + partes[1].usd - total) > 0.05) return { error: 'Las dos partes no suman el total de la factura.' };
  return partes;
}
const TIPOS_LAVADO = ['normal', 'garantia', 'autorizado'];
const ETIQUETA_TIPO = { garantia: 'Garantía', autorizado: 'Regalo' };
function registrarVenta(d, yo, extra) {
  extra = extra || {};
  const tel = String(d.telefono || '').replace(/\D/g, '');
  if (!/^0[24]\d{9}$/.test(tel)) return { error: 'Teléfono no válido.' };
  const sinPlaca = d.sinPlaca === true;
  const placa = sinPlaca ? '' : limpio(d.placa, 14).toUpperCase().replace(/[^A-Z0-9]/g, ''); if (!placa && !sinPlaca) return { error: 'Falta la placa (o marca que no tiene).' };
  const servicios = (Array.isArray(d.servicios) ? d.servicios : []).slice(0, 12).map(x => ({ id: limpio(x.id, 10), nombre: limpio(x.nombre, 60), precio: dinero(x.precio) })).filter(x => x.nombre && x.precio != null);
  const total = dinero(d.total);
  if (!servicios.length || total == null) return { error: 'Venta incompleta.' };
  // Tipo de lavado: garantía y autorizado solo los crea el servidor al aprobarse una autorización.
  const tipo = extra.tipo || 'normal';
  const pendiente = !extra.tipo && d.estado === 'pendiente';
  const pagos = pendiente || extra.tipo ? null : limpiarPagos(d.pagos, total); if (pagos && pagos.error) return pagos;
  const nota = limpio(d.nota, 200);
  if (pendiente && nota.length < 3) return { error: 'Escribe una nota que explique por qué el pago queda pendiente.' };
  // Factura que la tablet no pudo enviar (se cortó la conexión) y reintenta sola: trae un identificador (cid) para no duplicarla si la primera vez sí llegó, y la hora en que se hizo.
  const cid = limpio(d.cid, 40).replace(/[^A-Za-z0-9-]/g, ''), creada = Date.parse(d.creadaEn);
  const tardia = !extra.tipo && cid && creada && Date.now() - creada > 120e3 && Date.now() - creada < 36 * 3600e3;
  const ahora = tardia ? new Date(creada) : new Date(), dia = fechaCaracas(ahora), archivo = path.join(DATA, 'ventas-' + dia.slice(0, 7) + '.jsonl');
  if (cid) { try { const l = fs.readFileSync(archivo, 'utf8').split('\n').find(x => x.includes('"cid":"' + cid + '"')); if (l) { const o = JSON.parse(l); return { ok: true, id: o.id, num: o.num, repetida: true }; } } catch (e) {} }
  let delDia = 0; try { delDia = fs.readFileSync(archivo, 'utf8').split('\n').filter(l => l.includes('"dia":"' + dia + '"')).length; } catch (e) {}
  const v = { id: crypto.randomBytes(6).toString('hex'), num: delDia + 1, dia, fecha: ahora.toISOString(), usuario: yo.nombre, usuarioId: yo.id, telefono: tel, cliente: limpio(d.cliente, 60), placa, sinPlaca, modelo: limpio(d.modelo, 60),
    servicios, total, descuento: limpio(d.descuento, 10), lavador: limpio(d.lavador, 40), metodo: limpio(d.metodo, 20), ref: limpio(d.ref, 30), moneda: limpio(d.moneda, 6), monto: dinero(d.monto), esperado: dinero(d.esperado), tasa: Number(d.tasa) > 0 ? Number(d.tasa) : null,
    estado: pendiente ? 'pendiente' : 'pagada', tipo };
  if (nota) v.nota = nota;
  if (cid) v.cid = cid;
  if (tardia) v.tardia = true;
  if (pagos) Object.assign(v, { metodo: 'Mixto', pagos, ref: pagos.map(x => x.ref).filter(Boolean).join(' / '), moneda: '', monto: null, esperado: null });
  if (extra.autId) { v.autId = extra.autId; v.metodo = ETIQUETA_TIPO[tipo] || tipo; v.descuento = '100%'; v.monto = 0; }
  fs.appendFileSync(archivo, JSON.stringify(v) + '\n', { mode: 0o600 });
  const cs = leerClientes(), c = cs[tel] || { telefono: tel, nombre: '', motos: [], visitas: 0, gastado: 0, primera: v.fecha };
  if (v.cliente && v.cliente !== 'Sin nombre') c.nombre = v.cliente;
  if (placa) {
    const m = c.motos.find(x => String(x.placa).replace(/[^A-Z0-9]/g, '') === placa); if (m) m.placa = placa;
    if (m) { m.ultima = v.fecha; m.visitas = (m.visitas || 1) + 1; if (v.modelo) m.modelo = v.modelo; } else c.motos.push({ placa, modelo: v.modelo, ultima: v.fecha, visitas: 1 });
  }
  c.visitas++; c.gastado = Math.round((c.gastado + total) * 100) / 100; c.ultima = v.fecha; c.ultimoServicio = servicios.map(x => x.nombre).join(' + ');
  cs[tel] = c; guardarClientes(cs);
  return { ok: true, id: v.id, num: v.num };
}
// Cierra una factura que quedó con el pago pendiente.
function cobrarPendiente(d, yo) {
  const id = limpio(d.id, 20), hoy = fechaCaracas(new Date());
  for (const archivo of archivosVentas()) {
    const filas = leerLineas(archivo), v = filas.find(x => x.id === id);
    if (!v) continue;
    if (v.estado !== 'pendiente') return { error: 'Esa factura ya está cobrada.' };
    const pagos = limpiarPagos(d.pagos, v.total); if (pagos && pagos.error) return pagos;
    if (!pagos && !limpio(d.metodo, 20)) return { error: 'Falta el método de pago.' };
    Object.assign(v, { estado: 'pagada', metodo: limpio(d.metodo, 20), ref: limpio(d.ref, 30), moneda: limpio(d.moneda, 6), monto: dinero(d.monto), esperado: dinero(d.esperado), tasa: Number(d.tasa) > 0 ? Number(d.tasa) : null, cobradaPor: yo.nombre, cobradaFecha: new Date().toISOString(), cobradaDia: hoy });
    if (pagos) Object.assign(v, { metodo: 'Mixto', pagos, ref: pagos.map(x => x.ref).filter(Boolean).join(' / '), moneda: '', monto: null, esperado: null });
    escribirLineas(archivo, filas);
    return { ok: true, id: v.id, num: v.num };
  }
  return { error: 'No se encontró la factura.' };
}

// Marca una factura como validada con la cámara (cruce de fotos bueno o validación a ojo del dueño).
function marcarValidada(id, info) {
  for (const archivo of archivosVentas()) {
    const filas = leerLineas(archivo), v = filas.find(x => x.id === String(id));
    if (!v) continue;
    if (v.validada && v.validada.tipo === info.tipo) return true;
    v.validada = info; escribirLineas(archivo, filas); return true;
  }
  return false;
}
// Pone o corrige la placa de una factura (la corrige el dueño, o la completa la cámara en una factura "sin placa"). Actualiza también la ficha del cliente.
function corregirPlaca(id, placaNueva, quien, soloSiVacia) {
  const placa = String(placaNueva || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!/^[A-Z0-9]{5,8}$/.test(placa)) return { error: 'La placa debe tener de 5 a 8 letras y números.' };
  for (const archivo of archivosVentas()) {
    const filas = leerLineas(archivo), v = filas.find(x => x.id === String(id));
    if (!v) continue;
    if (soloSiVacia && v.placa) return { error: 'La factura ya tiene placa.' };
    const antes = v.placa || '';
    if (antes === placa) return { ok: true, placa };
    v.placaAnterior = antes; v.placa = placa; v.sinPlaca = false; v.placaPor = quien;
    escribirLineas(archivo, filas);
    const cs = leerClientes(), c = cs[v.telefono];
    if (c) {
      if (antes) { const i = c.motos.findIndex(m => String(m.placa).replace(/[^A-Z0-9]/g, '') === antes); if (i >= 0 && (c.motos[i].visitas || 1) <= 1) c.motos.splice(i, 1); }
      if (!c.motos.some(m => String(m.placa).replace(/[^A-Z0-9]/g, '') === placa)) c.motos.push({ placa, modelo: v.modelo, ultima: v.fecha, visitas: 1 });
      guardarClientes(cs);
    }
    return { ok: true, placa };
  }
  return { error: 'No se encontró la factura.' };
}

// ---------- autorizaciones (descuentos, garantías y lavados autorizados) ----------
const AUTS = path.join(DATA, 'autorizaciones.json');
function leerAuts() { try { return JSON.parse(fs.readFileSync(AUTS, 'utf8')); } catch (e) { return []; } }
function guardarAuts(l) { const tmp = AUTS + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(l), { mode: 0o600 }); fs.renameSync(tmp, AUTS); }
function pedirAut(d, yo) {
  const tipo = ['descuento', 'garantia', 'autorizado'].includes(d.tipo) ? d.tipo : null;
  if (!tipo) return { error: 'Tipo de autorización no válido.' };
  const motivo = limpio(d.motivo, 200); if (motivo.length < 3) return { error: 'Escribe el motivo.' };
  const tel = String(d.telefono || '').replace(/\D/g, ''); if (!/^0[24]\d{9}$/.test(tel)) return { error: 'Teléfono no válido.' };
  const sinPlaca = d.sinPlaca === true, placa = sinPlaca ? '' : limpio(d.placa, 14).toUpperCase().replace(/[^A-Z0-9]/g, ''); if (!placa && !sinPlaca) return { error: 'Falta la placa.' };
  const servicios = (Array.isArray(d.servicios) ? d.servicios : []).slice(0, 12).map(x => ({ id: limpio(x.id, 10), nombre: limpio(x.nombre, 60), precio: dinero(x.precio) })).filter(x => x.nombre && x.precio != null);
  if (!servicios.length) return { error: 'Faltan los servicios.' };
  const pct = tipo === 'descuento' ? Number(d.pct) : 100; if (!(pct > 0 && pct <= 100)) return { error: 'Porcentaje no válido.' };
  const a = { id: crypto.randomBytes(6).toString('hex'), tipo, estado: 'pendiente', creada: new Date().toISOString(), dia: fechaCaracas(new Date()), pidio: yo.nombre, pidioId: yo.id, placa, sinPlaca, modelo: limpio(d.modelo, 60), telefono: tel, cliente: limpio(d.cliente, 60), lavador: limpio(d.lavador, 40),
    servicios, lista: dinero(servicios.reduce((x, y) => x + y.precio, 0)), pct, motivo };
  const l = leerAuts(); l.push(a); guardarAuts(l);
  return { ok: true, id: a.id };
}
function decidirAut(d, yo) {
  const l = leerAuts(), a = l.find(x => x.id === limpio(d.id, 20));
  if (!a) return { error: 'No se encontró la solicitud.' };
  if (a.estado !== 'pendiente') return { error: 'Esa solicitud ya fue respondida.' };
  if (a.pidioId === yo.id && yo.rol !== 'dueno') return { error: 'No puedes autorizar tu propia solicitud.' };
  const aprobar = d.aprobar === true;
  if (aprobar && a.tipo !== 'descuento') {
    const r = registrarVenta({ telefono: a.telefono, cliente: a.cliente, placa: a.placa, sinPlaca: a.sinPlaca, modelo: a.modelo, servicios: a.servicios, total: 0, lavador: a.lavador }, { nombre: a.pidio, id: a.pidioId }, { tipo: a.tipo, autId: a.id });
    if (r.error) return r;
    a.ventaId = r.id; a.num = r.num;
  }
  Object.assign(a, { estado: aprobar ? 'aprobada' : 'negada', decidio: yo.nombre, decidioId: yo.id, decidida: new Date().toISOString(), nota: limpio(d.nota, 200) });
  guardarAuts(l);
  return { ok: true, estado: a.estado };
}
function listarAuts(yo, todas) {
  const desde = Date.now() - 4 * 864e5;
  return leerAuts().filter(a => (a.estado === 'pendiente' || Date.parse(a.creada) > desde) && (todas || a.pidioId === yo.id)).sort((a, b) => b.creada.localeCompare(a.creada));
}
// Cliente frecuente: ya vino más de 3 veces.
const FRECUENTE_DESDE = 3;
function esFrecuente(c) { return (c.visitas || 0) > FRECUENTE_DESDE; }
function buscarCliente(placa, tel) {
  const cs = leerClientes(); let c = null, m = null;
  if (placa) for (const x of Object.values(cs)) { const mm = x.motos.find(y => String(y.placa).replace(/[^A-Z0-9]/g, '') === placa); if (mm && (!m || String(mm.ultima) > String(m.ultima))) { c = x; m = mm; } }
  if (!c && tel) c = cs[tel] || null;
  if (!c) return { encontrado: false };
  if (!m) m = c.motos.slice().sort((a, b) => String(b.ultima).localeCompare(String(a.ultima)))[0] || {};
  // Con esta visita serían visitas+1: frecuente si ya pasó de 3.
  return { encontrado: true, nombre: c.nombre, telefono: c.telefono, placa: m.placa || '', modelo: m.modelo || '', visitas: c.visitas, visitasMoto: m.visitas || 0, frecuente: c.visitas >= FRECUENTE_DESDE, ultima: c.ultima, ultimoServicio: c.ultimoServicio || '' };
}
// ---------- día en pantalla: lo cobrado hoy, leído del servidor ----------
function archivosVentas() { try { return fs.readdirSync(DATA).filter(f => /^ventas-\d{4}-\d{2}\.jsonl$/.test(f)).map(f => path.join(DATA, f)); } catch (e) { return []; } }
function leerLineas(archivo) { try { return fs.readFileSync(archivo, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean); } catch (e) { return []; } }
function escribirLineas(archivo, filas) { const tmp = archivo + '.tmp'; fs.writeFileSync(tmp, filas.map(f => JSON.stringify(f)).join('\n') + (filas.length ? '\n' : ''), { mode: 0o600 }); fs.renameSync(tmp, archivo); }
const GASTOS_EJ = path.join(DATA, 'gastos-ejemplo.json');
function diaDeHoy(diaPedido) {
  const dia = /^\d{4}-\d{2}-\d{2}$/.test(diaPedido || '') ? diaPedido : fechaCaracas(new Date()); // sin fecha, o con una no válida: hoy
  const ventas = leerLineas(path.join(DATA, 'ventas-' + dia.slice(0, 7) + '.jsonl')).filter(v => v.dia === dia);
  let gastos = []; try { gastos = JSON.parse(fs.readFileSync(GASTOS_EJ, 'utf8')).filter(g => g.dia === dia); } catch (e) {}
  const cs = leerClientes(), previas = {};
  ventas.forEach(v => { const c = cs[v.telefono]; previas[v.telefono] = c ? Math.max(0, c.visitas - ventas.filter(x => x.telefono === v.telefono).length) : 0; });
  return { dia, ventas, gastos, previas, hayEjemplo: ventas.some(v => v.ejemplo) || gastos.length > 0 };
}
// Día de ejemplo: arma ventas inventadas (placas, teléfonos y nombres falsos, marcados como ejemplo) a partir de las cantidades reales del cuadre.
function cargarEjemplo(d, yo) {
  const cat = {}; (Array.isArray(d.catalogo) ? d.catalogo : []).slice(0, 60).forEach(x => { const pr = dinero(x.precio); if (x && x.id && pr != null) cat[limpio(x.id, 10)] = { nombre: limpio(x.nombre, 60), precio: pr, principal: !!x.principal }; });
  const cant = d.cantidades || {}, motos = [], extras = [];
  Object.keys(cat).forEach(id => { const n = Math.min(300, Math.max(0, parseInt(cant[id], 10) || 0)); for (let i = 0; i < n; i++) (cat[id].principal ? motos : extras).push(id); });
  if (!motos.length && extras.length) motos.push(extras.shift());
  if (!motos.length) return { error: 'El ejemplo no trae ningún servicio.' };
  if (motos.length > 300) return { error: 'Demasiadas motos.' };
  const lav = (Array.isArray(d.lavadores) ? d.lavadores : []).map(x => limpio(x, 40)).filter(Boolean).slice(0, 12);
  const tasa = Number(d.tasa) > 0 ? Number(d.tasa) : null, ahora = new Date(), dia = fechaCaracas(ahora), archivo = path.join(DATA, 'ventas-' + dia.slice(0, 7) + '.jsonl');
  const NOM = ['Carlos Pérez', 'Luis Rojas', 'María Gómez', 'José Medina', 'Pedro Salas', 'Ana Torres', 'Miguel Díaz', 'Rosa Blanco', 'Juan Castillo', 'Elena Rivas', 'Andrés Mora', 'Carmen León', 'Rafael Soto', 'Daniel Peña', 'Óscar Vera', 'Gabriel Lugo', 'Sofía Rangel', 'Héctor Bravo'];
  const MOD = ['Empire Horse negra', 'Bera SBR roja', 'Empire Owen azul', 'Bera BR200 blanca', 'Yamaha DT azul', 'Suzuki GN gris', 'Kawasaki KLR verde', 'Empire Arsen roja'], L = 'ABCDEFGHJKLMNPRSTVWXYZ';
  const mezcla = motos.map((id, i) => ({ id, k: (i * 7919) % 101 })).sort((a, b) => a.k - b.k).map(x => x.id);
  let efectivo = dinero(d.efectivo) || 0;
  const existentes = leerLineas(archivo), base = existentes.filter(v => v.dia === dia).length, nuevas = [], cs = leerClientes();
  // La hora se reparte entre las 8:10 a. m. y las 5:40 p. m. de Caracas (UTC-4).
  const ini = Date.parse(dia + 'T12:10:00Z'), paso = Math.floor((9.5 * 3600e3) / Math.max(1, mezcla.length));
  mezcla.forEach((id, i) => {
    const servicios = [{ id, nombre: cat[id].nombre, precio: cat[id].precio }];
    if (extras.length && (i % Math.max(1, Math.floor(mezcla.length / extras.length)) === 0 || mezcla.length - i <= extras.length)) { const e = extras.shift(); servicios.push({ id: e, nombre: cat[e].nombre, precio: cat[e].precio }); }
    const total = Math.round(servicios.reduce((a, x) => a + x.precio, 0) * 100) / 100;
    const enEfectivo = efectivo >= total; if (enEfectivo) efectivo = Math.round((efectivo - total) * 100) / 100;
    const tel = '0414555' + String(1000 + ((base + i) * 37) % 9000), placa = 'A' + L[(i * 7) % L.length] + (i % 10) + L[(i * 3 + 5) % L.length] + ((i * 3) % 10) + ((i * 7 + 2) % 10) + L[(i * 11 + 1) % L.length];
    const fecha = new Date(ini + i * paso).toISOString();
    const v = { id: crypto.randomBytes(6).toString('hex'), num: base + i + 1, dia, fecha, usuario: yo.nombre, usuarioId: yo.id, telefono: tel, cliente: NOM[i % NOM.length], placa, modelo: MOD[i % MOD.length], servicios, total, descuento: '', lavador: lav.length ? lav[i % lav.length] : '',
      metodo: enEfectivo ? 'Efectivo $' : 'Pago móvil', ref: enEfectivo ? '' : String(4100 + i * 37), moneda: enEfectivo ? '$' : 'Bs', monto: enEfectivo ? total : (tasa ? Math.round(total * tasa * 100) / 100 : total), tasa, ejemplo: true };
    nuevas.push(v);
    if (!cs[tel] || cs[tel].ejemplo) cs[tel] = { telefono: tel, nombre: v.cliente, motos: [{ placa, modelo: v.modelo, ultima: fecha, visitas: 1 }], visitas: 1, gastado: total, primera: fecha, ultima: fecha, ultimoServicio: servicios.map(x => x.nombre).join(' + '), ejemplo: true };
  });
  escribirLineas(archivo, existentes.concat(nuevas)); guardarClientes(cs);
  const gastos = (Array.isArray(d.gastos) ? d.gastos : []).slice(0, 20).map((g, i) => ({ id: i + 1, dia, desc: limpio(g.desc, 80), monto: dinero(g.monto) || 0, pago: g.pago === 'ef' ? 'Efectivo $' : 'Pago móvil', usuario: yo.nombre })).filter(g => g.desc && g.monto > 0);
  fs.writeFileSync(GASTOS_EJ, JSON.stringify(gastos), { mode: 0o600 });
  return { ok: true, motos: nuevas.length, gastos: gastos.length };
}
function borrarEjemplo() {
  let n = 0;
  archivosVentas().forEach(a => { const f = leerLineas(a), q = f.filter(v => !v.ejemplo); if (q.length !== f.length) { n += f.length - q.length; escribirLineas(a, q); } });
  const cs = leerClientes(); let c = 0; Object.keys(cs).forEach(t => { if (cs[t].ejemplo) { delete cs[t]; c++; } }); if (c) guardarClientes(cs);
  try { fs.unlinkSync(GASTOS_EJ); } catch (e) {}
  return { ok: true, ventas: n, clientes: c };
}
function csv(v) { v = String(v == null ? '' : v); if (/^[=+\-@]/.test(v)) v = "'" + v; return '"' + v.replace(/"/g, '""') + '"'; }

// ---------- tasa euro BCV: se busca sola cada hora y se guarda la última buena ----------
const TASA_ARCHIVO = path.join(DATA, 'tasa.json');
const TASA_URL = process.env.TASA_URL || 'https://ve.dolarapi.com/v1/euros/oficial';
let tasa = { valor: null, fecha: null, consultada: null, error: null };
try { tasa = Object.assign(tasa, JSON.parse(fs.readFileSync(TASA_ARCHIVO, 'utf8'))); } catch (e) {}
async function actualizarTasa() {
  try {
    const r = await fetch(TASA_URL, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error('respondió ' + r.status);
    const j = await r.json(), v = Number(j.promedio || j.venta || j.compra);
    if (!(v > 1 && v < 1e7)) throw new Error('valor no válido');
    // Un salto de más de 30% contra la última tasa buena se ignora: casi seguro es un error de la fuente.
    if (tasa.valor && Math.abs(v - tasa.valor) / tasa.valor > 0.3) throw new Error('salto sospechoso: ' + v);
    tasa = { valor: Math.round(v * 10000) / 10000, fecha: j.fechaActualizacion || null, consultada: new Date().toISOString(), error: null };
    fs.writeFileSync(TASA_ARCHIVO, JSON.stringify(tasa), { mode: 0o600 });
  } catch (e) { tasa.error = String(e.message || e).slice(0, 120); tasa.intento = new Date().toISOString(); }
}
actualizarTasa(); setInterval(actualizarTasa, 60 * 60 * 1000).unref();

// ---------- WhatsApp oficial (Meta Cloud API). La llave la pega el dueño en pantalla y queda en data/, nunca en el repositorio ----------
const WA_ARCHIVO = path.join(DATA, 'whatsapp.json');
const WA_BASE = process.env.WA_BASE || 'https://graph.facebook.com';
function waLeer() { try { return JSON.parse(fs.readFileSync(WA_ARCHIVO, 'utf8')); } catch (e) { return {}; } }
function waGuardar(c) { const tmp = WA_ARCHIVO + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(c), { mode: 0o600 }); fs.renameSync(tmp, WA_ARCHIVO); }
function waPublico(c) { return { configurado: !!(c.token && c.phoneId), phoneId: c.phoneId || '', version: c.version || 'v25.0', actualizado: c.actualizado || null }; }
// 04141234567 -> 584141234567
function waNumero(t) { let n = String(t || '').replace(/\D/g, ''); if (/^0[24]\d{9}$/.test(n)) n = '58' + n.slice(1); return /^\d{10,15}$/.test(n) ? n : null; }
async function waEnviar(para, cuerpo) {
  const c = waLeer();
  if (!c.token || !c.phoneId) return { ok: false, error: 'WhatsApp todavía no está conectado.' };
  try {
    const r = await fetch(WA_BASE + '/' + (c.version || 'v25.0') + '/' + c.phoneId + '/messages', {
      method: 'POST', headers: { authorization: 'Bearer ' + c.token, 'content-type': 'application/json' },
      body: JSON.stringify(Object.assign({ messaging_product: 'whatsapp', to: para }, cuerpo)), signal: AbortSignal.timeout(15000) });
    const j = await r.json().catch(() => ({}));
    if (r.ok) return { ok: true, id: j.messages && j.messages[0] && j.messages[0].id };
    return { ok: false, error: (j.error && (j.error.error_user_msg || j.error.message)) || 'Meta respondió ' + r.status };
  } catch (e) { return { ok: false, error: 'No se pudo llegar a Meta. Intenta de nuevo.' }; }
}

// Aviso a los dueños cuando se pide un regalo o una garantía: números en AVISO_DUENOS (separados por coma) del archivo vault/.env. La decisión se toma en la pestaña Autorizaciones.
function avisarDuenosAut(id) {
  try {
    const a = leerAuts().find(x => x.id === id); if (!a || a.tipo === 'descuento') return;
    const nums = String(process.env.AVISO_DUENOS || '').split(',').map(waNumero).filter(Boolean);
    if (!nums.length || !waqr || !waqr.conectado()) return;
    const que = a.tipo === 'garantia' ? 'una GARANTÍA (el lavado salió mal)' : 'un REGALO (lavado sin cobro)';
    const texto = '*Motolavado R1 · por autorizar*\n' + a.pidio + ' pide ' + que + '.\nMoto: ' + (a.placa || 'sin placa') + (a.modelo ? ' · ' + a.modelo : '') + '\nServicios: ' + a.servicios.map(x => x.nombre).join(' + ') + ' (valor $' + a.lista + ')\nMotivo: ' + a.motivo + '\n\nEntra a la pestaña *Autorizaciones* para aprobar o negar.';
    nums.forEach(n => waqr.enviarTexto(n, texto).catch(() => {}));
  } catch (e) {}
}

// Aviso de texto a los dueños (AVISO_DUENOS en vault/.env), por ejemplo cuando la cámara se queda sin señal.
function avisarDueno(texto) {
  try {
    const nums = String(process.env.AVISO_DUENOS || '').split(',').map(waNumero).filter(Boolean);
    if (!nums.length || !waqr || !waqr.conectado()) return;
    nums.forEach(n => waqr.enviarTexto(n, texto).catch(() => {}));
  } catch (e) {}
}

// ---------- WhatsApp por QR (provisional) y ticket ----------
// Un fallo de la librería de WhatsApp nunca debe tumbar la facturación.
process.on('unhandledRejection', (r) => console.error('rechazo sin atender:', r && r.message || r));
process.on('uncaughtException', (r) => console.error('error sin atender:', r && r.message || r));
let waqr = null;
try { waqr = require('./waqr')(DATA); } catch (e) { console.error('WhatsApp QR no disponible:', e.message); }
function txt(v, max) { return String(v == null ? '' : v).replace(/[\r\n\t]+/g, ' ').replace(/[*_~`]/g, '').trim().slice(0, max); }
function ticketTexto(d) {
  const serv = (Array.isArray(d.servicios) ? d.servicios : []).slice(0, 12).map(x => '• ' + txt(x.nombre, 60) + '  ' + txt(x.precio, 18));
  if (!serv.length) return null;
  const L = ['*Motolavado R1*', 'Ticket #' + txt(d.num, 8) + ' · ' + new Date().toLocaleString('es-VE', { timeZone: 'America/Caracas', dateStyle: 'short', timeStyle: 'short' }), ''];
  if (d.cliente && d.cliente !== 'Sin nombre') L.push('Hola ' + txt(d.cliente, 40) + ', este es el ticket de tu lavado.');
  L.push('Placa: *' + txt(d.placa, 12) + '*' + (d.modelo ? ' · ' + txt(d.modelo, 40) : ''), '', ...serv);
  if (d.descuento) L.push('Descuento: ' + txt(d.descuento, 10));
  L.push('', '*Total: ' + txt(d.total, 14) + '*', 'Pagado: ' + txt(d.pagado, 24) + ' por ' + txt(d.metodo, 20) + (d.ref ? ' (ref. ' + txt(d.ref, 20) + ')' : ''));
  if (d.tasa) L.push('Tasa euro BCV: Bs ' + txt(d.tasa, 14));
  L.push('', 'Gracias por tu visita.');
  return L.join('\n');
}

// ---------- freno a intentos de clave ----------
const intentos = new Map();
function ipDe(req) { return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim(); }
function bloqueado(ip) { const i = intentos.get(ip); return i && i.n >= 8 && Date.now() - i.t < 15 * 60e3; }
function fallo(ip) { const i = intentos.get(ip); if (!i || Date.now() - i.t > 15 * 60e3) intentos.set(ip, { n: 1, t: Date.now() }); else i.n++; }

function json(res, codigo, obj, extra) {
  res.writeHead(codigo, Object.assign({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, extra || {}));
  res.end(JSON.stringify(obj));
}
function cuerpoJson(req) {
  return new Promise((ok, mal) => {
    if (!/^application\/json/.test(req.headers['content-type'] || '')) return mal(new Error('tipo'));
    let t = '';
    req.on('data', c => { t += c; if (t.length > 60000) { mal(new Error('grande')); req.destroy(); } });
    req.on('end', () => { try { ok(JSON.parse(t || '{}')); } catch (e) { mal(e); } });
    req.on('error', mal);
  });
}
function mismoOrigen(req) {
  const o = req.headers.origin;
  if (!o) return true;
  try { return new URL(o).host === req.headers.host; } catch (e) { return false; }
}

async function api(req, res, ruta) {
  const yo = sesion(req);
  if (req.method === 'GET') {
    if (ruta === '/api/estado') return json(res, 200, { hayUsuarios: leerUsuarios().length > 0, yo: yo ? publico(yo) : null });
    if (ruta === '/api/yo') return yo ? json(res, 200, publico(yo)) : json(res, 401, { error: 'Sin sesión.' });
    if (ruta === '/api/tasa') return yo ? json(res, 200, tasa) : json(res, 401, { error: 'Sin sesión.' });
    if (ruta === '/api/dia') {
      if (!puede(yo, 'tablet')) return json(res, 403, { error: 'No tienes permiso.' });
      const pedido = new URL(req.url, 'http://localhost').searchParams.get('dia') || '';
      if (pedido && pedido !== fechaCaracas(new Date()) && !puede(yo, 'admin')) return json(res, 403, { error: 'Solo Administración puede ver otros días.' });
      const dia = diaDeHoy(pedido), val = camara.ventasValidadas();
      dia.ventas = dia.ventas.map(v => Object.assign({}, v, { validada: !!(v.validada || val.has(v.id)), conFoto: camara.tieneFotoVenta(v.id) })); // validada: la factura ya cruzó su foto con la cámara
      return json(res, 200, dia);
    }
    if (ruta === '/api/semana') { // motos facturadas por día en los 7 días que terminan en el día elegido (para el gráfico de Administración)
      if (!puede(yo, 'tablet')) return json(res, 403, { error: 'No tienes permiso.' });
      const hoy = fechaCaracas(new Date()), pedido = new URL(req.url, 'http://localhost').searchParams.get('dia') || '';
      const fin = /^\d{4}-\d{2}-\d{2}$/.test(pedido) ? pedido : hoy;
      if (fin !== hoy && !puede(yo, 'admin')) return json(res, 403, { error: 'Solo Administración puede ver otros días.' });
      const meses = {}, nombres = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'], dias = [];
      for (let i = 6; i >= 0; i--) {
        const f = new Date(Date.parse(fin + 'T12:00:00Z') - i * 864e5), d = f.toISOString().slice(0, 10), m = d.slice(0, 7);
        meses[m] = meses[m] || leerLineas(path.join(DATA, 'ventas-' + m + '.jsonl'));
        dias.push({ dia: d, etiqueta: nombres[f.getUTCDay()], n: meses[m].filter(v => v.dia === d && !v.ejemplo).length });
      }
      return json(res, 200, { dias, fin });
    }
    if (ruta === '/api/cliente') {
      if (!puede(yo, 'tablet')) return json(res, 403, { error: 'No tienes permiso.' });
      const q = new URL(req.url, 'http://localhost').searchParams;
      const placa = limpio(q.get('placa'), 12).toUpperCase().replace(/[^A-Z0-9]/g, ''), tel = String(q.get('telefono') || '').replace(/\D/g, '');
      if (placa.length < 5 && tel.length !== 11) return json(res, 200, { encontrado: false });
      return json(res, 200, buscarCliente(placa.length >= 5 ? placa : '', tel.length === 11 ? tel : ''));
    }
    if (ruta === '/api/clientes' || ruta === '/api/clientes.csv') {
      if (!puede(yo, 'clientes')) return json(res, 403, { error: 'No tienes permiso.' });
      const lista = Object.values(leerClientes()).sort((a, b) => String(b.ultima).localeCompare(String(a.ultima)));
      if (ruta === '/api/clientes') return json(res, 200, lista.map(c => Object.assign({}, c, { frecuente: esFrecuente(c) })));
      const filas = [['Nombre', 'Teléfono', 'Motos', 'Visitas', 'Frecuente', 'Gastado', 'Primera visita', 'Última visita', 'Último servicio']].concat(lista.map(c => [c.nombre, c.telefono, c.motos.map(m => m.placa + (m.modelo ? ' ' + m.modelo : '')).join(' / '), c.visitas, esFrecuente(c) ? 'Sí' : 'No', c.gastado, fechaCaracas(new Date(c.primera)), fechaCaracas(new Date(c.ultima)), c.ultimoServicio]));
      res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="clientes-motolavado.csv"', 'cache-control': 'no-store' });
      return res.end('\ufeff' + filas.map(f => f.map(csv).join(',')).join('\r\n'));
    }
    if (ruta === '/api/waqr') return yo && yo.rol === 'dueno' ? json(res, 200, waqr ? waqr.publico() : { estado: 'error', error: 'No disponible en este servidor.' }) : json(res, 403, { error: 'Solo el dueño.' });
    if (ruta === '/api/whatsapp') return yo && yo.rol === 'dueno' ? json(res, 200, waPublico(waLeer())) : json(res, 403, { error: 'Solo el dueño.' });
    if (ruta === '/api/autorizaciones') { if (!yo) return json(res, 401, { error: 'Sin sesión.' }); return json(res, 200, listarAuts(yo, puede(yo, 'autorizar') && !/[?&]mias=1/.test(req.url))); }
    if (ruta === '/api/usuarios') return puede(yo, 'usuarios') ? json(res, 200, leerUsuarios().map(publico)) : json(res, 403, { error: 'No tienes permiso.' });
    if (ruta === '/api/camara') return puede(yo, 'vigilante') ? json(res, 200, camara.publico()) : json(res, 403, { error: 'No tienes permiso.' });
    if (ruta === '/api/camara/vista') {
      if (!puede(yo, 'vigilante')) return json(res, 403, { error: 'No tienes permiso.' });
      const f = camara.fotoVista(); if (!f) return json(res, 404, { error: 'Sin imagen.' });
      res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'no-store' }); return res.end(f);
    }
    const fv = /^\/api\/ventas\/foto\/([a-f0-9]{6,20})\.jpg$/.exec(ruta); // la foto que el encargado tomó de la moto (para compartirla)
    if (fv) {
      if (!puede(yo, 'tablet')) return json(res, 403, { error: 'No tienes permiso.' });
      const f = camara.fotoVentaId(fv[1]); if (!f) return json(res, 404, { error: 'Sin foto.' });
      res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=600' }); return res.end(f);
    }
    if (ruta === '/api/cierre') {
      // Quien factura hace el cierre de hoy. Otros días y el consumo de la API son solo de Administración.
      const admin = puede(yo, 'admin');
      if (!admin && !puede(yo, 'tablet')) return json(res, 403, { error: 'No tienes permiso.' });
      const pedido = new URL(req.url, 'http://localhost').searchParams.get('dia') || '';
      if (pedido && pedido !== fechaCaracas(new Date()) && !admin) return json(res, 403, { error: 'Solo Administración puede ver otros días.' });
      const dia = diaDeHoy(pedido), r = { camara: camara.cierre(dia.ventas, dia.dia) };
      if (admin) { const co = consumo.resumen(dia.dia); r.consumo = { dia: co.delDia.costo, llamadas: co.delDia.llamadas, mes: co.delMes.costo, proyeccion: co.proyeccion }; }
      return json(res, 200, r);
    }
    if (ruta === '/api/consumo') {
      if (!puede(yo, 'admin')) return json(res, 403, { error: 'No tienes permiso.' });
      return json(res, 200, consumo.resumen(new URL(req.url, 'http://localhost').searchParams.get('dia') || ''));
    }
    if (ruta === '/api/camara/pendientes') return puede(yo, 'tablet') || puede(yo, 'vigilante') ? json(res, 200, camara.pendientes()) : json(res, 403, { error: 'No tienes permiso.' });
    if (ruta === '/api/camara/cruces') return puede(yo, 'vigilante') ? json(res, 200, camara.cruces((/[?&]dia=([\d-]+)/.exec(req.url) || [])[1])) : json(res, 403, { error: 'No tienes permiso.' });
    const cm = /^\/api\/camara\/(cruce|cruce-venta)\/([a-z0-9.-]+)$/.exec(ruta);
    if (cm) {
      if (!puede(yo, 'vigilante')) return json(res, 403, { error: 'No tienes permiso.' });
      const f = cm[1] === 'cruce' ? camara.fotoCruce(cm[2]) : camara.fotoVentaId(cm[2].replace(/\.jpg$/, ''));
      if (!f) return json(res, 404, { error: 'Sin foto.' });
      res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=3600' }); return res.end(f);
    }
    if (ruta === '/api/camara/historial') {
      if (!puede(yo, 'vigilante')) return json(res, 403, { error: 'No tienes permiso.' });
      return json(res, 200, camara.historial((/[?&]dia=([\d-]+)/.exec(req.url) || [])[1]));
    }
    const hp = /^\/api\/camara\/histp\/([a-z0-9]+)\.jpg$/.exec(ruta); // el recorte ampliado de la placa con el que se leyó
    if (hp) {
      if (!puede(yo, 'vigilante')) return json(res, 403, { error: 'No tienes permiso.' });
      const f = camara.fotoHistPlaca(hp[1]); if (!f) return json(res, 404, { error: 'Sin foto.' });
      res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=3600' }); return res.end(f);
    }
    const hm = /^\/api\/camara\/hist\/([a-z0-9]+)\.jpg$/.exec(ruta);
    if (hm) {
      if (!puede(yo, 'vigilante')) return json(res, 403, { error: 'No tienes permiso.' });
      const f = camara.fotoHist(hm[1]); if (!f) return json(res, 404, { error: 'Sin foto.' });
      res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=3600' }); return res.end(f);
    }
    const fm = /^\/api\/camara\/foto\/(\d)$/.exec(ruta);
    if (fm) {
      if (!puede(yo, 'vigilante')) return json(res, 403, { error: 'No tienes permiso.' });
      const f = camara.foto(fm[1]); if (!f) return json(res, 404, { error: 'Sin foto.' });
      res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'no-store' }); return res.end(f);
    }
    return json(res, 404, { error: 'No encontrado.' });
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'Método no permitido.' });
  if (!mismoOrigen(req)) return json(res, 403, { error: 'Origen no permitido.' });
  // La foto de la moto que toma el encargado llega como imagen cruda (el JSON no admite fotos): se cruza con la moto del puente.
  if (ruta === '/api/ventas/foto') {
    if (!yo) return json(res, 401, { error: 'Sin sesión.' });
    if (!puede(yo, 'tablet')) return json(res, 403, { error: 'No tienes permiso.' });
    let jpeg; try { jpeg = await camara.leerFoto(req); } catch (e) { return json(res, 400, { error: 'Falta la foto (image/jpeg, máx. 3 MB).' }); }
    const id = new URL(req.url, 'http://localhost').searchParams.get('id') || '', v = diaDeHoy().ventas.find(x => x.id === id);
    if (!v || jpeg.length < 1000) return json(res, 404, { error: 'No se encontró la factura de hoy.' });
    return json(res, 200, Object.assign({ ok: true }, await camara.cruzar(v, jpeg)));
  }
  let d; try { d = await cuerpoJson(req); } catch (e) { return json(res, 400, { error: 'Datos no válidos.' }); }
  const lista = leerUsuarios(), ip = ipDe(req);

  if (ruta === '/api/salir') return json(res, 200, { ok: true }, { 'set-cookie': 'ml_s=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0' });

  if (ruta === '/api/crear-dueno') {
    if (lista.length) return json(res, 403, { error: 'El dueño ya fue creado.' });
    const v = validar(d, lista, true); if (v.error) return json(res, 400, v);
    const u = nuevoUsuario(v, 'dueno'); guardarUsuarios([u]);
    return json(res, 200, publico(u), { 'set-cookie': cookieSesion(u) });
  }
  if (ruta === '/api/entrar') {
    if (bloqueado(ip)) return json(res, 429, { error: 'Demasiados intentos. Espera 15 minutos.' });
    const correo = String(d.correo || '').trim().toLowerCase();
    const u = lista.find(x => x.correo === correo);
    if (!u || !claveCorrecta(u, d.clave || '')) { fallo(ip); return json(res, 401, { error: 'Correo o clave incorrectos.' }); }
    intentos.delete(ip);
    return json(res, 200, publico(u), { 'set-cookie': cookieSesion(u) });
  }

  if (!yo) return json(res, 401, { error: 'Sin sesión.' });
  if (ruta === '/api/mi-clave') {
    if (!claveCorrecta(yo, d.actual || '')) return json(res, 400, { error: 'La clave actual no coincide.' });
    if (String(d.clave || '').length < 8) return json(res, 400, { error: 'La clave debe tener al menos 8 caracteres.' });
    const u = lista.find(x => x.id === yo.id); u.sal = crypto.randomBytes(16).toString('hex'); u.hash = cifrar(d.clave, u.sal); guardarUsuarios(lista);
    return json(res, 200, { ok: true }, { 'set-cookie': cookieSesion(u) });
  }
  if (ruta === '/api/ejemplo' || ruta === '/api/ejemplo/borrar') {
    if (yo.rol !== 'dueno') return json(res, 403, { error: 'Solo el dueño.' });
    const r = ruta === '/api/ejemplo' ? cargarEjemplo(d, yo) : borrarEjemplo();
    return json(res, r.error ? 400 : 200, r);
  }
  if (ruta === '/api/ventas') {
    if (!puede(yo, 'tablet')) return json(res, 403, { error: 'No tienes permiso.' });
    const r = registrarVenta(d, yo);
    if (r.ok && d.filaCam) { // el encargado marcó cuál es la moto que la cámara ve: se enlaza al facturar (si falla, la factura igual queda guardada)
      try { const e = camara.enlazarAlFacturar(String(d.filaCam).slice(0, 30), { id: r.id, num: r.num, placa: d.sinPlaca === true ? '' : d.placa }, yo.nombre); if (e.ok) r.enlazada = true; } catch (x) {}
    }
    return json(res, r.error ? 400 : 200, r);
  }
  if (ruta === '/api/ventas/placa') {
    if (yo.rol !== 'dueno') return json(res, 403, { error: 'Solo el dueño puede corregir la placa.' });
    const r = corregirPlaca(d.id, d.placa, yo.nombre, false);
    return json(res, r.error ? 400 : 200, r);
  }
  if (ruta === '/api/ventas/cobrar') {
    if (!puede(yo, 'tablet')) return json(res, 403, { error: 'No tienes permiso.' });
    const r = cobrarPendiente(d, yo);
    return json(res, r.error ? 400 : 200, r);
  }
  if (ruta === '/api/autorizaciones') {
    if (!puede(yo, 'tablet')) return json(res, 403, { error: 'No tienes permiso.' });
    const r = pedirAut(d, yo);
    if (r.ok) avisarDuenosAut(r.id); // garantías y regalos: el aviso por WhatsApp no frena ni rompe la solicitud
    return json(res, r.error ? 400 : 200, r);
  }
  if (ruta === '/api/autorizaciones/decidir') {
    if (!puede(yo, 'autorizar')) return json(res, 403, { error: 'No tienes permiso para autorizar.' });
    const r = decidirAut(d, yo);
    return json(res, r.error ? 400 : 200, r);
  }
  if (ruta === '/api/camara/puente/liberar') {
    if (!puede(yo, 'vigilante')) return json(res, 403, { error: 'No tienes permiso.' });
    return camara.liberarPuente(d.n, yo.nombre) ? json(res, 200, { ok: true }) : json(res, 400, { error: 'Puente no válido.' });
  }
  if (ruta === '/api/camara/cruces/revalidar') {
    if (!puede(yo, 'vigilante')) return json(res, 403, { error: 'No tienes permiso.' });
    const v = diaDeHoy().ventas.find(x => x.id === String(d.id || ''));
    if (!v) return json(res, 404, { error: 'No se encontró la factura de hoy.' });
    const r = await camara.revalidar(v);
    return json(res, r.error ? 400 : 200, r);
  }
  if (ruta === '/api/camara/cruces/manual') {
    if (yo.rol !== 'dueno') return json(res, 403, { error: 'Solo el dueño puede validar a ojo.' });
    const v = diaDeHoy().ventas.find(x => x.id === String(d.id || ''));
    if (!v) return json(res, 404, { error: 'No se encontró la factura de hoy.' });
    const r = camara.validarManual(v, d.nota, yo.nombre);
    return json(res, r.error ? 400 : 200, r);
  }
  if (ruta === '/api/camara/cruces/validar') {
    if (!puede(yo, 'vigilante')) return json(res, 403, { error: 'No tienes permiso.' });
    return camara.validarCruce(d.id, d.ok) ? json(res, 200, { ok: true }) : json(res, 404, { error: 'No se encontró el cruce.' });
  }
  if (ruta === '/api/camara/historial/enlazar') {
    if (yo.rol !== 'dueno') return json(res, 403, { error: 'Solo el dueño puede enlazar una moto con una factura.' });
    const v = diaDeHoy().ventas.find(x => x.id === String(d.venta || ''));
    if (!v) return json(res, 404, { error: 'No se encontró la factura de hoy.' });
    const r = camara.enlazarFila(d.fila, v, yo.nombre);
    return json(res, r.error ? 400 : 200, r);
  }
  if (ruta === '/api/camara/historial/reasignar') {
    if (yo.rol !== 'dueno') return json(res, 403, { error: 'Solo el dueño puede corregir un enlace.' });
    const r = camara.reasignarEnlace(d.fila, d.num == null || d.num === '' ? null : d.num, dia => diaDeHoy(dia).ventas, yo.nombre);
    return json(res, r.error ? 400 : 200, r);
  }
  if (ruta === '/api/camara/historial/real') {
    if (!puede(yo, 'vigilante')) return json(res, 403, { error: 'No tienes permiso.' });
    const r = camara.marcarReal(d.id, d.real, dia => diaDeHoy(dia).ventas, yo.nombre);
    return r ? json(res, 200, r) : json(res, 404, { error: 'No se encontró la lectura.' });
  }
  if (ruta === '/api/ticket') {
    if (!puede(yo, 'tablet')) return json(res, 403, { error: 'No tienes permiso.' });
    const para = waNumero(d.telefono); if (!para) return json(res, 400, { error: 'Teléfono no válido.' });
    const texto = ticketTexto(d); if (!texto) return json(res, 400, { error: 'Ticket vacío.' });
    if (!waqr || !waqr.conectado()) return json(res, 503, { ok: false, error: 'WhatsApp no está conectado.' });
    // Nota de entrega como imagen con el logo; si por algo no se puede dibujar, sale el texto.
    let png = null;
    try {
      png = require('./nota').notaPng({ num: d.num, fecha: new Date().toLocaleString('es-VE', { timeZone: 'America/Caracas', dateStyle: 'short', timeStyle: 'short' }), cliente: d.cliente && d.cliente !== 'Sin nombre' ? d.cliente : '', modelo: d.modelo, placa: d.placa,
        servicios: (Array.isArray(d.servicios) ? d.servicios : []).map(x => ({ nombre: x && x.nombre, precio: x && x.precio })), pagado: d.pagado, metodo: txt(d.metodo, 20) + (d.ref ? ' · ref. ' + txt(d.ref, 20) : '') }, 'claro');
    } catch (e) { console.error('nota:', e.message); }
    const hola = d.cliente && d.cliente !== 'Sin nombre' ? 'Hola ' + txt(d.cliente, 40).split(' ')[0] : 'Hola';
    const r = png ? await waqr.enviarImagen(para, png, hola + ', aquí tienes una imagen de referencia de tu servicio.') : await waqr.enviarTexto(para, texto);
    return json(res, r.ok ? 200 : 502, r);
  }
  if (ruta.startsWith('/api/waqr/')) {
    if (yo.rol !== 'dueno') return json(res, 403, { error: 'Solo el dueño.' });
    if (!waqr) return json(res, 503, { error: 'No disponible en este servidor.' });
    if (ruta === '/api/waqr/conectar') return json(res, 200, await waqr.iniciar());
    if (ruta === '/api/waqr/desvincular') return json(res, 200, await waqr.desvincular());
    if (ruta === '/api/waqr/prueba') {
      const para = waNumero(d.telefono); if (!para) return json(res, 400, { error: 'Teléfono no válido. Ejemplo: 04141234567.' });
      const r = await waqr.enviarTexto(para, '*Motolavado R1*\nMensaje de prueba del sistema. Si lo ves, los tickets ya pueden salir por WhatsApp.');
      return json(res, r.ok ? 200 : 502, r);
    }
    return json(res, 404, { error: 'No encontrado.' });
  }
  if (ruta === '/api/whatsapp' || ruta === '/api/whatsapp/prueba') {
    if (yo.rol !== 'dueno') return json(res, 403, { error: 'Solo el dueño.' });
    if (ruta === '/api/whatsapp') {
      const c = waLeer(), token = String(d.token || '').trim(), phoneId = String(d.phoneId || '').trim(), ver = String(d.version || '').trim();
      if (!/^\d{6,25}$/.test(phoneId)) return json(res, 400, { error: 'El identificador del número son solo dígitos (lo da Meta).' });
      if (token) { if (token.length < 50 || /\s/.test(token)) return json(res, 400, { error: 'La llave no parece completa. Cópiala entera.' }); c.token = token; }
      if (!c.token) return json(res, 400, { error: 'Falta pegar la llave (token).' });
      if (ver) { if (!/^v\d{2}\.\d$/.test(ver)) return json(res, 400, { error: 'Versión no válida.' }); c.version = ver; }
      c.phoneId = phoneId; c.actualizado = new Date().toISOString(); waGuardar(c);
      return json(res, 200, waPublico(c));
    }
    const para = waNumero(d.telefono); if (!para) return json(res, 400, { error: 'Teléfono no válido. Ejemplo: 04141234567.' });
    const r = await waEnviar(para, { type: 'template', template: { name: 'hello_world', language: { code: 'en_US' } } });
    return json(res, r.ok ? 200 : 502, r);
  }
  if (!puede(yo, 'usuarios')) return json(res, 403, { error: 'No tienes permiso.' });
  const soyDueno = yo.rol === 'dueno';
  // Solo un dueño puede tocar a otro dueño o nombrar dueños.
  const objetivo = lista.find(x => x.id === d.id);
  if (!soyDueno && ((objetivo && objetivo.rol === 'dueno') || d.rol === 'dueno')) return json(res, 403, { error: 'Solo un dueño puede hacer eso.' });
  if (ruta === '/api/usuarios/editar') {
    const u = objetivo; if (!u) return json(res, 404, { error: 'No existe.' });
    const rol = d.rol === 'dueno' ? 'dueno' : 'enc';
    if (u.rol === 'dueno' && rol !== 'dueno') {
      if (u.id === yo.id) return json(res, 400, { error: 'No puedes quitarte a ti mismo el acceso de dueño.' });
      if (lista.filter(x => x.rol === 'dueno').length < 2) return json(res, 400, { error: 'Tiene que quedar al menos un dueño.' });
    }
    const nombre = String(d.nombre || u.nombre).trim();
    if (nombre.length < 2 || nombre.length > 60) return json(res, 400, { error: 'Escribe el nombre.' });
    u.nombre = nombre; u.rol = rol;
    if (rol === 'enc') {
      let p = Array.isArray(d.permisos) ? d.permisos.filter(x => PERMISOS.includes(x)) : permisos(u);
      if (!soyDueno) p = p.filter(x => puede(yo, x)); // nadie da permisos que no tiene
      u.permisos = p;
    } else delete u.permisos;
    guardarUsuarios(lista);
    return json(res, 200, publico(u));
  }
  if (ruta === '/api/usuarios') {
    const rol = d.rol === 'dueno' ? 'dueno' : 'enc';
    const v = validar(d, lista, true); if (v.error) return json(res, 400, v);
    const u = nuevoUsuario(v, rol); if (rol === 'enc') u.permisos = BASE_ENC.slice(); lista.push(u); guardarUsuarios(lista);
    return json(res, 200, publico(u));
  }
  if (ruta === '/api/usuarios/clave') {
    const u = lista.find(x => x.id === d.id); if (!u) return json(res, 404, { error: 'No existe.' });
    if (String(d.clave || '').length < 8) return json(res, 400, { error: 'La clave debe tener al menos 8 caracteres.' });
    u.sal = crypto.randomBytes(16).toString('hex'); u.hash = cifrar(d.clave, u.sal); guardarUsuarios(lista);
    return json(res, 200, { ok: true }, u.id === yo.id ? { 'set-cookie': cookieSesion(u) } : {});
  }
  if (ruta === '/api/usuarios/borrar') {
    if (d.id === yo.id) return json(res, 400, { error: 'No puedes borrarte a ti mismo.' });
    if (!lista.some(x => x.id === d.id)) return json(res, 404, { error: 'No existe.' });
    guardarUsuarios(lista.filter(x => x.id !== d.id));
    return json(res, 200, { ok: true });
  }
  return json(res, 404, { error: 'No encontrado.' });
}

const consumo = require('./consumo').crear({ DATA, fechaCaracas });
const camara = require('./camara').crear({ DATA, json, fechaCaracas, registrarUso: consumo.registrar, ventasDeHoy: () => diaDeHoy().ventas, avisarDueno: texto => avisarDueno(texto), completarPlaca: (id, placa) => !corregirPlaca(id, placa, 'cámara', true).error, marcarValidada });
// FTP para las fotos 4K de la cámara. Solo arranca si hay clave en vault/.env (CAMARA_FTP_CLAVE); no lleva nada más: la carpeta es propia y solo acepta subir .jpg.
// CAMARA_FTP_USUARIO (por defecto "camara"), CAMARA_FTP_PUERTO (2121), CAMARA_FTP_PASIVO ("30000-30009"), CAMARA_FTP_IP (IP pública del servidor; si falta se usa la de la conexión).
// Solo para pruebas locales: con CAMARA_PRUEBA=1 y sin clave acepta usuario anónimo.
if (process.env.CAMARA_FTP_CLAVE || (process.env.CAMARA_PRUEBA === '1' && process.env.CAMARA_FTP_PUERTO)) {
  const pas = /^(\d{4,5})-(\d{4,5})$/.exec(process.env.CAMARA_FTP_PASIVO || '30000-30009');
  require('./ftp').crear({
    dir: camara.FOTOS4K, usuario: process.env.CAMARA_FTP_USUARIO || 'camara', clave: process.env.CAMARA_FTP_CLAVE || '', anonimo: !process.env.CAMARA_FTP_CLAVE,
    puerto: Number(process.env.CAMARA_FTP_PUERTO || 2121), rango: pas ? [Number(pas[1]), Number(pas[2])] : [30000, 30009], ipPublica: process.env.CAMARA_FTP_IP || '',
    alRecibir: camara.fotoRecibida, log: m => console.log(m),
  });
}

const servidor = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let ruta; try { ruta = decodeURIComponent(url.pathname); } catch (e) { res.writeHead(400); return res.end(); }
  // El agente de la cámara no usa sesión ni cookies: entra con su propia clave (CAMARA_TOKEN).
  if (ruta === '/api/camara/evento' && req.method === 'POST') return camara.evento(req, res).catch(() => json(res, 500, { error: 'Error del servidor.' }));
  if (ruta === '/api/camara/vista' && req.method === 'POST') return camara.vista(req, res).catch(() => json(res, 500, { error: 'Error del servidor.' }));
  // La cámara directa (sin agente): su "servidor de alarma" avisa aquí, con la clave en la URL (?t=CAMARA_TOKEN). Las fotos 4K llegan por FTP.
  if (ruta === '/api/camara/alarma' && req.method === 'POST') return camara.alarma(req, res).catch(() => json(res, 500, { error: 'Error del servidor.' }));
  if (ruta === '/health') return json(res, 200, { ok: true, sistema: 'motolavado', version: version(), tasa: tasa.valor, tasaConsultada: tasa.consultada, tasaError: tasa.error, waqr: waqr ? waqr.publico().estado : 'no-disponible', libs: fs.existsSync(path.join(ROOT, 'node_modules', 'baileys')), nota: (() => { try { require.resolve('@resvg/resvg-js'); return true; } catch (e) { return false; } })(), encendido: INICIO.toISOString(), hora: new Date().toISOString() });
  if (ruta.startsWith('/api/')) return api(req, res, ruta).catch(() => json(res, 500, { error: 'Error del servidor.' }));

  const yo = sesion(req);
  if (!PUBLICAS.has(ruta) && !yo) { res.writeHead(302, { location: '/entrar' + (ruta === '/' && url.search ? '?n=' + encodeURIComponent('/' + url.search) : ''), 'cache-control': 'no-store' }); return res.end(); }
  if ((SOLO_DUENO.has(ruta) && !puede(yo, 'usuarios')) || (SOLO_DUENO_ESTRICTO.has(ruta) && !(yo && yo.rol === 'dueno'))) { res.writeHead(302, { location: '/', 'cache-control': 'no-store' }); return res.end(); }
  if (ruta === '/_instalacion.log') {
    return fs.readFile('/var/log/motolavado-install.log', (err, data) => {
      res.writeHead(err ? 404 : 200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end(err ? 'sin registro' : data);
    });
  }
  let rel = ruta;
  if (rel === '/entrar' || rel === '/usuarios' || rel === '/whatsapp') rel += '.html';
  if (rel.endsWith('/')) rel += 'index.html';
  const archivo = path.normalize(path.join(WEB, rel));
  if (!archivo.startsWith(WEB + path.sep)) { res.writeHead(403); return res.end('prohibido'); }
  fs.readFile(archivo, (err, data) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('No encontrado'); }
    res.writeHead(200, { 'content-type': TIPOS[path.extname(archivo)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(data);
  });
});

servidor.listen(PORT, '127.0.0.1', () => console.log('Moto Lavado escuchando en el puerto ' + PORT + ' · versión ' + version()));
