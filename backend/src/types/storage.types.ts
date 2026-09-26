/**
 * Shared interfaces and types for storage orchestration
 * All storage-related types are defined here for consistency
 */

export type StorageProvider = 'cloudinary' | 'ipfs';

export interface UploadRequest {
  storageProvider: StorageProvider;
  buffer: Buffer;
  mimetype: string;
  originalname: string;
  userId: string;
  contentHash?: string;  // Verified SHA-256 hex; computed from the buffer when omitted
}

export interface UploadResult {
  provider: StorageProvider;
  url: string;
  cid?: string;          // IPFS only
  publicId?: string;     // Cloudinary only
  size: number;
  mimetype: string;
  contentHash?: string;  // SHA-256 hex of the stored bytes
  uploadedAt: Date;
}

/**
 * Stored upload that already holds the same content hash
 */
export interface ExistingStorageRecord {
  id: string;
  provider: StorageProvider;
  url: string;
  cid?: string;
  publicId?: string;
  uploadedAt: Date;
}

/**
 * Result of the pre-upload hash-consistency check
 */
export interface ContentHashCheckResult {
  contentHash: string;
  size: number;
  matches: true;
  alreadyStored: boolean;
  existingRecords: ExistingStorageRecord[];
}

/**
 * Base interface for storage provider implementations
 */
export interface IStorageProvider {
  upload(buffer: Buffer, mimetype: string, originalname: string): Promise<UploadResult>;
}

/**
 * Storage errors have provider context
 */
export class StorageError extends Error {
  statusCode: number;
  status: 'fail' | 'error';

  constructor(
    public provider: StorageProvider | null,
    public operation: string,
    public reason: string,
    statusCode: number = 500,
  ) {
    super(`Storage Error [${provider}/${operation}]: ${reason}`);
    this.name = 'StorageError';
    this.statusCode = statusCode;
    this.status = statusCode < 500 ? 'fail' : 'error';
  }
}
