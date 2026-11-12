// WhatsApp por código QR (vinculando el teléfono de la tienda, como WhatsApp Web).
// Camino provisional y no oficial: solo para tickets, pocos mensajes y con pausa entre ellos.
// La sesión queda en data/wa-qr (fuera del repositorio). No se guarda ningún mensaje recibido.
const fs = require('fs');
const path = require('path');

module.exports = function crear(DATA) {
  const DIR = path.join(DATA, 'wa-qr');
  const e = { estado: 'apagado', qr: null, numero: null, error: null, enviadosHoy: 0, dia: '' };
  let sock = null, arrancando = false, reintento = null, cola = Promise.resolve(), intentos = 0;
  const MAX_DIA = 150, PAUSA_MS = 4000;

  function publico() { return { estado: e.estado, qr: e.qr, numero: e.numero, error: e.error, enviadosHoy: e.enviadosHoy, maxDia: MAX_DIA }; }
  function haySesion() { return fs.existsSync(path.join(DIR, 'creds.json')); }
  function borrarSesion() { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (x) {} }

  async function iniciar() {
    if (arrancando || sock) return publico();
    arrancando = true; e.error = null; clearTimeout(reintento);
    try {
      const b = await import('baileys');
      const pino = (await import('pino')).default;
      const QR = (await import('qrcode')).default;
      fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
      const { state, saveCreds } = await b.useMultiFileAuthState(DIR);
      let version; try { version = (await b.fetchLatestBaileysVersion()).version; } catch (x) {}
      const s = b.makeWASocket({ auth: state, version, logger: pino({ level: 'silent' }), browser: ['Motolavado R1', 'Chrome', '1.0'], syncFullHistory: false, markOnlineOnConnect: false, generateHighQualityLinkPreview: false });
      sock = s; if (e.estado !== 'conectado') e.estado = 'conectando';
      s.ev.on('creds.update', saveCreds);
      s.ev.on('connection.update', async (u) => {
        try {
          if (u.qr) { e.qr = await QR.toDataURL(u.qr, { width: 320, margin: 2 }); e.estado = 'esperando_qr'; }
          if (u.connection === 'open') { e.estado = 'conectado'; e.qr = null; intentos = 0; e.numero = String((s.user && s.user.id) || '').split(/[:@]/)[0] || null; }
          if (u.connection === 'close') {
            if (sock === s) sock = null;
            const codigo = u.lastDisconnect && u.lastDisconnect.error && u.lastDisconnect.error.output && u.lastDisconnect.error.output.statusCode;
            e.qr = null;
            if (codigo === b.DisconnectReason.loggedOut) { borrarSesion(); e.estado = 'apagado'; e.numero = null; e.error = 'El teléfono cerró la sesión. Hay que escanear el código otra vez.'; return; }
            // Sin sesión guardada (nadie escaneó) no insistimos para siempre.
            if (!haySesion() && ++intentos > 3) { e.estado = 'apagado'; e.error = 'Nadie escaneó el código. Toca Conectar de nuevo.'; intentos = 0; return; }
            e.estado = 'reconectando';
            reintento = setTimeout(() => iniciar().catch(() => {}), Math.min(60000, 3000 * (intentos + 1)));
          }
        } catch (x) { e.error = 'Error interno de WhatsApp.'; }
      });
    } catch (x) {
      sock = null; e.estado = 'error'; e.error = 'No se pudo iniciar WhatsApp: ' + String((x && x.message) || x).slice(0, 160);
    } finally { arrancando = false; }
    return publico();
  }

  async function desvincular() {
    clearTimeout(reintento);
    const s = sock; sock = null;
    try { if (s) await s.logout(); } catch (x) {}
    try { if (s) s.end(undefined); } catch (x) {}
    borrarSesion(); e.estado = 'apagado'; e.qr = null; e.numero = null; e.error = null;
    return publico();
  }

  // Los envíos van en fila, con pausa, y con tope diario: es lo que más baja el riesgo de bloqueo.
  function enviarTexto(numero, texto) { return enviar(numero, { text: texto }); }
  function enviarImagen(numero, png, pie) { return enviar(numero, { image: png, caption: pie, mimetype: 'image/png' }); }
  function enviar(numero, contenido) {
    const tarea = cola.then(async () => {
      if (e.estado !== 'conectado' || !sock) return { ok: false, error: 'WhatsApp no está conectado.' };
      const hoy = new Date().toISOString().slice(0, 10);
      if (e.dia !== hoy) { e.dia = hoy; e.enviadosHoy = 0; }
      if (e.enviadosHoy >= MAX_DIA) return { ok: false, error: 'Se llegó al tope de mensajes de hoy.' };
      try {
        const r = await sock.onWhatsApp(numero);
        const jid = r && r[0] && r[0].exists && r[0].jid;
        if (!jid) return { ok: false, error: 'Ese número no tiene WhatsApp.' };
        await sock.sendMessage(jid, contenido);
        e.enviadosHoy++;
        await new Promise(ok => setTimeout(ok, PAUSA_MS));
        return { ok: true };
      } catch (x) { return { ok: false, error: 'No se pudo enviar. Intenta de nuevo.' }; }
    });
    cola = tarea.catch(() => {});
    return tarea;
  }

  if (haySesion()) iniciar().catch(() => {});
  return { publico, iniciar, desvincular, enviarTexto, enviarImagen, conectado: () => e.estado === 'conectado' };
};
