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
const PERMISOS = ['tablet', 'comisiones', 'gastos', 'admin', 'vigilante', 'autorizar', 'usuarios'];
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
  if (ruta === '/health') return json(res, 200, { ok: true, sistema: 'motolavado', version: version(), encendido: INICIO.toISOString(), hora: new Date().toISOString() });
  if (ruta.startsWith('/api/')) return api(req, res, ruta).catch(() => json(res, 500, { error: 'Error del servidor.' }));

  const yo = sesion(req);
  if (!PUBLICAS.has(ruta) && !yo) { res.writeHead(302, { location: '/entrar', 'cache-control': 'no-store' }); return res.end(); }
  if (SOLO_DUENO.has(ruta) && !(ruta === '/_instalacion.log' ? yo && yo.rol === 'dueno' : puede(yo, 'usuarios'))) { res.writeHead(302, { location: '/', 'cache-control': 'no-store' }); return res.end(); }
  if (ruta === '/_instalacion.log') {
    return fs.readFile('/var/log/motolavado-install.log', (err, data) => {
      res.writeHead(err ? 404 : 200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end(err ? 'sin registro' : data);
    });
  }
  let rel = ruta;
  if (rel === '/entrar' || rel === '/usuarios') rel += '.html';
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
