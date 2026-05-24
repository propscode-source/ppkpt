import CryptoJS from 'crypto-js';

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;

if (!ENCRYPTION_KEY) {
  console.error('ENCRYPTION_KEY env var is not set. Sensitive data cannot be safely encrypted.');
}

export const encrypt = (text: string | null | undefined): string | null => {
  if (!text || !ENCRYPTION_KEY) return null;
  return CryptoJS.AES.encrypt(text, ENCRYPTION_KEY).toString();
};

export const decrypt = (ciphertext: string | null | undefined): string | null => {
  if (!ciphertext || !ENCRYPTION_KEY) return null;
  try {
    const bytes = CryptoJS.AES.decrypt(ciphertext, ENCRYPTION_KEY);
    return bytes.toString(CryptoJS.enc.Utf8) || null;
  } catch {
    return null;
  }
};
