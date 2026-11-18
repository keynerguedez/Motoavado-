// Moto Lavado · servidor FTP mínimo solo para recibir las fotos de la cámara (sin dependencias).
// La cámara Hikvision sube por FTP las capturas en 4K; el aviso HTTP del evento solo trae una miniatura.
//   - Un solo usuario (CAMARA_FTP_USUARIO / CAMARA_FTP_CLAVE) que solo puede SUBIR .jpg; no lista ni descarga ni borra.
//   - Todo cae plano en una carpeta propia; el nombre que mande el cliente se limpia (nada de rutas).
//   - Solo modo pasivo (la cámara está detrás de un router: el servidor no puede llamarla).
//   - FTP NO va cifrado: usa una clave larga y exclusiva, y abre en el firewall solo el puerto de control y el rango pasivo.
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_ARCHIVO = 8 * 1024 * 1024;
const MAX_SESIONES = 6;

function igual(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest(), y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

// opciones: { dir, usuario, clave, anonimo, puerto, rango: [desde, hasta], ipPublica, alRecibir(nombre, ruta), log }
function crear(o) {
  const log = o.log || (() => {});
  fs.mkdirSync(o.dir, { recursive: true });
  const [pDesde, pHasta] = o.rango || [30000, 30009];
  const fallos = new Map(); // ip → intentos de clave fallidos
  let sesiones = 0;

  const servidor = net.createServer(sock => {
    if (sesiones >= MAX_SESIONES) { sock.end('421 Demasiadas conexiones.\r\n'); return; }
    sesiones++;
    const ip = String(sock.remoteAddress || '').replace('::ffff:', '');
    let usuario = '', auth = false, datos = null, esperaDatos = null, buf = '', pasivo = null;
    const r = (cod, txt) => { if (!sock.destroyed) sock.write(cod + ' ' + txt + '\r\n'); };
    const cerrarPasivo = () => { if (pasivo) { try { pasivo.close(); } catch (e) {} pasivo = null; } if (datos) { try { datos.destroy(); } catch (e) {} datos = null; } esperaDatos = null; };
    sock.setTimeout(60000, () => sock.destroy());
    sock.on('error', () => {});
    sock.on('close', () => { sesiones--; cerrarPasivo(); });
    r(220, 'Moto Lavado listo.');

    // Abre un puerto pasivo en el rango y devuelve su número; la conexión de datos llega después.
    function abrirPasivo() {
      cerrarPasivo();
      return new Promise((ok, mal) => {
        let intentos = 0;
        const probar = () => {
          const puerto = pDesde + Math.floor(Math.random() * (pHasta - pDesde + 1));
          const s = net.createServer(c => {
            if (String(c.remoteAddress || '').replace('::ffff:', '') !== ip) { c.destroy(); return; } // los datos deben venir de la misma IP que el control
            if (datos) { c.destroy(); return; }
            datos = c; c.on('error', () => {}); if (esperaDatos) esperaDatos(c);
          });
          s.once('error', () => { if (++intentos < 20) probar(); else mal(new Error('sin puerto')); });
          s.listen(puerto, '0.0.0.0', () => { pasivo = s; ok(puerto); });
        };
        probar();
      });
    }
    const conexionDatos = () => new Promise((ok, mal) => {
      if (datos) return ok(datos);
      const t = setTimeout(() => { esperaDatos = null; mal(new Error('tiempo')); }, 10000);
      esperaDatos = c => { clearTimeout(t); ok(c); };
    });

    async function comando(linea) {
      const m = /^(\S+)(?:\s+(.*))?$/.exec(linea.trim()); if (!m) return;
      const cmd = m[1].toUpperCase(), arg = (m[2] || '').trim();
      if (cmd === 'USER') { usuario = arg; auth = false; return r(331, 'Falta la clave.'); }
      if (cmd === 'PASS') {
        if ((fallos.get(ip) || 0) >= 8) { return sock.end('421 Demasiados intentos.\r\n'); }
        const bien = o.anonimo ? /^(anonymous|ftp)$/i.test(usuario) : (o.usuario && o.clave && igual(usuario, o.usuario) && igual(arg, o.clave));
        if (!bien) { fallos.set(ip, (fallos.get(ip) || 0) + 1); log('FTP: clave incorrecta desde ' + ip); return setTimeout(() => r(530, 'Acceso denegado.'), 800); }
        fallos.delete(ip); auth = true; return r(230, 'Listo.');
      }
      if (cmd === 'QUIT') return sock.end('221 Hasta luego.\r\n');
      if (cmd === 'FEAT') return r(211, 'Sin extensiones.');
      if (cmd === 'OPTS' || cmd === 'NOOP') return r(200, 'Ok.');
      if (cmd === 'SYST') return r(215, 'UNIX Type: L8');
      if (cmd === 'AUTH' || cmd === 'PBSZ' || cmd === 'PROT') return r(502, 'Sin cifrado.');
      if (!auth) return r(530, 'Primero inicia sesión.');
      if (cmd === 'TYPE' || cmd === 'MODE' || cmd === 'STRU') return r(200, 'Ok.');
      if (cmd === 'PWD' || cmd === 'XPWD') return r(257, '"/" es el directorio actual.');
      if (cmd === 'CWD' || cmd === 'CDUP' || cmd === 'XCUP') return r(250, 'Ok.');
      if (cmd === 'MKD' || cmd === 'XMKD') return r(257, '"' + (arg.replace(/[^\w.\-\/]/g, '') || '/') + '" creado.');
      if (cmd === 'PASV' || cmd === 'EPSV') {
        let puerto; try { puerto = await abrirPasivo(); } catch (e) { return r(425, 'No hay puerto libre.'); }
        if (cmd === 'EPSV') return r(229, 'Modo pasivo extendido (|||' + puerto + '|)');
        const dir = (o.ipPublica || String(sock.localAddress || '').replace('::ffff:', '')).split('.');
        if (dir.length !== 4) return r(425, 'Solo IPv4.');
        return r(227, 'Modo pasivo (' + dir.join(',') + ',' + (puerto >> 8) + ',' + (puerto & 255) + ')');
      }
      if (cmd === 'STOR') {
        const nombre = path.basename(arg.replace(/\\/g, '/'));
        if (!/^[\w.\-]{1,120}\.jpe?g$/i.test(nombre)) { cerrarPasivo(); return r(553, 'Solo se aceptan archivos .jpg.'); }
        let c; try { c = await conexionDatos(); } catch (e) { cerrarPasivo(); return r(425, 'Sin conexión de datos.'); }
        r(150, 'Subiendo.');
        const tmp = path.join(o.dir, '.' + crypto.randomBytes(6).toString('hex') + '.tmp'), fin = path.join(o.dir, nombre);
        const out = fs.createWriteStream(tmp, { mode: 0o600 }); let n = 0, grande = false;
        c.on('data', d => { n += d.length; if (n > MAX_ARCHIVO) { grande = true; c.destroy(); out.destroy(); } });
        c.pipe(out);
        const listo = () => {
          cerrarPasivo();
          if (grande) { fs.unlink(tmp, () => {}); return r(552, 'Archivo demasiado grande.'); }
          if (n < 1000) { fs.unlink(tmp, () => {}); return r(451, 'Archivo vacío.'); }
          fs.rename(tmp, fin, e => { if (e) { fs.unlink(tmp, () => {}); return r(451, 'No se pudo guardar.'); } r(226, 'Recibido.'); try { o.alRecibir && o.alRecibir(nombre, fin, n); } catch (x) { log('FTP: ' + x.message); } });
        };
        out.on('finish', listo); out.on('error', () => { cerrarPasivo(); fs.unlink(tmp, () => {}); });
        return;
      }
      return r(502, 'Comando no disponible.');
    }

    // Los comandos se atienden de a uno, en orden.
    let cola = Promise.resolve();
    sock.on('data', d => {
      buf += d.toString('latin1'); if (buf.length > 4096) return sock.destroy();
      let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1); cola = cola.then(() => comando(l)).catch(() => {}); }
    });
  });
  servidor.on('error', e => log('FTP: ' + e.message));
  servidor.listen(o.puerto || 2121, '0.0.0.0', () => log('FTP de la cámara escuchando en el puerto ' + (o.puerto || 2121) + ' · pasivo ' + pDesde + '-' + pHasta));
  return servidor;
}

module.exports = { crear };
