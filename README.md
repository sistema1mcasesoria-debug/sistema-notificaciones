# Monitor de Buzón Electrónico SUNAT

Sistema base en **Node.js + TypeScript + Playwright (Chrome)** para consultar de forma segura los buzones electrónicos de SUNAT de múltiples clientes, cifrar sus credenciales SOL en base de datos SQLite y centralizar las nuevas notificaciones detectadas.

## Características incluidas en esta base

- **Seguridad AES-256-GCM:** El usuario y la Clave SOL se cifran antes de guardarse en SQLite (`data/sunat.db`), usando una llave maestra local en `.env`.
- **Automatización real con Google Chrome:** Usa `playwright` conectado a tu Google Chrome instalado (`HEADLESS=false` por defecto para que veas el proceso en pantalla durante tus pruebas).
- **Soporte RUC y DNI:** Compatible con los botones `#btnPorRuc` y `#btnPorDni` del login oficial OAuth2 de SUNAT SOL.
- **Detección de notificaciones nuevas:** Genera un hash único por notificación para distinguir alertas nuevas de notificaciones ya vistas.
- **Modo depuración:** Si algún selector interno del buzón cambia, guarda capturas de pantalla y estructura de `frames` en `logs/`.

---

## Guía rápida de puesta en marcha

### 1. Generar la llave de cifrado y archivo `.env`
Ejecuta una sola vez dentro de `E:\Programa\Notificaciones`:

```bash
npm run keygen
```

Esto generará una llave de 256 bits y creará automáticamente tu archivo `.env` a partir de `.env.example`.

> **Importante:** Nunca compartas ni subas a Git tu archivo `.env`. Si lo pierdes, no podrás descifrar las claves guardadas.

### 2. Registrar tu primer cliente (de prueba)
Se recomienda crear primero un **Usuario Secundario SOL** en SUNAT con permiso exclusivo para consultar el Buzón Electrónico:

```bash
npm run client:add
```

El asistente te pedirá el modo (`RUC` o `DNI`), nombre/etiqueta, número de documento, usuario SOL y la clave SOL (oculta al escribir).

Para ver los clientes guardados:

```bash
npm run client:list
```

### 3. Abrir el Panel Web (Dashboard Visual)

Puedes gestionar clientes, revisar la bandeja unificada y lanzar revisiones en Chrome desde el navegador ejecutando:

```bash
npm run web
```

Luego abre `http://127.0.0.1:3000` en tu navegador.

### 4. Ejecutar una revisión desde terminal (opcional)

```bash
npm run check
```

O para revisar un cliente específico por su ID:

```bash
npm run check -- --client=1
```

### 5. Consultar notificaciones guardadas desde terminal (opcional)

```bash
# Ver todas las últimas notificaciones guardadas
npm run notifications

# Ver solo alertas nuevas
npm run notifications -- --new

# Marcar alertas nuevas como revisadas
npm run notifications -- --ack
```

### 5. Modo monitoreo periódico continuo

Revisa automáticamente todos los clientes activos según `CHECK_INTERVAL_MINUTES` (por defecto cada 60 minutos):

```bash
npm run monitor
```

---

## Otros comandos útiles

- `npm run client:toggle -- <id>`: Pausa o reactiva un cliente.
- `npm run client:remove -- <id>`: Elimina un cliente y su historial.
- `npm run test:crypto`: Ejecuta pruebas unitarias del módulo de cifrado.
- `npm run build`: Verifica compilación TypeScript (`tsc`).
