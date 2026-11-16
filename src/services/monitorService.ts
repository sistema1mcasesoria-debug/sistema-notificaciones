import type { AppConfig } from '../config/env.js';
import { checkSunafilMailbox } from '../scraper/sunafilScraper.js';
import { checkSunatMailbox } from '../scraper/sunatScraper.js';
import type { PortalType } from '../scraper/types.js';
import { maskSecret } from '../security/crypto.js';
import type { ClientService } from './clientService.js';

function nowLocalIso(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(
    now.getHours(),
  )}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface MonitorCycleSummary {
  clientsChecked: number;
  clientsOk: number;
  clientsFailed: number;
  newNotificationsTotal: number;
}

export interface MonitorProgressEvent {
  index: number;
  total: number;
  clientId: number;
  label: string;
  docNumber: string;
}

export async function runMonitorCycle(
  clientService: ClientService,
  config: AppConfig,
  onlyClientId?: number,
  onProgress?: (progress: MonitorProgressEvent) => void,
  targetPortal: PortalType | 'ALL' = 'ALL',
): Promise<MonitorCycleSummary> {
  const credentialsList = clientService.getActiveCredentials(onlyClientId);

  if (credentialsList.length === 0) {
    console.log(
      '[Monitor] No hay clientes activos registrados. Usa "npm run client:add" para agregar uno.',
    );
    return {
      clientsChecked: 0,
      clientsOk: 0,
      clientsFailed: 0,
      newNotificationsTotal: 0,
    };
  }

  const portalLabel =
    targetPortal === 'ALL' ? 'SUNAT y SUNAFIL' : targetPortal;
  console.log(
    `\n[${nowLocalIso()}] Iniciando revision de ${credentialsList.length} buzon(es) [${portalLabel}]...`,
  );

  let clientsOk = 0;
  let clientsFailed = 0;
  let newNotificationsTotal = 0;

  for (let i = 0; i < credentialsList.length; i++) {
    const cred = credentialsList[i];
    let clientHadError = false;

    const userPreview =
      cred.loginMode === 'RUC' ? ` | Usuario: ${maskSecret(cred.solUser)}` : '';
    console.log(
      `\n-> [${i + 1}/${credentialsList.length}] Revisando "${cred.label}" (${cred.loginMode}: ${cred.docNumber}${userPreview})...`,
    );

    // 1. Revisar SUNAT si corresponde
    if (targetPortal === 'SUNAT' || targetPortal === 'ALL') {
      onProgress?.({
        index: i + 1,
        total: credentialsList.length,
        clientId: cred.clientId,
        label: `${cred.label} (SUNAT)`,
        docNumber: cred.docNumber,
      });

      console.log(`   [SUNAT] Consultando Buzón Electrónico SUNAT...`);
      const startedAt = nowLocalIso();
      const scrapeResult = await checkSunatMailbox(cred, config);
      const finishedAt = nowLocalIso();

      const recorded = clientService.recordCheckResult({
        clientId: cred.clientId,
        startedAt,
        finishedAt,
        status: scrapeResult.status,
        notifications: scrapeResult.notifications,
        errorMessage: scrapeResult.status === 'OK' ? undefined : scrapeResult.message,
      });

      if (scrapeResult.status === 'OK') {
        newNotificationsTotal += recorded.newFound;
        console.log(
          `   [SUNAT OK] ${scrapeResult.message} | Nuevas alertas: ${recorded.newFound}`,
        );
        if (recorded.newItems.length > 0) {
          for (const item of recorded.newItems) {
            console.log(
              `      * [${item.publishedAt || 'Sin fecha'}] ${item.subject}${
                item.sunatCode ? ` (Ref: ${item.sunatCode})` : ''
              }`,
            );
          }
        }
      } else {
        clientHadError = true;
        console.error(`   [SUNAT ${scrapeResult.status}] ${scrapeResult.message}`);
        if (scrapeResult.debugScreenshotPath) {
          console.error(`   Captura SUNAT: ${scrapeResult.debugScreenshotPath}`);
        }
      }
    }

    // 2. Revisar SUNAFIL si corresponde
    if (targetPortal === 'SUNAFIL' || targetPortal === 'ALL') {
      onProgress?.({
        index: i + 1,
        total: credentialsList.length,
        clientId: cred.clientId,
        label: `${cred.label} (SUNAFIL)`,
        docNumber: cred.docNumber,
      });

      console.log(`   [SUNAFIL] Consultando Casilla Electrónica SUNAFIL...`);
      const startedAt = nowLocalIso();
      const scrapeResult = await checkSunafilMailbox(cred, config);
      const finishedAt = nowLocalIso();

      const recorded = clientService.recordCheckResult({
        clientId: cred.clientId,
        startedAt,
        finishedAt,
        status: scrapeResult.status,
        notifications: scrapeResult.notifications,
        errorMessage: scrapeResult.status === 'OK' ? undefined : scrapeResult.message,
      });

      if (scrapeResult.status === 'OK') {
        newNotificationsTotal += recorded.newFound;
        console.log(
          `   [SUNAFIL OK] ${scrapeResult.message} | Nuevas alertas: ${recorded.newFound}`,
        );
        if (recorded.newItems.length > 0) {
          for (const item of recorded.newItems) {
            console.log(
              `      * [${item.publishedAt || 'Sin fecha'}] [${item.mailboxSource}] ${item.subject}${
                item.termDays ? ` (Plazo: ${item.termDays} días)` : ''
              }`,
            );
          }
        }
      } else {
        clientHadError = true;
        console.error(`   [SUNAFIL ${scrapeResult.status}] ${scrapeResult.message}`);
        if (scrapeResult.debugScreenshotPath) {
          console.error(`   Captura SUNAFIL: ${scrapeResult.debugScreenshotPath}`);
        }
      }
    }

    if (clientHadError) {
      clientsFailed++;
    } else {
      clientsOk++;
    }

    if (i < credentialsList.length - 1 && config.delayBetweenClientsMs > 0) {
      console.log(
        `   Esperando ${Math.round(config.delayBetweenClientsMs / 1000)}s antes del siguiente cliente...`,
      );
      await sleep(config.delayBetweenClientsMs);
    }
  }

  console.log(
    `\n[${nowLocalIso()}] Ciclo finalizado -> OK: ${clientsOk}, Con error: ${clientsFailed}, Nuevas notificaciones: ${newNotificationsTotal}`,
  );

  return {
    clientsChecked: credentialsList.length,
    clientsOk,
    clientsFailed,
    newNotificationsTotal,
  };
}
