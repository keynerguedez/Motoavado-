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
const nombre = n => n === EXTRA ? 'Zona fuera del puente' : 'Puente ' + n;
const ESPERA_BAJADA_MIN = 15;   // minutos que tiene una moto que ya bajó para que la facturen (el cliente puede pagar al terminar) antes de la alerta
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

  const vacio = () => ({ puentes: Array.from({ length: PUENTES }, (_, i) => ({ n: i + 1, estado: 'libre' })), log: [], dia: '', vistas: 0, cruces: [] });
  let S = vacio();
  try { const d = JSON.parse(fs.readFileSync(ESTADO, 'utf8')); if (d && Array.isArray(d.puentes) && d.puentes.length === PUENTES - 1) d.puentes.push({ n: EXTRA, estado: 'libre' }); if (d && Array.isArray(d.puentes) && d.puentes.length === PUENTES) S = d; } catch (e) {}
  if (!Array.isArray(S.cruces)) S.cruces = [];
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
  const RELEER_MS = Number(process.env.CAMARA_RELEER_MS) || 5 * 60e3;
  const MISMA_MOTO_MS = 10 * 60e3;
  function hAbrir(p, jpeg) {
    let ult = null; for (let i = H.length - 1; i >= 0; i--) if (H[i].puente === p.n) { ult = H[i]; break; }
    if (ult && ult.salida && !ult.noReusar && Date.now() - Date.parse(ult.salida) < MISMA_MOTO_MS && ult.dia === ctx.fechaCaracas(new Date())) {
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
    try { hTarde(); } catch (e) {}
    hGuardar();
  }
  // Al bajar una moto sin factura (que estuvo montada más de MIN_GRACIA minutos) no hay alerta todavía: queda "esperando factura" ESPERA_BAJADA_MIN minutos.
  function hSalida(p) {
    const e = p && p.hid && H.find(x => x.id === p.hid); if (!e || e.salida) return;
    e.salida = new Date().toISOString(); hSucio = true;
    if ((p.estado === 'esperando' || p.estado === 'lavando') && (Date.now() - new Date(p.desde || e.llegada).getTime()) / 60000 >= MIN_GRACIA) e.estado = 'espera';
  }
  // Venta de hoy que corresponde a una fila del historial (misma placa, lectura parcial compatible o factura "sin placa"), hecha después de su llegada.
  function ventaDeFila(e, vs, usadas) {
    const desde = vs.filter(x => String(x.fecha || '') >= e.llegada && !usadas.has(x.num));
    if (e.placa) return desde.find(x => limpiarPlaca(x.placa) === limpiarPlaca(e.placa)) || null;
    if (e.parcial) { const m = desde.filter(x => parcialSuave(e.parcial, limpiarPlaca(x.placa))); return m.length === 1 ? m[0] : null; }
    return desde.find(x => x.sinPlaca) || null;
  }
  // Una moto que bajó sin factura y se factura después queda "facturada después"; si pasan ESPERA_BAJADA_MIN minutos sin factura, salta la alerta.
  function hTarde() {
    const hoy = ctx.fechaCaracas(new Date()); let vs = null, usadas = null;
    H.forEach(e => {
      if (e.dia !== hoy || !e.salida || (e.estado !== 'alerta' && e.estado !== 'espera')) return;
      vs = vs || ctx.ventasDeHoy(); usadas = usadas || new Set(H.filter(x => x.dia === hoy && x.num != null).map(x => x.num));
      const v = ventaDeFila(e, vs, usadas);
      if (v) { e.estado = 'tarde'; e.num = v.num; usadas.add(v.num); hSucio = true; return; }
      if (e.estado === 'espera' && Date.now() - Date.parse(e.salida) >= ESPERA_BAJADA_MIN * 60e3) {
        e.estado = 'alerta'; hSucio = true;
        avisar('bad', nombre(e.puente) + ': la moto ' + (e.placa || e.parcial || 'sin placa legible') + ' bajó hace ' + ESPERA_BAJADA_MIN + ' min y no tiene factura.');
      }
    });
  }
  function historial(dia) {
    try { hTarde(); hGuardar(); } catch (e) {}
    const hoy = ctx.fechaCaracas(new Date()), d = /^\d{4}-\d{2}-\d{2}$/.test(dia || '') ? dia : hoy;
    // Fuera del puente solo cuentan las motos con placa legible (formato de placa); lo que se guardó antes sin placa en esa zona no se muestra.
    const items = H.filter(e => e.dia === d && !(e.puente === EXTRA && !e.placa && !e.parcial)).slice().reverse();
    const r = { total: items.length, completa: 0, parcial: 0, ilegible: 0, verificadas: 0, sinFactura: 0, tarde: 0, espera: 0, esperando: 0, conReal: 0, aciertos: 0 };
    items.forEach(e => {
      if (e.placa) r.completa++; else if (e.parcial) r.parcial++; else r.ilegible++;
      if (e.estado === 'ok') r.verificadas++; else if (e.estado === 'alerta') r.sinFactura++; else if (e.estado === 'tarde') r.tarde++; else if (e.estado === 'espera') r.espera++; else r.esperando++;
      if (e.real) { r.conReal++; const real = limpiarPlaca(e.real); if (real && (limpiarPlaca(e.placa) === real || (e.parcial && coincideParcial(e.parcial, real)))) r.aciertos++; }
    });
    return { dia: d, hoy, resumen: r, items: items.slice(0, 200).map(e => Object.assign({}, e, { foto: '/api/camara/hist/' + e.id + '.jpg' })) };
  }
  function coincideParcial(parcial, real) { const nucleo = parcial.replace(/\?+$/, ''), abierta = nucleo.length < parcial.length; return (abierta ? real.length >= nucleo.length : real.length === nucleo.length) && [...nucleo].every((c, i) => c === '?' || c === real[i]); }
  function marcarReal(id, real) { const e = H.find(x => x.id === String(id)); if (!e) return false; e.real = limpiarPlaca(real).slice(0, 10); hSucio = true; hGuardar(); return true; }
  function fotoHist(id) { if (!/^[a-z0-9]{6,20}$/.test(String(id))) return null; try { return fs.readFileSync(path.join(HFOTOS, id + '.jpg')); } catch (e) { return null; } }
  function avisar(kind, txt) { S.log.unshift({ t: new Date().toISOString(), kind, txt }); S.log.length = Math.min(S.log.length, MAX_LOG); }
  function cambioDeDia() { const d = ctx.fechaCaracas(new Date()); if (S.dia !== d) { S.dia = d; S.vistas = 0; S.autorev = {}; } }

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

  // Consumo de la API: cada respuesta trae `usage` (tokens); se registra con la función que hizo la llamada (ver server/consumo.js).
  function usoApi(funcion, modelo, texto) {
    if (!ctx.registrarUso) return;
    try { let j = null; try { j = JSON.parse(texto); } catch (e) {} ctx.registrarUso({ funcion, modelo: (j && j.model) || modelo, usage: (j && j.usage) || null }); } catch (e) {}
  }

  // ---------- lectura de la imagen: ¿hay moto? ¿qué placa? ----------
  // moto: true/false lo dice el modelo; null = no se pudo saber (sin clave o error), y entonces se confía en el agente.
  // Una placa completa del modelo bueno solo se acepta si una segunda lectura de la misma foto da exactamente lo mismo;
  // si no coinciden se guarda como lectura parcial (los caracteres iguales y "?" en los que difieren). Evita placas inventadas.
  function confirmar(r, r2) {
    if (r2 && r2.placa === r.placa) return r;
    let parcial = '';
    if (r2 && r2.placa && r2.placa.length === r.placa.length) parcial = limpiarParcial([...r.placa].map((c, i) => c === r2.placa[i] ? c : '?').join(''));
    return { moto: r.moto, placa: '', parcial, motivo: parcial ? 'parcial' : 'ilegible' };
  }
  // Recorte de la placa (con margen) ampliado, para que se vean mejor los caracteres. Sin ffmpeg o sin caja devuelve null.
  async function ampliar(jpeg, caja) {
    if (!caja) return null;
    const x = Math.max(0, caja.x - caja.w * 0.35), y = Math.max(0, caja.y - caja.h * 0.6), w = Math.min(1 - x, caja.w * 1.7), h = Math.min(1 - y, caja.h * 2.2);
    return ffmpegJpeg(jpeg, 'crop=iw*' + w.toFixed(4) + ':ih*' + h.toFixed(4) + ':iw*' + x.toFixed(4) + ':ih*' + y.toFixed(4) + ',scale=min(1000\\,iw*6):-2:flags=lanczos,unsharp=5:5:0.8');
  }
  // Lectura con el modelo bueno: la placa se confirma con OTRA vista (el recorte ampliado de la placa), no con la misma imagen leída dos veces.
  async function leerConfirmada(jpeg, f) {
    const a = await f(jpeg);
    if (!a || a.moto !== true) return a;
    const zoom = a.caja ? await ampliar(jpeg, a.caja) : null, solo = { placaSolo: true };
    if (a.placa) return confirmar(a, await (zoom ? f(zoom, undefined, solo) : f(jpeg)));
    if (!zoom) return a;
    const b = await f(zoom, undefined, solo);
    if (b && b.placa) {
      if (a.parcial && coincideParcial(a.parcial, b.placa)) return { moto: true, placa: b.placa }; // lo que se veía a medias encaja con lo ampliado
      const c = await f(zoom, undefined, solo); // sin parcial previo: dos lecturas del recorte ampliado
      return c && c.placa === b.placa ? { moto: true, placa: b.placa } : confirmar({ moto: true, placa: b.placa }, c || {});
    }
    const mejor = b && b.parcial && conocidos(b.parcial) > conocidos(a.parcial) ? b.parcial : a.parcial;
    return { moto: true, placa: '', parcial: mejor || '', motivo: mejor ? 'parcial' : 'ilegible' };
  }
  const leer = async (jpeg, modelo) => {
    const f = ctx.leerPlaca || leerPlaca;
    if (modelo) return f(jpeg, modelo);
    return leerConfirmada(jpeg, f);
  };
  // ¿Esta placa completa encaja con la placa (o lectura parcial) que ya tiene el puente?
  function encajaPuente(pl, p) {
    if (p.placa) return pl === p.placa;
    if (!p.parcial) return true;
    const nucleo = p.parcial.replace(/\?+$/, ''), abierta = nucleo.length < p.parcial.length;
    return (abierta ? pl.length >= nucleo.length : pl.length === nucleo.length) && [...nucleo].every((c, i) => c === '?' || c === pl[i]);
  }
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
  function leerPlaca(jpeg, modeloForzado, opc) {
    opc = opc || {};
    const clave = process.env.ANTHROPIC_API_KEY;
    if (!clave) return Promise.resolve({ moto: null, placa: '', motivo: 'sin-lector' });
    const modelo = modeloForzado || process.env.CAMARA_MODELO || 'claude-sonnet-5-5';
    // max_tokens holgado: si el modelo piensa antes de responder, esos tokens salen del mismo cupo y con uno corto el texto llega vacío.
    // Haiku piensa por defecto y admite apagarlo; los demás modelos rechazan ese parámetro, así que solo se manda a Haiku.
    const cuerpo = JSON.stringify(Object.assign({
      model: modelo, max_tokens: 1500,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpeg.toString('base64') } },
        { type: 'text', text: opc.placaSolo ? 'Esta imagen es un recorte ampliado de la placa de una moto venezolana. Responde solo JSON: {"placa":"ABC123","segura":true}. "placa" son los 6 a 8 letras y números de la placa; si no estás seguro de cada carácter, deja "placa":"" y "segura":false, y en "parcial" escribe los que sí distingues con "?" en los dudosos (ejemplo: {"placa":"","segura":false,"parcial":"AR8U65?"}). Fíjate bien en M/H, 8/B, 0/O/D, 5/S, 1/I y 2/Z. Nunca inventes un carácter que no se vea.' : (process.env.CAMARA_PRUEBA === '1' ? 'MODO DE PRUEBA: un cartón o papel con una placa escrita cuenta como la moto (moto:true). ' : '') + 'Es una foto de una rampa de un lavadero de motos. Responde solo JSON: {"moto":true,"placa":"ABC123","segura":true}. "moto" es true solo si ves una moto sobre la rampa (aunque esté a medias, mojada o sin placa visible); es false si solo hay personas, cubetas, mangueras, herramientas, el piso o la rampa vacía. "placa" es la placa venezolana (6 a 8 letras y números); si no se ve completa o no estás seguro de cada carácter, deja "placa":"" y "segura":false, y en "parcial" escribe los caracteres que sí distingues, en su posición, con "?" en cada uno que no ves o no estás seguro (ejemplo: {"moto":true,"placa":"","segura":false,"parcial":"AB1C??"}). Nunca inventes un carácter que no se vea. Si la moto no tiene placa o está tapada, deja "placa":"" y "parcial":""; no tomes números de otras motos, cascos, carteles, ropa o calcomanías. Además añade "caja": el rectángulo donde está la placa, como fracciones del ancho y alto de la imagen, {"x":0.42,"y":0.55,"w":0.12,"h":0.05} (x e y son la esquina superior izquierda), o null si no la ves. Añade también "cortada": true si lo que ves de la moto está cortado por el borde de la imagen (solo un trozo de una moto que está fuera de la rampa), o false si la moto aparece entera sobre la rampa.' }] }],
    }, /haiku/.test(modelo) ? { thinking: { type: 'disabled' } } : {}));
    return new Promise(ok => {
      const r = https.request({ hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST', timeout: 20000,
        headers: { 'content-type': 'application/json', 'x-api-key': clave, 'anthropic-version': '2023-06-01', 'content-length': Buffer.byteLength(cuerpo) } }, res => {
        let t = ''; res.on('data', c => { t += c; });
        res.on('end', () => {
          usoApi(opc.placaSolo ? 'lectura-ampliada' : /haiku/.test(modelo) ? 'moto-haiku' : 'lectura-placa', modelo, t);
          try {
            const txt = (JSON.parse(t).content || []).map(x => x.text || '').join('');
            const j = JSON.parse(/\{[\s\S]*\}/.exec(txt)[0]);
            const placa = limpiarPlaca(j.placa), moto = opc.placaSolo ? true : j.moto === true ? true : j.moto === false ? false : null;
            const cortada = j.cortada === true;
            const cj = j.caja, caja = cj && [cj.x, cj.y, cj.w, cj.h].every(v => typeof v === 'number' && v >= 0 && v <= 1) && cj.w > 0.01 && cj.h > 0.01 ? { x: cj.x, y: cj.y, w: cj.w, h: cj.h } : null;
            if (moto === false) return ok({ moto: false, placa: '', motivo: 'no-hay-moto' });
            if (j.segura === true && /^[A-Z0-9]{5,8}$/.test(placa)) return ok({ moto, placa, caja, cortada });
            const parcial = limpiarParcial(j.parcial);
            ok({ moto, placa: '', parcial, motivo: parcial ? 'parcial' : 'ilegible', caja, cortada });
          } catch (e) { ok({ moto: null, placa: '', motivo: 'error' }); }
        });
      });
      r.on('error', () => ok({ moto: null, placa: '', motivo: 'error' })); r.on('timeout', () => { r.destroy(); ok({ moto: null, placa: '', motivo: 'error' }); });
      r.end(cuerpo);
    });
  }

  // ---------- cruce de la foto del encargado con la foto del puente ----------
  // Dos fotos a Claude: ¿es la misma moto? Se comparan color, tipo, accesorios… no las personas ni el fondo.
  function compararFotos(a, b) {
    const clave = process.env.ANTHROPIC_API_KEY;
    if (!clave) return Promise.resolve({ misma: null });
    const img = j => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: j.toString('base64') } });
    const cuerpo = JSON.stringify({ model: process.env.CAMARA_MODELO || 'claude-sonnet-5-5', max_tokens: 1500, messages: [{ role: 'user', content: [
      { type: 'text', text: 'Foto 1 (la tomó el encargado al registrar la moto):' }, img(a), { type: 'text', text: 'Foto 2 (cámara fija sobre el puente de lavado):' }, img(b),
      { type: 'text', text: 'Son de un lavadero de motos. ¿La moto de la foto 1 es la misma que la moto montada en el puente de la foto 2? Compara color, tipo, marca, maletas, carenado, accesorios y estado; ignora personas, fondo y luz. Responde solo JSON: {"misma":true,"confianza":"alta","motivo":"frase corta"}. "misma" es true, false, o null si no puedes saberlo; "confianza" es "alta", "media" o "baja"; "motivo" es una frase de menos de 20 palabras con lo que viste (qué coincide o qué difiere).' }] }] });
    return new Promise(ok => {
      const r = https.request({ hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST', timeout: 30000,
        headers: { 'content-type': 'application/json', 'x-api-key': clave, 'anthropic-version': '2023-06-01', 'content-length': Buffer.byteLength(cuerpo) } }, res => {
        let t = ''; res.on('data', c => { t += c; });
        res.on('end', () => { usoApi('comparar-fotos', process.env.CAMARA_MODELO || 'claude-sonnet-5-5', t); try { const txt = (JSON.parse(t).content || []).map(x => x.text || '').join(''); const j = JSON.parse(/\{[\s\S]*\}/.exec(txt)[0]); ok({ misma: j.misma === true ? true : j.misma === false ? false : null, confianza: ['alta', 'media', 'baja'].includes(j.confianza) ? j.confianza : 'baja', motivo: String(j.motivo || '').slice(0, 200) }); } catch (e) { ok({ misma: null }); } });
      });
      r.on('error', () => ok({ misma: null })); r.on('timeout', () => { r.destroy(); ok({ misma: null }); });
      r.end(cuerpo);
    });
  }
  const comparar = (a, b) => (ctx.compararFotos || compararFotos)(a, b);
  // Registro de cada cruce (con las fotos comparadas y lo que dijo Claude) para que el dueño valide si acertó.
  const CRU = path.join(ctx.DATA, 'camara-cruces.json'), CFOTOS = path.join(FOTOS, 'cruce');
  fs.mkdirSync(CFOTOS, { recursive: true });
  let C = []; try { C = JSON.parse(fs.readFileSync(CRU, 'utf8')); if (!Array.isArray(C)) C = []; } catch (e) {}
  function cGuardar() { try { const tmp = CRU + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(C), { mode: 0o600 }); fs.renameSync(tmp, CRU); } catch (e) { console.error('camara cruces:', e.message); } }
  function cNuevo(v, origen, comps, tipo, puente, extra) {
    const id = Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
    const cs = comps.map(x => { const nf = id + '-p' + x.p.n + '.jpg'; try { fs.writeFileSync(path.join(CFOTOS, nf), x.foto, { mode: 0o600 }); } catch (e) {} return { puente: x.p.n, misma: x.r.misma, confianza: x.r.confianza || null, motivo: x.r.motivo || '', foto: nf }; });
    C.unshift(Object.assign({ id, t: new Date().toISOString(), origen, venta: { id: v.id, num: v.num, placa: v.placa || '', sinPlaca: !!v.sinPlaca }, comps: cs, tipo, puente: puente || null, valido: null }, extra || {}));
    // Un cruce bueno deja la factura marcada como validada (queda en la propia factura, aunque el registro de cruces se recorte).
    if (['coincide', 'enlazada', 'manual'].includes(tipo) && ctx.marcarValidada) { try { ctx.marcarValidada(v.id, { tipo, t: new Date().toISOString(), por: (extra && extra.por) || 'cámara' }); } catch (e) {} }
    while (C.length > 100) { const x = C.pop(); x.comps.forEach(k => { try { fs.unlinkSync(path.join(CFOTOS, k.foto)); } catch (e) {} }); }
    cGuardar();
  }
  const ventasValidadas = () => new Set(C.filter(x => ['coincide', 'enlazada', 'manual'].includes(x.tipo) && x.valido !== false).map(x => x.venta.id));
  const cruces = () => { const v = C.filter(x => x.valido !== null); return { resumen: { total: C.length, validados: v.length, acertó: v.filter(x => x.valido === true).length }, items: C.slice(0, 50).map(x => Object.assign({}, x, { fotoVenta: '/api/camara/cruce-venta/' + x.venta.id + '.jpg', comps: x.comps.map(k => Object.assign({}, k, { url: '/api/camara/cruce/' + k.foto })) })) }; };
  function validarCruce(id, ok) { const e = C.find(x => x.id === String(id)); if (!e) return false; e.valido = ok === true ? true : ok === false ? false : null; cGuardar(); return true; }
  const fotoCruce = nombre => /^[a-z0-9]+-p[1-5]\.jpg$/.test(String(nombre)) ? (() => { try { return fs.readFileSync(path.join(CFOTOS, nombre)); } catch (e) { return null; } })() : null;
  const fotoVentaId = id => /^[a-f0-9]{6,20}$/.test(String(id)) ? fotoVenta(id) : null;
  const fotoVenta = id => { try { return fs.readFileSync(path.join(FOTOS, 'venta', id + '.jpg')); } catch (e) { return null; } };
  const fotoPuente = n => { try { return fs.readFileSync(path.join(FOTOS, 'camara-puente-' + n + '.jpg')); } catch (e) { return null; } };
  const buena = r => r && r.misma === true && r.confianza !== 'baja';
  const pendiente = v => { S.cruces = S.cruces.filter(c => c.id !== v.id); S.cruces.unshift({ id: v.id, num: v.num, placa: v.placa || '', t: Date.now() }); S.cruces.length = Math.min(S.cruces.length, 5); guardar(); };
  // La foto del encargado SOLO se compara con la moto del puente cuya placa coincide con la de la factura (placa completa o lectura parcial compatible).
  // Se acepta: la misma placa, una que difiera en un solo carácter (la cámara a veces se come o confunde uno; las fotos confirman), una lectura parcial compatible,
  // o un puente que el sistema ya enlazó con esa factura (estado ok con su número).
  const cerca = (a, b) => {
    if (a === b) return true; if (Math.abs(a.length - b.length) > 1 || Math.min(a.length, b.length) < 6) return false;
    let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return a.slice(i + 1) === b.slice(i + 1) || a.slice(i + 1) === b.slice(i) || a.slice(i) === b.slice(i + 1);
  };
  // Caracteres que la cámara confunde entre sí (0/O/D/Q, 1/I/L, 5/S, 8/B, 2/Z, 6/G): solo para decidir qué lecturas se comparan con una factura; las fotos validan después.
  const PARECIDOS = { O: '0', Q: '0', D: '0', I: '1', L: '1', S: '5', B: '8', Z: '2', G: '6' };
  const suave = x => [...String(x)].map(c => PARECIDOS[c] || c).join('');
  const cercaSuave = (a, b) => cerca(suave(a), suave(b));
  const parcialSuave = (parcial, placa) => coincideParcial(suave(parcial), suave(placa));
  const encajaVenta = (p, placa, v) => p.estado !== 'libre' && ((p.estado === 'ok' && v && p.num === v.num) || (p.placa && cercaSuave(p.placa, placa)) || (!p.placa && p.parcial && parcialSuave(p.parcial, placa)));
  // Compara las dos fotos y lo registra: 'coincide' (misma moto), 'distinta' (misma placa pero otra moto: alerta) o 'duda'.
  async function verificar(v, jpeg, cands, origen) {
    const comps = (await Promise.all(cands.map(async p => { const f = fotoPuente(p.n); return f ? { p, r: await comparar(jpeg, f), foto: f } : null; }))).filter(Boolean);
    if (!comps.length) return null;
    const si = comps.filter(x => buena(x.r)), no = comps.filter(x => x.r && x.r.misma === false && x.r.confianza !== 'baja');
    const tipo = si.length ? 'coincide' : no.length ? 'distinta' : 'duda', p = (si[0] || no[0] || comps[0]).p;
    cNuevo(v, origen, comps, tipo, tipo === 'duda' ? null : p.n);
    if (tipo === 'coincide') { p.cruce = true; avisar('ok', nombre(p.n) + ': la foto del encargado coincide con la moto del puente (#' + v.num + ').'); }
    else if (tipo === 'distinta') avisar('bad', nombre(p.n) + ': la foto de la factura #' + v.num + ' (' + (v.placa || '') + ') NO coincide con la moto del puente, aunque la placa es igual o casi igual.');
    if (tipo !== 'duda') S.cruces = S.cruces.filter(c => c.id !== v.id);
    guardar();
    return { puente: p.n, misma: tipo === 'coincide' ? true : tipo === 'distinta' ? false : null };
  }
  // Al registrar una moto: se guarda su foto y, si ya hay un puente con esa placa, se comparan las dos fotos; si no, queda pendiente.
  async function cruzar(v, jpeg) {
    cambioDeDia();
    try { fs.mkdirSync(path.join(FOTOS, 'venta'), { recursive: true }); fs.writeFileSync(path.join(FOTOS, 'venta', v.id + '.jpg'), jpeg, { mode: 0o600 }); } catch (e) {}
    const placa = limpiarPlaca(v.placa);
    if (!placa) return { puente: null, sinPlaca: true };
    const cands = S.puentes.filter(p => encajaVenta(p, placa, v));
    const r = cands.length ? await verificar(v, jpeg, cands, 'registro') : null;
    if (r) return r;
    pendiente(v); return { puente: null, pendiente: true };
  }
  // Cada revisión de un puente con placa leída: si hay fotos de encargado pendientes con esa placa, se comparan con la moto del puente.
  async function cruzarPuente(p, jpeg) {
    const lim = Date.now() - 3 * 3600e3;
    S.cruces = S.cruces.filter(c => c.t > lim);
    p.cruceT = Date.now();
    for (const c of S.cruces.slice(0, 3)) {
      const v = ctx.ventasDeHoy().find(x => x.id === c.id), f = fotoVenta(c.id), placa = v && limpiarPlaca(v.placa);
      if (!v || !f || !placa || !encajaVenta(p, placa, v)) continue;
      const r = await verificar(v, f, [p], 'revisión'); if (r) return true;
    }
    return false;
  }

  // Revalida una factura de hoy. 1) Compara la foto del encargado con las lecturas del historial de hoy cuya placa sea igual, casi igual (también con caracteres parecidos), parcial compatible
  // o ya enlazada a esa factura. 2) Si no hay ninguna o ninguna coincide, busca entre TODAS las fotos de la cámara guardadas hoy (historial y cruces), por si la fila de esa moto se reescribió.
  function vincularFila(e, v) {
    if (e && (e.num == null || e.num === v.num)) { e.num = v.num; if (e.estado === 'alerta' || e.estado === 'espera') e.estado = e.salida ? 'tarde' : 'ok'; hSucio = true; hGuardar(); }
  }
  async function revalidar(v, opc) {
    opc = opc || {}; const org = opc.origen || 'revalidación';
    const jpeg = fotoVenta(v.id); if (!jpeg) return { error: 'Esa factura no tiene foto del encargado.' };
    const placa = limpiarPlaca(v.placa);
    const hoy = ctx.fechaCaracas(new Date());
    const filas = placa ? H.filter(e => e.dia === hoy && (e.num === v.num || (e.placa && cercaSuave(limpiarPlaca(e.placa), placa)) || (!e.placa && e.parcial && parcialSuave(e.parcial, placa)))).reverse().slice(0, 3) : [];
    const vistas = new Set(); let comparadas = 0, prev = [];
    if (filas.length) {
      const comps = (await Promise.all(filas.map(async e => { const f = fotoHist(e.id); vistas.add(e.id); return f ? { e, p: { n: e.puente }, r: await comparar(jpeg, f), foto: f } : null; }))).filter(Boolean);
      comparadas += comps.length; prev = comps;
      const si = comps.filter(x => buena(x.r));
      if (si.length) { const m = si[0]; cNuevo(v, org, comps, 'coincide', m.p.n); vincularFila(m.e, v); S.cruces = S.cruces.filter(c => c.id !== v.id); guardar(); return { ok: true, tipo: 'coincide', puente: m.p.n, comparadas }; }
    }
    // Solo con las lecturas de esa placa (lo barato): si no coincide, no se buscan más fotos.
    if (opc.soloPlaca) {
      const no0 = prev.filter(x => x.r && x.r.misma === false && x.r.confianza !== 'baja');
      if (no0.length) { cNuevo(v, org, prev, 'distinta', no0[0].p.n); return { ok: true, tipo: 'distinta', puente: no0[0].p.n, comparadas }; }
      return { ok: true, tipo: 'ninguna', comparadas, soloPlaca: true };
    }
    // 2) todas las fotos de hoy
    const cand = H.filter(e => e.dia === hoy && !vistas.has(e.id)).map(e => ({ t: Date.parse(e.salida || e.llegada), e, p: { n: e.puente }, leer: () => fotoHist(e.id) }));
    const vf = new Set();
    C.filter(x => ctx.fechaCaracas(new Date(x.t)) === hoy).forEach(x => x.comps.forEach(k => { if (!vf.has(k.foto)) { vf.add(k.foto); cand.push({ t: Date.parse(x.t), p: { n: k.puente }, leer: () => fotoCruce(k.foto) }); } }));
    // Las más cercanas en el tiempo a la factura primero: la moto estaba en el puente cuando la facturaron.
    const t0 = Date.parse(v.fecha) || Date.now(); cand.sort((a, b) => Math.abs(a.t - t0) - Math.abs(b.t - t0));
    const lista = cand.slice(0, 24); let m = null;
    for (let i = 0; i < lista.length && !m; i += 4) {
      const lote = (await Promise.all(lista.slice(i, i + 4).map(async c => { const f = c.leer(); return f ? Object.assign({ foto: f }, c, { r: await comparar(jpeg, f) }) : null; }))).filter(Boolean);
      comparadas += lote.length;
      m = lote.find(x => buena(x.r) && x.r.confianza === 'alta') || null;
    }
    if (m) {
      cNuevo(v, org + ' (todas las fotos)', [m], 'coincide', m.p.n); vincularFila(m.e, v);
      S.cruces = S.cruces.filter(c => c.id !== v.id); guardar(); return { ok: true, tipo: 'coincide', puente: m.p.n, comparadas };
    }
    const no = prev.filter(x => x.r && x.r.misma === false && x.r.confianza !== 'baja');
    if (no.length) { cNuevo(v, org, prev, 'distinta', no[0].p.n); return { ok: true, tipo: 'distinta', puente: no[0].p.n, comparadas }; }
    if (!comparadas) return { error: 'La cámara no tiene fotos de hoy para comparar.' };
    return { ok: true, tipo: 'ninguna', comparadas };
  }
  // Revalidación automática: cada minuto el sistema reintenta validar solo las facturas de hoy cobradas con foto del encargado y sin cruce válido.
  // Intento 1 (a los 2 min de la factura): solo las lecturas de esa placa, barato. Intentos 2 y 4 (+5 y +45 min): buscan en todas las fotos del día. Tope de 4 intentos por factura.
  // El gasto por vuelta se limita por comparaciones de fotos (COMPARACIONES_POR_VUELTA), no por facturas: un intento que no compara nada es gratis y no frena a los demás.
  // Termina al coincidir, al salir "otra moto" (queda a revisión del dueño) o si no hay foto; lo demás lo resuelve el dueño con "Validar a ojo".
  const ESPERAS_AUTO = [5, 15, 45], COMPARACIONES_POR_VUELTA = 6; let autoCorriendo = false;
  async function autoRevalidar() {
    if (autoCorriendo) return { corrida: false }; autoCorriendo = true;
    const hechos = []; let gastadas = 0;
    try {
      S.autorev = S.autorev || {};
      const val = ventasValidadas(), ahora = Date.now();
      const pendientes = ctx.ventasDeHoy().filter(v => v.estado !== 'pendiente' && !v.validada && !val.has(v.id) && fotoVenta(v.id));
      for (const v of pendientes) {
        if (gastadas >= COMPARACIONES_POR_VUELTA || hechos.length >= 40) break;
        const a = S.autorev[v.id] || { n: 0, t: 0 };
        if (a.fin) continue;
        const toca = a.n === 0 ? ahora >= Date.parse(v.fecha) + 2 * 60e3 : ahora >= a.t + ESPERAS_AUTO[Math.min(a.n - 1, 2)] * 60e3;
        if (!toca) continue;
        const r = await revalidar(v, { soloPlaca: !(a.n === 1 || a.n === 3), origen: 'automática' });
        a.n++; a.t = Date.now();
        if (r.error && /no tiene foto del encargado/.test(r.error)) a.fin = true;
        if (r.ok && (r.tipo === 'coincide' || r.tipo === 'distinta')) a.fin = true;
        if (a.n >= 4) a.fin = true;
        gastadas += r.comparadas || 0; S.autorev[v.id] = a; hechos.push({ num: v.num, tipo: r.tipo || 'error' });
      }
      if (hechos.length) guardar();
    } catch (e) { console.error('camara autorevalidar:', e.message); } finally { autoCorriendo = false; }
    return { corrida: true, hechos };
  }
  const autoSeg = process.env.CAMARA_AUTOREV_SEG === undefined ? 60 : Number(process.env.CAMARA_AUTOREV_SEG);
  if (autoSeg > 0) setInterval(() => autoRevalidar().catch(() => {}), autoSeg * 1000).unref();

  // El dueño valida a ojo una factura cuando la cámara no guardó una foto de esa moto: queda registrado con su nombre y una nota.
  function validarManual(v, nota, quien) {
    nota = String(nota || '').trim().slice(0, 200); if (nota.length < 3) return { error: 'Escribe una nota (por qué la validas a ojo).' };
    cNuevo(v, 'manual', [], 'manual', null, { nota, por: quien, valido: true });
    S.cruces = S.cruces.filter(c => c.id !== v.id); guardar(); return { ok: true };
  }

  // Una moto que llega a un puente justo después de que bajó otra NO es "la misma" por estar en el mismo puente: se reabre la fila anterior solo si la placa leída es compatible
  // con la de esa fila (o, si no hay placa que comparar, si Claude dice que la foto es de la misma moto).
  function compatibles(a, b) {
    if (!a.includes('?') && !b.includes('?')) return cerca(a, b);
    let mal = 0; for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== '?' && b[i] !== '?' && a[i] !== b[i]) mal++;
    return mal <= 1;
  }
  async function otraMoto(n, r, jpeg) {
    let ult = null; for (let i = H.length - 1; i >= 0; i--) if (H[i].puente === n) { ult = H[i]; break; }
    if (!ult || !ult.salida || ult.noReusar || Date.now() - Date.parse(ult.salida) >= MISMA_MOTO_MS || ult.dia !== ctx.fechaCaracas(new Date())) return false; // no se reabriría: ya será una fila nueva
    const viejo = ult.placa || ult.parcial, nuevo = r.placa || r.parcial;
    if (viejo && nuevo) return !compatibles(viejo, nuevo);
    const f = fotoHist(ult.id); if (!f) return false;
    const c = await comparar(f, jpeg); return c.misma === false && c.confianza !== 'baja';
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
    // Moto enlazada a una factura "sin placa" (por la foto o por el orden): si la cámara lee la placa completa y confirmada, la factura la toma.
    const vid = p.sinPlacaId || p.cruceId;
    if (vid && p.placa && p.confirmada && ctx.completarPlaca) {
      const vs = ctx.ventasDeHoy().find(x => x.id === vid);
      if (vs && vs.sinPlaca && !vs.placa && ctx.completarPlaca(vs.id, p.placa)) avisar('info', nombre(p.n) + ': la factura #' + vs.num + ' no tenía placa; la cámara leyó ' + p.placa + ' y se la completó.');
    }
    let v = registrada(p.placa) || (vid && ctx.ventasDeHoy().find(x => x.id === vid)) || null, aprox = false;
    if (!v && !p.placa && p.parcial) { v = registradaParcial(p.parcial); aprox = !!v; }
    // Placa completa que difiere en un solo carácter de UNA sola factura de hoy (la cámara confunde M/H, 0/O…) y que ningún otro puente tiene asignada: se da por registrada como aproximada.
    if (!v && p.placa) {
      const tomadas = new Set(S.puentes.filter(x => x !== p && x.estado === 'ok' && x.num != null).map(x => x.num));
      const cerca1 = ctx.ventasDeHoy().filter(x => x.placa && !tomadas.has(x.num) && limpiarPlaca(x.placa) !== p.placa && cerca(limpiarPlaca(x.placa), p.placa));
      if (cerca1.length === 1) { v = cerca1[0]; aprox = true; }
    }
    // Estaba enlazada a una factura y la lectura ya no encaja (cambió la moto o se corrigió la lectura): vuelve a "esperando" y se reevalúa.
    if (!v && p.estado === 'ok' && p.num != null && !p.sinPlacaId) { avisar('info', nombre(p.n) + ': la moto ya no coincide con la factura #' + p.num + '; se vuelve a evaluar.'); p.estado = 'esperando'; delete p.num; delete p.aprox; }
    if (v) {
      if (p.estado !== 'ok') avisar('ok', nombre(p.n) + ': ' + (aprox ? 'la lectura ' + (p.placa || p.parcial) + ' casi coincide con la moto ' + limpiarPlaca(v.placa) : 'se registró la moto ' + p.placa) + ' (#' + v.num + ').');
      p.estado = 'ok'; p.num = v.num; if (aprox) p.aprox = limpiarPlaca(v.placa); else delete p.aprox; return;
    }
    // Moto sin placa legible: si hoy hay una factura marcada "sin placa" que ningún otro puente tiene asignada, se da por registrada.
    if (!p.placa && !p.parcial) {
      const tomadas = new Set(S.puentes.filter(x => x !== p && (x.sinPlacaId || x.cruceId)).map(x => x.sinPlacaId || x.cruceId));
      const sp = ctx.ventasDeHoy().find(x => x.sinPlaca && !tomadas.has(x.id) && (p.sinPlacaId ? x.id === p.sinPlacaId : true));
      if (sp) { if (p.estado !== 'ok') avisar('ok', nombre(p.n) + ': moto sin placa legible, coincide con la factura sin placa #' + sp.num + '.'); p.estado = 'ok'; p.num = sp.num; p.sinPlacaId = sp.id; return; }
    }
    const min = (Date.now() - new Date(p.desde).getTime()) / 60000;
    // El cliente puede pagar al terminar: mientras la moto sigue montada solo se marca "en lavado, sin factura"; la alerta salta si baja y pasan ESPERA_BAJADA_MIN minutos sin factura.
    if (min >= MIN_GRACIA && p.estado === 'esperando') { p.estado = 'lavando'; avisar('info', nombre(p.n) + ': moto en lavado sin factura todavía' + (p.placa ? ' (' + p.placa + ')' : p.parcial ? ' (' + p.parcial + ')' : '') + '. Si baja sin factura saltará la alerta.'); }
  }
  // Guarda lo que leyó el modelo: placa completa, o la lectura parcial con más caracteres conocidos.
  function guardarLectura(p, r) {
    if (r.placa) { p.placa = r.placa; p.parcial = ''; p.confirmada = true; p.dudas = 0; avisar('info', nombre(p.n) + ': placa leída ' + r.placa + '.'); return; }
    p.motivo = r.motivo;
    if (r.parcial && conocidos(r.parcial) >= conocidos(p.parcial)) { if (r.parcial !== p.parcial) avisar('info', nombre(p.n) + ': placa leída en parte: ' + r.parcial + '.'); p.parcial = r.parcial; }
  }

  // El puente 1 está pegado a la zona de fuera del puente: una moto que se lava ahí aparece cortada en el borde del recorte del puente 1 y sin placa. Eso no es una moto del puente 1.
  const cortada1 = (n, r) => n === 1 && r.moto === true && r.cortada === true && !(r.placa || r.parcial);

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
    // La foto del historial es la que se usó para leer la placa (no se pisa con las revisiones); la del puente en vivo sí se renueva.
    const guardarFoto = (hist) => { p.visto = ahora; if (hist) hFoto(p, jpeg); try { fs.writeFileSync(path.join(FOTOS, 'camara-puente-' + n + '.jpg'), jpeg, { mode: 0o600 }); } catch (e) {} };
    const llegada = (r, origen, nueva) => {
      Object.assign(p, { estado: 'esperando', desde: ahora, placa: '', parcial: '', intentos: 1, leidoT: Date.now(), relT: Date.now(), sinMoto: 0, origen }); delete p.num; delete p.otraMoto; delete p.cortadas; delete p.cortT; delete p.cruceId; delete p.cruce; delete p.cruceT; delete p.confirmada; delete p.dudas; delete p.alertado; delete p.motivo; delete p.aprox; delete p.sinPlacaId;
      S.vistas++; avisar('info', nombre(n) + (origen === 'revision' ? ': se encontró una moto ya montada.' : ': llegó una moto.'));
      if (nueva) hNuevo(p, jpeg); else hAbrir(p, jpeg);
      guardarLectura(p, r);
      guardarFoto(true);
    };
    const libera = () => { avisar('info', nombre(n) + ': ya no se ve la moto.'); hSalida(p); S.puentes[n - 1] = { n, estado: 'libre' }; S.vistas = Math.max(0, S.vistas - 1); guardar(); return { ok: true, estado: 'libre' }; };
    const modeloBarato = process.env.CAMARA_MODELO_REVISION || 'claude-haiku-5-5';
    // Revisión de zona quieta: cada cierto tiempo se mira la zona igual, por si hay una moto que ya estaba montada
    // o que el detector de movimiento no notó, y para saber si la moto que estaba ya se fue.
    if (opc.revision) {
      if (p.estado !== 'libre' && p.origen !== 'revision' && p.origen !== 'alarma') { guardar(); return { ok: true, estado: p.estado, revision: 'ignorada' }; } // llegó con movimiento del agente: su bajada la avisa el agente
      const rapida = await leer(jpeg, modeloBarato); // primero el modelo barato: ¿hay moto?
      if (p.estado === 'libre') {
        p.revL = { t: ahora, h: rapida.moto }; // para que el panel muestre que el puente libre se está revisando
        if (rapida.moto !== true) { guardar(); return { ok: true, estado: 'libre', revision: 'sin-moto' }; }
        const r = await leer(jpeg); // hay moto: la placa se lee con el modelo bueno
        if (r.moto !== true || (n === EXTRA && !(r.placa || r.parcial)) || cortada1(n, r)) { guardar(); return { ok: true, estado: 'libre', revision: 'sin-moto' }; } // fuera del puente: sin placa legible no se registra nada
        llegada(r, 'revision', await otraMoto(n, r, jpeg)); evaluar(p); guardar();
        return { ok: true, estado: p.estado, placa: p.placa || null, revision: 'moto-encontrada' };
      }
      // Ya marcada por una revisión anterior: si deja de verse dos veces seguidas, se libera.
      // El modelo barato se equivoca a veces: un "no hay moto" se confirma con el modelo bueno antes de contarlo, y solo un "sí hay moto" claro reinicia la cuenta.
      let sinMoto = rapida.moto === false, conf = null;
      if (sinMoto) { conf = await leer(jpeg); if (conf.moto === true) { sinMoto = false; if (!p.placa) { guardarLectura(p, conf); hFoto(p, jpeg); } } }
      const hayMoto = rapida.moto === true || (conf && conf.moto === true);
      p.rev = { t: ahora, h: rapida.moto, s: conf ? conf.moto : null };
      if (sinMoto) { p.sinMoto = (p.sinMoto || 0) + 1; p.rev.n = p.sinMoto; if (p.sinMoto >= 2) return libera(); }
      else if (hayMoto) { p.sinMoto = 0; p.rev.n = 0; guardarFoto(); }
      // Cada 5 minutos con la moto en el puente se vuelve a leer la placa: si sale una placa completa que no encaja con la guardada, es otra moto (la anterior se fue sin que el puente quedara vacío).
      if (hayMoto && (p.placa || p.parcial) && Date.now() - (p.relT || 0) >= RELEER_MS) {
        p.relT = Date.now();
        const r = await leer(jpeg);
        if (r.moto === true && r.placa && !encajaPuente(r.placa, p)) {
          avisar('info', nombre(n) + ': otra moto en el puente (placa ' + r.placa + ', antes ' + (p.placa || p.parcial) + ').');
          hSalida(p); S.vistas = Math.max(0, S.vistas - 1);
          llegada(r, 'revision', true); evaluar(p); guardar();
          return { ok: true, estado: p.estado, placa: p.placa || null, revision: 'moto-nueva' };
        }
        if (r.moto === true && r.placa && !p.placa) { guardarLectura(p, r); hFoto(p, jpeg); }
        // Si no se volvió a confirmar la placa guardada, se compara la foto de ahora con la foto con la que se leyó: dos veces seguidas "otra moto" (confianza alta o media) = otra moto en el puente.
        const ref = p.hid && r.moto === true && !(r.placa && r.placa === p.placa) ? fotoHist(p.hid) : null;
        if (ref) {
          const cm = await comparar(ref, jpeg);
          if (cm.misma === false && cm.confianza !== 'baja') p.otraMoto = (p.otraMoto || 0) + 1; else if (cm.misma === true) p.otraMoto = 0;
          if (p.otraMoto >= 2) {
            avisar('info', nombre(n) + ': otra moto en el puente (la foto ya no coincide con la que se leyó; antes ' + (p.placa || p.parcial) + ').');
            hSalida(p); S.vistas = Math.max(0, S.vistas - 1);
            llegada(r, 'revision', true); evaluar(p); guardar();
            return { ok: true, estado: p.estado, placa: p.placa || null, revision: 'moto-nueva' };
          }
        } else if (r.moto === true && r.placa && r.placa === p.placa) p.otraMoto = 0;
        // Una placa que no se vuelve a confirmar dos relecturas seguidas se descarta (pudo ser inventada): la moto queda sin placa legible.
        if (r.moto === true && p.placa && r.placa === p.placa) { p.confirmada = true; p.dudas = 0; }
        else if (r.moto === true && p.placa && !r.placa && !p.confirmada) {
          p.dudas = (p.dudas || 0) + 1;
          if (p.dudas >= 2) {
            // La placa no se pudo confirmar: se conserva su fila en el historial (marcada "descartada") y la moto sigue en una fila nueva sin placa; así una fila nunca cambia de moto ni pierde su lectura original.
            avisar('info', nombre(n) + ': la placa ' + p.placa + ' no se pudo confirmar y se descartó.');
            const eh = p.hid && H.find(x => x.id === p.hid); hSalida(p); if (eh) { eh.estado = 'descartada'; hSucio = true; }
            S.vistas = Math.max(0, S.vistas - 1);
            llegada({ moto: true, placa: '', parcial: '', motivo: 'ilegible' }, 'revision', true); evaluar(p); guardar();
            return { ok: true, estado: p.estado, placa: null, revision: 'placa-descartada' };
          }
        }
      }
      if (hayMoto && (p.placa || p.parcial) && S.cruces.length && Date.now() - (p.cruceT || 0) >= 2 * 60e3) await cruzarPuente(p, jpeg);
      // Puente 1 ocupado sin placa: si lo que hay es un trozo de moto cortado en el borde (la moto está fuera del puente), dos veces seguidas se libera y la fila queda descartada.
      if (hayMoto && n === 1 && !p.placa && !p.parcial && Date.now() - (p.cortT || 0) >= 55000) {
        p.cortT = Date.now(); const rc = await leer(jpeg);
        if (cortada1(n, rc)) {
          p.cortadas = (p.cortadas || 0) + 1;
          if (p.cortadas >= 2) { avisar('info', nombre(n) + ': lo que se veía era un trozo de moto fuera del puente; se descartó.'); const eh = p.hid && H.find(x => x.id === p.hid); hSalida(p); if (eh) { eh.estado = 'descartada'; hSucio = true; } return libera(); }
        } else if (rc.moto === true) p.cortadas = 0;
      }
      // Mientras siga sin placa completa, la revisión también sirve de intento de lectura.
      if (!p.placa && p.intentos < MAX_LECTURAS_LENTAS && rapida.moto !== false) { p.intentos++; p.leidoT = Date.now(); guardarLectura(p, await leer(jpeg)); guardarFoto(true); }
      evaluar(p); guardar();
      return { ok: true, estado: p.estado, placa: p.placa || null, revision: 'vigente' };
    }
    if (p.estado === 'libre') {
      if (opc.previo) { const rapida = await leer(jpeg, modeloBarato); if (rapida.moto !== true) { guardar(); return { ok: true, estado: 'libre', motivo: 'no-hay-moto' }; } }
      const r = await leer(jpeg);
      if (r.moto === false || (n === EXTRA && !(r.placa || r.parcial)) || cortada1(n, r)) { guardar(); return { ok: true, estado: 'libre', motivo: 'no-hay-moto' }; } // fuera del puente: sin placa legible no se registra nada (y se deja de mirar un rato) // persona, cubeta, manguera…
      llegada(r, opc.origen || 'movimiento', await otraMoto(n, r, jpeg));
    } else {
      guardarFoto();
      const toca = p.intentos < MAX_REINTENTOS_LECTURA || (p.intentos < MAX_LECTURAS_LENTAS && Date.now() - (p.leidoT || 0) >= CADA_LECTURA_LENTA);
      if (!p.placa && toca) {
        p.intentos++; p.leidoT = Date.now();
        const r = await leer(jpeg);
        if (r.moto === false) {
          // Dos veces seguidas sin moto: lo que se había tomado por moto ya no está.
          if (++p.sinMoto >= 2) return libera();
        } else { p.sinMoto = 0; guardarLectura(p, r); hFoto(p, jpeg); }
      }
    }
    evaluar(p); guardar();
    return { ok: true, estado: p.estado, placa: p.placa || null };
  }

  // El dueño libera un puente a mano (la moto ya no está o quedó una lectura vieja): la próxima detección vuelve a leerlo desde cero.
  function liberarPuente(n, quien) {
    n = Number(n); if (!Number.isInteger(n) || n < 1 || n > PUENTES) return false;
    const p = S.puentes[n - 1]; if (p.estado === 'libre') return true;
    avisar('info', nombre(n) + ': liberado a mano por ' + quien + ' (la moto ' + (p.placa || p.parcial || 'sin placa leída') + ').');
    hSalida(p); const eh = p.hid && H.find(x => x.id === p.hid); if (eh) { eh.noReusar = true; hSucio = true; }
    S.puentes[n - 1] = { n, estado: 'libre' }; S.vistas = Math.max(0, S.vistas - 1); enfriar[n] = 0; guardar(); return true;
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
  // Zona "fuera del puente": por ahí pasa gente todo el rato. Solo se mira si hay movimiento sostenido FUERA_ESPERA_MS (un minuto) seguido;
  // un hueco de más de FUERA_HUECO_MS sin movimiento reinicia la cuenta. Si al mirar no hay moto, se deja de mirar FUERA_ENFRIAR_MS.
  const FUERA_ESPERA_MS = (Number(process.env.CAMARA_FUERA_SEG) || 60) * 1000, FUERA_HUECO_MS = 45000, FUERA_ENFRIAR_MS = 120000;
  const MAX_AVISO = 2 * 1024 * 1024;
  fs.mkdirSync(FOTOS4K, { recursive: true });
  const ffmpeg = process.env.FFMPEG || 'ffmpeg';
  const fotos4k = [];                     // más recientes: { t, nombre, ruta }
  const enCurso = {}, enfriar = {}, ultimaFoto = {}; // por puente
  const fuera = { ini: 0, ult: 0 };
  let vistaT = 0;
  const VISTA_MS = Number(process.env.CAMARA_VISTA_MS) || 2000;

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
    // La pantalla de Puentes usa la misma foto, reducida, como vista en vivo (como mucho una cada VISTA_MS; 2 s por defecto, cambia con CAMARA_VISTA_MS).
    if (Date.now() - vistaT >= VISTA_MS) {
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
    // Un aviso de movimiento en un puente ya ocupado es una revisión más: se comprueba que la moto siga ahí (antes solo se cambiaba la foto sin mirar).
    if (S.puentes[n - 1].estado !== 'libre' && !(opc && opc.revision)) opc = Object.assign({}, opc, { revision: true });
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
      if (pn === EXTRA && S.puentes[EXTRA - 1].estado === 'libre') {
        const t = Date.now(); if (!fuera.ini || t - fuera.ult > FUERA_HUECO_MS) fuera.ini = t; fuera.ult = t;
        if (t - fuera.ini < FUERA_ESPERA_MS) { dep('puente', pn, 'movimiento de menos de un minuto: se ignora'); return; }
      }
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
        if (r && r.motivo === 'no-hay-moto') { enfriar[pn] = Date.now() + (pn === EXTRA ? FUERA_ENFRIAR_MS : ENFRIAR_LIBRE); if (pn === EXTRA) fuera.ini = 0; }
      } finally { enCurso[pn] = false; }
    } catch (e) { console.error('camara alarma:', e.message); }
  }

  // Revisión periódica con la última foto 4K: encuentra motos que ya estaban montadas (puentes libres, cada CAMARA_REVISION_SEG, 60 por defecto)
  // y libera los puentes cuando la moto se va (puentes ocupados, cada CAMARA_REVISION_OCUPADOS_SEG, 60 por defecto; con el modelo barato).
  const REVISION_FUERA_MS = 300000; let ultRevFuera = 0;
  async function revisar(ocupados) {
    const f = fotos4k[fotos4k.length - 1]; if (!f || Date.now() - f.t > 60000) return; // sin foto reciente no hay nada que mirar
    for (let n = 1; n <= PUENTES; n++) {
      if (enCurso[n] || (S.puentes[n - 1].estado !== 'libre') !== ocupados) continue;
      // La zona de fuera del puente (por donde pasa gente) se revisa cada REVISION_FUERA_MS; los puentes se revisan cada vez.
      if (n === EXTRA && !ocupados) { if (Date.now() - ultRevFuera < REVISION_FUERA_MS) continue; ultRevFuera = Date.now(); }
      enCurso[n] = true;
      try { await mirarPuente(n, f, { revision: true, origen: 'alarma' }); } catch (e) { console.error('camara revision:', e.message); } finally { enCurso[n] = false; }
    }
  }
  const segundos = (v, def) => v === undefined ? def : Number(v);
  const revLibres = segundos(process.env.CAMARA_REVISION_SEG, 60), revOcupados = segundos(process.env.CAMARA_REVISION_OCUPADOS_SEG, 60);
  setInterval(limpiar, 60000).unref();
  if (revLibres > 0) setInterval(() => revisar(false).catch(() => {}), revLibres * 1000).unref();
  if (revOcupados > 0) setInterval(() => revisar(true).catch(() => {}), revOcupados * 1000).unref();
  // Al arrancar (por ejemplo tras un despliegue) se revisa todo en cuanto llega una foto, sin esperar al primer ciclo.
  setTimeout(() => { revisar(false).catch(() => {}); revisar(true).catch(() => {}); }, 30000).unref();

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

  return { autoRevalidar, ventasValidadas, validarManual, revalidar, liberarPuente, cruces, validarCruce, fotoCruce, fotoVentaId, cruzar, leerFoto, evento, vista, fotoVista, publico, foto, historial, marcarReal, fotoHist, alarma, fotoRecibida, leerPlaca, FOTOS4K, PUENTES };
}

module.exports = { crear };
