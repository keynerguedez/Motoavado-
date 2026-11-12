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
function registrarVenta(d, yo) {
  const tel = String(d.telefono || '').replace(/\D/g, '');
  if (!/^0[24]\d{9}$/.test(tel)) return { error: 'Teléfono no válido.' };
  const placa = limpio(d.placa, 14).toUpperCase().replace(/[^A-Z0-9]/g, ''); if (!placa) return { error: 'Falta la placa.' };
  const servicios = (Array.isArray(d.servicios) ? d.servicios : []).slice(0, 12).map(x => ({ id: limpio(x.id, 10), nombre: limpio(x.nombre, 60), precio: dinero(x.precio) })).filter(x => x.nombre && x.precio != null);
  const total = dinero(d.total);
  if (!servicios.length || total == null) return { error: 'Venta incompleta.' };
  const ahora = new Date(), dia = fechaCaracas(ahora), archivo = path.join(DATA, 'ventas-' + dia.slice(0, 7) + '.jsonl');
  let delDia = 0; try { delDia = fs.readFileSync(archivo, 'utf8').split('\n').filter(l => l.includes('"dia":"' + dia + '"')).length; } catch (e) {}
  const v = { id: crypto.randomBytes(6).toString('hex'), num: delDia + 1, dia, fecha: ahora.toISOString(), usuario: yo.nombre, usuarioId: yo.id, telefono: tel, cliente: limpio(d.cliente, 60), placa, modelo: limpio(d.modelo, 60),
    servicios, total, descuento: limpio(d.descuento, 10), lavador: limpio(d.lavador, 40), metodo: limpio(d.metodo, 20), ref: limpio(d.ref, 30), moneda: limpio(d.moneda, 6), monto: dinero(d.monto), tasa: Number(d.tasa) > 0 ? Number(d.tasa) : null };
  fs.appendFileSync(archivo, JSON.stringify(v) + '\n', { mode: 0o600 });
  const cs = leerClientes(), c = cs[tel] || { telefono: tel, nombre: '', motos: [], visitas: 0, gastado: 0, primera: v.fecha };
  if (v.cliente && v.cliente !== 'Sin nombre') c.nombre = v.cliente;
  const m = c.motos.find(x => String(x.placa).replace(/[^A-Z0-9]/g, '') === placa); if (m) m.placa = placa;
  if (m) { m.ultima = v.fecha; m.visitas = (m.visitas || 1) + 1; if (v.modelo) m.modelo = v.modelo; } else c.motos.push({ placa, modelo: v.modelo, ultima: v.fecha, visitas: 1 });
  c.visitas++; c.gastado = Math.round((c.gastado + total) * 100) / 100; c.ultima = v.fecha; c.ultimoServicio = servicios.map(x => x.nombre).join(' + ');
  cs[tel] = c; guardarClientes(cs);
  return { ok: true, id: v.id, num: v.num };
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
function csv(v) { v = String(v == null ? '' : v); if (/^[=+\-@]/.test(v)) v = "'" + v; return '"' + v.replace(/"/g, '""') + '"'; }

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
    req.on('data', c => { t += c; if (t.length > 20000) { mal(new Error('grande')); req.destroy(); } });
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
    if (ruta === '/api/usuarios') return puede(yo, 'usuarios') ? json(res, 200, leerUsuarios().map(publico)) : json(res, 403, { error: 'No tienes permiso.' });
    return json(res, 404, { error: 'No encontrado.' });
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'Método no permitido.' });
  if (!mismoOrigen(req)) return json(res, 403, { error: 'Origen no permitido.' });
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
  if (ruta === '/api/ventas') {
    if (!puede(yo, 'tablet')) return json(res, 403, { error: 'No tienes permiso.' });
    const r = registrarVenta(d, yo);
    return json(res, r.error ? 400 : 200, r);
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
    const hola = d.cliente && d.cliente !== 'Sin nombre' ? 'Hola ' + txt(d.cliente, 40).split(' ')[0] + ', aquí' : 'Aquí';
    const r = png ? await waqr.enviarImagen(para, png, hola + ' tienes tu nota de entrega de *Motolavado R1*. ¡Gracias por tu visita!') : await waqr.enviarTexto(para, texto);
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

const servidor = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let ruta; try { ruta = decodeURIComponent(url.pathname); } catch (e) { res.writeHead(400); return res.end(); }
  if (ruta === '/health') return json(res, 200, { ok: true, sistema: 'motolavado', version: version(), waqr: waqr ? waqr.publico().estado : 'no-disponible', libs: fs.existsSync(path.join(ROOT, 'node_modules', 'baileys')), nota: (() => { try { require.resolve('@resvg/resvg-js'); return true; } catch (e) { return false; } })(), encendido: INICIO.toISOString(), hora: new Date().toISOString() });
  if (ruta.startsWith('/api/')) return api(req, res, ruta).catch(() => json(res, 500, { error: 'Error del servidor.' }));

  const yo = sesion(req);
  if (!PUBLICAS.has(ruta) && !yo) { res.writeHead(302, { location: '/entrar', 'cache-control': 'no-store' }); return res.end(); }
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
