# Agente de la cámara

Corre en un equipo del local (no en el servidor). Lee el video de la cámara Hikvision, detecta moto en cada uno de los 4 puentes y manda al servidor un fotograma recortado de esa zona. El servidor lee la placa y avisa si una moto lleva más de 5 minutos sin factura.

## Requisitos
- Node 20 o más y `ffmpeg` (Mac: `brew install ffmpeg` · Ubuntu/Raspberry: `sudo apt install ffmpeg`).
- En la cámara, RTSP activo (viene activo por defecto en Hikvision) y las secuencias 101 (principal) y 102 (secundaria).
- En el servidor, en `/opt/motolavado/vault/.env`: `CAMARA_TOKEN` (mínimo 24 caracteres) y `ANTHROPIC_API_KEY`.

## Puesta en marcha
1. `cp .env.example .env` y llena IP, usuario, clave de la cámara, `SERVIDOR_URL` y `CAMARA_TOKEN`. El `.env` no se sube a git.
2. `node agente.js probar`: guarda en `prueba/` la imagen completa y el recorte de cada puente. Si un recorte no muestra su puente entero, ajusta `zonas.json`.
3. Con los 4 puentes vacíos: `node agente.js calibrar`.
4. `node agente.js`: vigila. Con `CAMARA_DEPURAR=1` imprime cada minuto cuánto cambió cada zona.

## Cómo decide
Cada segundo compara cada zona con el fondo calibrado (ajustando por cambios de luz). Una moto cuenta si la zona lleva 4 segundos distinta; se da por ida tras 10 segundos igual al fondo. Mientras está, reenvía el fotograma a los 8 s, 20 s y luego cada minuto (el servidor reintenta leer la placa hasta 3 veces).
