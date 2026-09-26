import crypto from 'crypto';

/**
 * Recursively sorts the keys of an object to ensure deterministic stringification.
 */
const sortObjectKeys = (obj: any): any => {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }
  
  if (Array.isArray(obj)) {
    return obj.map(sortObjectKeys);
  }

  const sortedKeys = Object.keys(obj).sort();
  const result: Record<string, any> = {};
  
  sortedKeys.forEach((key) => {
    result[key] = sortObjectKeys(obj[key]);
  });
  
  return result;
};

/**
 * Generates a deterministic SHA256 hash from a JSON object.
 */
export const generateDeterministicHash = (data: Record<string, any>): string => {
  const sortedObject = sortObjectKeys(data);
  const jsonString = JSON.stringify(sortedObject);
  
  return crypto.createHash('sha256').update(jsonString).digest('hex');
};

const SHA256_HEX_LENGTH = 64;
const SHA256_INPUT_REGEX = /^(?:sha256:|0x)?([a-fA-F0-9]{64})$/;

/**
 * Computes the SHA-256 digest of a raw buffer as lowercase hex.
 * This is the canonical content hash stored server-side and anchored on-chain.
 */
export const computeSha256 = (buffer: Buffer): string =>
  crypto.createHash('sha256').update(buffer).digest('hex');

/**
 * Normalises a client-supplied SHA-256 digest to bare lowercase hex.
 * Accepts an optional `sha256:` or `0x` prefix. Returns null if the value
 * is not a 64-character hex digest.
 */
export const normalizeSha256Hex = (value: string): string | null => {
  const match = SHA256_INPUT_REGEX.exec(value.trim());
  return match ? match[1].toLowerCase() : null;
};

/**
 * Constant-time comparison of two normalised SHA-256 hex digests.
 */
export const sha256HexEquals = (a: string, b: string): boolean => {
  if (a.length !== SHA256_HEX_LENGTH || b.length !== SHA256_HEX_LENGTH) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
};
