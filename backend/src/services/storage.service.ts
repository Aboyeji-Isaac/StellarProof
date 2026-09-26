import { createHash } from 'crypto';
import { StatusCodes } from 'http-status-codes';
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

/** Accepts both "sha256:<hex>" and bare "<hex>" forms. */
function normalizeSha256(hash: string): string {
  return hash.trim().toLowerCase().replace(/^sha256:/, '');
}

/**
 * Storage Orchestrator Service
 * Factory that routes upload requests to the appropriate provider (Cloudinary or IPFS)
 * Ensures all uploads are persisted to MongoDB before returning
 */
class StorageOrchestratorService {
  /**
   * Orchestrate the upload based on the requested storage provider
   * Routes to the appropriate provider, persists result to DB, and returns saved record
   */
  async orchestrate(request: UploadRequest): Promise<UploadResult> {
    // Validate provider
    const validProviders: StorageProvider[] = ['cloudinary', 'ipfs'];
    if (!validProviders.includes(request.storageProvider)) {
      throw new StorageError(
        null,
        'orchestrate',
        `Invalid storage provider: ${request.storageProvider}. Supported providers: ${validProviders.join(', ')}`,
        400,
      );
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
            name: request.originalname
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

      throw new StorageError(
        request.storageProvider,
        'orchestrate',
        `Provider delegation failed: ${error instanceof Error ? error.message : String(error)}`,
        502,
      );
    }

    // Persist result to MongoDB
    const storageRecord = new StorageRecord({
      userId: request.userId,
      provider: uploadResult.provider,
      url: uploadResult.url,
      cid: uploadResult.cid,
      publicId: uploadResult.publicId,
      contentHash: sha256Hex(request.buffer),
      size: uploadResult.size,
      mimetype: uploadResult.mimetype,
      originalFilename: request.originalname,
      uploadedAt: uploadResult.uploadedAt,
    });

    try {
      const savedRecord = await storageRecord.save();

      // Return the saved record (not the provider result)
      // Ensures response data always comes from MongoDB
      return {
        provider: savedRecord.provider,
        url: savedRecord.url,
        cid: savedRecord.cid,
        publicId: savedRecord.publicId,
        size: savedRecord.size,
        mimetype: savedRecord.mimetype,
        uploadedAt: savedRecord.uploadedAt,
      };
    } catch (dbError) {
      throw new StorageError(
        request.storageProvider,
        'persist',
        `Failed to persist upload record to database: ${dbError instanceof Error ? dbError.message : String(dbError)}`,
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

export const storageOrchestratorService = new StorageOrchestratorService();
