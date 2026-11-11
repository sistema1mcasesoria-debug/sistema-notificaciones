import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { chromium } from 'playwright';
import { getConfig } from '../config/env.js';
import { closeDatabase, getDatabase } from '../db/database.js';
import { generateEncryptionKeyHex } from '../security/crypto.js';
import { ClientService } from '../services/clientService.js';
import { createWebServer } from './webServer.js';

test('migraciones v2 y v3 limpian filas heredadas sin fecha y conservan notificaciones validas', () => {
  const tmpDb = path.join(os.tmpdir(), `sunat_mig_test_${Date.now()}.db`);
  const key = generateEncryptionKeyHex();

  // Simular BD creada en v1 con filas basura {"text": ...}, filas sin fecha y una valida
  const seedDb = new DatabaseSync(tmpDb);
  seedDb.exec(`
    CREATE TABLE clients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT NOT NULL,
      login_mode TEXT NOT NULL DEFAULT 'RUC',
      doc_number TEXT NOT NULL,
      sol_user_enc TEXT,
      sol_password_enc TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      last_checked_at TEXT,
      last_status TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      UNIQUE(login_mode, doc_number)
    );
    CREATE TABLE notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      external_hash TEXT NOT NULL,
      sunat_code TEXT,
      subject TEXT NOT NULL,
      sender TEXT,
      notification_type TEXT,
      published_at TEXT,
      read_status_sunat TEXT,
      is_new_alert INTEGER NOT NULL DEFAULT 1,
      raw_row_json TEXT,
      first_seen_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      UNIQUE(client_id, external_hash)
    );
    INSERT INTO clients (label, login_mode, doc_number, sol_user_enc, sol_password_enc)
    VALUES ('Cliente Legacy', 'RUC', '20111111111', 'u', 'p');
    INSERT INTO notifications (client_id, external_hash, subject, published_at, raw_row_json)
    VALUES
      (1, 'hash_ruido_v1', 'Monto a Pagar: S/.', NULL, '{"text":"Monto a Pagar: S/."}'),
      (1, 'hash_tabla_interna', '07-Nota de Crédito', NULL, '{"Tipo de Documento":"07-Nota de Crédito"}'),
      (1, 'hash_valida', 'Resolucion de Prueba', '20/09/2024 16:18:15', '{"FechaSUNAT":"20/09/2024 16:18:15"}');
  `);
  seedDb.close();

  try {
    const db = getDatabase(tmpDb);
    const svc = new ClientService(db, key);
    const remaining = svc.listNotifications();
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].subject, 'Resolucion de Prueba');
    assert.equal(remaining[0].publishedAt, '20/09/2024 16:18:15');
  } finally {
    closeDatabase();
    fs.rmSync(tmpDb, { force: true });
  }
});

test('listNotifications ordena estrictamente de fecha mas reciente a mas antigua (descendente)', () => {
  const tmpDb = path.join(os.tmpdir(), `sunat_order_test_${Date.now()}.db`);
  const key = generateEncryptionKeyHex();

  try {
    const db = getDatabase(tmpDb);
    const svc = new ClientService(db, key);
    const clientId = svc.addClient({
      label: 'Cliente Orden',
      loginMode: 'RUC',
      docNumber: '20123456789',
      solUser: 'USER',
      solPassword: 'PASS',
    });

    // Insertar en orden desordenado y con distinto is_new_alert / mes
    db.prepare(`
      INSERT INTO notifications (client_id, external_hash, subject, published_at, read_status_sunat, is_new_alert, first_seen_at)
      VALUES
        (?, 'h_09', 'Notif dia 09', '09/11/2026 10:00:00', 'Leído', 0, '2026-11-11 09:00:00'),
        (?, 'h_11', 'Notif dia 11', '11/11/2026 08:15:00', 'Leído', 0, '2026-11-11 09:00:00'),
        (?, 'h_08', 'Notif dia 08', '08/11/2026 17:30:00', 'Pendiente', 1, '2026-11-11 09:00:00'),
        (?, 'h_10', 'Notif dia 10', '10/11/2026 14:20:00', 'No leído', 1, '2026-11-11 09:00:00'),
        (?, 'h_sep', 'Notif septiembre', '30/09/2026 11:00:00', 'Leído', 0, '2026-11-11 09:00:00')
    `).run(clientId, clientId, clientId, clientId, clientId);

    const ordered = svc.listNotifications({ clientId });
    assert.deepEqual(
      ordered.map((n) => n.publishedAt),
      [
        '11/11/2026 08:15:00',
        '10/11/2026 14:20:00',
        '09/11/2026 10:00:00',
        '08/11/2026 17:30:00',
        '30/09/2026 11:00:00',
      ],
    );

    const topTwo = svc.listNotifications({ clientId, limit: 2 });
    assert.deepEqual(
      topTwo.map((n) => n.publishedAt),
      ['11/11/2026 08:15:00', '10/11/2026 14:20:00'],
    );
  } finally {
    closeDatabase();
    fs.rmSync(tmpDb, { force: true });
  }
});

test('API REST, seguridad, indicador Cargando y panel web en Chrome funcionan correctamente', async () => {
  const tmpDb = path.join(os.tmpdir(), `sunat_web_test_${Date.now()}.db`);
  const key = generateEncryptionKeyHex();
  const db = getDatabase(tmpDb);
  const svc = new ClientService(db, key);
  const cfg = { ...getConfig(), dbPath: tmpDb, encryptionKey: key };

  const server = createWebServer(svc, cfg, path.resolve(process.cwd(), 'public'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    // 1. Verificar archivos estaticos, CSP y bloqueo de path traversal
    const rRoot = await fetch(`${baseUrl}/`);
    assert.equal(rRoot.status, 200);
    assert.ok(rRoot.headers.get('content-security-policy')?.includes("script-src 'self'"));
    assert.equal(rRoot.headers.get('x-frame-options'), 'DENY');

    const rTraversal = await fetch(`${baseUrl}/..%2fpackage.json`);
    assert.ok([403, 404].includes(rTraversal.status));

    // 2. Probar alta de cliente y verificar que la clave SOL nunca se filtre por API
    const addRes = await fetch(`${baseUrl}/api/clients`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        label: 'Empresa Demo SAC',
        loginMode: 'RUC',
        docNumber: '20100000001',
        solUser: 'DEMOUSR1',
        solPassword: 'SuperSecretPassword!',
      }),
    });
    assert.equal(addRes.status, 201);
    const added = (await addRes.json()) as { clientId: number };

    svc.recordCheckResult({
      clientId: added.clientId,
      startedAt: '2026-11-10 09:00:00',
      finishedAt: '2026-11-10 09:00:05',
      status: 'OK',
      notifications: [
        {
          sunatCode: 'RES-2026-991',
          subject: 'Resolucion de Ejecucion Coactiva de prueba',
          sender: 'Intendencia Lima',
          notificationType: 'Resolucion',
          publishedAt: '10/11/2026 08:30',
          readStatusSunat: 'No leido',
          rawRow: { Nro: 'RES-2026-991', Asunto: 'Resolucion de Ejecucion Coactiva de prueba' },
        },
      ],
    });

    const dashRes = await fetch(`${baseUrl}/api/dashboard`);
    assert.equal(dashRes.status, 200);
    const dashText = await dashRes.text();
    assert.ok(!dashText.includes('SuperSecretPassword!'));
    const dashJson = JSON.parse(dashText) as {
      stats: { unreadAlerts: number };
      notifications: Array<{ id: number }>;
    };
    assert.equal(dashJson.stats.unreadAlerts, 1);
    assert.equal(dashJson.notifications.length, 1);

    // 3. Prueba en Chrome real (desktop y movil)
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
      page.on('console', (msg) => {
        if (msg.type() === 'error') errors.push(`console: ${msg.text()}`);
      });

      await page.goto(baseUrl, { waitUntil: 'networkidle' });
      assert.equal(await page.locator('#kpi-unread').textContent(), '1');
      assert.ok(await page.locator('#notifications-tbody tr').first().isVisible());
      assert.ok(await page.locator('.badge-urgent').first().isVisible());

      // Interceptar llamada a /api/notifications/*/mark-read-sunat para simular éxito sin login real a SUNAT
      await page.route('**/api/notifications/*/mark-read-sunat', async (route) => {
        svc.markNotificationAsReadSunat(dashJson.notifications[0].id);
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            foundInSunat: true,
            message: 'Notificación marcada como leída en SUNAT.',
          }),
        });
      });

      // Probar que el icono de check en la fila esté presente antes de ser revisada
      assert.ok(await page.locator('#notifications-tbody button.btn-action-check').first().isVisible());

      // Abrir detalle en <dialog> usando el icono del ojito
      await page.click('#notifications-tbody button[title="Ver detalle"]');
      assert.ok(await page.locator('#detail-dialog[open]').isVisible());
      await page.click('#btn-detail-ack');
      await page.waitForTimeout(400);
      assert.equal(await page.locator('#kpi-unread').textContent(), '0');

      // Si ya está revisada, el check NO debe aparecer otra vez (solo queda el ojito)
      assert.equal(await page.locator('#notifications-tbody button.btn-action-check').count(), 0);

      // Cambiar a pestana Clientes y probar modal de nuevo cliente
      await page.click('#tab-clients');
      assert.equal(await page.locator('#panel-clients').isVisible(), true);
      assert.equal(await page.locator('#panel-inbox').isVisible(), false);

      await page.click('#btn-clients-add');
      assert.ok(await page.locator('#client-dialog[open]').isVisible());
      await page.click('#mode-dni');
      assert.equal(await page.locator('#sol-user-group').isVisible(), false);
      await page.click('#mode-ruc');
      assert.equal(await page.locator('#sol-user-group').isVisible(), true);
      await page.click('#btn-cancel-client');

      // Probar indicador "Cargando" al iniciar revision en segundo plano
      await page.route('**/api/check', async (route) => {
        await route.fulfill({
          status: 202,
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            message: 'Revisión general iniciada en segundo plano.',
            monitorState: {
              isRunning: true,
              startedAt: new Date().toISOString(),
              progress: {
                index: 1,
                total: 1,
                clientId: added.clientId,
                label: 'Empresa Demo SAC',
                docNumber: '20100000001',
              },
              lastSummary: null,
              lastRunError: null,
            },
          }),
        });
      });

      let pollCount = 0;
      await page.route('**/api/status', async (route) => {
        pollCount++;
        const running = pollCount < 2;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            stats: dashJson.stats,
            monitorState: {
              isRunning: running,
              startedAt: new Date().toISOString(),
              progress: running
                ? {
                    index: 1,
                    total: 1,
                    clientId: added.clientId,
                    label: 'Empresa Demo SAC',
                    docNumber: '20100000001',
                  }
                : null,
              lastSummary: running
                ? null
                : { clientsChecked: 1, clientsOk: 1, clientsFailed: 0, newNotificationsTotal: 0 },
              lastRunError: null,
            },
          }),
        });
      });

      await page.click('#btn-check-all');
      await page.waitForSelector('#loading-banner:not([hidden])');
      assert.equal(await page.locator('progress.loading-spinner').isVisible(), true);
      assert.equal(await page.locator('#btn-check-all').textContent(), 'Cargando...');
      assert.equal(await page.locator('#btn-check-all').isDisabled(), true);
      assert.ok(
        (await page.locator('#loading-banner-detail').textContent())?.includes('Empresa Demo SAC'),
      );

      // Esperar que termine el polling simulado y desaparezca el banner
      await page.waitForSelector('#loading-banner', { state: 'hidden', timeout: 5000 });
      assert.equal(await page.locator('#btn-check-all').textContent(), 'Revisar todos ahora');
      await page.unroute('**/api/check');
      await page.unroute('**/api/status');

      // Probar vista movil responsive (<680px container)
      await page.setViewportSize({ width: 375, height: 812 });
      await page.click('#tab-inbox');
      await page.waitForTimeout(100);
      const layoutMetrics = await page.evaluate(() => {
        const vw = window.innerWidth;
        const sw = document.documentElement.scrollWidth;
        const wide = [...document.querySelectorAll('*')]
          .map((el) => {
            const r = el.getBoundingClientRect();
            return { tag: el.tagName, id: el.id, cls: el.className, right: Math.round(r.right), width: Math.round(r.width) };
          })
          .filter((x) => x.right > vw && x.width > 0)
          .slice(0, 10);
        return { vw, sw, wide };
      });
      assert.equal(
        layoutMetrics.sw <= layoutMetrics.vw + 2,
        true,
        `Horizontal overflow detected: ${JSON.stringify(layoutMetrics)}`,
      );

      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDatabase();
    fs.rmSync(tmpDb, { force: true });
  }
});
