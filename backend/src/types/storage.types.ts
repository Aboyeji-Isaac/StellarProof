/**
 * Shared interfaces and types for storage orchestration
 * All storage-related types are defined here for consistency
 */
import { AppError } from '../errors/AppError';

export type StorageProvider = 'cloudinary' | 'ipfs';

export interface UploadRequest {
  storageProvider: StorageProvider;
  buffer: Buffer;
  mimetype: string;
  originalname: string;
  userId: string;
}

export interface UploadResult {
  provider: StorageProvider;          // Provider that actually stored the file
  requestedProvider: StorageProvider; // Provider the client asked for
  fallbackUsed: boolean;              // True when the requested provider failed and a fallback stored the file
  url: string;
  cid?: string;          // IPFS only
  publicId?: string;     // Cloudinary only
  size: number;
  mimetype: string;
  uploadedAt: Date;
}

/**
 * Base interface for storage provider implementations
 */
export interface IStorageProvider {
  upload(buffer: Buffer, mimetype: string, originalname: string): Promise<UploadResult>;
}

/**
 * Storage errors have provider context.
 * Extends AppError so the global error handler honours the status code
 * instead of collapsing every storage failure into a generic 500.
 */
export class StorageError extends AppError {
  status: 'fail' | 'error';

  constructor(
    public provider: StorageProvider | null,
    public operation: string,
    public reason: string,
    statusCode: number = 500,
  ) {
    super(
      `Storage Error [${provider}/${operation}]: ${reason}`,
      statusCode,
      `STORAGE_${operation.toUpperCase()}_FAILED`,
    );
    this.name = 'StorageError';
    this.status = statusCode < 500 ? 'fail' : 'error';
    // AppError pins the prototype to AppError; restore it for `instanceof StorageError`.
    Object.setPrototypeOf(this, StorageError.prototype);
  }
}
