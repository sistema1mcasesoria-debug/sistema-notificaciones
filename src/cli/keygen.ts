import fs from 'node:fs';
import path from 'node:path';
import { generateEncryptionKeyHex } from '../security/crypto.js';

const key = generateEncryptionKeyHex();
const envPath = path.resolve(process.cwd(), '.env');
const envExamplePath = path.resolve(process.cwd(), '.env.example');

console.log('\n=== Generador de Llave Maestra AES-256-GCM ===\n');
console.log(`ENCRYPTION_KEY=${key}\n`);

if (!fs.existsSync(envPath) && fs.existsSync(envExamplePath)) {
  const template = fs.readFileSync(envExamplePath, 'utf8');
  const updated = template.replace(/^ENCRYPTION_KEY=.*$/m, `ENCRYPTION_KEY=${key}`);
  fs.writeFileSync(envPath, updated, 'utf8');
  console.log('Se creo automaticamente el archivo .env con esta llave maestra.');
  console.log('IMPORTANTE: Haz una copia segura de tu .env; sin esta llave no podras descifrar las claves guardadas.\n');
} else if (fs.existsSync(envPath)) {
  console.log('Tu archivo .env ya existe y NO fue modificado para proteger datos existentes.');
  console.log('Si es una instalacion nueva, reemplaza manualmente ENCRYPTION_KEY en tu .env.\n');
}
