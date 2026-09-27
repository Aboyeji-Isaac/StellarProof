import { createHash } from 'crypto';
import { StatusCodes } from 'http-status-codes';
import mongoose from 'mongoose';
import {
  UploadRequest,
  UploadResult,
  StorageProvider,
  StorageError,
  CidResolutionResult,
} from '../types/storage.types';
import { cloudinaryService } from './cloudinary.service';
import { ipfsService } from './ipfs.service';
import StorageRecord, { IStorageRecord } from '../models/StorageRecord.model';
import { AppError } from '../errors/AppError';
import { env } from '../config/env';

/**
 * CIDv0: base58btc multihash starting with "Qm" (46 chars).
 * CIDv1: multibase base32 (lowercase, "b" prefix) as emitted by Pinata/Kubo.
 */
const CID_V0_PATTERN = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/;
const CID_V1_BASE32_PATTERN = /^b[a-z2-7]{50,}$/;

export function isValidCid(cid: string): boolean {
  return CID_V0_PATTERN.test(cid) || CID_V1_BASE32_PATTERN.test(cid);
}

function sha256Hex(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function isDuplicateKeyError(error: unknown, fields: string[]): boolean {
  if (!(error instanceof mongoose.mongo.MongoServerError) || error.code !== 11000) {
    return false;
  }
  const keys = Object.keys(error.keyPattern ?? {});
  return keys.some((key) => fields.includes(key));
}

/** Accepts both "sha256:<hex>" and bare "<hex>" forms. */
function normalizeSha256(hash: string): string {
  return hash.trim().toLowerCase().replace(/^sha256:/, '');
}

/**
 * Storage Orchestrator Service
 * Factory that routes upload requests to the appropriate provider (Cloudinary or IPFS)
 * Consults the provider registry before each upload and fails over to the
 * next ranked provider when the preferred one is unhealthy or errors.
 * Ensures all uploads are persisted to MongoDB before returning
 */
class StorageOrchestratorService {
  constructor(private readonly registry: StorageProviderRegistry) {}

  /**
   * Orchestrate the upload based on the requested storage provider
   * Routes to the appropriate provider, persists result to DB, and returns saved record.
   *
   * IPFS uploads are content-addressed and deduplicated: if the same bytes
   * were already pinned, the existing StorageRecord is returned and the
   * provider is not called again. If the provider returns a CID that already
   * has a record (legacy record without contentHash, or a concurrent upload),
   * that record is reused instead of creating a duplicate.
   */
  async orchestrate(request: UploadRequest): Promise<UploadResult> {
    // Validate provider
    if (!STORAGE_PROVIDERS.includes(request.storageProvider)) {
      throw new StorageError(
        null,
        'orchestrate',
        `Invalid storage provider: ${request.storageProvider}. Supported providers: ${STORAGE_PROVIDERS.join(', ')}`,
        400,
      );
    }

    if (request.assetId !== undefined && !mongoose.Types.ObjectId.isValid(request.assetId)) {
      throw new StorageError(request.storageProvider, 'orchestrate', 'Invalid assetId', 400);
    }

    const contentHash = sha256Hex(request.buffer);

    // Skip the provider entirely when these exact bytes are already pinned
    if (request.storageProvider === 'ipfs') {
      const existing = await this.runDbOperation(request.storageProvider, 'dedup-lookup', () =>
        StorageRecord.findOne({ provider: 'ipfs', contentHash }).sort({ createdAt: 1 }).exec()
      );
      if (existing) {
        return this.reuseRecord(existing, request, contentHash);
      }
    }

    // Delegate to provider
    let uploadResult: UploadResult;

    try {
      switch (request.storageProvider) {
        case 'cloudinary':
          const cloudinaryUpload = await cloudinaryService.uploadBuffer(request.buffer);
          uploadResult = {
            provider: 'cloudinary',
            url: cloudinaryUpload.secure_url,
            publicId: cloudinaryUpload.public_id,
            size: cloudinaryUpload.bytes,
            mimetype: request.mimetype,
            uploadedAt: new Date(cloudinaryUpload.created_at)
          };
          break;

        case 'ipfs':
          const ipfsUpload = await ipfsService.upload({
            content: request.buffer,
            name: request.originalname,
            ...(request.metadata ? { metadata: request.metadata } : {}),
          });
          uploadResult = {
            provider: 'ipfs',
            url: ipfsUpload.gatewayUrl,
            cid: ipfsUpload.cid,
            size: ipfsUpload.size,
            mimetype: request.mimetype,
            uploadedAt: new Date(ipfsUpload.timestamp)
          };
          break;

        default:
          // TypeScript exhaustiveness check
          const _exhaustive: never = request.storageProvider;
          throw new StorageError(
            request.storageProvider,
            'orchestrate',
            `Unhandled provider: ${_exhaustive}`,
            500,
          );
      }
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }
    }

    if (!uploadResult) {
      throw new StorageError(
        request.storageProvider,
        'orchestrate',
        `All storage providers failed: ${failures.join('; ')}`,
        502,
      );
    }

    // Provider returned a CID we already track: reuse that record
    const cid = uploadResult.cid;
    if (cid) {
      const existing = await this.runDbOperation(request.storageProvider, 'dedup-lookup', () =>
        StorageRecord.findOne({ cid }).exec()
      );
      if (existing) {
        return this.reuseRecord(existing, request, contentHash);
      }
    }

    // Persist result to MongoDB
    const storageRecord = new StorageRecord({
      userId: request.userId,
      assetId: request.assetId,
      kind: request.kind ?? 'media',
      provider: uploadResult.provider,
      url: uploadResult.url,
      cid,
      publicId: uploadResult.publicId,
      contentHash,
      size: uploadResult.size,
      mimetype: uploadResult.mimetype,
      originalFilename: request.originalname,
      uploadedAt: uploadResult.uploadedAt,
    });

    try {
      const savedRecord = await storageRecord.save();

      // Return the saved record (not the provider result)
      // Ensures response data always comes from MongoDB
      return this.toUploadResult(savedRecord, false);
    } catch (dbError) {
      // Lost a race with a concurrent upload of the same bytes: the unique
      // cid (or cid-derived gateway url) index rejected our insert, so
      // return the record that won.
      if (cid && isDuplicateKeyError(dbError, ['cid', 'url'])) {
        const winner = await this.runDbOperation(request.storageProvider, 'dedup-lookup', () =>
          StorageRecord.findOne({ cid }).exec()
        );
        if (winner) {
          return this.reuseRecord(winner, request, contentHash);
        }
      }

      throw new StorageError(
        uploadResult.provider,
        'persist',
        `Failed to persist upload record to database: ${dbError instanceof Error ? dbError.message : String(dbError)}`,
        500,
      );
    }
  }

  /**
   * Link a StorageRecord to the Asset it stores. A record is linked to the
   * first asset that claims it; later links for deduplicated bytes leave the
   * original linkage untouched. Returns the record as stored.
   */
  async linkAsset(recordId: string, assetId: string): Promise<UploadResult> {
    if (!mongoose.Types.ObjectId.isValid(recordId) || !mongoose.Types.ObjectId.isValid(assetId)) {
      throw new AppError('Invalid recordId or assetId', StatusCodes.BAD_REQUEST, 'INVALID_OBJECT_ID');
    }

    const linked = await StorageRecord.findOneAndUpdate(
      { _id: recordId, assetId: null },
      { $set: { assetId } },
      { new: true }
    ).exec();
    const record = linked ?? (await StorageRecord.findById(recordId).exec());

    if (!record) {
      throw new AppError('Storage record not found', StatusCodes.NOT_FOUND, 'STORAGE_RECORD_NOT_FOUND');
    }

    return this.toUploadResult(record, false);
  }

  /**
   * Find the Asset that owns the given media bytes, if any.
   * Used to link manifests (which carry the media contentHash) to their asset.
   */
  async findAssetIdByContentHash(contentHash: string): Promise<string | undefined> {
    const record = await StorageRecord.findOne({
      kind: 'media',
      contentHash: normalizeSha256(contentHash),
      assetId: { $ne: null },
    })
      .sort({ createdAt: 1 })
      .select('assetId')
      .exec();

    return record?.assetId?.toString();
  }

  /**
   * Return an existing record for a deduplicated upload, backfilling the
   * contentHash (legacy records) and asset link when they are missing.
   */
  private async reuseRecord(
    record: IStorageRecord,
    request: UploadRequest,
    contentHash: string
  ): Promise<UploadResult> {
    const backfill: Partial<Pick<IStorageRecord, 'contentHash' | 'assetId'>> = {};
    if (!record.contentHash) backfill.contentHash = contentHash;
    if (!record.assetId && request.assetId) {
      backfill.assetId = new mongoose.Types.ObjectId(request.assetId);
    }

    if (Object.keys(backfill).length === 0) {
      return this.toUploadResult(record, true);
    }

    const updated = await this.runDbOperation(request.storageProvider, 'persist', () =>
      StorageRecord.findByIdAndUpdate(record._id, { $set: backfill }, { new: true }).exec()
    );

    return this.toUploadResult(updated ?? record, true);
  }

  private toUploadResult(record: IStorageRecord, deduplicated: boolean): UploadResult {
    return {
      recordId: String(record._id),
      provider: record.provider,
      url: record.url,
      cid: record.cid,
      publicId: record.publicId,
      kind: record.kind,
      assetId: record.assetId?.toString(),
      size: record.size,
      mimetype: record.mimetype,
      uploadedAt: record.uploadedAt,
      deduplicated,
    };
  }

  private async runDbOperation<T>(
    provider: StorageProvider,
    operation: string,
    fn: () => Promise<T>
  ): Promise<T> {
    try {
      return await fn();
    } catch (dbError) {
      throw new StorageError(
        provider,
        operation,
        `Database operation failed: ${dbError instanceof Error ? dbError.message : String(dbError)}`,
        500,
      );
    }
  }

  /**
   * Resolve a CID against the IPFS gateway and verify it against the
   * SHA-256 recorded for it at upload time.
   * The StorageRecord is the source of truth: CIDs this service never
   * stored are rejected with 404 rather than proxied to the gateway.
   */
  async resolveCid(cid: string): Promise<CidResolutionResult> {
    if (!isValidCid(cid)) {
      throw new AppError('Invalid IPFS CID format', StatusCodes.BAD_REQUEST, 'INVALID_CID');
    }

    const record: IStorageRecord | null = await StorageRecord.findOne({ cid })
      .sort({ createdAt: -1 })
      .select('cid contentHash size')
      .exec();

    if (!record) {
      throw new AppError(`No storage record found for CID ${cid}`, StatusCodes.NOT_FOUND, 'CID_NOT_FOUND');
    }

    const fetchResult = await ipfsService.fetchFromGateway(cid, {
      timeoutMs: env.IPFS_RESOLVE_TIMEOUT_MS,
      maxBytes: env.IPFS_RESOLVE_MAX_BYTES,
    });

    const base = {
      cid,
      expectedSize: record.size,
      gatewayStatus: fetchResult.status,
      checkedAt: new Date(),
    };

    switch (fetchResult.status) {
      case 'ok':
        return {
          ...base,
          available: true,
          size: fetchResult.size,
          hashMatches: record.contentHash
            ? normalizeSha256(record.contentHash) === fetchResult.sha256
            : null,
        };

      case 'too_large':
        return { ...base, available: true, size: fetchResult.declaredSize, hashMatches: null };

      case 'not_found':
      case 'timeout':
      case 'unreachable':
        return { ...base, available: false, size: null, hashMatches: null };

      default: {
        const _exhaustive: never = fetchResult;
        throw new AppError(
          `Unhandled gateway status: ${JSON.stringify(_exhaustive)}`,
          StatusCodes.INTERNAL_SERVER_ERROR,
          'CID_RESOLVE_FAILED'
        );
      }
    }
  }
}

export const storageOrchestratorService = new StorageOrchestratorService(storageProviderRegistry);
