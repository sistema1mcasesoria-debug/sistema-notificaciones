import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { extractNotificationsFromFrame } from './sunatScraper.js';

test('extractNotificationsFromFrame filtra ruido del portal SUNAT y extrae fecha, asunto, codigo y categoria', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });

  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

    await page.setContent(`
      <!DOCTYPE html>
      <html lang="es">
        <head>
          <style>
            .hidden { display: none; }
            .modal { display: none; }
            .modal.in { display: block; }
          </style>
        </head>
        <body>
          <div id="app">
            <h2>Buzón Electrónico - Notificaciones Recibidas</h2>

            <!-- Ruido de menú lateral SUNAT -->
            <ul class="list-group">
              <li class="list-group-item">Personas</li>
              <li class="list-group-item">Empresas</li>
              <li class="list-group-item">Operador de Comercio Exterior</li>
              <li class="list-group-item">Buzón Notificaciones</li>
              <li class="list-group-item">Buzón Mensajes (2)</li>
              <li class="list-group-item">Órdenes de Pago</li>
              <li class="list-group-item">Resoluciones de Ejecución Coactiva</li>
            </ul>

            <!-- Lista real de notificaciones (con spans pegados, etiquetas separadas y contenedor padre duplicado) -->
            <div class="list-group">
              <div class="list-group-item">
                <div class="list-group-item list-group-item-info">
                  <div><strong>ASUNTO:</strong> <span>Notificación de Valor N° 023-002-2694674</span></div>
                  <div><span>SOL</span><span>20/09/2024 16:18:15</span><span>VALORES</span></div>
                </div>
              </div>

              <div class="list-group-item">
                <div><span>ASUNTO: Notificación de Resolución de Determinación N° 123022233770</span></div>
                <div>N° 12302223377018/12/2023 21:21:49RESOLUCIONES DE FISCALIZACION</div>
              </div>
            </div>

            <!-- Ruido de formulario/modal oculto de fraccionamiento o pago de deuda -->
            <div class="modal" id="modalPago">
              <div class="list-group-item">*El campo monto a pagar es editable. Siguiente</div>
              <div class="list-group-item">Monto a Pagar: S/.</div>
              <div class="list-group-item">Etapa Documento: Saldo Documento: S/.2881,122</div>
            </div>
          </div>
        </body>
      </html>
    `);

    const res = await extractNotificationsFromFrame(page.mainFrame(), 'Notificación SUNAT');

    assert.equal(res.foundMailboxView, true);
    assert.equal(res.isExplicitlyEmpty, false);
    assert.equal(res.items.length, 2, `Items inesperados: ${JSON.stringify(res.items)}`);

    assert.equal(res.items[0].publishedAt, '20/09/2024 16:18:15');
    assert.equal(res.items[0].sunatCode, '023-002-2694674');
    assert.equal(res.items[0].notificationType, 'VALORES');
    assert.equal(res.items[0].sender, 'SOL');
    assert.equal(res.items[0].subject, 'Notificación de Valor N° 023-002-2694674');
    assert.equal(res.items[0].readStatusSunat, 'No leído');

    assert.equal(res.items[1].publishedAt, '18/12/2023 21:21:49');
    assert.equal(res.items[1].sunatCode, '123022233770');
    assert.equal(res.items[1].notificationType, 'RESOLUCIONES DE FISCALIZACION');
    assert.equal(res.items[1].subject, 'Notificación de Resolución de Determinación N° 123022233770');
    assert.equal(res.items[1].readStatusSunat, 'Leído');
  } finally {
    await browser.close();
  }
});

test('extractNotificationsFromFrame soporta vista de tabla clásica de respaldo', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });

  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

    await page.setContent(`
      <!DOCTYPE html>
      <html lang="es">
        <body>
          <h3>Buzón Mensajes</h3>
          <table>
            <thead>
              <tr>
                <th>Código</th>
                <th>Fecha</th>
                <th>Asunto</th>
                <th>Estado</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>MSG-2026-01</td>
                <td>05/11/2026 09:15</td>
                <td>Comunicado de campaña de actualización RUC</td>
                <td>No leído</td>
              </tr>
            </tbody>
          </table>
        </body>
      </html>
    `);

    const res = await extractNotificationsFromFrame(page.mainFrame(), 'Mensaje SUNAT');

    assert.equal(res.foundMailboxView, true);
    assert.equal(res.items.length, 1);
    assert.equal(res.items[0].sunatCode, 'MSG-2026-01');
    assert.equal(res.items[0].publishedAt, '05/11/2026 09:15');
    assert.equal(res.items[0].subject, 'Comunicado de campaña de actualización RUC');
    assert.equal(res.items[0].notificationType, 'Mensaje SUNAT');
    assert.equal(res.items[0].readStatusSunat, 'No leído');
  } finally {
    await browser.close();
  }
});
