/**
 * Shared interfaces and types for storage orchestration
 * All storage-related types are defined here for consistency
 */
import { AppError } from '../errors/AppError';

export type StorageProvider = 'cloudinary' | 'ipfs';

/** What a stored object represents: raw media bytes or a provenance manifest */
export type StorageRecordKind = 'media' | 'manifest';

export interface UploadRequest {
  storageProvider: StorageProvider;
  buffer: Buffer;
  mimetype: string;
  originalname: string;
  userId: string;
  kind?: StorageRecordKind;            // defaults to 'media'
  assetId?: string;                    // Asset the stored object belongs to
  metadata?: Record<string, string>;   // Provider metadata (IPFS pin key-values)
  allowFallback?: boolean;             // IPFS -> Cloudinary fallback on failure (default true)
}

export interface UploadResult {
  provider: StorageProvider;          // Provider that actually stored the file
  requestedProvider: StorageProvider; // Provider the client asked for
  fallbackUsed: boolean;              // True when the requested provider failed and a fallback stored the file
  url: string;
  cid?: string;          // IPFS only
  publicId?: string;     // Cloudinary only
  fallbackFrom?: StorageProvider; // Requested provider when the upload fell back
  kind?: StorageRecordKind;
  assetId?: string;
  size: number;
  mimetype: string;
  uploadedAt: Date;
  /** True when an existing record was reused instead of pinning the bytes again */
  deduplicated?: boolean;
}

/**
 * Outcome of fetching a CID from the IPFS gateway.
 * - ok:          full object was streamed and hashed within the size cap
 * - not_found:   gateway answered 404/410 (not pinned or not yet propagated)
 * - too_large:   object exceeds the configured size cap; content not hashed
 * - timeout:     gateway did not deliver the object within the timeout
 * - unreachable: network failure or unexpected gateway status
 */
export type GatewayFetchStatus = 'ok' | 'not_found' | 'too_large' | 'timeout' | 'unreachable';

export type GatewayFetchResult =
  | { status: 'ok'; size: number; sha256: string }
  | { status: 'too_large'; declaredSize: number | null }
  | { status: 'not_found' | 'timeout' | 'unreachable'; httpStatus?: number };

export interface GatewayFetchOptions {
  timeoutMs: number;
  maxBytes: number;
}

/**
 * Response of GET /api/v1/storage/resolve/:cid
 */
export interface CidResolutionResult {
  cid: string;
  /** True when the gateway serves the object (including objects over the size cap) */
  available: boolean;
  /** Size in bytes reported by the gateway, or null when unknown */
  size: number | null;
  /**
   * True/false when the fetched bytes were hashed and compared with the stored
   * contentHash; null when verification was not possible (object unavailable,
   * over the size cap, or no contentHash stored for the record).
   */
  hashMatches: boolean | null;
  /** Size recorded at upload time (from the StorageRecord) */
  expectedSize: number;
  gatewayStatus: GatewayFetchStatus;
  checkedAt: Date;
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
