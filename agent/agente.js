#!/usr/bin/env node
// Moto Lavado · agente de la cámara (corre en un equipo del local, no en el servidor).
// Lee el video RTSP de la cámara Hikvision con ffmpeg, detecta moto en cada puente y manda los fotogramas al servidor.
//   node agente.js            vigilar (modo normal)
//   node agente.js probar     guarda una captura completa y el recorte de cada zona en agent/prueba/
//   node agente.js calibrar   guarda como "fondo" lo que ve ahora (haz esto con los 4 puentes VACÍOS)
// Necesita: Node 20+ y ffmpeg instalado. Configuración en agent/.env y agent/zonas.json.
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { crearDetector, W, H } = require('./detector');

const DIR = __dirname;
const FONDO = path.join(DIR, 'fondo.gray');

try { for (const l of fs.readFileSync(path.join(DIR, '.env'), 'utf8').split('\n')) { const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(l); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2'); } } catch (e) {}
const E = process.env;
const log = (...a) => console.log(new Date().toLocaleString('es-VE', { timeZone: 'America/Caracas' }), ...a);
function salir(msg) { console.error('Error: ' + msg); process.exit(1); }

// Usa FFMPEG del .env, o agent/herramientas/ffmpeg si existe, o el ffmpeg del sistema.
const FFMPEG = process.env.FFMPEG || (fs.existsSync(path.join(DIR, 'herramientas', 'ffmpeg')) ? path.join(DIR, 'herramientas', 'ffmpeg') : 'ffmpeg');
if (spawnSync(FFMPEG, ['-version']).error) salir('no encuentro ffmpeg. Instálalo (Mac: brew install ffmpeg · Ubuntu/Raspberry: sudo apt install ffmpeg).');
const cfg = JSON.parse(fs.readFileSync(path.join(DIR, 'zonas.json'), 'utf8'));

// La clave de la cámara se queda en este equipo; nunca se escribe en el registro.
function rtsp(canal) {
  if (!E.CAMARA_IP || !E.CAMARA_USUARIO || !E.CAMARA_CLAVE) salir('faltan CAMARA_IP, CAMARA_USUARIO o CAMARA_CLAVE en agent/.env');
  return 'rtsp://' + encodeURIComponent(E.CAMARA_USUARIO) + ':' + encodeURIComponent(E.CAMARA_CLAVE) + '@' + E.CAMARA_IP + ':' + (E.CAMARA_PUERTO || 554) + '/Streaming/Channels/' + canal;
}
const SUB = () => E.CAMARA_FUENTE_SUB || rtsp(102);        // calidad baja: para detectar movimiento
const PRINCIPAL = () => E.CAMARA_FUENTE_PRINCIPAL || rtsp(101); // calidad completa: para leer la placa
const entrada = src => (/^rtsp:/.test(src) ? ['-rtsp_transport', 'tcp', '-timeout', '10000000'] : []).concat(['-i', src]);

// ---------- fotogramas ----------
function capturar(filtro, tiempoMs) {
  return new Promise(ok => {
    const args = ['-loglevel', 'error'].concat(entrada(PRINCIPAL()), ['-frames:v', '1'], filtro ? ['-vf', filtro] : [], ['-q:v', '3', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1']);
    const p = spawn(FFMPEG, args); const partes = [];
    const t = setTimeout(() => p.kill('SIGKILL'), tiempoMs || 20000);
    p.stdout.on('data', c => partes.push(c));
    p.on('close', () => { clearTimeout(t); const b = Buffer.concat(partes); ok(b.length > 1000 ? b : null); });
    p.on('error', () => ok(null));
  });
}
const cortar = z => 'crop=trunc(iw*' + z.w + '/2)*2:trunc(ih*' + z.h + '/2)*2:trunc(iw*' + z.x + '/2)*2:trunc(ih*' + z.y + '/2)*2';

// Flujo continuo de fotogramas pequeños en gris (1 por segundo). Si se corta, se vuelve a conectar.
function flujo(alFotograma) {
  let parar = false, proc = null;
  (function conectar() {
    if (parar) return;
    const p = proc = spawn(FFMPEG, ['-loglevel', 'error'].concat(entrada(SUB()), ['-vf', 'fps=1,scale=' + W + ':' + H + ',format=gray', '-f', 'rawvideo', 'pipe:1']));
    let buf = Buffer.alloc(0), recibio = false;
    p.stdout.on('data', c => {
      buf = Buffer.concat([buf, c]);
      while (buf.length >= W * H) { recibio = true; const f = buf.subarray(0, W * H); buf = buf.subarray(W * H); alFotograma(Buffer.from(f)); }
    });
    p.stderr.on('data', d => { if (!recibio) log('ffmpeg:', String(d).trim().replace(/\/\/[^@\s]*@/g, '//***@')); });
    p.on('close', () => { if (!parar) { log('Se cortó el video. Reconecto en 5 s…'); setTimeout(conectar, 5000); } });
    p.on('error', e => log('ffmpeg:', e.message));
  })();
  return () => { parar = true; if (proc) proc.kill(); };
}

// ---------- envío al servidor ----------
function enviar(puente, jpeg) {
  const u = new URL(E.SERVIDOR_URL.replace(/\/$/, '') + '/api/camara/evento?puente=' + puente + '&presente=' + (jpeg ? 1 : 0));
  const lib = u.protocol === 'https:' ? https : http;
  return new Promise(ok => {
    const r = lib.request(u, { method: 'POST', timeout: 30000, headers: { authorization: 'Bearer ' + E.CAMARA_TOKEN, 'content-type': jpeg ? 'image/jpeg' : 'application/octet-stream', 'content-length': jpeg ? jpeg.length : 0 } }, res => {
      let t = ''; res.on('data', c => { t += c; }); res.on('end', () => ok({ codigo: res.statusCode, cuerpo: t }));
    });
    r.on('error', e => ok({ error: e.message })); r.on('timeout', () => r.destroy(new Error('tiempo agotado')));
    r.end(jpeg || undefined);
  });
}

// Una sola cola: los envíos van de uno en uno para no saturar la cámara ni el internet del local.
let cola = Promise.resolve();
function encolar(tarea) { cola = cola.then(tarea).catch(e => log('error:', e.message)); }

async function reportar(ev) {
  const z = cfg.zonas.find(x => x.puente === ev.puente);
  let jpeg = null;
  if (ev.tipo !== 'baja' && ev.tipo !== 'libre') { jpeg = await capturar(cortar(z)); if (!jpeg) return log('Puente ' + ev.puente + ': no pude sacar el fotograma de la cámara.'); }
  const r = await enviar(ev.puente, jpeg);
  if (r.error || r.codigo !== 200) log('Puente ' + ev.puente + ' (' + ev.tipo + '): el servidor no aceptó. ' + (r.error || r.codigo + ' ' + r.cuerpo));
  else if (ev.tipo !== 'libre') log('Puente ' + ev.puente + ': ' + ev.tipo + (jpeg ? ' (' + Math.round(jpeg.length / 1024) + ' KB)' : '') + ' → ' + r.cuerpo);
}

// ---------- comandos ----------
async function probar() {
  fs.mkdirSync(path.join(DIR, 'prueba'), { recursive: true });
  const full = await capturar('', 30000); if (!full) salir('no pude leer la cámara. Revisa IP, usuario, clave y que el RTSP esté activo.');
  fs.writeFileSync(path.join(DIR, 'prueba', 'completa.jpg'), full); console.log('Captura completa: agent/prueba/completa.jpg (' + Math.round(full.length / 1024) + ' KB)');
  for (const z of cfg.zonas) { const j = await capturar(cortar(z), 30000); if (j) { fs.writeFileSync(path.join(DIR, 'prueba', 'zona-' + z.puente + '.jpg'), j); console.log('Puente ' + z.puente + ': agent/prueba/zona-' + z.puente + '.jpg'); } }
  console.log('Mira zona-N.jpg: cada recorte debe mostrar el puente N completo. Si no, ajusta agent/zonas.json.');
}
function calibrar() {
  const acum = new Float32Array(W * H); let n = 0;
  log('Calibrando con 5 fotogramas. Los 4 puentes deben estar VACÍOS…');
  const parar = flujo(f => { for (let i = 0; i < f.length; i++) acum[i] += f[i]; if (++n === 5) { parar(); fs.writeFileSync(FONDO, Buffer.from(acum.map(v => Math.round(v / 5)))); console.log('Listo: agent/fondo.gray guardado.'); process.exit(0); } });
  setTimeout(() => salir('no llegaron fotogramas de la cámara en 40 s.'), 40000);
}
function vigilar() {
  if (!E.SERVIDOR_URL || !E.CAMARA_TOKEN) salir('faltan SERVIDOR_URL o CAMARA_TOKEN en agent/.env');
  const d = crearDetector(cfg.zonas, { umbral: cfg.umbral }, ev => encolar(() => reportar(ev)));
  if (fs.existsSync(FONDO)) { d.fijarFondo(fs.readFileSync(FONDO)); log('Fondo cargado de agent/fondo.gray.'); }
  else log('AVISO: no hay fondo calibrado. Tomo como "vacío" lo primero que vea. Mejor ejecuta: node agente.js calibrar');
  let n = 0;
  flujo(f => { const r = d.procesar(f, Date.now()); if (++n % 60 === 1 && E.CAMARA_DEPURAR) log('zonas:', JSON.stringify(r)); });
  log('Vigilando ' + cfg.zonas.length + ' puentes. Ctrl+C para parar.');
}

({ probar, calibrar }[process.argv[2]] || vigilar)();
