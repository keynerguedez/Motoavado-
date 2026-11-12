#!/usr/bin/env bash
# Instalador de Moto Lavado en Ubuntu (Hetzner). Corre solo al crear el servidor (cloud-init), como root.
# Deja: /opt/motolavado (código), /opt/motolavado/vault (claves, 700), /opt/motolavado/data (base de datos y fotos),
# servicio systemd "motolavado", actualización automática desde GitHub cada 2 minutos,
# y Caddy con HTTPS automático en https://<IP-con-guiones>.sslip.io
# No pide nada y no contiene claves.
set -uo pipefail
exec > >(tee -a /var/log/motolavado-install.log) 2>&1
REPO="https://github.com/keynerguedez/Motoavado-.git"
DIR=/opt/motolavado
export DEBIAN_FRONTEND=noninteractive
echo "== Moto Lavado · instalación · $(date) =="

timedatectl set-timezone America/Caracas || true
apt-get update -q
apt-get install -y -q curl git ufw fail2ban ca-certificates gnupg sqlite3 unattended-upgrades python3 || true

IP=$(curl -4 -s --max-time 10 https://ifconfig.me || hostname -I | awk '{print $1}')
DOMAIN="${MOTOLAVADO_DOMAIN:-$(echo "$IP" | tr . -).sslip.io}"
echo "IP: $IP · dominio: $DOMAIN"

# Memoria de intercambio (1 GB) para que no se quede sin memoria
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile && echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# Cortafuegos primero
ufw allow OpenSSH >/dev/null; ufw allow 80 >/dev/null; ufw allow 443 >/dev/null; ufw --force enable >/dev/null
systemctl enable -q --now fail2ban || true

# Node (20 o superior)
nodeok(){ command -v node >/dev/null && [ "$(node -v | cut -d. -f1 | tr -d v)" -ge 20 ]; }
nodeok || apt-get install -y -q nodejs || true
if ! nodeok; then curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y -q nodejs; fi
echo "node: $(node -v 2>&1)"

# Caddy (HTTPS automático)
if ! command -v caddy >/dev/null; then
  apt-get install -y -q caddy || {
    apt-get install -y -q debian-keyring debian-archive-keyring apt-transport-https
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
    apt-get update -q && apt-get install -y -q caddy
  }
fi
echo "caddy: $(caddy version 2>&1 | head -1)"

# Código
if [ -d "$DIR/.git" ]; then git -C "$DIR" fetch -q origin main && git -C "$DIR" reset -q --hard origin/main; else git clone -q "$REPO" "$DIR"; fi
mkdir -p "$DIR/vault" "$DIR/data/fotos" && chmod 700 "$DIR/vault"
ENV="$DIR/vault/.env"; touch "$ENV"; chmod 600 "$ENV"
grep -q '^SESSION_SECRET=' "$ENV" || echo "SESSION_SECRET=$(openssl rand -hex 32)" >> "$ENV"
grep -q '^DOMAIN=' "$ENV" || echo "DOMAIN=$DOMAIN" >> "$ENV"
chmod +x "$DIR/bin/motolavado" && ln -sf "$DIR/bin/motolavado" /usr/local/bin/motolavado

# Servicio
cat > /etc/systemd/system/motolavado.service <<UNIT
[Unit]
Description=Moto Lavado (sistema)
After=network-online.target
Wants=network-online.target
[Service]
WorkingDirectory=$DIR
Environment=NODE_ENV=production
Environment=PORT=3000
Environment=MOTOLAVADO_VAULT=$DIR/vault
Environment=MOTOLAVADO_DATA=$DIR/data
EnvironmentFile=-$DIR/vault/.env
ExecStart=$(command -v node) server/index.js
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
UNIT

# Actualización automática desde GitHub cada 2 minutos
cat > /etc/systemd/system/motolavado-update.service <<UNIT
[Unit]
Description=Moto Lavado · traer código nuevo
[Service]
Type=oneshot
ExecStart=$DIR/bin/motolavado autoupdate
UNIT
cat > /etc/systemd/system/motolavado-update.timer <<UNIT
[Unit]
Description=Moto Lavado · revisar código nuevo cada 2 minutos
[Timer]
OnBootSec=2min
OnUnitActiveSec=2min
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable -q motolavado && systemctl restart motolavado
systemctl enable -q --now motolavado-update.timer

# Caddy
cat > /etc/caddy/Caddyfile <<CADDY
$DOMAIN {
  encode gzip
  reverse_proxy 127.0.0.1:3000
}
CADDY
systemctl enable -q caddy && systemctl restart caddy

sleep 4
if curl -sf http://127.0.0.1:3000/health >/dev/null; then
  echo "== Moto Lavado instalado =="
  echo " Pantalla: https://$DOMAIN"
else
  echo "!! El sistema no respondió. Se publica este registro en http://$IP/ para revisarlo."
  systemctl stop caddy || true
  mkdir -p /var/log/motolavado-pub && cp /var/log/motolavado-install.log /var/log/motolavado-pub/instalacion.txt
  journalctl -u motolavado -n 60 --no-pager > /var/log/motolavado-pub/servicio.txt 2>&1 || true
  (cd /var/log/motolavado-pub && nohup python3 -m http.server 80 >/dev/null 2>&1 &)
fi
