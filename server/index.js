// Moto Lavado · servidor. Etapa 1: sirve la pantalla y reporta estado.
// Sin dependencias externas: solo módulos propios de Node.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PORT = Number(process.env.PORT || 3000);
const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'web');
const INICIO = new Date();
const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };

function version() {
  try { return execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim(); } catch (e) { return 'desconocida'; }
}

const servidor = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ ok: true, sistema: 'motolavado', version: version(), encendido: INICIO.toISOString(), hora: new Date().toISOString() }));
  }
  if (url.pathname === '/_instalacion.log') {
    // Registro de la instalación (no contiene claves). Se quita cuando el sistema esté en operación.
    return fs.readFile('/var/log/motolavado-install.log', (err, data) => {
      res.writeHead(err ? 404 : 200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end(err ? 'sin registro' : data);
    });
  }
  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const archivo = path.normalize(path.join(WEB, rel));
  if (!archivo.startsWith(WEB)) { res.writeHead(403); return res.end('prohibido'); }
  fs.readFile(archivo, (err, data) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('No encontrado'); }
    res.writeHead(200, { 'content-type': TIPOS[path.extname(archivo)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(data);
  });
});

servidor.listen(PORT, '127.0.0.1', () => console.log('Moto Lavado escuchando en el puerto ' + PORT + ' · versión ' + version()));
