// Nota de entrega como imagen (PNG) para mandar por WhatsApp. Se dibuja en SVG y se convierte con resvg.
const fs = require('fs');
const path = require('path');
const FUENTES = fs.readdirSync(path.join(__dirname, 'fuentes')).filter(f => f.endsWith('.otf')).map(f => path.join(__dirname, 'fuentes', f));
const LOGO = 'data:image/png;base64,' + fs.readFileSync(path.join(__dirname, '..', 'web', 'logo.png')).toString('base64');
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const corta = (s, n) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s; };
const TEMAS = {
  claro: { bg: '#E9F7F7', card: '#FFFFFF', ink: '#06191B', mut: '#5B7577', line: '#D5E8E8', acc: '#0AA7A3', pill: '#06191B', pillInk: '#FFFFFF', head1: '#00E0DC', head2: '#0C8F8C', tit: '#06191B', num: '#06191B', fec: '#06383A' },
  oscuro: { bg: '#041416', card: '#0A2226', ink: '#EAF7F7', mut: '#8DB5B6', line: '#16444A', acc: '#00E0DC', pill: '#00E0DC', pillInk: '#031112', head1: '#06282C', head2: '#0A3F44', tit: '#00E0DC', num: '#FFFFFF', fec: '#8DB5B6' }
};

function notaSvg(d, tema) {
  const T = TEMAS[tema] || TEMAS.claro, W = 1080;
  const serv = (d.servicios || []).slice(0, 12), yServ = 820, yTot = yServ + serv.length * 74 + 40, H = yTot + 450;
  const pagado = corta(d.pagado, 22), tamPago = pagado.length > 16 ? 54 : pagado.length > 12 ? 66 : 80;
  let s = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Inter">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${T.head1}"/><stop offset="1" stop-color="${T.head2}"/></linearGradient>
<clipPath id="c"><rect x="40" y="40" width="${W - 80}" height="${H - 80}" rx="44"/></clipPath></defs>
<rect width="${W}" height="${H}" fill="${T.bg}"/>
<rect x="40" y="40" width="${W - 80}" height="${H - 80}" rx="44" fill="${T.card}"/>
<g clip-path="url(#c)">
 <path d="M40 40 H${W - 40} V330 C ${W - 260} 430, 300 250, 40 380 Z" fill="url(#g)"/>
 <path d="M40 380 C 300 250, ${W - 260} 430, ${W - 40} 330 V362 C ${W - 260} 462, 300 282, 40 412 Z" fill="${T.acc}" opacity=".35"/>
</g>
<circle cx="230" cy="250" r="158" fill="#fff"/><circle cx="230" cy="250" r="158" fill="none" stroke="${T.acc}" stroke-width="6"/>
<image xlink:href="${LOGO}" href="${LOGO}" x="92" y="125" width="276" height="252" preserveAspectRatio="xMidYMid meet"/>
<text x="${W - 90}" y="150" text-anchor="end" font-size="34" font-weight="700" fill="${T.tit}" letter-spacing="6">NOTA DE ENTREGA</text>
<text x="${W - 90}" y="240" text-anchor="end" font-size="92" font-weight="800" fill="${T.num}">#${esc(corta(d.num, 8))}</text>
<text x="${W - 90}" y="292" text-anchor="end" font-size="32" font-weight="500" fill="${T.fec}">${esc(d.fecha)}</text>
<text x="100" y="520" font-size="30" font-weight="600" fill="${T.mut}" letter-spacing="3">CLIENTE</text>
<text x="100" y="578" font-size="52" font-weight="700" fill="${T.ink}">${esc(corta(d.cliente || 'Cliente', 30))}</text>
<rect x="100" y="620" width="${W - 200}" height="130" rx="26" fill="${T.bg}"/>
<text x="140" y="672" font-size="26" font-weight="600" fill="${T.mut}" letter-spacing="3">MOTO</text>
<text x="140" y="722" font-size="38" font-weight="600" fill="${T.ink}">${esc(corta(d.modelo || 'Moto', 24))}</text>
<rect x="${W - 400}" y="648" width="260" height="76" rx="16" fill="${T.card}" stroke="${T.acc}" stroke-width="4"/>
<text x="${W - 270}" y="701" text-anchor="middle" font-size="${String(d.placa || '').length > 8 ? 32 : 42}" font-weight="800" fill="${T.ink}" letter-spacing="3">${esc(corta(d.placa, 10))}</text>`;
  serv.forEach((x, i) => {
    const y = yServ + i * 74;
    s += `<circle cx="118" cy="${y + 22}" r="10" fill="${T.acc}"/><text x="150" y="${y + 36}" font-size="38" font-weight="500" fill="${T.ink}">${esc(corta(x.nombre, 30))}</text><text x="${W - 100}" y="${y + 36}" text-anchor="end" font-size="38" font-weight="700" fill="${T.ink}">${esc(corta(x.precio, 10))}</text><line x1="100" y1="${y + 62}" x2="${W - 100}" y2="${y + 62}" stroke="${T.line}" stroke-width="2"/>`;
  });
  s += `<rect x="100" y="${yTot}" width="${W - 200}" height="200" rx="34" fill="${T.pill}"/>
<text x="150" y="${yTot + 78}" font-size="32" font-weight="700" fill="${T.pillInk}" opacity=".75" letter-spacing="5">PAGADO</text>
<text x="${W - 150}" y="${yTot + 98}" text-anchor="end" font-size="${tamPago}" font-weight="800" fill="${T.pillInk}">${esc(pagado)}</text>
<text x="150" y="${yTot + 160}" font-size="32" font-weight="500" fill="${T.pillInk}" opacity=".85">${esc(corta(d.metodo, 40))}</text>
<text x="${W / 2}" y="${yTot + 290}" text-anchor="middle" font-size="42" font-weight="700" fill="${T.ink}">¡Gracias por tu visita!</text>
<text x="${W / 2}" y="${yTot + 344}" text-anchor="middle" font-size="30" font-weight="500" fill="${T.mut}">Tu moto queda en buenas manos · Motolavado R1</text>
</svg>`;
  return s;
}

function notaPng(d, tema) {
  const { Resvg } = require('@resvg/resvg-js');
  return Buffer.from(new Resvg(notaSvg(d, tema), { font: { fontFiles: FUENTES, loadSystemFonts: false, defaultFontFamily: 'Inter' }, fitTo: { mode: 'width', value: 1080 } }).render().asPng());
}
module.exports = { notaPng };
