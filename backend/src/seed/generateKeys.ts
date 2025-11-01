// src/seed/generateKeys.ts
import { generateKeyPairSync } from 'crypto';
import fs from 'fs';
import path from 'path';
// Ensure the keys directory exists
const keysDir = path.join(__dirname, '../../keys');
if (!fs.existsSync(keysDir)) fs.mkdirSync(keysDir);

// Generate RSA key pair
const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

// Write keys to files
fs.writeFileSync(path.join(keysDir, 'private.pem'), privateKey);
fs.writeFileSync(path.join(keysDir, 'public.pem'), publicKey);

console.log('RSA keys generated in ./keys folder');
