// Detector de motos por zona. Lógica pura: recibe fotogramas en gris (640x360) y avisa cuándo llega, sigue o baja una moto.
// Compara cada zona contra un "fondo" (el puente vacío). Sin dependencias.
const W = 640, H = 360;

function crearDetector(zonas, opt, alEvento) {
  const o = Object.assign({ umbral: 0.18, difPixel: 25, muestrasLlega: 4, muestrasBaja: 10, reenvios: [8, 20], cadaSeg: 60, libreCadaSeg: 300, adaptar: 0.005 }, opt || {});
  let fondo = null;
  const est = zonas.map(z => ({
    z, rect: { x0: Math.round(z.x * W), y0: Math.round(z.y * H), x1: Math.min(W, Math.round((z.x + z.w) * W)), y1: Math.min(H, Math.round((z.y + z.h) * H)) },
    presente: false, cuenta: 0, desde: 0, enviados: 0, ultimo: 0,
  }));

  function media(f, r) { let s = 0, n = 0; for (let y = r.y0; y < r.y1; y++) for (let x = r.x0; x < r.x1; x++) { s += f[y * W + x]; n++; } return n ? s / n : 0; }
  // Qué parte de la zona es distinta del fondo, ajustando por cambios de luz de toda la zona.
  function cambio(f, r) {
    const mf = media(fondo, r), mi = media(f, r) || 1, g = mf / mi;
    let d = 0, n = 0;
    for (let y = r.y0; y < r.y1; y++) for (let x = r.x0; x < r.x1; x++) { const i = y * W + x; if (Math.abs(f[i] * g - fondo[i]) > o.difPixel) d++; n++; }
    return n ? d / n : 0;
  }
  function adaptar(f, r) {
    for (let y = r.y0; y < r.y1; y++) for (let x = r.x0; x < r.x1; x++) { const i = y * W + x; fondo[i] = fondo[i] + (f[i] - fondo[i]) * o.adaptar; }
  }

  return {
    W, H,
    fijarFondo(f) { fondo = Buffer.from(f); },
    tieneFondo() { return !!fondo; },
    // Devuelve el estado de cada zona (útil para depurar).
    procesar(f, ahora) {
      if (f.length !== W * H) return [];
      if (!fondo) fondo = Buffer.from(f);
      return est.map(e => {
        const c = cambio(f, e.rect), hay = c > o.umbral;
        if (!e.presente) {
          e.cuenta = hay ? e.cuenta + 1 : 0;
          if (c < o.umbral / 2) adaptar(f, e.rect);
          if (e.cuenta >= o.muestrasLlega) { e.presente = true; e.cuenta = 0; e.desde = ahora; e.enviados = 1; e.ultimo = ahora; alEvento({ puente: e.z.puente, tipo: 'llega' }); }
          else if (ahora - e.ultimo >= o.libreCadaSeg * 1000) { e.ultimo = ahora; alEvento({ puente: e.z.puente, tipo: 'libre' }); }
        } else {
          e.cuenta = hay ? 0 : e.cuenta + 1;
          if (e.cuenta >= o.muestrasBaja) { e.presente = false; e.cuenta = 0; e.ultimo = ahora; alEvento({ puente: e.z.puente, tipo: 'baja' }); }
          else {
            const seg = (ahora - e.desde) / 1000, prox = o.reenvios[e.enviados - 1];
            if ((prox != null && seg >= prox) || (prox == null && ahora - e.ultimo >= o.cadaSeg * 1000)) { e.enviados++; e.ultimo = ahora; alEvento({ puente: e.z.puente, tipo: 'sigue' }); }
          }
        }
        return { puente: e.z.puente, cambio: Math.round(c * 100) / 100, presente: e.presente };
      });
    },
  };
}

module.exports = { crearDetector, W, H };
