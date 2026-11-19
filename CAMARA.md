# Cámara vigilante · modo directo (sin PC en el local)

La cámara Hikvision manda sola, por internet, lo que el servidor necesita. No hay PC, DVR ni agente en el motolavado, y **no se abre ningún puerto en el router de la tienda** (el proveedor además usa CGNAT: entrar desde afuera no es posible).

```
Cámara ──(1) aviso HTTPS: "hay algo en tal puente"──▶ Caddy ─▶ /api/camara/alarma
Cámara ──(2) foto 4K por FTP cada 10 s─────────────▶ FTP del servidor (puerto 2121)
```

1. **El aviso** (servidor de alarma HTTP de la cámara) trae el tipo de objetivo (`human`, `vehicle`…) y su posición en la imagen, más una miniatura de 640×360 que no sirve para leer la placa.
2. **Las fotos 4K** (captura programada por FTP) sí. Al llegar un aviso, el servidor espera la primera foto 4K posterior (2–10 s), **recorta la zona del puente**, pregunta al modelo barato (Haiku) si hay moto y, si la hay, lee la placa con Sonnet. De ahí en adelante es el flujo de siempre: comparar con las ventas de hoy, alerta "sin factura" a los 5 min, etc.
3. **Revisión periódica** con la última foto 4K: cada 5 min en puentes libres (encuentra una moto que ya estaba montada) y cada 60 s en puentes ocupados (libera el puente cuando la moto se va: dos lecturas seguidas sin moto).
4. La **vista en vivo** de la pantalla de Puentes sale de las mismas fotos 4K (reducidas).
5. Las fotos 4K se borran del servidor a los 3 minutos. Solo se conserva el recorte del puente con moto, en `data/fotos/`.

> El agente de `agent/` (lee RTSP, necesita un equipo en el local) sigue funcionando y sirve para pruebas, pero **no cumple el requisito del dueño** de no tener PC en la tienda.

## 1. En el servidor (Hetzner)

En `/opt/motolavado/vault/.env` (nunca en el repositorio):

| Variable | Valor |
|---|---|
| `CAMARA_TOKEN` | Ya existe (mín. 24 caracteres). También va en la URL del aviso. |
| `ANTHROPIC_API_KEY` | Una llave **nueva y exclusiva** de producción. |
| `CAMARA_FTP_CLAVE` | Clave solo para esto, **máximo 16 caracteres** (límite de la cámara), p. ej. `openssl rand -hex 8`. Sin ella el FTP no arranca. |
| `CAMARA_FTP_IP` | `2.29.38.80` (la IP pública, para el modo pasivo del FTP). |
| `CAMARA_FTP_USUARIO` | Opcional (por defecto `camara`). |
| `CAMARA_FTP_PUERTO` / `CAMARA_FTP_PASIVO` | Opcionales (por defecto `2121` y `30000-30009`). |

**No poner `CAMARA_PRUEBA`**: es solo para pruebas locales (hace que un cartón cuente como moto y permite FTP anónimo).

Instalar `ffmpeg` (recorta la zona del puente; sin él se lee el cuadro completo y la placa casi no se distingue):

```bash
sudo apt install -y ffmpeg
```

Abrir el firewall (el FTP no va cifrado: solo se abre lo necesario). Si hay firewall de Hetzner Cloud, las mismas reglas allí:

```bash
sudo ufw allow 2121/tcp
sudo ufw allow 30000:30009/tcp
```

Reiniciar: `sudo systemctl restart motolavado` y revisar `journalctl -u motolavado -n 30` (debe decir "FTP de la cámara escuchando en el puerto 2121").

### Zonas de los puentes

Por defecto el servidor reparte la imagen en 4 tiras verticales, que casi seguro no coinciden con los puentes reales. Se ajustan en `/opt/motolavado/data/camara-zonas.json` (fracciones de la imagen, de 0 a 1; no hace falta reiniciar):

```json
[
  {"puente":1,"x":0.02,"y":0.30,"w":0.22,"h":0.60},
  {"puente":2,"x":0.27,"y":0.30,"w":0.22,"h":0.60},
  {"puente":3,"x":0.52,"y":0.30,"w":0.22,"h":0.60},
  {"puente":4,"x":0.77,"y":0.30,"w":0.22,"h":0.60}
]
```

La pantalla de Puentes dibuja estas zonas sobre la vista en vivo: sirven para afinarlas viendo la imagen real. Cada recorte debe mostrar el puente entero y su placa.

## 2. En la cámara (página web, con la cuenta `admin`)

1. **Configuration → Common Settings → Time Settings**: zona horaria **Atlantic Time (Canada)** con horario de verano desactivado (UTC−4); la opción "Caracas" de la cámara es −04:30 y no sirve.
2. **Configuration → Event → Alarm Setting → Alarm Server → Add**: host `2-29-38-80.sslip.io`, URL `/api/camara/alarma?t=<CAMARA_TOKEN>`, protocolo **HTTPS**, puerto **443**. (Si la cámara no acepta el certificado, el plan B es abrir `http` en Caddy solo para esa ruta.)
3. **Event → Alarm Setting → FTP**: IP `2.29.38.80`, puerto `2121`, **usuario y clave** de arriba (los escribe el dueño, no se comparten por chat), Directory Structure *Save in the root directory*, **Upload Picture** activado. Botón *Test*: sube un archivo que no es `.jpg` y el servidor lo rechaza a propósito; la prueba real es ver llegar las fotos 4K a `data/fotos-4k`.
4. **Storage → Schedule Settings → Picture Capture**: *Scheduled Capture* activado, JPEG 3840×2160, calidad alta, intervalo **10000 ms**, Main Stream. Marcar en la cuadrícula el horario de atención (p. ej. 7:00–19:00) para no subir fotos de noche.
5. **Event → Event and Detection → Motion Detection**: activado, con *Notify Surveillance Center*. Para dibujar la zona y ajustar la sensibilidad la página pide instalar su plug-in.

Tráfico aproximado: 1 a 2 MB cada 10 s ≈ 0,9 Mbps de subida mientras esté activo el horario.

## 3. Probar

- Con `CAMARA_DEPURAR=1` en el `.env` del servidor, el registro muestra cada aviso (tipo, posición, puente elegido, foto usada, resultado).
- Poner una moto (o un cartón con una placa, con `CAMARA_PRUEBA=1` solo en local) frente a la cámara: en 2 a 10 s el puente pasa a "esperando" o "ok".
- Quitarla: el puente se libera en ~2 min.

## Límites conocidos

- **Falsos avisos.** La detección de movimiento de este firmware avisa también por personas y sombras. El servidor los descarta preguntando primero al modelo barato; y tras un "no hay moto" no vuelve a mirar ese puente por 25 s. Falta ver con motos reales cómo clasifica la cámara (`targetType`).
- **Cobro posterior.** El servidor solo conoce las ventas ya cobradas; una factura abierta en la tablet aún no cobrada puede salir como "sin factura" pasados los 5 minutos.
- **Placa a distancia.** A 3–4 m una placa de moto es pequeña: hay que probar con placas reales y, si hace falta, acercar la cámara o reducir la zona de cada puente.
- **Moto sin placa.** Si la placa no se lee y hay una factura marcada "sin placa" hoy, sin puente asignado, se empareja con ella.
- **El aviso por WhatsApp** al dueño para "sin factura" de la cámara aún no está conectado.
