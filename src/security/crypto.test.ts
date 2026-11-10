import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decryptSecret,
  encryptSecret,
  generateEncryptionKeyHex,
  maskSecret,
  sha256Hex,
} from './crypto.js';

test('encryptSecret y decryptSecret cifran y descifran correctamente con AES-256-GCM', () => {
  const key = generateEncryptionKeyHex();
  assert.equal(key.length, 64);

  const original = 'ClaveSol#2026!';
  const encrypted1 = encryptSecret(original, key);
  const encrypted2 = encryptSecret(original, key);

  assert.notEqual(encrypted1, original);
  assert.notEqual(encrypted1, encrypted2, 'Cada cifrado debe usar un IV distinto');
  assert.equal(decryptSecret(encrypted1, key), original);
  assert.equal(decryptSecret(encrypted2, key), original);
});

test('decryptSecret rechaza texto manipulado o llave incorrecta', () => {
  const key1 = generateEncryptionKeyHex();
  const key2 = generateEncryptionKeyHex();
  const encrypted = encryptSecret('MI_CLAVE_SOL', key1);

  assert.throws(() => decryptSecret(encrypted, key2));

  const parts = encrypted.split(':');
  parts[3] = Buffer.from('manipulado').toString('base64');
  assert.throws(() => decryptSecret(parts.join(':'), key1));
});

test('maskSecret y sha256Hex funcionan correctamente', () => {
  assert.equal(maskSecret('MIUSUARIO'), 'MI*****IO');
  assert.equal(maskSecret('1234'), '****');
  assert.equal(sha256Hex('hola').length, 64);
});
