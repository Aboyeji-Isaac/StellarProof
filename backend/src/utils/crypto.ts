import crypto from 'crypto';

/**
 * Recursively sorts the keys of an object to ensure deterministic stringification.
 */
export const sortObjectKeys = (obj: any): any => {
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
 * Serializes a JSON object with recursively sorted keys so the same data
 * always produces byte-identical output (and therefore the same hash / CID).
 */
export const canonicalStringify = (data: Record<string, any>): string => {
  return JSON.stringify(sortObjectKeys(data));
};

/**
 * Generates a deterministic SHA256 hash from a JSON object.
 */
export const generateDeterministicHash = (data: Record<string, any>): string => {
  const jsonString = canonicalStringify(data);
  
  return crypto.createHash('sha256').update(jsonString).digest('hex');
};