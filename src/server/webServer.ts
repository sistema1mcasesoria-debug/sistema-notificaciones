import fs from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { getConfig, requireEncryptionKey, type AppConfig } from '../config/env.js';
import { closeDatabase, getDatabase } from '../db/database.js';
import {
  downloadNotificationAttachmentFromSunat,
  markMultipleNotificationsAsReadInSunat,
  markNotificationAsReadInSunat,
} from '../scraper/sunatScraper.js';
import type { LoginMode } from '../scraper/types.js';
import { ClientService } from '../services/clientService.js';
import {
  runMonitorCycle,
  type MonitorCycleSummary,
  type MonitorProgressEvent,
} from '../services/monitorService.js';

interface MonitorRuntimeState {
  isRunning: boolean;
  startedAt: string | null;
  progress: MonitorProgressEvent | null;
  lastSummary: MonitorCycleSummary | null;
  lastRunError: string | null;
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const MAX_BODY_BYTES = 64 * 1024;

function applySecurityHeaders(res: ServerResponse): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
  );
}

function sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
  applySecurityHeaders(res);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(data));
}

async function readJsonBody<T = Record<string, unknown>>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > MAX_BODY_BYTES) {
      throw new Error('Cuerpo de peticion demasiado grande.');
    }
    chunks.push(buf);
  }

  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) {
    return {} as T;
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error('JSON invalido en el cuerpo de la peticion.');
  }
}

function serveStaticFile(publicDir: string, reqPath: string, res: ServerResponse): void {
  const normalized = reqPath === '/' ? '/index.html' : reqPath;
  const resolved = path.resolve(publicDir, `.${normalized}`);

  if (!resolved.startsWith(publicDir + path.sep) && resolved !== path.join(publicDir, 'index.html')) {
    sendJson(res, 403, { error: 'Acceso denegado.' });
    return;
  }

  if (!fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
    sendJson(res, 404, { error: 'Recurso no encontrado.' });
    return;
  }

  const ext = path.extname(resolved).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  applySecurityHeaders(res);
  res.writeHead(200, {
    'Content-Type': contentType,
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
  });
  fs.createReadStream(resolved).pipe(res);
}

export function createWebServer(
  clientService: ClientService,
  config: AppConfig,
  publicDir = path.resolve(process.cwd(), 'public'),
): http.Server {
  const monitorState: MonitorRuntimeState = {
    isRunning: false,
    startedAt: null,
    progress: null,
    lastSummary: null,
    lastRunError: null,
  };

  const triggerCheck = (onlyClientId?: number) => {
    if (monitorState.isRunning) {
      return false;
    }

    monitorState.isRunning = true;
    monitorState.startedAt = new Date().toISOString();
    monitorState.progress = null;
    monitorState.lastRunError = null;

    void runMonitorCycle(clientService, config, onlyClientId, (progress) => {
      monitorState.progress = progress;
    })
      .then((summary) => {
        monitorState.lastSummary = summary;
      })
      .catch((err) => {
        monitorState.lastRunError = err instanceof Error ? err.message : String(err);
      })
      .finally(() => {
        monitorState.isRunning = false;
        monitorState.progress = null;
      });

    return true;
  };

  return http.createServer(async (req, res) => {
    try {
      const method = (req.method ?? 'GET').toUpperCase();
      const url = new URL(req.url ?? '/', `http://${req.headers.host || 'localhost'}`);
      const pathname = url.pathname;

      if (!pathname.startsWith('/api/')) {
        if (method !== 'GET' && method !== 'HEAD') {
          sendJson(res, 405, { error: 'Metodo no permitido.' });
          return;
        }
        if (pathname === '/favicon.ico') {
          applySecurityHeaders(res);
          res.writeHead(204);
          res.end();
          return;
        }
        serveStaticFile(publicDir, pathname, res);
        return;
      }

      // --- REST API ---
      if (method === 'GET' && pathname === '/api/dashboard') {
        const onlyNew = url.searchParams.get('onlyNew') === 'true';
        const clientIdParam = url.searchParams.get('clientId');
        const clientId = clientIdParam ? Number.parseInt(clientIdParam, 10) : undefined;
        const mailboxParam = url.searchParams.get('mailboxSource');
        const mailboxSource =
          mailboxParam === 'NOTIFICACIONES' || mailboxParam === 'MENSAJES'
            ? mailboxParam
            : undefined;
        const query = url.searchParams.get('q') ?? undefined;

        sendJson(res, 200, {
          stats: clientService.getDashboardStats(),
          monitorState,
          clients: clientService.listClients(),
          notifications: clientService.listNotifications({
            onlyNew,
            clientId: clientId && Number.isFinite(clientId) ? clientId : undefined,
            mailboxSource,
            query,
            limit: 120,
          }),
          runs: clientService.listCheckRuns(40),
        });
        return;
      }

      if (method === 'GET' && pathname === '/api/status') {
        sendJson(res, 200, {
          stats: clientService.getDashboardStats(),
          monitorState,
        });
        return;
      }

      if (method === 'GET' && pathname === '/api/notifications') {
        const onlyNew = url.searchParams.get('onlyNew') === 'true';
        const clientIdParam = url.searchParams.get('clientId');
        const clientId = clientIdParam ? Number.parseInt(clientIdParam, 10) : undefined;
        const mailboxParam = url.searchParams.get('mailboxSource');
        const mailboxSource =
          mailboxParam === 'NOTIFICACIONES' || mailboxParam === 'MENSAJES'
            ? mailboxParam
            : undefined;
        const query = url.searchParams.get('q') ?? undefined;

        sendJson(res, 200, {
          notifications: clientService.listNotifications({
            onlyNew,
            clientId: clientId && Number.isFinite(clientId) ? clientId : undefined,
            mailboxSource,
            query,
            limit: 120,
          }),
        });
        return;
      }

      if (method === 'POST' && pathname === '/api/clients') {
        const body = await readJsonBody<{
          label?: string;
          loginMode?: string;
          docNumber?: string;
          solUser?: string;
          solPassword?: string;
        }>(req);

        const loginMode: LoginMode =
          String(body.loginMode ?? 'RUC').toUpperCase() === 'DNI' ? 'DNI' : 'RUC';

        const clientId = clientService.addClient({
          label: String(body.label ?? ''),
          loginMode,
          docNumber: String(body.docNumber ?? ''),
          solUser: body.solUser ? String(body.solUser) : undefined,
          solPassword: String(body.solPassword ?? ''),
        });

        sendJson(res, 201, {
          ok: true,
          clientId,
          message: 'Cliente guardado con credenciales cifradas (AES-256-GCM).',
        });
        return;
      }

      const toggleMatch = pathname.match(/^\/api\/clients\/(\d+)\/toggle$/);
      if (method === 'POST' && toggleMatch) {
        const id = Number.parseInt(toggleMatch[1], 10);
        const active = clientService.toggleClient(id);
        sendJson(res, 200, { ok: true, id, active });
        return;
      }

      const deleteClientMatch = pathname.match(/^\/api\/clients\/(\d+)$/);
      if (method === 'DELETE' && deleteClientMatch) {
        const id = Number.parseInt(deleteClientMatch[1], 10);
        const removed = clientService.removeClient(id);
        if (!removed) {
          sendJson(res, 404, { error: `No se encontro cliente con ID ${id}.` });
          return;
        }
        sendJson(res, 200, { ok: true, id });
        return;
      }

      const ackNotifMatch = pathname.match(/^\/api\/notifications\/(\d+)\/ack$/);
      if (method === 'POST' && ackNotifMatch) {
        const id = Number.parseInt(ackNotifMatch[1], 10);
        const updated = clientService.markNotificationAsReviewed(id);
        sendJson(res, 200, { ok: true, updated });
        return;
      }

      const markReadSunatMatch = pathname.match(/^\/api\/notifications\/(\d+)\/mark-read-sunat$/);
      if (method === 'POST' && markReadSunatMatch) {
        if (monitorState.isRunning) {
          sendJson(res, 409, {
            error: 'Hay una revisión o proceso de Chrome en curso. Espera a que termine.',
          });
          return;
        }

        const id = Number.parseInt(markReadSunatMatch[1], 10);
        const notif = clientService.getNotificationById(id);
        if (!notif) {
          sendJson(res, 404, { error: `No se encontró la notificación #${id}.` });
          return;
        }

        const credsList = clientService.getActiveCredentials(notif.clientId);
        if (credsList.length === 0) {
          sendJson(res, 400, {
            error: 'No se encontraron credenciales activas para el cliente de esta notificación.',
          });
          return;
        }

        const creds = credsList[0];

        monitorState.isRunning = true;
        monitorState.startedAt = new Date().toISOString();
        monitorState.progress = {
          index: 1,
          total: 1,
          clientId: notif.clientId,
          label: `${notif.clientLabel} - Marcando leída: ${notif.subject.slice(0, 30)}`,
          docNumber: notif.docNumber,
        };

        try {
          const sunatRes = await markNotificationAsReadInSunat(
            creds,
            {
              id: notif.id,
              subject: notif.subject,
              sunatCode: notif.sunatCode,
              publishedAt: notif.publishedAt,
              notificationType: notif.notificationType,
              mailboxSource: notif.mailboxSource,
            },
            config,
          );

          clientService.markNotificationAsReadSunat(id);

          sendJson(res, 200, {
            ok: true,
            foundInSunat: sunatRes.foundInSunat,
            message: sunatRes.message,
          });
        } catch (sunatErr) {
          const msg = sunatErr instanceof Error ? sunatErr.message : String(sunatErr);
          sendJson(res, 500, { error: `Error conectando con SUNAT: ${msg}` });
        } finally {
          monitorState.isRunning = false;
          monitorState.progress = null;
        }
        return;
      }

      const downloadAttachMatch = pathname.match(/^\/api\/notifications\/(\d+)\/download-attachment$/);
      if (method === 'POST' && downloadAttachMatch) {
        if (monitorState.isRunning) {
          sendJson(res, 409, {
            error: 'Hay una operación de Chrome en curso. Espera unos segundos a que termine.',
          });
          return;
        }

        const id = Number.parseInt(downloadAttachMatch[1], 10);
        const notif = clientService.getNotificationById(id);
        if (!notif) {
          sendJson(res, 404, { error: `No se encontró la notificación #${id}.` });
          return;
        }

        if (notif.attachmentPath && notif.attachmentPath !== 'NONE' && fs.existsSync(notif.attachmentPath)) {
          sendJson(res, 200, {
            ok: true,
            cached: true,
            hasAttachment: true,
            filename: notif.attachmentName || path.basename(notif.attachmentPath),
            url: `/api/notifications/${id}/attachment`,
            message: 'El archivo adjunto ya se encuentra descargado en el sistema.',
          });
          return;
        }

        if (notif.attachmentName === 'SIN_ADJUNTO' || notif.attachmentPath === 'NONE') {
          sendJson(res, 200, {
            ok: false,
            cached: true,
            hasAttachment: false,
            message: 'Esta comunicación es de carácter informativo y no contiene archivos adjuntos en el portal de SUNAT.',
          });
          return;
        }

        const credsList = clientService.getActiveCredentials(notif.clientId);
        if (credsList.length === 0) {
          sendJson(res, 400, {
            error: 'No se encontraron credenciales activas para el cliente de esta notificación.',
          });
          return;
        }
        const creds = credsList[0];

        monitorState.isRunning = true;
        monitorState.startedAt = new Date().toISOString();
        monitorState.progress = {
          index: 1,
          total: 1,
          clientId: notif.clientId,
          label: `${notif.clientLabel} - Descargando adjunto: ${notif.subject.slice(0, 30)}`,
          docNumber: notif.docNumber,
        };

        try {
          const destDir = path.resolve(process.cwd(), 'data', 'adjuntos', notif.docNumber);
          const dlRes = await downloadNotificationAttachmentFromSunat(
            creds,
            {
              id: notif.id,
              subject: notif.subject,
              sunatCode: notif.sunatCode,
              publishedAt: notif.publishedAt,
              notificationType: notif.notificationType,
              mailboxSource: notif.mailboxSource,
            },
            destDir,
            config,
          );

          if (dlRes.found && dlRes.filePath && dlRes.filename) {
            clientService.saveNotificationAttachment(id, dlRes.filePath, dlRes.filename);
            sendJson(res, 200, {
              ok: true,
              hasAttachment: true,
              filename: dlRes.filename,
              url: `/api/notifications/${id}/attachment`,
              message: dlRes.message || 'Archivo adjunto descargado con éxito.',
            });
          } else {
            clientService.saveNotificationAttachment(id, 'NONE', 'SIN_ADJUNTO');
            sendJson(res, 200, {
              ok: false,
              hasAttachment: false,
              message: dlRes.message || 'Esta comunicación es de carácter informativo y no contiene archivos adjuntos en el portal de SUNAT.',
            });
          }
        } catch (dlErr) {
          const msg = dlErr instanceof Error ? dlErr.message : String(dlErr);
          sendJson(res, 500, { error: `Error conectando con SUNAT: ${msg}` });
        } finally {
          monitorState.isRunning = false;
          monitorState.progress = null;
        }
        return;
      }

      const getAttachMatch = pathname.match(/^\/api\/notifications\/(\d+)\/attachment$/);
      if (method === 'GET' && getAttachMatch) {
        const id = Number.parseInt(getAttachMatch[1], 10);
        const notif = clientService.getNotificationById(id);
        if (!notif || !notif.attachmentPath || !fs.existsSync(notif.attachmentPath)) {
          sendJson(res, 404, { error: 'Archivo adjunto no encontrado en el servidor.' });
          return;
        }

        const ext = path.extname(notif.attachmentPath).toLowerCase();
        let contentType = 'application/octet-stream';
        if (ext === '.pdf') contentType = 'application/pdf';
        else if (ext === '.zip') contentType = 'application/zip';
        else if (ext === '.xml') contentType = 'application/xml';
        else if (ext === '.txt') contentType = 'text/plain; charset=utf-8';
        else if (ext === '.xlsx') {
          contentType =
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
        } else if (ext === '.xls') contentType = 'application/vnd.ms-excel';

        const filename = notif.attachmentName || path.basename(notif.attachmentPath);
        res.writeHead(200, {
          'Content-Type': contentType,
          'Content-Disposition': `inline; filename="${encodeURIComponent(filename)}"`,
        });
        fs.createReadStream(notif.attachmentPath).pipe(res);
        return;
      }

      if (method === 'POST' && pathname === '/api/notifications/ack-all') {
        const body = await readJsonBody<{ clientId?: number }>(req);
        const cid =
          typeof body.clientId === 'number' && Number.isFinite(body.clientId)
            ? body.clientId
            : undefined;

        if (monitorState.isRunning) {
          sendJson(res, 409, {
            error: 'Ya hay una operación de Chrome en curso. Espera unos segundos a que termine.',
            monitorState,
          });
          return;
        }

        const unread = clientService.listNotifications({
          onlyNew: true,
          clientId: cid,
          limit: 120,
        });

        if (unread.length === 0) {
          sendJson(res, 200, {
            ok: true,
            updatedCount: 0,
            message: 'No hay alertas pendientes para marcar.',
          });
          return;
        }

        // Agrupar por contribuyente para iniciar sesión una sola vez por cliente
        const byClient = new Map<number, typeof unread>();
        for (const notif of unread) {
          const list = byClient.get(notif.clientId) || [];
          list.push(notif);
          byClient.set(notif.clientId, list);
        }

        monitorState.isRunning = true;
        monitorState.startedAt = new Date().toISOString();
        monitorState.progress = {
          index: 0,
          total: unread.length,
          clientId: unread[0].clientId,
          label: `${unread[0].clientLabel} (iniciando...)`,
          docNumber: unread[0].docNumber,
        };

        void (async () => {
          let totalMarked = 0;
          let overallIndex = 0;

          try {
            for (const [clientId, clientNotifs] of byClient.entries()) {
              const credsList = clientService.getActiveCredentials(clientId);
              if (credsList.length === 0) continue;
              const creds = credsList[0];

              const targets = clientNotifs.map((n) => ({
                id: n.id,
                subject: n.subject,
                sunatCode: n.sunatCode,
                publishedAt: n.publishedAt,
                notificationType: n.notificationType,
                mailboxSource: n.mailboxSource,
              }));

              try {
                const markRes = await markMultipleNotificationsAsReadInSunat(
                  creds,
                  targets,
                  config,
                  (idx, total, current) => {
                    overallIndex++;
                    monitorState.progress = {
                      index: overallIndex,
                      total: unread.length,
                      clientId: creds.clientId,
                      label: `${creds.label} - ${current.subject.slice(0, 30)}`,
                      docNumber: creds.docNumber,
                    };
                  },
                );

                for (const r of markRes.results) {
                  if (r.target.id) {
                    clientService.markNotificationAsReadSunat(r.target.id);
                    totalMarked++;
                  }
                }
              } catch (clientErr) {
                for (const item of targets) {
                  if (item.id) {
                    clientService.markNotificationAsReviewed(item.id);
                    totalMarked++;
                  }
                }
              }
            }

            monitorState.lastSummary = {
              clientsChecked: byClient.size,
              clientsOk: byClient.size,
              clientsFailed: 0,
              newNotificationsTotal: 0,
            };
          } catch (batchErr) {
            monitorState.lastRunError =
              batchErr instanceof Error ? batchErr.message : String(batchErr);
          } finally {
            monitorState.isRunning = false;
            monitorState.progress = null;
          }
        })();

        sendJson(res, 202, {
          ok: true,
          message: `Iniciando marcado en SUNAT para ${unread.length} notificación(es)...`,
          monitorState,
        });
        return;
      }

      if (method === 'POST' && pathname === '/api/check') {
        const body = await readJsonBody<{ clientId?: number }>(req);
        const cid =
          typeof body.clientId === 'number' && Number.isFinite(body.clientId) && body.clientId > 0
            ? body.clientId
            : undefined;

        const started = triggerCheck(cid);
        if (!started) {
          sendJson(res, 409, {
            error: 'Ya hay una revision de Chrome en curso. Espera unos segundos a que termine.',
            monitorState,
          });
          return;
        }

        sendJson(res, 202, {
          ok: true,
          message: cid
            ? `Revisión en segundo plano iniciada para el cliente ID ${cid}.`
            : 'Revisión general iniciada en segundo plano.',
          monitorState,
        });
        return;
      }

      sendJson(res, 404, { error: 'Ruta API no encontrada.' });
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Error interno del servidor.';
      const status =
        /obligatori|invalido|digitos|existe|demasiado grande/i.test(msg) ? 400 : 500;
      sendJson(res, status, { error: msg });
    }
  });
}

// Ejecutar directamente cuando se invoca con npm run web
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);
if (isMain) {
  const config = getConfig();
  const encryptionKey = requireEncryptionKey(config);
  const db = getDatabase(config.dbPath);
  const clientService = new ClientService(db, encryptionKey);
  const server = createWebServer(clientService, config);

  const shutdown = () => {
    console.log('\n[Web] Cerrando servidor web...');
    server.close(() => {
      closeDatabase();
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  server.listen(config.port, config.host, () => {
    console.log(`\n=== Panel Web Monitor SUNAT ===`);
    console.log(`Abre en tu navegador: http://${config.host}:${config.port}`);
    console.log(`Base de datos: ${config.dbPath}`);
    console.log(
      `Modo Chrome: ${config.headless ? 'Segundo plano oculto (HEADLESS=true)' : 'Ventana visible (HEADLESS=false)'}\n`,
    );
  });
}
