import crypto from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH_BYTES = 12; // Recomendado por NIST para AES-GCM
const KEY_LENGTH_BYTES = 32; // 256 bits
const FORMAT_VERSION = 'v1';

function parseHexKey(hexKey: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(hexKey)) {
    throw new Error(
      'La llave maestra debe ser una cadena hexadecimal de 64 caracteres (32 bytes).',
    );
  }
  return Buffer.from(hexKey, 'hex');
}

/**
 * Genera una llave maestra aleatoria de 256 bits en formato hexadecimal (64 chars).
 */
export function generateEncryptionKeyHex(): string {
  return crypto.randomBytes(KEY_LENGTH_BYTES).toString('hex');
}

/**
 * Cifra un secreto usando AES-256-GCM con IV aleatorio por cada cifrado.
 * Formato resultante: v1:<iv_base64>:<authTag_base64>:<ciphertext_base64>
 */
export function encryptSecret(plaintext: string, hexKey: string): string {
  const key = parseHexKey(hexKey);
  const iv = crypto.randomBytes(IV_LENGTH_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [
    FORMAT_VERSION,
    iv.toString('base64'),
    authTag.toString('base64'),
    encrypted.toString('base64'),
  ].join(':');
}

/**
 * Descifra un secreto previamente cifrado con encryptSecret.
 * Lanza error si el texto cifrado fue alterado o si la llave es incorrecta.
 */
export function decryptSecret(payload: string, hexKey: string): string {
  const parts = payload.split(':');
  if (parts.length !== 4 || parts[0] !== FORMAT_VERSION) {
    throw new Error('Formato de secreto cifrado invalido o version no soportada.');
  }

  const [, ivB64, authTagB64, ciphertextB64] = parts;
  const key = parseHexKey(hexKey);
  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(authTagB64, 'base64');
  const ciphertext = Buffer.from(ciphertextB64, 'base64');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf8');
}

/**
 * Genera un hash SHA-256 deterministico para deduplicar notificaciones.
 */
export function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Oculta parte de una credencial para mostrar en consola/logs sin exponer el secreto.
 */
export function maskSecret(value: string): string {
  if (!value) return '';
  if (value.length <= 4) return '*'.repeat(value.length);
  return `${value.slice(0, 2)}${'*'.repeat(value.length - 4)}${value.slice(-2)}`;
}
