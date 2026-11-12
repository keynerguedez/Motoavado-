# Moto Lavado

Sistema de facturación y control de Moto Lavado: facturación en tablet, clientes y tickets, comisiones, gastos con autorización, administración y vigilante por cámara.

Corre en su propio servidor (Hetzner, Ubuntu), separado de Jarvis. Misma receta: Node, HTTPS automático con Caddy en `https://<ip-con-guiones>.sslip.io`, servicio systemd.

## Instalación
No se instala a mano. Al crear el servidor, cloud-init descarga y ejecuta `install.sh`. No pide claves.

## Actualización
El servidor revisa este repositorio cada 2 minutos y, si hay código nuevo en `main`, lo trae y se reinicia solo.

## Claves y datos
Nunca van en este repositorio. Viven en el servidor: `/opt/motolavado/vault/.env` (claves) y `/opt/motolavado/data` (base de datos y fotos).

## Estado
`https://<dominio>/health` devuelve la versión instalada.

## Etapas
1. Pantalla (demo) publicada desde el servidor. ← actual
2. Usuarios con clave, base de datos, facturación real y clientes.
3. Fotos, lectura de placa, tasa euro automática, tickets por WhatsApp.
4. Comisiones, gastos con autorización, cierre.
5. Vigilante por cámara.
