import { getConfig, requireEncryptionKey } from './config/env.js';
import { closeDatabase, getDatabase } from './db/database.js';
import { ClientService } from './services/clientService.js';
import { runMonitorCycle } from './services/monitorService.js';

function parseClientIdArg(args: string[]): number | undefined {
  const flag = args.find((a) => a.startsWith('--client='));
  if (!flag) return undefined;
  const parsed = Number.parseInt(flag.slice('--client='.length), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error('Parametro --client=<id> invalido.');
  }
  return parsed;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const runOnce = args.includes('--once');
  const onlyClientId = parseClientIdArg(args);

  const config = getConfig();
  const encryptionKey = requireEncryptionKey(config);
  const db = getDatabase(config.dbPath);
  const clientService = new ClientService(db, encryptionKey);

  let isStopping = false;
  let timer: NodeJS.Timeout | null = null;

  const shutdown = () => {
    if (isStopping) return;
    isStopping = true;
    console.log('\n[Sistema] Cerrando monitor de forma segura...');
    if (timer) clearInterval(timer);
    closeDatabase();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  if (runOnce) {
    await runMonitorCycle(clientService, config, onlyClientId);
    closeDatabase();
    return;
  }

  console.log(
    `[Sistema] Monitor continuo iniciado. Intervalo configurado: cada ${config.checkIntervalMinutes} minuto(s).`,
  );
  console.log('[Sistema] Presiona Ctrl+C para detener.\n');

  let running = false;
  const executeSafe = async () => {
    if (running || isStopping) return;
    running = true;
    try {
      await runMonitorCycle(clientService, config, onlyClientId);
    } catch (error) {
      console.error('[Monitor Error]', error instanceof Error ? error.message : String(error));
    } finally {
      running = false;
    }
  };

  await executeSafe();

  const intervalMs = config.checkIntervalMinutes * 60 * 1000;
  timer = setInterval(() => {
    void executeSafe();
  }, intervalMs);
}

main().catch((err) => {
  console.error('\n[Error Fatal]', err instanceof Error ? err.message : String(err));
  closeDatabase();
  process.exit(1);
});
