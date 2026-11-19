// Moto Lavado · vigilante por cámara (servidor).
// Recibe de un agente en el local (que lee el video RTSP de la cámara IP) un fotograma por puente
// con "hay moto / no hay moto", lee la placa con un modelo de visión y la compara con lo registrado hoy.
// Sin dependencias externas. Claves en el entorno (vault/.env), nunca en el repositorio:
//   CAMARA_TOKEN       clave que usa el agente para enviar eventos (obligatoria)
//   ANTHROPIC_API_KEY  para leer la placa en la imagen (si falta, se detecta la moto pero la placa queda "sin lector")
//   CAMARA_MODELO_REVISION  modelo barato para las revisiones de zonas quietas (por defecto claude-haiku-5-5; solo dice si hay moto)
//   CAMARA_MODELO      modelo de visión (por defecto claude-sonnet-5-5; Haiku es más barato pero leyó peor las placas en las pruebas)
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const PUENTES = 5;            // 1 a 4: los puentes. 5: la zona extra, a la izquierda del puente 1, para motos que se lavan fuera del puente
const EXTRA = 5;
const nombre = n => n === EXTRA ? 'Zona fuera del puente' : nombre(n);
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
  try { const d = JSON.parse(fs.readFileSync(ESTADO, 'utf8')); if (d && Array.isArray(d.puentes) && d.puentes.length === PUENTES - 1) d.puentes.push({ n: EXTRA, estado: 'libre' }); if (d && Array.isArray(d.puentes) && d.puentes.length === PUENTES) S = d; } catch (e) {}
  function guardar() { try { hSync(); } catch (e) {} try { const tmp = ESTADO + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(S), { mode: 0o600 }); fs.renameSync(tmp, ESTADO); } catch (e) { console.error('camara:', e.message); } }
  // ---------- historial de motos vistas (para validar cómo se leen las placas) ----------
  const HIST = path.join(ctx.DATA, 'camara-historial.json'), HFOTOS = path.join(FOTOS, 'hist'), MAX_HIST = 600;
  fs.mkdirSync(HFOTOS, { recursive: true });
  let H = []; try { H = JSON.parse(fs.readFileSync(HIST, 'utf8')); if (!Array.isArray(H)) H = []; } catch (e) {}
  let hSucio = false;
  function hGuardar() { if (!hSucio) return; hSucio = false; try { const tmp = HIST + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(H), { mode: 0o600 }); fs.renameSync(tmp, HIST); } catch (e) { console.error('camara historial:', e.message); } }
  function hNuevo(p, jpeg) {
    const id = Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
    H.push({ id, puente: p.n, llegada: new Date().toISOString(), dia: ctx.fechaCaracas(new Date()), origen: p.origen || '', placa: '', parcial: '', motivo: '', estado: 'esperando', num: null, salida: null, real: '' });
    while (H.length > MAX_HIST) { const v = H.shift(); try { fs.unlinkSync(path.join(HFOTOS, v.id + '.jpg')); } catch (e) {} }
    p.hid = id; hSucio = true; hFoto(p, jpeg);
  }
  // Si la moto de un puente desaparece y vuelve a verse en menos de 10 minutos, es la misma: se reabre su fila y su reloj (no empieza otra).
  const MISMA_MOTO_MS = 10 * 60e3;
  function hAbrir(p, jpeg) {
    let ult = null; for (let i = H.length - 1; i >= 0; i--) if (H[i].puente === p.n) { ult = H[i]; break; }
    if (ult && ult.salida && Date.now() - Date.parse(ult.salida) < MISMA_MOTO_MS && ult.dia === ctx.fechaCaracas(new Date())) {
      ult.salida = null; hSucio = true; p.hid = ult.id;
      p.desde = ult.llegada; p.placa = ult.placa || ''; p.parcial = ult.parcial || ''; if (ult.sinPlaca) { /* se vuelve a emparejar solo */ }
      hFoto(p, jpeg); return true;
    }
    hNuevo(p, jpeg); return false;
  }
  function hFoto(p, jpeg) { if (p.hid && jpeg) try { fs.writeFileSync(path.join(HFOTOS, p.hid + '.jpg'), jpeg, { mode: 0o600 }); } catch (e) {} }
  function hSync() {
    S.puentes.forEach(p => {
      // Una moto que ya estaba en el puente antes de existir el historial también se anota, con la última foto de ese puente.
      if (!p.hid && p.estado !== 'libre') {
        let f = null; try { f = fs.readFileSync(path.join(FOTOS, 'camara-puente-' + p.n + '.jpg')); } catch (e) {}
        hNuevo(p, f); const e0 = H[H.length - 1]; if (p.desde) { e0.llegada = p.desde; e0.dia = ctx.fechaCaracas(new Date(p.desde)); }
      }
      if (!p.hid) return; const e = H.find(x => x.id === p.hid); if (!e) return;
      const nuevo = { placa: p.placa || e.placa || '', parcial: p.placa ? '' : (p.parcial || e.parcial || ''), motivo: p.motivo || '', estado: p.estado === 'libre' ? e.estado : p.estado, num: p.num == null ? null : p.num, aprox: p.aprox || '', sinPlaca: !!p.sinPlacaId };
      if (Object.keys(nuevo).some(k => (e[k] == null ? '' : e[k]) !== (nuevo[k] == null ? '' : nuevo[k]))) { Object.assign(e, nuevo); hSucio = true; }
    });
    hGuardar();
  }
  function hSalida(p) { const e = p && p.hid && H.find(x => x.id === p.hid); if (e && !e.salida) { e.salida = new Date().toISOString(); hSucio = true; } }
  function historial(dia) {
    const hoy = ctx.fechaCaracas(new Date()), d = /^\d{4}-\d{2}-\d{2}$/.test(dia || '') ? dia : hoy;
    const items = H.filter(e => e.dia === d).slice().reverse();
    const r = { total: items.length, completa: 0, parcial: 0, ilegible: 0, verificadas: 0, sinFactura: 0, esperando: 0, conReal: 0, aciertos: 0 };
    items.forEach(e => {
      if (e.placa) r.completa++; else if (e.parcial) r.parcial++; else r.ilegible++;
      if (e.estado === 'ok') r.verificadas++; else if (e.estado === 'alerta') r.sinFactura++; else r.esperando++;
      if (e.real) { r.conReal++; const real = limpiarPlaca(e.real); if (real && (limpiarPlaca(e.placa) === real || (e.parcial && coincideParcial(e.parcial, real)))) r.aciertos++; }
    });
    return { dia: d, hoy, resumen: r, items: items.slice(0, 200).map(e => Object.assign({}, e, { foto: '/api/camara/hist/' + e.id + '.jpg' })) };
  }
  function coincideParcial(parcial, real) { const nucleo = parcial.replace(/\?+$/, ''), abierta = nucleo.length < parcial.length; return (abierta ? real.length >= nucleo.length : real.length === nucleo.length) && [...nucleo].every((c, i) => c === '?' || c === real[i]); }
  function marcarReal(id, real) { const e = H.find(x => x.id === String(id)); if (!e) return false; e.real = limpiarPlaca(real).slice(0, 10); hSucio = true; hGuardar(); return true; }
  function fotoHist(id) { if (!/^[a-z0-9]{6,20}$/.test(String(id))) return null; try { return fs.readFileSync(path.join(HFOTOS, id + '.jpg')); } catch (e) { return null; } }
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
  const leer = (jpeg, modelo) => (ctx.leerPlaca || leerPlaca)(jpeg, modelo);
  function limpiarPlaca(v) { return String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }
  // Lectura parcial: lo que el modelo sí ve, con "?" en cada carácter que no distingue (p. ej. "AB1C??").
  // Solo se acepta con 5 a 8 caracteres y al menos 4 conocidos; si no, no sirve para identificar nada.
  const conocidos = s => String(s || '').replace(/\?/g, '').length;
  function limpiarParcial(v) {
    const s = String(v || '').toUpperCase().replace(/[^A-Z0-9?]/g, '');
    // Si el modelo dio todos los caracteres pero sin marcarla como segura, es una lectura probable, no una certeza: se guarda con '?' final (largo abierto).
    const t = !s.includes('?') && s.length >= 5 && s.length <= 7 ? s + '?' : s;
    return /^[A-Z0-9?]{5,8}$/.test(t) && conocidos(t) >= 4 && conocidos(t) < t.length ? t : '';
  }
  function leerPlaca(jpeg, modeloForzado) {
    const clave = process.env.ANTHROPIC_API_KEY;
    if (!clave) return Promise.resolve({ moto: null, placa: '', motivo: 'sin-lector' });
    const modelo = modeloForzado || process.env.CAMARA_MODELO || 'claude-sonnet-5-5';
    // max_tokens holgado: si el modelo piensa antes de responder, esos tokens salen del mismo cupo y con uno corto el texto llega vacío.
    // Haiku piensa por defecto y admite apagarlo; los demás modelos rechazan ese parámetro, así que solo se manda a Haiku.
    const cuerpo = JSON.stringify(Object.assign({
      model: modelo, max_tokens: 1500,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpeg.toString('base64') } },
        { type: 'text', text: (process.env.CAMARA_PRUEBA === '1' ? 'MODO DE PRUEBA: un cartón o papel con una placa escrita cuenta como la moto (moto:true). ' : '') + 'Es una foto de una rampa de un lavadero de motos. Responde solo JSON: {"moto":true,"placa":"ABC123","segura":true}. "moto" es true solo si ves una moto sobre la rampa (aunque esté a medias, mojada o sin placa visible); es false si solo hay personas, cubetas, mangueras, herramientas, el piso o la rampa vacía. "placa" es la placa venezolana (6 a 8 letras y números); si no se ve completa o no estás seguro de cada carácter, deja "placa":"" y "segura":false, y en "parcial" escribe los caracteres que sí distingues, en su posición, con "?" en cada uno que no ves o no estás seguro (ejemplo: {"moto":true,"placa":"","segura":false,"parcial":"AB1C??"}). Nunca inventes un carácter que no se vea.' }] }],
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
    // Los "?" del final no fijan el largo (el modelo no sabe cuántos caracteres tiene la placa); los del medio sí valen un carácter.
    const nucleo = parcial.replace(/\?+$/, ''), abierta = nucleo.length < parcial.length;
    const encaja = v => { const pl = limpiarPlaca(v.placa); return (abierta ? pl.length >= nucleo.length : pl.length === nucleo.length) && [...nucleo].every((c, i) => c === '?' || c === pl[i]); };
    const hoy = ctx.ventasDeHoy().filter(encaja);
    return hoy.length && new Set(hoy.map(v => limpiarPlaca(v.placa))).size === 1 ? hoy[0] : null;
  }
  function evaluar(p) {
    if (p.estado === 'libre') return;
    let v = registrada(p.placa), aprox = false;
    if (!v && !p.placa && p.parcial) { v = registradaParcial(p.parcial); aprox = !!v; }
    if (v) {
      if (p.estado !== 'ok') avisar('ok', nombre(p.n) + ': ' + (aprox ? 'la lectura parcial ' + p.parcial + ' coincide con la moto ' + limpiarPlaca(v.placa) : 'se registró la moto ' + p.placa) + ' (#' + v.num + ').');
      p.estado = 'ok'; p.num = v.num; if (aprox) p.aprox = limpiarPlaca(v.placa); else delete p.aprox; return;
    }
    // Moto sin placa legible: si hoy hay una factura marcada "sin placa" que ningún otro puente tiene asignada, se da por registrada.
    if (!p.placa && !p.parcial) {
      const tomadas = new Set(S.puentes.filter(x => x !== p && x.sinPlacaId).map(x => x.sinPlacaId));
      const sp = ctx.ventasDeHoy().find(x => x.sinPlaca && !tomadas.has(x.id) && (p.sinPlacaId ? x.id === p.sinPlacaId : true));
      if (sp) { if (p.estado !== 'ok') avisar('ok', nombre(p.n) + ': moto sin placa legible, coincide con la factura sin placa #' + sp.num + '.'); p.estado = 'ok'; p.num = sp.num; p.sinPlacaId = sp.id; return; }
    }
    const min = (Date.now() - new Date(p.desde).getTime()) / 60000;
    if (min >= MIN_GRACIA && p.estado !== 'alerta') { p.estado = 'alerta'; p.alertado = true; avisar('bad', nombre(p.n) + ': moto sin factura' + (p.placa ? '. Placa leída ' + p.placa + '.' : p.parcial ? '. Placa leída en parte: ' + p.parcial + '.' : '. Placa no legible.')); }
  }
  // Guarda lo que leyó el modelo: placa completa, o la lectura parcial con más caracteres conocidos.
  function guardarLectura(p, r) {
    if (r.placa) { p.placa = r.placa; p.parcial = ''; avisar('info', nombre(p.n) + ': placa leída ' + r.placa + '.'); return; }
    p.motivo = r.motivo;
    if (r.parcial && conocidos(r.parcial) >= conocidos(p.parcial)) { if (r.parcial !== p.parcial) avisar('info', nombre(p.n) + ': placa leída en parte: ' + r.parcial + '.'); p.parcial = r.parcial; }
  }

  // ---------- núcleo: una imagen de un puente, venga del agente o de la cámara directa ----------
  // opc: { revision: es una revisión de zona quieta, previo: pregunta primero al modelo barato si hay moto, origen: de dónde vino }
  // Devuelve el cuerpo de la respuesta.
  async function procesar(n, presente, jpeg, opc) {
    opc = opc || {};
    cambioDeDia();
    const p = S.puentes[n - 1], ahora = new Date().toISOString();
    S.contacto = ahora; // última vez que llegó algo de la cámara: la pantalla avisa si se queda sin señal
    if (!presente) {
      if (p.estado !== 'libre') {
        avisar(p.estado === 'alerta' ? 'bad' : 'info', nombre(n) + ': la moto ' + (p.placa || 'sin placa leída') + ' bajó' + (p.estado === 'alerta' ? ' sin registrarse.' : '.'));
        hSalida(p); S.puentes[n - 1] = { n, estado: 'libre' };
      }
      guardar(); return { ok: true };
    }
    const guardarFoto = () => { p.visto = ahora; hFoto(p, jpeg); try { fs.writeFileSync(path.join(FOTOS, 'camara-puente-' + n + '.jpg'), jpeg, { mode: 0o600 }); } catch (e) {} };
    const llegada = (r, origen) => {
      Object.assign(p, { estado: 'esperando', desde: ahora, placa: '', parcial: '', intentos: 1, leidoT: Date.now(), sinMoto: 0, origen }); delete p.num; delete p.alertado; delete p.motivo; delete p.aprox; delete p.sinPlacaId;
      S.vistas++; avisar('info', nombre(n) + (origen === 'revision' ? ': se encontró una moto ya montada.' : ': llegó una moto.'));
      hAbrir(p, jpeg);
      guardarLectura(p, r);
      guardarFoto();
    };
    const libera = () => { avisar('info', nombre(n) + ': ya no se ve la moto.'); hSalida(p); S.puentes[n - 1] = { n, estado: 'libre' }; S.vistas = Math.max(0, S.vistas - 1); guardar(); return { ok: true, estado: 'libre' }; };
    const modeloBarato = process.env.CAMARA_MODELO_REVISION || 'claude-haiku-5-5';
    // Revisión de zona quieta: cada cierto tiempo se mira la zona igual, por si hay una moto que ya estaba montada
    // o que el detector de movimiento no notó, y para saber si la moto que estaba ya se fue.
    if (opc.revision) {
      if (p.estado !== 'libre' && p.origen !== 'revision' && p.origen !== 'alarma') { guardar(); return { ok: true, estado: p.estado, revision: 'ignorada' }; } // llegó con movimiento del agente: su bajada la avisa el agente
      const rapida = await leer(jpeg, modeloBarato); // primero el modelo barato: ¿hay moto?
      if (p.estado === 'libre') {
        if (rapida.moto !== true) { guardar(); return { ok: true, estado: 'libre', revision: 'sin-moto' }; }
        const r = await leer(jpeg); // hay moto: la placa se lee con el modelo bueno
        if (r.moto !== true) { guardar(); return { ok: true, estado: 'libre', revision: 'sin-moto' }; }
        llegada(r, 'revision'); evaluar(p); guardar();
        return { ok: true, estado: p.estado, placa: p.placa || null, revision: 'moto-encontrada' };
      }
      // Ya marcada por una revisión anterior: si deja de verse dos veces seguidas, se libera.
      // El modelo barato se equivoca a veces con una moto que sí está: antes de contar un "no hay moto" se confirma con el modelo bueno.
      let sinMoto = rapida.moto === false;
      if (sinMoto) { const conf = await leer(jpeg); if (conf.moto !== false) { sinMoto = false; if (!p.placa) guardarLectura(p, conf); } }
      if (sinMoto) { if (++p.sinMoto >= 2) return libera(); } else p.sinMoto = 0;
      // Mientras siga sin placa completa, la revisión también sirve de intento de lectura.
      if (!p.placa && p.intentos < MAX_LECTURAS_LENTAS && rapida.moto !== false) { p.intentos++; p.leidoT = Date.now(); guardarLectura(p, await leer(jpeg)); guardarFoto(); }
      evaluar(p); guardar();
      return { ok: true, estado: p.estado, placa: p.placa || null, revision: 'vigente' };
    }
    if (p.estado === 'libre') {
      if (opc.previo) { const rapida = await leer(jpeg, modeloBarato); if (rapida.moto !== true) { guardar(); return { ok: true, estado: 'libre', motivo: 'no-hay-moto' }; } }
      const r = await leer(jpeg);
      if (r.moto === false) { guardar(); return { ok: true, estado: 'libre', motivo: 'no-hay-moto' }; } // persona, cubeta, manguera…
      llegada(r, opc.origen || 'movimiento');
    } else {
      guardarFoto();
      const toca = p.intentos < MAX_REINTENTOS_LECTURA || (p.intentos < MAX_LECTURAS_LENTAS && Date.now() - (p.leidoT || 0) >= CADA_LECTURA_LENTA);
      if (!p.placa && toca) {
        p.intentos++; p.leidoT = Date.now();
        const r = await leer(jpeg);
        if (r.moto === false) {
          // Dos veces seguidas sin moto: lo que se había tomado por moto ya no está.
          if (++p.sinMoto >= 2) return libera();
        } else { p.sinMoto = 0; guardarLectura(p, r); }
      }
    }
    evaluar(p); guardar();
    return { ok: true, estado: p.estado, placa: p.placa || null };
  }

  // ---------- eventos que manda el agente (RTSP desde un equipo del local) ----------
  async function evento(req, res) {
    if (!tokenValido(req)) return ctx.json(res, 401, { error: 'Clave de cámara incorrecta.' });
    const q = new URL(req.url, 'http://localhost').searchParams;
    const n = Number(q.get('puente')), presente = q.get('presente') === '1';
    if (!Number.isInteger(n) || n < 1 || n > PUENTES) return ctx.json(res, 400, { error: 'Puente no válido.' });
    let jpeg = null;
    if (presente) { try { jpeg = await leerFoto(req); } catch (e) { return ctx.json(res, 400, { error: 'Falta el fotograma (image/jpeg, máx. 3 MB).' }); } if (jpeg.length < 1000) return ctx.json(res, 400, { error: 'Fotograma vacío.' }); }
    else req.resume();
    return ctx.json(res, 200, await procesar(n, presente, jpeg, { revision: q.get('revision') === '1', origen: 'movimiento' }));
  }

  // ---------- la cámara directa: aviso HTTP del evento + foto 4K por FTP ----------
  // Sin agente ni PC en el local: la cámara manda sola (1) un aviso con el tipo y la posición del objetivo y (2) fotos 4K por FTP.
  // El aviso dice "hay algo moviéndose en tal puente"; la foto grande (la primera que llega después) es la que se recorta y se lee.
  const FOTOS4K = path.join(ctx.DATA, 'fotos-4k');
  const ZONAS_ARCHIVO = path.join(ctx.DATA, 'camara-zonas.json');
  const VIDA_FOTO_4K = 3 * 60 * 1000;     // las fotos 4K se borran a los 3 minutos
  const ESPERA_FOTO = 16000;              // máximo que se espera una foto 4K después de un aviso
  const ENFRIAR_LIBRE = 25000;            // si en un puente libre no había moto, no se vuelve a mirar por avisos durante este tiempo
  const MAX_AVISO = 2 * 1024 * 1024;
  fs.mkdirSync(FOTOS4K, { recursive: true });
  const ffmpeg = process.env.FFMPEG || 'ffmpeg';
  const fotos4k = [];                     // más recientes: { t, nombre, ruta }
  const enCurso = {}, enfriar = {}, ultimaFoto = {}; // por puente
  let vistaT = 0;

  // Zonas de los puentes (fracciones de la imagen). Por defecto 4 tiras verticales; se ajustan en data/camara-zonas.json.
  function zonas() {
    let ok = [];
    try { const z = JSON.parse(fs.readFileSync(ZONAS_ARCHIVO, 'utf8')); ok = (Array.isArray(z) ? z : []).filter(x => Number.isInteger(x.puente) && x.puente >= 1 && x.puente <= PUENTES && [x.x, x.y, x.w, x.h].every(v => typeof v === 'number' && v >= 0 && v <= 1 && isFinite(v))); } catch (e) {}
    if (!ok.length) return Array.from({ length: PUENTES - 1 }, (_, i) => ({ puente: i + 1, x: i / (PUENTES - 1), y: 0.15, w: 1 / (PUENTES - 1), h: 0.8 }));
    // La zona extra se pone sola a la izquierda del puente 1 (mismo tamaño) si el archivo no la define.
    const p1 = ok.find(x => x.puente === 1);
    if (!ok.some(x => x.puente === EXTRA) && p1) { const w = p1.w, x = Math.max(0, p1.x - w - 0.01); if (x + w <= p1.x) ok.push({ puente: EXTRA, x: Math.round(x * 1000) / 1000, y: p1.y, w, h: p1.h }); }
    return ok;
  }
  function puenteDe(cx, cy) {
    const zs = zonas(); let mejor = null, dist = Infinity;
    for (const z of zs) {
      if (cx >= z.x && cx <= z.x + z.w && cy >= z.y && cy <= z.y + z.h) return z.puente;
      const d = Math.hypot(cx - (z.x + z.w / 2), cy - (z.y + z.h / 2)); if (d < dist) { dist = d; mejor = z.puente; }
    }
    return dist < 0.2 ? mejor : null; // fuera de toda zona y lejos: se ignora
  }
  // Pasa la imagen por ffmpeg (recorte de una zona o reducción para la vista); sin ffmpeg devuelve null.
  function ffmpegJpeg(entrada, filtro) {
    return new Promise(ok => {
      let p; try { p = require('child_process').spawn(ffmpeg, ['-loglevel', 'error', '-i', 'pipe:0', '-vf', filtro, '-q:v', '3', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1']); } catch (e) { return ok(null); }
      const partes = []; const t = setTimeout(() => p.kill('SIGKILL'), 15000);
      p.stdout.on('data', c => partes.push(c)); p.stdin.on('error', () => {}); p.on('error', () => { clearTimeout(t); ok(null); });
      p.on('close', () => { clearTimeout(t); const b = Buffer.concat(partes); ok(b.length > 1000 ? b : null); });
      p.stdin.end(entrada);
    });
  }
  const cortarZona = (jpeg, z) => ffmpegJpeg(jpeg, 'crop=trunc(iw*' + z.w + '/2)*2:trunc(ih*' + z.h + '/2)*2:trunc(iw*' + z.x + '/2)*2:trunc(ih*' + z.y + '/2)*2');

  // Una foto 4K llegó por FTP.
  function fotoRecibida(nombre, ruta) {
    cambioDeDia(); S.contacto = new Date().toISOString();
    fotos4k.push({ t: Date.now(), nombre, ruta }); while (fotos4k.length > 12) fotos4k.shift();
    // La pantalla de Puentes usa la misma foto, reducida, como vista en vivo (como mucho una cada 8 s).
    if (Date.now() - vistaT >= 8000) {
      vistaT = Date.now();
      fs.readFile(ruta, (e, b) => { if (e) return; ffmpegJpeg(b, 'scale=1280:-2').then(j => { if (!j) return; try { fs.writeFileSync(path.join(FOTOS, 'camara-vista.jpg'), j, { mode: 0o600 }); } catch (x) {} S.vistaT = new Date().toISOString(); S.zonas = zonas(); guardar(); }); });
    }
  }
  // Borra las fotos 4K viejas (la carpeta no crece).
  function limpiar() {
    fs.readdir(FOTOS4K, (e, l) => { if (e) return; for (const f of l) { const r = path.join(FOTOS4K, f); fs.stat(r, (e2, s) => { if (!e2 && Date.now() - s.mtimeMs > VIDA_FOTO_4K) fs.unlink(r, () => {}); }); } });
  }
  const espera = ms => new Promise(r => setTimeout(r, ms));
  // La primera foto 4K llegada desde `desde` (ms), esperando hasta ESPERA_FOTO.
  async function fotoDespuesDe(desde) {
    for (let i = 0; i < ESPERA_FOTO / 500; i++) { const f = fotos4k.find(x => x.t >= desde); if (f) return f; await espera(500); }
    return null;
  }
  // Mira un puente con una foto 4K: recorta su zona y la pasa por el mismo flujo que el agente.
  async function mirarPuente(n, f, opc) {
    let jpeg; try { jpeg = fs.readFileSync(f.ruta); } catch (e) { return null; }
    const z = zonas().find(x => x.puente === n);
    const recorte = z && await cortarZona(jpeg, z);
    return procesar(n, true, recorte || jpeg, opc); // sin ffmpeg se manda el cuadro completo (se lee peor)
  }

  function ficha(xml) { const g = t => { const m = new RegExp('<' + t + '>([^<]*)</' + t + '>', 'i').exec(xml); return m ? m[1].trim() : ''; }; return { tipo: g('eventType'), estado: g('eventState'), objetivo: g('targetType'), x: Number(g('X')), y: Number(g('Y')), w: Number(g('width')), h: Number(g('height')) }; }
  // Separa las partes de un multipart/form-data y devuelve el XML del evento.
  function xmlDelAviso(cuerpo, tipo) {
    const m = /boundary=("?)([^";]+)\1/i.exec(tipo || ''); if (!m) return /xml/i.test(tipo || '') ? cuerpo.toString('utf8') : '';
    const sep = Buffer.from('--' + m[2]); let pos = cuerpo.indexOf(sep);
    while (pos >= 0) {
      const sig = cuerpo.indexOf(sep, pos + sep.length); if (sig < 0) break;
      const trozo = cuerpo.subarray(pos + sep.length, sig), fin = trozo.indexOf('\r\n\r\n');
      if (fin >= 0 && /xml/i.test(trozo.subarray(0, fin).toString('latin1'))) return trozo.subarray(fin + 4).toString('utf8');
      pos = sig;
    }
    return '';
  }
  function avisoValido(req) {
    const t = process.env.CAMARA_TOKEN || '', q = new URL(req.url, 'http://localhost').searchParams.get('t') || '';
    if (t.length < 24 || q.length !== t.length) return false;
    return crypto.timingSafeEqual(Buffer.from(q), Buffer.from(t));
  }
  // POST /api/camara/alarma?t=CAMARA_TOKEN : el "servidor de alarma" de la cámara.
  const dep = (...a) => { if (process.env.CAMARA_DEPURAR) console.log('camara:', ...a); };
  async function alarma(req, res) {
    if (!avisoValido(req)) { req.resume(); return ctx.json(res, 401, { error: 'Clave de cámara incorrecta.' }); }
    const partes = []; let n = 0, grande = false;
    await new Promise(ok => { req.on('data', c => { n += c.length; if (n > MAX_AVISO) grande = true; else partes.push(c); }); req.on('end', ok); req.on('error', ok); });
    if (grande) return ctx.json(res, 413, { error: 'Aviso demasiado grande.' });
    ctx.json(res, 200, { ok: true }); // la cámara no espera: el trabajo sigue aparte
    const llego = Date.now();
    try {
      const e = ficha(xmlDelAviso(Buffer.concat(partes), req.headers['content-type']));
      cambioDeDia(); S.contacto = new Date().toISOString();
      dep('aviso', JSON.stringify(e));
      if (e.tipo && !/VMD|linedetection|fielddetection|regionEntrance|ANPR|vehicle/i.test(e.tipo)) return; // solo eventos de movimiento/inteligentes
      if (e.estado && !/active/i.test(e.estado)) return;
      if (![e.x, e.y, e.w, e.h].every(isFinite) || e.w <= 0) return;
      const pn = puenteDe(e.x + e.w / 2, e.y + e.h / 2); dep('puente', pn); if (!pn) return;
      if (enCurso[pn] || Date.now() < (enfriar[pn] || 0)) { dep('puente', pn, 'ocupado o en enfriamiento'); return; } // ya se está atendiendo este puente, o hace poco no había moto
      enCurso[pn] = true;
      try {
        const f = await fotoDespuesDe(llego - 1000);
        if (!f) { avisar('info', nombre(pn) + ': hubo movimiento pero no llegó la foto 4K.'); guardar(); return; }
        dep('foto', f.nombre, 'tras', Date.now() - llego, 'ms');
        if (ultimaFoto[pn] === f.nombre) return; // ya se miró esta misma foto
        ultimaFoto[pn] = f.nombre;
        const r = await mirarPuente(pn, f, { previo: true, origen: 'alarma' });
        dep('resultado', JSON.stringify(r));
        if (r && r.motivo === 'no-hay-moto') enfriar[pn] = Date.now() + ENFRIAR_LIBRE;
      } finally { enCurso[pn] = false; }
    } catch (e) { console.error('camara alarma:', e.message); }
  }

  // Revisión periódica con la última foto 4K: encuentra motos que ya estaban montadas (puentes libres, cada CAMARA_REVISION_SEG, 300 por defecto)
  // y libera los puentes cuando la moto se va (puentes ocupados, cada CAMARA_REVISION_OCUPADOS_SEG, 60 por defecto; con el modelo barato).
  async function revisar(ocupados) {
    const f = fotos4k[fotos4k.length - 1]; if (!f || Date.now() - f.t > 60000) return; // sin foto reciente no hay nada que mirar
    for (let n = 1; n <= PUENTES; n++) {
      if (enCurso[n] || (S.puentes[n - 1].estado !== 'libre') !== ocupados) continue; enCurso[n] = true;
      try { await mirarPuente(n, f, { revision: true, origen: 'alarma' }); } catch (e) { console.error('camara revision:', e.message); } finally { enCurso[n] = false; }
    }
  }
  const segundos = (v, def) => v === undefined ? def : Number(v);
  const revLibres = segundos(process.env.CAMARA_REVISION_SEG, 300), revOcupados = segundos(process.env.CAMARA_REVISION_OCUPADOS_SEG, 60);
  setInterval(limpiar, 60000).unref();
  if (revLibres > 0) setInterval(() => revisar(false).catch(() => {}), revLibres * 1000).unref();
  if (revOcupados > 0) setInterval(() => revisar(true).catch(() => {}), revOcupados * 1000).unref();

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
    S.puentes.forEach(evaluar); try { hSync(); } catch (e) {}
    return { dia: S.dia, vistas: S.vistas, contacto: S.contacto || null, vista: S.vistaT ? { t: S.vistaT, zonas: S.zonas || [] } : null, puentes: S.puentes.map(p => Object.assign({}, p, { foto: p.estado !== 'libre' })), log: S.log.slice(0, 30), ahora: new Date().toISOString() };
  }
  function foto(n) { try { return fs.readFileSync(path.join(FOTOS, 'camara-puente-' + Number(n) + '.jpg')); } catch (e) { return null; } }

  return { evento, vista, fotoVista, publico, foto, historial, marcarReal, fotoHist, alarma, fotoRecibida, leerPlaca, FOTOS4K, PUENTES };
}

module.exports = { crear };
