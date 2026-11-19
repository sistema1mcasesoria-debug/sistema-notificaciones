import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import type { AppConfig } from '../config/env.js';
import type {
  AttachmentDownloadResult,
  ClientCredentials,
  DownloadAttachmentTarget,
  ScrapeResult,
  SunatNotificationItem,
} from './types.js';

const SUNAFIL_LOGIN_URL = 'https://casillaelectronica.sunafil.gob.pe/si.inbox/Login/SUNAT';

const SUNAFIL_SECTIONS = [
  {
    source: 'FISCALIZACION' as const,
    name: 'Notificaciones de Fiscalización',
    url: 'https://casillaelectronica.sunafil.gob.pe/si.inbox/Notificacion/Empleador',
    menuText: 'Notificaciones de Fiscalización',
  },
  {
    source: 'COBRANZA' as const,
    name: 'Notificaciones de Cobranza',
    url: 'https://casillaelectronica.sunafil.gob.pe/si.inbox/Notificacion/CobroOrdinario',
    menuText: 'Notificaciones de Cobranza',
  },
  {
    source: 'ACCIONES_PREVIAS' as const,
    name: 'Acciones Previas',
    url: 'https://casillaelectronica.sunafil.gob.pe/si.inbox/ActosAdministrativos/ListadoRequerimientos',
    menuText: 'Acciones Previas',
  },
  {
    source: 'ORIENTACION' as const,
    name: 'Sunafil te Orienta',
    url: 'https://casillaelectronica.sunafil.gob.pe/si.inbox/Orientacion/ListadoOrientacionEmpleador',
    menuText: 'Sunafil te Orienta',
  },
];

function logsDir(): string {
  const dir = path.resolve(process.cwd(), 'logs');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

async function saveDebugScreenshot(page: Page, docNumber: string, prefix: string): Promise<string> {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(logsDir(), `sunafil_${docNumber}_${prefix}_${ts}.png`);
  try {
    await page.screenshot({ path: file, fullPage: false });
    return file;
  } catch {
    return '';
  }
}

export async function dismissSunafilModals(page: Page): Promise<void> {
  // 1. Modal de notificación inicial ("Estimado usuario, no tiene nuevas notificaciones...")
  const notifModalClose = page.locator(
    '#formNotificaciones\\:mdNotificaciones button.close, .scNotificaciones button.close, #formNotificaciones\\:mdNotificaciones [data-dismiss="modal"]',
  ).first();

  if (await notifModalClose.isVisible({ timeout: 1500 }).catch(() => false)) {
    await notifModalClose.click().catch(() => {});
    await page.waitForTimeout(800);
  }

  // 2. Modal de términos y condiciones (si aparece)
  const terminosAcepto = page.locator('#frmTerminosYCondiciones button:has-text("Acepto"), .scTerminosYCondiciones button:has-text("Acepto")').first();
  if (await terminosAcepto.isVisible({ timeout: 1500 }).catch(() => false)) {
    await terminosAcepto.click().catch(() => {});
    await page.waitForTimeout(800);
  }

  // 3. Otros botones de cierre emergentes
  const genericClose = page.locator('.modal.in button.close, .modal.show button.close').first();
  if (await genericClose.isVisible({ timeout: 1000 }).catch(() => false)) {
    await genericClose.click().catch(() => {});
    await page.waitForTimeout(600);
  }
}

export async function performSunafilLogin(page: Page, credentials: ClientCredentials, config: AppConfig): Promise<void> {
  await page.goto(SUNAFIL_LOGIN_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#btnAceptar', { state: 'visible' });

  if (credentials.loginMode === 'RUC') {
    await page.click('#btnPorRuc');
    await page.waitForSelector('#txtRuc', { state: 'visible' });
    await page.fill('#txtRuc', credentials.docNumber);
    await page.fill('#txtUsuario', credentials.solUser.toUpperCase());
    await page.fill('#txtContrasena', credentials.solPassword);
  } else {
    await page.click('#btnPorDni');
    await page.waitForSelector('#txtDni', { state: 'visible' });
    await page.fill('#txtDni', credentials.docNumber);
    await page.fill('#txtContrasena', credentials.solPassword);
  }

  await page.click('#btnAceptar');

  const outcome = await Promise.race([
    page
      .waitForURL((url) => url.hostname.includes('sunafil.gob.pe'), {
        timeout: config.navigationTimeoutMs,
        waitUntil: 'domcontentloaded',
      })
      .then(() => 'LOGGED_IN' as const),
    page
      .waitForSelector('#btnWithOutCode', {
        state: 'visible',
        timeout: config.navigationTimeoutMs,
      })
      .then(() => 'MFA_WITHOUT_CODE' as const),
    page
      .waitForSelector(
        'text=/sesi[oó]n\\s+(?:activa|iniciada|en\\s+uso)|ya\\s+tiene\\s+una\\s+sesi[oó]n|otra\\s+sesi[oó]n|sesi[oó]n\\s+abierta/i',
        {
          state: 'visible',
          timeout: config.navigationTimeoutMs,
        },
      )
      .then(() => 'SESSION_ACTIVE' as const),
    page
      .waitForSelector('#divMensajeError:not(.hidden)', {
        state: 'visible',
        timeout: config.navigationTimeoutMs,
      })
      .then(() => 'AUTH_ERROR' as const),
    page
      .waitForSelector('#txtCaptcha', {
        state: 'visible',
        timeout: config.navigationTimeoutMs,
      })
      .then(() => 'CAPTCHA' as const),
  ]);

  if (outcome === 'SESSION_ACTIVE') {
    throw new Error('Sesión activa en otra máquina: Por favor cierre la sesión en uso para poder sincronizar.');
  }

  if (outcome === 'MFA_WITHOUT_CODE') {
    const btnWithoutCode = page.locator('#btnWithOutCode').first();
    await btnWithoutCode.click({ timeout: 5000 }).catch(() => {});
    await page.waitForURL((url) => url.hostname.includes('sunafil.gob.pe'), {
      timeout: config.navigationTimeoutMs,
      waitUntil: 'domcontentloaded',
    });
  } else if (outcome === 'AUTH_ERROR') {
    const errorText =
      (await page.locator('#spanMensajeError').textContent().catch(() => null))?.trim() ||
      'Credenciales inválidas al intentar ingresar a SUNAFIL.';
    throw new Error(errorText);
  } else if (outcome !== 'LOGGED_IN') {
    throw new Error(
      outcome === 'CAPTCHA'
        ? 'SUNAT/SUNAFIL solicitó captcha. No se pudo iniciar sesión.'
        : 'Credenciales inválidas al intentar ingresar a SUNAFIL.',
    );
  }

  await page.waitForTimeout(2000);
  await dismissSunafilModals(page);
}

/**
 * Extracts notification rows from standard DataTables in SUNAFIL.
 */
async function scrapeSunafilTable(
  page: Page,
  sectionSource: 'FISCALIZACION' | 'COBRANZA' | 'ACCIONES_PREVIAS' | 'ORIENTACION',
): Promise<SunatNotificationItem[]> {
  const items: SunatNotificationItem[] = [];

  // Esperar a que la tabla o mensaje de "Ningún dato" esté presente
  await page.waitForSelector('table, .dataTables_wrapper, tbody', { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(1000);

  const rawRows = await page.evaluate((source) => {
    const results: Array<{
      columns: string[];
      rawRow: Record<string, string>;
      hasDocButton: boolean;
    }> = [];

    const table = document.querySelector('table.dataTable, table');
    if (!table) return results;

    const headerCells = Array.from(table.querySelectorAll('thead th')).map(
      (th) => (th.textContent || '').replace(/\s+/g, ' ').trim(),
    );

    const rows = Array.from(table.querySelectorAll('tbody tr'));
    for (const row of rows) {
      const text = (row.textContent || '').replace(/\s+/g, ' ').trim();
      if (
        !text ||
        /ning[uú]n\s+dato\s+disponible|no\s+se\s+encontraron|sesi[oó]n\s+ha\s+caducado|cargando/i.test(text)
      ) {
        continue;
      }

      const cells = Array.from(row.querySelectorAll('td')).map((td) => {
        const clone = td.cloneNode(true) as HTMLElement;
        clone.querySelectorAll('script, style').forEach((s) => s.remove());
        const cleaned = (clone.textContent || '').replace(/\s+/g, ' ').trim();
        return cleaned.startsWith('$(') ? '' : cleaned;
      });

      if (cells.length === 0 || (cells.length === 1 && cells[0].length < 3)) {
        continue;
      }

      const rawRow: Record<string, string> = {};
      for (let i = 0; i < cells.length; i++) {
        const header = headerCells[i] || `col_${i + 1}`;
        rawRow[header] = cells[i];
      }

      const hasDocButton = Boolean(
        row.querySelector('.fa-file-pdf-o, .fa-file, .btn-danger, .btn-primary, [title*="PDF" i]'),
      );

      results.push({ columns: cells, rawRow, hasDocButton });
    }

    return results;
  }, sectionSource);

  for (const row of rawRows) {
    const r = row.rawRow;

    if (sectionSource === 'FISCALIZACION') {
      const orden = r['Orden de Inspección'] || row.columns[0] || '';
      const intendencia = r['Intendencia'] || row.columns[1] || '';
      const estado = r['Estado'] || row.columns[2] || '';

      items.push({
        portal: 'SUNAFIL',
        sunatCode: orden || null,
        subject: `Orden de Inspección ${orden} - ${intendencia}`.trim(),
        sender: intendencia || 'SUNAFIL',
        notificationType: 'Notificación de Fiscalización',
        mailboxSource: 'FISCALIZACION',
        publishedAt: null,
        readStatusSunat: estado || 'Notificado',
        rawRow: r,
      });
    } else if (sectionSource === 'COBRANZA') {
      const expediente = r['Expediente Sancionador'] || row.columns[0] || '';
      const intendencia = r['Intendencia'] || row.columns[1] || '';

      items.push({
        portal: 'SUNAFIL',
        sunatCode: expediente || null,
        subject: `Expediente Sancionador ${expediente} - ${intendencia}`.trim(),
        sender: intendencia || 'SUNAFIL',
        notificationType: 'Notificación de Cobranza',
        mailboxSource: 'COBRANZA',
        publishedAt: null,
        readStatusSunat: 'Notificado',
        rawRow: r,
      });
    } else if (sectionSource === 'ACCIONES_PREVIAS') {
      const tipoReq = r['Tipo de Requerimiento'] || row.columns[0] || 'Carta Inductiva';
      const registro = r['Registro'] || row.columns[1] || '';
      const fechaDep = r['Fecha de Depósito'] || row.columns[2] || '';
      const fechaAcuse = r['Fecha Acuse de Recibo'] || row.columns[3] || '';
      const fechaNotif = r['Fecha de Notificación'] || row.columns[4] || '';
      const plazo = r['Plazo'] || row.columns[5] || '';
      const fechaLimite = r['Fecha Límite de Presentación'] || row.columns[6] || '';

      // Extraer fecha limpia (DD/MM/YYYY)
      const cleanFecha = (fechaNotif || fechaDep).match(/\d{1,2}[/-]\d{1,2}[/-]\d{4}/)?.[0] || fechaDep || null;

      items.push({
        portal: 'SUNAFIL',
        sunatCode: registro || null,
        subject: `${tipoReq} ${registro}`.trim(),
        sender: 'SUNAFIL',
        notificationType: tipoReq,
        mailboxSource: 'ACCIONES_PREVIAS',
        publishedAt: cleanFecha,
        deadlineAt: fechaLimite || null,
        termDays: plazo || null,
        readStatusSunat: fechaAcuse && fechaAcuse.length > 5 ? 'Leído' : 'Pendiente',
        rawRow: r,
      });
    } else if (sectionSource === 'ORIENTACION') {
      const categoria = r['Categoría'] || row.columns[0] || 'Orientación';
      const fechaDep = r['Fecha de Depósito'] || row.columns[1] || '';
      const asunto = r['Asunto'] || row.columns[2] || 'Comunicado de Orientación';
      const estado = r['Estado'] || row.columns[3] || '';

      const cleanFecha = fechaDep.match(/\d{1,2}[/-]\d{1,2}[/-]\d{4}/)?.[0] || fechaDep || null;

      items.push({
        portal: 'SUNAFIL',
        sunatCode: null,
        subject: asunto,
        sender: 'SUNAFIL Orienta',
        notificationType: categoria,
        mailboxSource: 'ORIENTACION',
        publishedAt: cleanFecha,
        readStatusSunat: /le[ií]do/i.test(estado) ? 'Leído' : 'Pendiente',
        rawRow: r,
      });
    }
  }

  return items;
}

export async function checkSunafilMailbox(
  credentials: ClientCredentials,
  config: AppConfig,
): Promise<ScrapeResult> {
  let browser: Browser | null = null;
  try {
    const channel = config.browserChannel || 'chrome';
    browser = await chromium.launch({
      channel,
      headless: config.headless,
      args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
    });

    const majorVersion = browser.version().split('.')[0] || '133';
    const context = await browser.newContext({
      locale: 'es-PE',
      timezoneId: 'America/Lima',
      viewport: { width: 1400, height: 900 },
      userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${majorVersion}.0.0.0 Safari/537.36`,
    });

    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    const page = await context.newPage();
    page.setDefaultTimeout(config.navigationTimeoutMs);

    // 1. Login con Clave SOL en SUNAFIL
    await performSunafilLogin(page, credentials, config);

    // 2. Recorrer las 4 secciones
    const allNotifications: SunatNotificationItem[] = [];

    for (const sec of SUNAFIL_SECTIONS) {
      try {
        const link = page.locator(`a:has-text("${sec.menuText}"), [href*="${sec.menuText}"]`).first();
        if (await link.isVisible({ timeout: 2000 }).catch(() => false)) {
          await link.click();
        } else {
          await page.goto(sec.url, { waitUntil: 'domcontentloaded' });
        }
        await page.waitForTimeout(2000);
        await dismissSunafilModals(page);

        const sectionItems = await scrapeSunafilTable(page, sec.source);
        allNotifications.push(...sectionItems);
      } catch (err) {
        // Si una sección falla, continuar con las siguientes
      }
    }

    await browser.close();
    browser = null;

    return {
      status: 'OK',
      notifications: allNotifications,
      message: `Buzón SUNAFIL sincronizado con éxito: ${allNotifications.length} comunicación(es) encontrada(s).`,
    };
  } catch (err) {
    if (browser) {
      await browser.close().catch(() => {});
    }
    const message = err instanceof Error ? err.message : String(err);
    const status = /sesi[oó]n\s+activa/i.test(message)
      ? 'SESSION_ACTIVE'
      : /captcha/i.test(message)
      ? 'CAPTCHA'
      : /inv[aá]lid|clave|contrase/i.test(message)
      ? 'AUTH_ERROR'
      : 'ERROR';

    return {
      status,
      notifications: [],
      message,
    };
  }
}

export async function downloadSunafilAttachment(
  credentials: ClientCredentials,
  target: DownloadAttachmentTarget,
  destinationDir: string,
  config: AppConfig,
): Promise<AttachmentDownloadResult> {
  // 0. En Sunafil te Orienta las comunicaciones son boletines informativos HTML y no contienen archivo descargable
  if (target.mailboxSource === 'ORIENTACION') {
    return {
      found: false,
      message: 'Esta comunicación es un boletín informativo y no contiene archivo descargable en SUNAFIL.',
    };
  }

  let browser: Browser | null = null;
  try {
    const channel = config.browserChannel || 'chrome';
    browser = await chromium.launch({
      channel,
      headless: config.headless,
      args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
    });

    const majorVersion = browser.version().split('.')[0] || '133';
    const context = await browser.newContext({
      locale: 'es-PE',
      timezoneId: 'America/Lima',
      viewport: { width: 1400, height: 900 },
      acceptDownloads: true,
      userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${majorVersion}.0.0.0 Safari/537.36`,
    });

    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    const page = await context.newPage();
    page.setDefaultTimeout(15000);

    // 1. Iniciar sesión
    await performSunafilLogin(page, credentials, config);

    // 2. Determinar la sección a visitar
    const targetSection = SUNAFIL_SECTIONS.find((s) => s.source === target.mailboxSource) || SUNAFIL_SECTIONS[2];

    await page.goto(targetSection.url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    await dismissSunafilModals(page);

    // Si es Fiscalización o Cobranza, primero entramos a "Ver" documentos de la orden/expediente
    if (target.mailboxSource === 'FISCALIZACION' || target.mailboxSource === 'COBRANZA') {
      const codeNumbers = (target.sunatCode || '').match(/\d{5,}/)?.[0] || target.sunatCode || '';
      const orderSearchTerms = [codeNumbers, target.sunatCode].filter(Boolean) as string[];

      let orderRow = null;
      for (const term of orderSearchTerms) {
        const candidate = page.locator('tbody tr').filter({ hasText: term }).first();
        if (await candidate.isVisible({ timeout: 1500 }).catch(() => false)) {
          orderRow = candidate;
          break;
        }
      }

      if (!orderRow) {
        orderRow = page.locator('tbody tr').first();
      }

      const btnVer = orderRow.locator('button, a').filter({ hasText: 'Ver' }).first();
      if (await btnVer.isVisible({ timeout: 2000 }).catch(() => false)) {
        await btnVer.click();
        await page.waitForTimeout(2000);
        await dismissSunafilModals(page);
      }
    }

    // 3. Localizar la fila del documento
    const coreNumber = (target.sunatCode || '').match(/\d{5,}/)?.[0];
    const searchTerms = [
      coreNumber,
      target.sunatCode,
      target.subject.slice(0, 30),
      target.publishedAt,
    ].filter((t): t is string => Boolean(t && t.length >= 4));

    let targetRow = null;
    for (const term of searchTerms) {
      const candidate = page.locator('tbody tr').filter({ hasText: term }).first();
      if (await candidate.isVisible({ timeout: 1500 }).catch(() => false)) {
        targetRow = candidate;
        break;
      }
    }

    if (!targetRow) {
      const fallbackRow = page.locator('tbody tr').first();
      if (await fallbackRow.isVisible({ timeout: 1500 }).catch(() => false)) {
        targetRow = fallbackRow;
      } else {
        return {
          found: false,
          message: 'No se encontró la notificación en la lista de SUNAFIL.',
        };
      }
    }

    // 4. Buscar botón de descarga en la fila (botón rojo con ícono de PDF/ojo)
    const docBtn = targetRow
      .locator('button:has(.fa-file-pdf-o), .btn-danger:has(.fa-file-pdf-o), button:has(.fa-eye), .btn-danger')
      .first();
    if (!(await docBtn.isVisible({ timeout: 2000 }).catch(() => false))) {
      return {
        found: false,
        message: 'Esta comunicación de SUNAFIL no contiene un archivo descargable directo.',
      };
    }

    // Clic en el botón para abrir el modal de descarga
    await docBtn.click();
    await page.waitForTimeout(1500);

    // 5. Clic en "Descargar" dentro del modal abierto (.modal.in) con listener de descarga
    const modalDownloadBtn = page
      .locator('.modal.in button, .modal.show button, .scDescargaDoc.modal button, .scDescargaDocPV.modal button')
      .filter({ hasText: 'Descargar' })
      .first();

    if (!(await modalDownloadBtn.isVisible({ timeout: 6000 }).catch(() => false))) {
      return {
        found: false,
        message: 'No se abrió el modal de descarga de documento en SUNAFIL.',
      };
    }

    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 20000 }),
      modalDownloadBtn.click(),
    ]);

    const suggestedName = download.suggestedFilename() || 'documento_sunafil.pdf';
    const cleanFilename = suggestedName.replace(/[^a-zA-Z0-9._-]/g, '_');

    if (!fs.existsSync(destinationDir)) {
      fs.mkdirSync(destinationDir, { recursive: true });
    }

    const filePath = path.join(destinationDir, cleanFilename);
    await download.saveAs(filePath);

    await browser.close();
    browser = null;

    return {
      found: true,
      filename: cleanFilename,
      filePath,
      message: 'Documento descargado con éxito desde SUNAFIL.',
    };
  } catch (err) {
    if (browser) {
      await browser.close().catch(() => {});
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      found: false,
      message: `Error descargando de SUNAFIL: ${message}`,
    };
  }
}
