import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type Frame, type Page } from 'playwright';
import type { AppConfig } from '../config/env.js';
import type {
  ClientCredentials,
  ScrapeResult,
  SunatNotificationItem,
} from './types.js';

const SUNAT_MENU_ENTRY_URL = 'https://e-menu.sunat.gob.pe/cl-ti-itmenu/MenuInternet.htm';

function logsDir(): string {
  const dir = path.resolve(process.cwd(), 'logs');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

async function saveDebugScreenshot(
  page: Page,
  docNumber: string,
  tag: string,
): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = path.join(logsDir(), `${docNumber}_${tag}_${timestamp}.png`);
  await page.screenshot({ path: filePath, fullPage: true });
  return filePath;
}

async function saveFrameStructureDump(page: Page, docNumber: string): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = path.join(logsDir(), `${docNumber}_frames_${timestamp}.json`);

  const dump: Array<{
    name: string;
    url: string;
    interactiveMatches: Array<{ tag: string; id: string; text: string; onclick: string }>;
    tablesCount: number;
  }> = [];

  for (const frame of page.frames()) {
    try {
      const info = await frame.evaluate(() => {
        const els = Array.from(
          document.querySelectorAll('a, button, li, [onclick], [id*="buzon" i], [id*="noti" i]'),
        );
        const interactiveMatches = els
          .map((el) => ({
            tag: el.tagName.toLowerCase(),
            id: el.id || '',
            text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120),
            onclick: el.getAttribute('onclick') || '',
          }))
          .filter(
            (item) =>
              /buz[oó]n|notific|mensaje|salir|cerrar/i.test(item.text) ||
              /buzon|noti/i.test(item.id) ||
              /buzon|noti/i.test(item.onclick),
          )
          .slice(0, 30);

        return {
          interactiveMatches,
          tablesCount: document.querySelectorAll('table').length,
        };
      });

      dump.push({
        name: frame.name() || '(sin-nombre)',
        url: frame.url(),
        ...info,
      });
    } catch {
      dump.push({
        name: frame.name() || '(inaccesible)',
        url: frame.url(),
        interactiveMatches: [],
        tablesCount: 0,
      });
    }
  }

  fs.writeFileSync(filePath, JSON.stringify(dump, null, 2), 'utf8');
  return filePath;
}

async function dismissWelcomeModals(page: Page): Promise<void> {
  const closeSelectors = [
    '.modal.in button.close',
    '.modal.show button.close',
    'button:has-text("Cerrar")',
    'button:has-text("Entendido")',
    'button:has-text("Continuar")',
    'a:has-text("Cerrar")',
  ];

  for (const frame of [page.mainFrame(), ...page.frames()]) {
    for (const selector of closeSelectors) {
      try {
        const btn = frame.locator(selector).first();
        if (await btn.isVisible({ timeout: 350 })) {
          await btn.click({ timeout: 1000 });
          await page.waitForTimeout(400);
        }
      } catch {
        // Ignorar si no existe o ya se cerro
      }
    }
  }
}

async function clickBuzonElectronico(page: Page): Promise<Page> {
  const candidateSelectors = [
    '#divBuzon',
    '#btnBuzon',
    'a[href*="buzon" i]',
    '[onclick*="buzon" i]',
    'li[onclick*="Buzon" i]',
    'button:has-text("Buzón Electrónico")',
    'a:has-text("Buzón Electrónico")',
    'span:has-text("Buzón Electrónico")',
    'button:has-text("Buzon Electronico")',
    'a:has-text("Buzon Electronico")',
    'text=/^\\s*Buz[oó]n\\s+Electr[oó]nico\\s*$/i',
  ];

  const popupPromise = page
    .context()
    .waitForEvent('page', { timeout: 5000 })
    .catch(() => null);

  let clicked = false;
  for (const frame of [page.mainFrame(), ...page.frames()]) {
    for (const selector of candidateSelectors) {
      try {
        const locator = frame.locator(selector).first();
        if (await locator.isVisible({ timeout: 600 })) {
          await locator.click({ timeout: 5000 });
          clicked = true;
          break;
        }
      } catch {
        // Intentar siguiente selector o frame
      }
    }
    if (clicked) break;
  }

  if (!clicked) {
    throw new Error(
      'No se encontro el boton o enlace de "Buzon Electronico" dentro del Menu SOL.',
    );
  }

  const popup = await popupPromise;
  const activePage = popup ?? page;

  await activePage.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
  await activePage.waitForTimeout(3000);
  return activePage;
}

interface FrameExtractionResult {
  foundMailboxView: boolean;
  isExplicitlyEmpty: boolean;
  items: SunatNotificationItem[];
}

export async function extractNotificationsFromFrame(
  frame: Frame,
  defaultCategory: string | null = null,
): Promise<FrameExtractionResult> {
  // Nota: evitar `const fn = () => ...` o `function fn()` dentro de `frame.evaluate`,
  // ya que `tsx` (esbuild keepNames) inyecta `__name(...)` que no existe en el DOM del navegador.
  return frame.evaluate((fallbackCategory) => {
    const DATE_REGEX =
      /((?:0[1-9]|[12]\d|3[01])\/(?:0[1-9]|1[0-2])\/(?:19|20)\d{2}(?:\s+(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?)?)/;
    const SIDEBAR_NOISE_REGEX =
      /^(?:personas|empresas|operador de comercio exterior|buz[oó]n notificaciones|buz[oó]n mensajes(?:\s*\(\d+\))?|[oó]rdenes de pago|resoluciones de ejecuci[oó]n coactiva|resoluciones de cobranza|resoluciones de fraccionamiento|resoluciones no contenciosas|resoluciones de fiscalizaci[oó]n|notificaciones anteriores|inspecci[oó]n no intrusiva|requerimientos diversos|anterior|siguiente|buscar|todos|le[ií]dos|no le[ií]dos)$/i;
    const PART_NOISE_REGEX =
      /^(?:personas|empresas|operador de comercio exterior|buz[oó]n notificaciones|buz[oó]n mensajes(?:\s*\(\d+\))?|anterior|siguiente|buscar|todos|le[ií]dos|no le[ií]dos)$/i;
    const FORM_NOISE_REGEX =
      /monto a pagar:|etapa documento:|nro documento:|fecha emisi[oó]n:|nro exp\. coactivo:|campo monto a pagar es editable/i;

    const bodyText = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
    const url = window.location.href;
    const looksLikeMailbox =
      /buz[oó]n|notificaci[oó]n|mensajes|correspondencia/i.test(url) ||
      /buz[oó]n electr[oó]nico|notificaciones recibidas|bandeja de entrada|buz[oó]n mensajes/i.test(
        bodyText,
      );

    const emptyMessage =
      /no\s+(?:tiene|existen|se\s+encontraron)\s+(?:notificaciones|mensajes|registros)/i.test(
        bodyText,
      );

    const extracted: Array<{
      sunatCode: string | null;
      subject: string;
      sender: string | null;
      notificationType: string | null;
      publishedAt: string | null;
      readStatusSunat: string | null;
      rawRow: Record<string, string>;
    }> = [];

    let foundMailboxContainer = false;

    // 1. Vista principal moderna de SUNAT basada en .list-group-item (Buzon Notificaciones / Mensajes)
    const rawListItems = Array.from(document.querySelectorAll('.list-group-item'));
    for (const item of rawListItems) {
      if (!(item instanceof HTMLElement)) continue;
      if (item.querySelector('.list-group-item')) continue;
      if (item.getClientRects().length === 0) continue;
      if (item.closest('[hidden], .hidden, .modal:not(.in):not(.show)')) continue;

      const itemStyle = window.getComputedStyle(item);
      if (
        itemStyle.display === 'none' ||
        itemStyle.visibility === 'hidden' ||
        itemStyle.opacity === '0'
      ) {
        continue;
      }

      const chunks: string[] = [];
      const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT);
      let current = walker.nextNode();
      while (current) {
        const parent = current.parentElement;
        if (
          parent instanceof HTMLElement &&
          !['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(parent.tagName) &&
          parent.getClientRects().length > 0 &&
          !parent.closest('[hidden], .hidden, .modal:not(.in):not(.show)')
        ) {
          const pStyle = window.getComputedStyle(parent);
          if (
            pStyle.display !== 'none' &&
            pStyle.visibility !== 'hidden' &&
            pStyle.opacity !== '0'
          ) {
            const text = (current.nodeValue || '').replace(/\s+/g, ' ').trim();
            if (text) chunks.push(text);
          }
        }
        current = walker.nextNode();
      }

      if (chunks.length === 0) continue;

      const joined = chunks.join(' ').trim();
      if (SIDEBAR_NOISE_REGEX.test(joined) || FORM_NOISE_REGEX.test(joined)) {
        continue;
      }

      let publishedAt: string | null = null;
      const rawNonDateParts: string[] = [];

      for (const chunk of chunks) {
        const m = chunk.match(DATE_REGEX);
        if (!publishedAt && m && m.index !== undefined) {
          publishedAt = m[1];
          const before = chunk.slice(0, m.index).trim();
          const after = chunk.slice(m.index + m[1].length).trim();
          if (before && !PART_NOISE_REGEX.test(before)) rawNonDateParts.push(before);
          if (after && !PART_NOISE_REGEX.test(after)) rawNonDateParts.push(after);
        } else if (!PART_NOISE_REGEX.test(chunk)) {
          rawNonDateParts.push(chunk);
        }
      }

      // En el buzon real de SUNAT cada notificacion/mensaje tiene fecha de deposito
      if (!publishedAt) {
        continue;
      }

      foundMailboxContainer = true;

      // Combinar etiquetas separadas tipo "ASUNTO:" + siguiente fragmento
      const nonDateParts: string[] = [];
      for (let i = 0; i < rawNonDateParts.length; i++) {
        const part = rawNonDateParts[i];
        if (/^(?:asunto|detalle|sumilla)\s*:?$/i.test(part) && i + 1 < rawNonDateParts.length) {
          nonDateParts.push(`${part} ${rawNonDateParts[i + 1]}`);
          i++;
        } else {
          nonDateParts.push(part);
        }
      }

      const senderPart =
        nonDateParts.find((c) => /^(?:SOL|SUNAT)$/i.test(c))?.toUpperCase() || null;

      const categoryChunk =
        nonDateParts.find(
          (c) =>
            c.length >= 3 &&
            c.length <= 50 &&
            /[A-ZÁÉÍÓÚÑ]{3,}/.test(c) &&
            /^[A-ZÁÉÍÓÚÑ0-9\s./-]+$/.test(c) &&
            !/^(?:SOL|SUNAT)$/i.test(c) &&
            !/^(?:N[°º]\.?|Nro\.?|No\.)\s*[A-Z0-9-]*\d[A-Z0-9-]{3,}$/i.test(c) &&
            !/^\d{8,}$/.test(c) &&
            !/^(?:asunto|detalle|sumilla)\s*:/i.test(c) &&
            !/notificaci[oó]n/i.test(c),
        ) ?? fallbackCategory;

      const subjectChunk =
        nonDateParts.find(
          (c) => /^asunto\s*:/i.test(c) && c.replace(/^asunto\s*:\s*/i, '').trim().length > 0,
        ) ||
        nonDateParts.find(
          (c) =>
            c !== categoryChunk &&
            !/^(?:SOL|SUNAT)$/i.test(c) &&
            !/^(?:N[°º]\.?|Nro\.?|No\.)\s*[A-Z0-9-]*\d[A-Z0-9-]{3,}$/i.test(c) &&
            !/^\d{8,}$/.test(c) &&
            /notificaci[oó]n|mensaje|resoluci[oó]n|esquela|orden|comunicado|carta|aviso|requerimiento|valor/i.test(
              c,
            ),
        ) ||
        [...nonDateParts]
          .filter(
            (c) =>
              c !== categoryChunk &&
              !/^(?:SOL|SUNAT)$/i.test(c) &&
              !/^(?:N[°º]\.?|Nro\.?|No\.)\s*[A-Z0-9-]*\d[A-Z0-9-]{3,}$/i.test(c) &&
              !/^\d{8,}$/.test(c),
          )
          .sort((a, b) => b.length - a.length)[0] ||
        [...nonDateParts].sort((a, b) => b.length - a.length)[0] ||
        joined;

      const cleanSubject = subjectChunk.replace(/^asunto\s*:\s*/i, '').trim();

      const codeMatch =
        cleanSubject.match(/\b(?:N[°º]\.?|Nro\.?|No\.)\s*([A-Z0-9-]*\d[A-Z0-9-]{4,})/i) ||
        nonDateParts
          .join(' ')
          .match(/\b(?:N[°º]\.?|Nro\.?|No\.)\s*([A-Z0-9-]*\d[A-Z0-9-]{4,})/i);
      const sunatCode = codeMatch ? codeMatch[1] : null;

      const classStr = item.className || '';
      const boldSubject = item.querySelector('strong, b, [class*="bold" i]');
      const readStatusSunat =
        /no[-_]?le[ií]d|unread|sin[-_]?leer|list-group-item-info/i.test(classStr) || boldSubject
          ? 'No leído'
          : 'Leído';

      const rawRow: Record<string, string> = {
        FechaSUNAT: publishedAt,
        Asunto: cleanSubject,
      };
      if (categoryChunk) rawRow.Categoria = categoryChunk;
      if (senderPart) rawRow.Remitente = senderPart;
      if (sunatCode) rawRow.Codigo = sunatCode;
      rawRow.EstadoSUNAT = readStatusSunat;

      extracted.push({
        sunatCode,
        subject: cleanSubject,
        sender: senderPart,
        notificationType: categoryChunk,
        publishedAt,
        readStatusSunat,
        rawRow,
      });
    }

    // 2. Respaldo para vistas clasicas basadas en <table> (solo si no se extrajeron tarjetas .list-group-item)
    if (extracted.length === 0) {
      const tables = Array.from(document.querySelectorAll('table'));
      for (const table of tables) {
        if (!(table instanceof HTMLElement)) continue;
        if (table.getClientRects().length === 0) continue;
        if (table.closest('[hidden], .hidden, .modal:not(.in):not(.show)')) continue;

        const tStyle = window.getComputedStyle(table);
        if (tStyle.display === 'none' || tStyle.visibility === 'hidden' || tStyle.opacity === '0') {
          continue;
        }

        const headerCells = Array.from(
          table.querySelectorAll('thead th, thead td, tr:first-child th'),
        ).map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim());

        const bodyRows = Array.from(table.querySelectorAll('tbody tr'));
        const candidateRows =
          bodyRows.length > 0
            ? bodyRows
            : Array.from(table.querySelectorAll('tr')).slice(headerCells.length > 0 ? 1 : 0);

        if (candidateRows.length === 0) continue;

        const tableText = (table.textContent || '').replace(/\s+/g, ' ');
        const headerJoined = headerCells.join(' ').toLowerCase();
        const isNotificationTable =
          (/fecha|asunto|notific|documento|remitente|estado|tipo|acto/i.test(headerJoined) ||
            DATE_REGEX.test(tableText)) &&
          !FORM_NOISE_REGEX.test(tableText);

        if (!isNotificationTable) continue;

        foundMailboxContainer = true;

        for (const row of candidateRows) {
          if (!(row instanceof HTMLElement) || row.getClientRects().length === 0) continue;
          const rStyle = window.getComputedStyle(row);
          if (rStyle.display === 'none' || rStyle.visibility === 'hidden' || rStyle.opacity === '0') {
            continue;
          }

          const cells = Array.from(row.querySelectorAll('td')).map((td) => {
            const parts: string[] = [];
            const walker = document.createTreeWalker(td, NodeFilter.SHOW_TEXT);
            let n = walker.nextNode();
            while (n) {
              const p = n.parentElement;
              if (
                p instanceof HTMLElement &&
                !['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(p.tagName) &&
                p.getClientRects().length > 0
              ) {
                const txt = (n.nodeValue || '').replace(/\s+/g, ' ').trim();
                if (txt) parts.push(txt);
              }
              n = walker.nextNode();
            }
            return parts.join(' ').trim();
          });

          if (cells.length === 0) continue;

          const rowJoined = cells.join(' ').trim();
          if (
            !rowJoined ||
            FORM_NOISE_REGEX.test(rowJoined) ||
            /no\s+(?:tiene|existen|se\s+encontraron)\s+(?:notificaciones|mensajes|registros)/i.test(
              rowJoined,
            )
          ) {
            continue;
          }

          const rawRow: Record<string, string> = {};
          cells.forEach((val, idx) => {
            const key = headerCells[idx] || `col_${idx + 1}`;
            rawRow[key] = val;
          });

          let sunatCode: string | null = null;
          let subject = '';
          let sender: string | null = null;
          let notificationType: string | null = fallbackCategory;
          let publishedAt: string | null = null;
          let readStatusSunat: string | null = null;

          cells.forEach((val, idx) => {
            const header = (headerCells[idx] || '').toLowerCase();
            const dateMatch = val.match(DATE_REGEX);
            if (/fecha|dep[oó]sito|publicaci[oó]n/.test(header) || (!publishedAt && dateMatch)) {
              if (!publishedAt) publishedAt = dateMatch ? dateMatch[1] : val;
            } else if (/asunto|descripci[oó]n|detalle|t[ií]tulo|mensaje/.test(header)) {
              if (!subject) subject = val;
            } else if (/remitente|dependencia|[oó]rgano|emisor/.test(header)) {
              if (!sender) sender = val;
            } else if (/tipo|clase|acto/.test(header)) {
              if (!notificationType) notificationType = val;
            } else if (/estado|situaci[oó]n|le[ií]do/.test(header)) {
              if (!readStatusSunat) readStatusSunat = val;
            } else if (/n[°ºo]|c[oó]digo|nro|numero|documento|expediente/.test(header)) {
              if (!sunatCode) sunatCode = val;
            }
          });

          if (!publishedAt) {
            continue;
          }

          if (!subject) {
            const descriptive = cells
              .filter((c) => c.length > 5 && !DATE_REGEX.test(c))
              .sort((a, b) => b.length - a.length)[0];
            subject = descriptive || rowJoined.slice(0, 180);
          }

          if (!sunatCode) {
            const mCode = subject.match(/\b(?:N[°º]\.?|Nro\.?|No\.)\s*([A-Z0-9-]*\d[A-Z0-9-]{4,})/i);
            if (mCode) sunatCode = mCode[1];
          }

          extracted.push({
            sunatCode,
            subject: subject.replace(/^asunto\s*:\s*/i, '').trim(),
            sender,
            notificationType,
            publishedAt,
            readStatusSunat,
            rawRow,
          });
        }
      }
    }

    return {
      foundMailboxView: looksLikeMailbox || foundMailboxContainer,
      isExplicitlyEmpty: emptyMessage && extracted.length === 0,
      items: extracted,
    };
  }, defaultCategory);
}

async function trySwitchToMensajesTab(activePage: Page): Promise<boolean> {
  for (const frame of [activePage.mainFrame(), ...activePage.frames()]) {
    try {
      const mensajesTab = frame
        .locator('a:has-text("Buzón Mensajes"), button:has-text("Buzón Mensajes"), li:has-text("Buzón Mensajes")')
        .first();
      if (await mensajesTab.isVisible({ timeout: 700 })) {
        await mensajesTab.click({ timeout: 3000 });
        await activePage.waitForTimeout(2000);
        return true;
      }
    } catch {
      // Continuar buscando en otros frames
    }
  }
  return false;
}

async function tryLogout(page: Page): Promise<void> {
  try {
    for (const frame of [page.mainFrame(), ...page.frames()]) {
      const salir = frame.locator('#btnSalir, a:has-text("Salir"), button:has-text("Salir")').first();
      if (await salir.isVisible({ timeout: 500 })) {
        await salir.click({ timeout: 2000 });
        await page.waitForTimeout(500);
        break;
      }
    }
  } catch {
    // No bloquear cierre si no se encuentra Salir
  }
}

export async function checkSunatMailbox(
  credentials: ClientCredentials,
  config: AppConfig,
): Promise<ScrapeResult> {
  let browser: Browser | null = null;
  let page: Page | null = null;

  try {
    browser = await chromium.launch({
      channel: config.browserChannel,
      headless: config.headless,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
      ],
    });

    const majorVersion = browser.version().split('.')[0] || '131';
    const context = await browser.newContext({
      locale: 'es-PE',
      timezoneId: 'America/Lima',
      viewport: { width: 1366, height: 768 },
      userAgent:
        `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${majorVersion}.0.0.0 Safari/537.36`,
    });

    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    page = await context.newPage();
    page.setDefaultTimeout(config.navigationTimeoutMs);

    // 1. Abrir entrada oficial de SUNAT SOL y esperar redireccion OAuth2
    await page.goto(SUNAT_MENU_ENTRY_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#btnAceptar', { state: 'visible' });

    // 2. Completar formulario segun RUC o DNI
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

    // 3. Verificar si SUNAT ya muestra captcha antes de enviar
    const captchaVisibleBefore = await page
      .locator('#txtCaptcha')
      .isVisible()
      .catch(() => false);
    if (captchaVisibleBefore) {
      const shot = config.saveDebugArtifacts
        ? await saveDebugScreenshot(page, credentials.docNumber, 'captcha')
        : undefined;
      return {
        status: 'CAPTCHA',
        notifications: [],
        message: 'SUNAT solicito resolver un captcha de imagen en el login.',
        debugScreenshotPath: shot,
      };
    }

    // 4. Enviar login y esperar resultado
    await page.click('#btnAceptar');

    const outcome = await Promise.race([
      page
        .waitForURL((url) => !url.hostname.includes('api-seguridad.sunat.gob.pe'), {
          timeout: config.navigationTimeoutMs,
          waitUntil: 'domcontentloaded',
        })
        .then(() => 'LOGGED_IN' as const),
      page
        .waitForSelector('#divBuzon, #btnBuzon, [onclick*="buzon" i], a[href*="buzon" i]', {
          state: 'attached',
          timeout: config.navigationTimeoutMs,
        })
        .then(() => 'LOGGED_IN' as const),
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

    if (outcome === 'AUTH_ERROR') {
      const errorText =
        (await page.locator('#spanMensajeError').textContent().catch(() => null))?.trim() ||
        'Credenciales invalidas o acceso rechazado por SUNAT.';
      const shot = config.saveDebugArtifacts
        ? await saveDebugScreenshot(page, credentials.docNumber, 'auth_error')
        : undefined;
      return {
        status: 'AUTH_ERROR',
        notifications: [],
        message: errorText,
        debugScreenshotPath: shot,
      };
    }

    if (outcome === 'CAPTCHA') {
      const shot = config.saveDebugArtifacts
        ? await saveDebugScreenshot(page, credentials.docNumber, 'captcha')
        : undefined;
      return {
        status: 'CAPTCHA',
        notifications: [],
        message: 'SUNAT solicito captcha tras intentar iniciar sesion.',
        debugScreenshotPath: shot,
      };
    }

    // 5. Ya dentro del Menu SOL: cerrar avisos y abrir Buzon Electronico
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2500);
    await dismissWelcomeModals(page);

    const activePage = await clickBuzonElectronico(page);

    // 6. Buscar notificaciones en Buzon Notificaciones y Buzon Mensajes
    const allItems: SunatNotificationItem[] = [];
    const seenKeys = new Set<string>();
    let mailboxViewDetected = false;
    let explicitlyEmptyDetected = false;

    const collectFromCurrentFrames = async (defaultCategory: string) => {
      for (const frame of activePage.frames()) {
        try {
          const res = await extractNotificationsFromFrame(frame, defaultCategory);
          if (res.foundMailboxView) mailboxViewDetected = true;
          if (res.isExplicitlyEmpty) explicitlyEmptyDetected = true;
          for (const item of res.items) {
            const key = `${item.publishedAt ?? ''}|${item.subject}`;
            if (!seenKeys.has(key)) {
              seenKeys.add(key);
              allItems.push(item);
            }
          }
        } catch {
          // Ignorar frames cross-origin inaccesibles
        }
      }
    };

    await collectFromCurrentFrames('Notificación SUNAT');

    // Si existe pestana "Buzon Mensajes", revisar tambien mensajeria general
    const switchedToMensajes = await trySwitchToMensajesTab(activePage);
    if (switchedToMensajes) {
      await collectFromCurrentFrames('Mensaje SUNAT');
    }

    if (!mailboxViewDetected && allItems.length === 0) {
      let debugMsg =
        'Se inicio sesion en SUNAT SOL, pero no se pudo reconocer la vista/tabla del Buzon Electronico.';
      let shot: string | undefined;
      if (config.saveDebugArtifacts) {
        shot = await saveDebugScreenshot(activePage, credentials.docNumber, 'mailbox_not_found');
        const dumpPath = await saveFrameStructureDump(activePage, credentials.docNumber);
        debugMsg += ` Captura: ${shot} | Estructura frames: ${dumpPath}`;
      }
      await tryLogout(page);
      return {
        status: 'ERROR',
        notifications: [],
        message: debugMsg,
        debugScreenshotPath: shot,
      };
    }

    await tryLogout(page);

    return {
      status: 'OK',
      notifications: allItems,
      message:
        allItems.length === 0 && explicitlyEmptyDetected
          ? 'Buzon consultado correctamente (sin notificaciones).'
          : `Buzon consultado correctamente (${allItems.length} elemento(s) encontrados).`,
    };
  } catch (error) {
    let shot: string | undefined;
    if (page && config.saveDebugArtifacts) {
      shot = await saveDebugScreenshot(page, credentials.docNumber, 'error').catch(
        () => undefined,
      );
      await saveFrameStructureDump(page, credentials.docNumber).catch(() => undefined);
    }
    const errMsg = error instanceof Error ? error.message : String(error);
    return {
      status: 'ERROR',
      notifications: [],
      message: errMsg,
      debugScreenshotPath: shot,
    };
  } finally {
    if (browser) {
      await browser.close().catch(() => undefined);
    }
  }
}

export interface MarkAsReadTarget {
  id?: number;
  subject: string;
  sunatCode?: string | null;
  publishedAt?: string | null;
  notificationType?: string | null;
}

export interface MarkAsReadResult {
  foundInSunat: boolean;
  message: string;
}

export async function markMultipleNotificationsAsReadInSunat(
  credentials: ClientCredentials,
  targets: MarkAsReadTarget[],
  config: AppConfig,
  onProgress?: (index: number, total: number, target: MarkAsReadTarget) => void,
): Promise<{ markedCount: number; results: Array<{ target: MarkAsReadTarget; foundInSunat: boolean }> }> {
  let browser: Browser | null = null;
  let page: Page | null = null;
  const results: Array<{ target: MarkAsReadTarget; foundInSunat: boolean }> = [];

  if (targets.length === 0) {
    return { markedCount: 0, results: [] };
  }

  try {
    browser = await chromium.launch({
      channel: config.browserChannel,
      headless: config.headless,
      args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
    });

    const majorVersion = browser.version().split('.')[0] || '131';
    const context = await browser.newContext({
      locale: 'es-PE',
      timezoneId: 'America/Lima',
      viewport: { width: 1366, height: 768 },
      userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${majorVersion}.0.0.0 Safari/537.36`,
    });

    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    page = await context.newPage();
    page.setDefaultTimeout(config.navigationTimeoutMs);

    // 1. Iniciar sesión en SUNAT SOL
    await page.goto(SUNAT_MENU_ENTRY_URL, { waitUntil: 'domcontentloaded' });
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
        .waitForURL((url) => !url.hostname.includes('api-seguridad.sunat.gob.pe'), {
          timeout: config.navigationTimeoutMs,
          waitUntil: 'domcontentloaded',
        })
        .then(() => 'LOGGED_IN' as const),
      page
        .waitForSelector('#divBuzon, #btnBuzon, [onclick*="buzon" i], a[href*="buzon" i]', {
          state: 'attached',
          timeout: config.navigationTimeoutMs,
        })
        .then(() => 'LOGGED_IN' as const),
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

    if (outcome !== 'LOGGED_IN') {
      throw new Error(
        outcome === 'CAPTCHA'
          ? 'SUNAT solicitó captcha. No se pudo iniciar sesión.'
          : 'Credenciales inválidas al intentar ingresar a SUNAT.',
      );
    }

    // 2. Entrar a Buzón Electrónico
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);
    await dismissWelcomeModals(page);

    const activePage = await clickBuzonElectronico(page);
    let currentTab: 'NOTIFICACIONES' | 'MENSAJES' = 'NOTIFICACIONES';

    const switchToTab = async (targetTab: 'NOTIFICACIONES' | 'MENSAJES') => {
      if (currentTab === targetTab) return;
      if (targetTab === 'MENSAJES') {
        const ok = await trySwitchToMensajesTab(activePage);
        if (ok) currentTab = 'MENSAJES';
      } else {
        for (const frame of activePage.frames()) {
          try {
            const notiTab = frame
              .locator('a:has-text("Buzón Notificaciones"), button:has-text("Buzón Notificaciones")')
              .first();
            if (await notiTab.isVisible({ timeout: 600 })) {
              await notiTab.click({ timeout: 2000 });
              await activePage.waitForTimeout(2000);
              currentTab = 'NOTIFICACIONES';
              break;
            }
          } catch {}
        }
      }
    };

    let markedCount = 0;

    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      onProgress?.(i + 1, targets.length, target);

      const isMensaje = /mensaje/i.test(target.notificationType || '');
      await switchToTab(isMensaje ? 'MENSAJES' : 'NOTIFICACIONES');

      const searchTerms = [
        target.publishedAt,
        target.sunatCode,
        target.subject
          ? target.subject.replace(/^(?:notificaci[oó]n|asunto|resoluci[oó]n)\s*[:.]?\s*/i, '').slice(0, 32)
          : null,
      ].filter((t): t is string => Boolean(t && t.length >= 4));

      const attemptFindAndClick = async (): Promise<boolean> => {
        for (const frame of activePage.frames()) {
          for (const term of searchTerms) {
            try {
              const candidate = frame
                .locator('.list-group-item, tbody tr, tr')
                .filter({ hasText: term })
                .first();

              if (await candidate.isVisible({ timeout: 1200 })) {
                const clickTarget =
                  (await candidate.locator('a, button, [onclick], strong').first().isVisible().catch(() => false))
                    ? candidate.locator('a, button, [onclick], strong').first()
                    : candidate;
                await clickTarget.click({ timeout: 4000 });
                await activePage.waitForTimeout(2000);
                await dismissWelcomeModals(activePage).catch(() => {});
                return true;
              }
            } catch {}
          }
        }
        return false;
      };

      let clicked = await attemptFindAndClick();

      if (!clicked) {
        // Intentar en la otra pestaña
        await switchToTab(currentTab === 'NOTIFICACIONES' ? 'MENSAJES' : 'NOTIFICACIONES');
        clicked = await attemptFindAndClick();
      }

      if (clicked) {
        markedCount++;
      }
      results.push({ target, foundInSunat: clicked });

      if (i < targets.length - 1) {
        await activePage.waitForTimeout(800);
      }
    }

    await dismissWelcomeModals(activePage).catch(() => {});
    await tryLogout(page);

    return { markedCount, results };
  } finally {
    if (browser) {
      await browser.close().catch(() => undefined);
    }
  }
}

export async function markNotificationAsReadInSunat(
  credentials: ClientCredentials,
  target: MarkAsReadTarget,
  config: AppConfig,
): Promise<MarkAsReadResult> {
  const batchRes = await markMultipleNotificationsAsReadInSunat(credentials, [target], config);
  const found = batchRes.results[0]?.foundInSunat ?? false;
  return {
    foundInSunat: found,
    message: found
      ? 'Notificación abierta y registrada como leída en el portal de SUNAT.'
      : 'Se registró como leída localmente (no se ubicó en la primera página de SUNAT).',
  };
}
