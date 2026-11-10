import dotenv from 'dotenv';
import path from 'node:path';

dotenv.config({ quiet: true });

export interface AppConfig {
  encryptionKey: string;
  headless: boolean;
  browserChannel: string | undefined;
  navigationTimeoutMs: number;
  saveDebugArtifacts: boolean;
  dbPath: string;
  checkIntervalMinutes: number;
  delayBetweenClientsMs: number;
  port: number;
  host: string;
}

function parseBool(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value.trim() === '') return defaultValue;
  return ['1', 'true', 'yes', 'si', 'on'].includes(value.trim().toLowerCase());
}

function parsePositiveInt(value: string | undefined, defaultValue: number): number {
  if (!value) return defaultValue;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

export function getConfig(): AppConfig {
  const rawChannel = process.env.BROWSER_CHANNEL?.trim();
  const rawDbPath = process.env.DB_PATH?.trim() || './data/sunat.db';

  return {
    encryptionKey: (process.env.ENCRYPTION_KEY ?? '').trim(),
    headless: parseBool(process.env.HEADLESS, true),
    browserChannel: rawChannel ? rawChannel : undefined,
    navigationTimeoutMs: parsePositiveInt(process.env.NAVIGATION_TIMEOUT_MS, 45_000),
    saveDebugArtifacts: parseBool(process.env.SAVE_DEBUG_ARTIFACTS, true),
    dbPath: path.resolve(process.cwd(), rawDbPath),
    checkIntervalMinutes: parsePositiveInt(process.env.CHECK_INTERVAL_MINUTES, 60),
    delayBetweenClientsMs: parsePositiveInt(process.env.DELAY_BETWEEN_CLIENTS_MS, 5_000),
    port: parsePositiveInt(process.env.PORT, 3000),
    host: process.env.HOST?.trim() || '127.0.0.1',
  };
}

export function requireEncryptionKey(config = getConfig()): string {
  const key = config.encryptionKey;
  if (!/^[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error(
      [
        'ENCRYPTION_KEY no esta configurada o es invalida en tu archivo .env.',
        'Debe tener exactamente 64 caracteres hexadecimales (32 bytes).',
        'Pasos para configurarla:',
        '  1. Ejecuta: npm run keygen',
        '  2. Copia .env.example a .env (si aun no existe)',
        '  3. Pega la clave generada en ENCRYPTION_KEY=... dentro de .env',
      ].join('\n'),
    );
  }
  return key;
}
