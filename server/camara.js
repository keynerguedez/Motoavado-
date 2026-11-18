// Moto Lavado · vigilante por cámara (servidor).
// Recibe de un agente en el local (que lee el video RTSP de la cámara IP) un fotograma por puente
// con "hay moto / no hay moto", lee la placa con un modelo de visión y la compara con lo registrado hoy.
// Sin dependencias externas. Claves en el entorno (vault/.env), nunca en el repositorio:
//   CAMARA_TOKEN       clave que usa el agente para enviar eventos (obligatoria)
//   ANTHROPIC_API_KEY  para leer la placa en la imagen (si falta, se detecta la moto pero la placa queda "sin lector")
//   CAMARA_MODELO      modelo de visión (por defecto claude-sonnet-5-5; Haiku es más barato pero leyó peor las placas en las pruebas)
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const PUENTES = 4;
const MIN_GRACIA = 5;           // minutos que se le da a una moto montada para que la registren antes de alertar
const MAX_FOTO = 3 * 1024 * 1024;
const MAX_REINTENTOS_LECTURA = 3;   // lecturas seguidas al llegar la moto (el agente reenvía a los 8 y 20 s)
const MAX_LECTURAS_LENTAS = 30;     // tope de lecturas por moto, contando las lentas
const CADA_LECTURA_LENTA = 55000;   // ms: mientras siga sin placa completa, se reintenta una vez por minuto
const MAX_LOG = 100;

function crear(ctx) {
  const ESTADO = path.join(ctx.DATA, 'camara.json');
  const FOTOS = path.join(ctx.DATA, 'fotos');
  fs.mkdirSync(FOTOS, { recursive: true });

  const vacio = () => ({ puentes: Array.from({ length: PUENTES }, (_, i) => ({ n: i + 1, estado: 'libre' })), log: [], dia: '', vistas: 0 });
  let S = vacio();
  try { const d = JSON.parse(fs.readFileSync(ESTADO, 'utf8')); if (d && Array.isArray(d.puentes) && d.puentes.length === PUENTES) S = d; } catch (e) {}
  function guardar() { try { const tmp = ESTADO + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(S), { mode: 0o600 }); fs.renameSync(tmp, ESTADO); } catch (e) { console.error('camara:', e.message); } }
  function avisar(kind, txt) { S.log.unshift({ t: new Date().toISOString(), kind, txt }); S.log.length = Math.min(S.log.length, MAX_LOG); }
  function cambioDeDia() { const d = ctx.fechaCaracas(new Date()); if (S.dia !== d) { S.dia = d; S.vistas = 0; } }

  function tokenValido(req) {
    const t = process.env.CAMARA_TOKEN || '';
    if (t.length < 24) return false;
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    if (!m) return false;
    const a = Buffer.from(m[1]), b = Buffer.from(t);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  function leerFoto(req) {
    return new Promise((ok, mal) => {
      if (!/^image\/jpeg/.test(req.headers['content-type'] || '')) return mal(new Error('tipo'));
      const partes = []; let n = 0;
      req.on('data', c => { n += c.length; if (n > MAX_FOTO) { mal(new Error('grande')); req.destroy(); } else partes.push(c); });
      req.on('end', () => ok(Buffer.concat(partes)));
      req.on('error', mal);
    });
  }

  // ---------- lectura de la imagen: ¿hay moto? ¿qué placa? ----------
  // moto: true/false lo dice el modelo; null = no se pudo saber (sin clave o error), y entonces se confía en el agente.
  const leer = jpeg => (ctx.leerPlaca || leerPlaca)(jpeg);
  function limpiarPlaca(v) { return String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }
  // Lectura parcial: lo que el modelo sí ve, con "?" en cada carácter que no distingue (p. ej. "AB1C??").
  // Solo se acepta con 5 a 8 caracteres y al menos 4 conocidos; si no, no sirve para identificar nada.
  const conocidos = s => String(s || '').replace(/\?/g, '').length;
  function limpiarParcial(v) {
    const s = String(v || '').toUpperCase().replace(/[^A-Z0-9?]/g, '');
    return /^[A-Z0-9?]{5,8}$/.test(s) && conocidos(s) >= 4 && conocidos(s) < s.length ? s : '';
  }
  function leerPlaca(jpeg) {
    const clave = process.env.ANTHROPIC_API_KEY;
    if (!clave) return Promise.resolve({ moto: null, placa: '', motivo: 'sin-lector' });
    const modelo = process.env.CAMARA_MODELO || 'claude-sonnet-5-5';
    // max_tokens holgado: si el modelo piensa antes de responder, esos tokens salen del mismo cupo y con uno corto el texto llega vacío.
    // Haiku piensa por defecto y admite apagarlo; los demás modelos rechazan ese parámetro, así que solo se manda a Haiku.
    const cuerpo = JSON.stringify(Object.assign({
      model: modelo, max_tokens: 1500,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpeg.toString('base64') } },
        { type: 'text', text: 'Es una foto de una rampa de un lavadero de motos. Responde solo JSON: {"moto":true,"placa":"ABC123","segura":true}. "moto" es true solo si ves una moto sobre la rampa (aunque esté a medias, mojada o sin placa visible); es false si solo hay personas, cubetas, mangueras, herramientas, el piso o la rampa vacía. "placa" es la placa venezolana (6 a 8 letras y números); si no se ve completa o no estás seguro de cada carácter, deja "placa":"" y "segura":false, y en "parcial" escribe los caracteres que sí distingues, en su posición, con "?" en cada uno que no ves o no estás seguro (ejemplo: {"moto":true,"placa":"","segura":false,"parcial":"AB1C??"}). Nunca inventes un carácter que no se vea.' }] }],
    }, /haiku/.test(modelo) ? { thinking: { type: 'disabled' } } : {}));
    return new Promise(ok => {
      const r = https.request({ hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST', timeout: 20000,
        headers: { 'content-type': 'application/json', 'x-api-key': clave, 'anthropic-version': '2023-06-01', 'content-length': Buffer.byteLength(cuerpo) } }, res => {
        let t = ''; res.on('data', c => { t += c; });
        res.on('end', () => {
          try {
            const txt = (JSON.parse(t).content || []).map(x => x.text || '').join('');
            const j = JSON.parse(/\{[\s\S]*\}/.exec(txt)[0]);
            const placa = limpiarPlaca(j.placa), moto = j.moto === true ? true : j.moto === false ? false : null;
            if (moto === false) return ok({ moto: false, placa: '', motivo: 'no-hay-moto' });
            if (j.segura === true && /^[A-Z0-9]{5,8}$/.test(placa)) return ok({ moto, placa });
            const parcial = limpiarParcial(j.parcial);
            ok({ moto, placa: '', parcial, motivo: parcial ? 'parcial' : 'ilegible' });
          } catch (e) { ok({ moto: null, placa: '', motivo: 'error' }); }
        });
      });
      r.on('error', () => ok({ moto: null, placa: '', motivo: 'error' })); r.on('timeout', () => { r.destroy(); ok({ moto: null, placa: '', motivo: 'error' }); });
      r.end(cuerpo);
    });
  }

  // ---------- comparación con lo registrado hoy ----------
  function registrada(placa) {
    if (!placa) return null;
    return ctx.ventasDeHoy().find(v => limpiarPlaca(v.placa) === placa) || null;
  }
  // Con una lectura parcial solo se da por registrada si UNA sola placa de hoy encaja (cada "?" vale cualquier carácter).
  function registradaParcial(parcial) {
    if (!parcial) return null;
    const encaja = v => { const pl = limpiarPlaca(v.placa); return pl.length === parcial.length && [...parcial].every((c, i) => c === '?' || c === pl[i]); };
    const hoy = ctx.ventasDeHoy().filter(encaja);
    return hoy.length && new Set(hoy.map(v => limpiarPlaca(v.placa))).size === 1 ? hoy[0] : null;
  }
  function evaluar(p) {
    if (p.estado === 'libre') return;
    let v = registrada(p.placa), aprox = false;
    if (!v && !p.placa && p.parcial) { v = registradaParcial(p.parcial); aprox = !!v; }
    if (v) {
      if (p.estado !== 'ok') avisar('ok', 'Puente ' + p.n + ': ' + (aprox ? 'la lectura parcial ' + p.parcial + ' coincide con la moto ' + limpiarPlaca(v.placa) : 'se registró la moto ' + p.placa) + ' (#' + v.num + ').');
      p.estado = 'ok'; p.num = v.num; if (aprox) p.aprox = limpiarPlaca(v.placa); else delete p.aprox; return;
    }
    const min = (Date.now() - new Date(p.desde).getTime()) / 60000;
    if (min >= MIN_GRACIA && p.estado !== 'alerta') { p.estado = 'alerta'; p.alertado = true; avisar('bad', 'Puente ' + p.n + ': moto sin factura' + (p.placa ? '. Placa leída ' + p.placa + '.' : p.parcial ? '. Placa leída en parte: ' + p.parcial + '.' : '. Placa no legible.')); }
  }
  // Guarda lo que leyó el modelo: placa completa, o la lectura parcial con más caracteres conocidos.
  function guardarLectura(p, r) {
    if (r.placa) { p.placa = r.placa; p.parcial = ''; avisar('info', 'Puente ' + p.n + ': placa leída ' + r.placa + '.'); return; }
    p.motivo = r.motivo;
    if (r.parcial && conocidos(r.parcial) >= conocidos(p.parcial)) { if (r.parcial !== p.parcial) avisar('info', 'Puente ' + p.n + ': placa leída en parte: ' + r.parcial + '.'); p.parcial = r.parcial; }
  }

  // ---------- eventos que manda el agente ----------
  async function evento(req, res) {
    if (!tokenValido(req)) return ctx.json(res, 401, { error: 'Clave de cámara incorrecta.' });
    const q = new URL(req.url, 'http://localhost').searchParams;
    const n = Number(q.get('puente')), presente = q.get('presente') === '1';
    if (!Number.isInteger(n) || n < 1 || n > PUENTES) return ctx.json(res, 400, { error: 'Puente no válido.' });
    let jpeg = null;
    if (presente) { try { jpeg = await leerFoto(req); } catch (e) { return ctx.json(res, 400, { error: 'Falta el fotograma (image/jpeg, máx. 3 MB).' }); } if (jpeg.length < 1000) return ctx.json(res, 400, { error: 'Fotograma vacío.' }); }
    else req.resume();
    cambioDeDia();
    const p = S.puentes[n - 1], ahora = new Date().toISOString();
    S.contacto = ahora; // última vez que el agente habló: la pantalla avisa si se queda sin señal
    if (!presente) {
      if (p.estado !== 'libre') {
        avisar(p.estado === 'alerta' ? 'bad' : 'info', 'Puente ' + n + ': la moto ' + (p.placa || 'sin placa leída') + ' bajó' + (p.estado === 'alerta' ? ' sin registrarse.' : '.'));
        S.puentes[n - 1] = { n, estado: 'libre' };
      }
      guardar(); return ctx.json(res, 200, { ok: true });
    }
    const guardarFoto = () => { p.visto = ahora; try { fs.writeFileSync(path.join(FOTOS, 'camara-puente-' + n + '.jpg'), jpeg, { mode: 0o600 }); } catch (e) {} };
    if (p.estado === 'libre') {
      const r = await leer(jpeg);
      if (r.moto === false) { guardar(); return ctx.json(res, 200, { ok: true, estado: 'libre', motivo: 'no-hay-moto' }); } // persona, cubeta, manguera…
      Object.assign(p, { estado: 'esperando', desde: ahora, placa: '', parcial: '', intentos: 1, leidoT: Date.now(), sinMoto: 0 }); delete p.num; delete p.alertado; delete p.motivo; delete p.aprox;
      S.vistas++; avisar('info', 'Puente ' + n + ': llegó una moto.');
      guardarLectura(p, r);
      guardarFoto();
    } else {
      guardarFoto();
      const toca = p.intentos < MAX_REINTENTOS_LECTURA || (p.intentos < MAX_LECTURAS_LENTAS && Date.now() - (p.leidoT || 0) >= CADA_LECTURA_LENTA);
      if (!p.placa && toca) {
        p.intentos++; p.leidoT = Date.now();
        const r = await leer(jpeg);
        if (r.moto === false) {
          // Dos veces seguidas sin moto: lo que se había tomado por moto ya no está.
          if (++p.sinMoto >= 2) { avisar('info', 'Puente ' + n + ': ya no se ve la moto.'); S.puentes[n - 1] = { n, estado: 'libre' }; S.vistas = Math.max(0, S.vistas - 1); guardar(); return ctx.json(res, 200, { ok: true, estado: 'libre' }); }
        } else { p.sinMoto = 0; guardarLectura(p, r); }
      }
    }
    evaluar(p); guardar();
    return ctx.json(res, 200, { ok: true, estado: p.estado, placa: p.placa || null });
  }

  // ---------- vista de la cámara (fotograma liviano + zonas) para la pantalla ----------
  async function vista(req, res) {
    if (!tokenValido(req)) return ctx.json(res, 401, { error: 'Clave de cámara incorrecta.' });
    let jpeg; try { jpeg = await leerFoto(req); } catch (e) { return ctx.json(res, 400, { error: 'Falta el fotograma (image/jpeg, máx. 3 MB).' }); }
    if (jpeg.length < 1000) return ctx.json(res, 400, { error: 'Fotograma vacío.' });
    let zonas = []; try {
      const z = JSON.parse(new URL(req.url, 'http://localhost').searchParams.get('zonas') || '[]');
      zonas = (Array.isArray(z) ? z : []).slice(0, PUENTES).map(x => ({ puente: Number(x.puente), x: Number(x.x), y: Number(x.y), w: Number(x.w), h: Number(x.h) }))
        .filter(x => Number.isInteger(x.puente) && x.puente >= 1 && x.puente <= PUENTES && [x.x, x.y, x.w, x.h].every(v => v >= 0 && v <= 1));
    } catch (e) {}
    try { fs.writeFileSync(path.join(FOTOS, 'camara-vista.jpg'), jpeg, { mode: 0o600 }); } catch (e) {}
    S.contacto = S.vistaT = new Date().toISOString(); S.zonas = zonas; guardar();
    return ctx.json(res, 200, { ok: true });
  }
  function fotoVista() { try { return fs.readFileSync(path.join(FOTOS, 'camara-vista.jpg')); } catch (e) { return null; } }

  // ---------- lo que ve la pantalla ----------
  function publico() {
    cambioDeDia();
    S.puentes.forEach(evaluar);
    return { dia: S.dia, vistas: S.vistas, contacto: S.contacto || null, vista: S.vistaT ? { t: S.vistaT, zonas: S.zonas || [] } : null, puentes: S.puentes.map(p => Object.assign({}, p, { foto: p.estado !== 'libre' })), log: S.log.slice(0, 30), ahora: new Date().toISOString() };
  }
  function foto(n) { try { return fs.readFileSync(path.join(FOTOS, 'camara-puente-' + Number(n) + '.jpg')); } catch (e) { return null; } }

  return { evento, vista, fotoVista, publico, foto, PUENTES };
}

module.exports = { crear };
