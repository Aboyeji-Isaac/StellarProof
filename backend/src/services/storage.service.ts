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
import StorageRecord from '../models/StorageRecord.model';
import { env } from '../config/env';
import logger from '../utils/logger';

/** Provider-level upload outcome, before fallback bookkeeping is attached. */
type ProviderUpload = Omit<UploadResult, 'requestedProvider' | 'fallbackUsed'>;

interface ResolvedUpload {
  uploadResult: ProviderUpload;
  /** Set only when the requested provider failed and a fallback stored the file. */
  fallbackReason?: string;
}

/** Mirrors the `maxlength` of StorageRecord.fallbackReason. */
const MAX_FALLBACK_REASON_LENGTH = 1000;

const toErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Storage Orchestrator Service
 * Factory that routes upload requests to the appropriate provider (Cloudinary or IPFS)
 * Consults the provider registry before each upload and fails over to the
 * next ranked provider when the preferred one is unhealthy or errors.
 * Ensures all uploads are persisted to MongoDB before returning
 *
 * IPFS uploads are resilient: if pinning errors or exceeds IPFS_UPLOAD_TIMEOUT_MS,
 * the same buffer is transparently routed to Cloudinary and the StorageRecord
 * records which provider actually holds the file.
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

    // Delegate to provider (with Cloudinary fallback for IPFS)
    const { uploadResult, fallbackReason } = await this.uploadWithFallback(request);

    // Persist result to MongoDB
    const storageRecord = new StorageRecord({
      userId: request.userId,
      provider: uploadResult.provider,
      url: uploadResult.url,
      cid: uploadResult.cid,
      publicId: uploadResult.publicId,
      size: uploadResult.size,
      mimetype: uploadResult.mimetype,
      originalFilename: request.originalname,
      uploadedAt: uploadResult.uploadedAt,
      requestedProvider: request.storageProvider,
      fallbackUsed: uploadResult.provider !== request.storageProvider,
      fallbackReason,
    });

    if (Object.keys(backfill).length === 0) {
      return this.toUploadResult(record, true);
    }

      // Return the saved record (not the provider result)
      // Ensures response data always comes from MongoDB
      return {
        provider: savedRecord.provider,
        requestedProvider: savedRecord.requestedProvider,
        fallbackUsed: savedRecord.fallbackUsed,
        url: savedRecord.url,
        cid: savedRecord.cid,
        publicId: savedRecord.publicId,
        size: savedRecord.size,
        mimetype: savedRecord.mimetype,
        uploadedAt: savedRecord.uploadedAt,
      };
    } catch (dbError) {
      throw new StorageError(
        uploadResult.provider,
        'persist',
        `Failed to persist upload record to database: ${toErrorMessage(dbError)}`,
        500,
      );
    }
  }

  /**
   * Uploads to the requested provider. When IPFS is requested and fails for
   * any reason (provider error, network error, timeout), retries the same
   * buffer on Cloudinary. Cloudinary requests are never redirected to IPFS.
   */
  private async uploadWithFallback(request: UploadRequest): Promise<ResolvedUpload> {
    if (request.storageProvider === 'cloudinary') {
      return { uploadResult: await this.uploadToCloudinary(request) };
    }

    try {
      return { uploadResult: await this.uploadToIpfs(request) };
    } catch (ipfsError) {
      const fallbackReason = toErrorMessage(ipfsError).slice(0, MAX_FALLBACK_REASON_LENGTH);
      const logContext = {
        userId: request.userId,
        originalname: request.originalname,
        size: request.buffer.length,
      };

      logger.warn('IPFS upload failed; falling back to Cloudinary', {
        ...logContext,
        reason: fallbackReason,
      });

      try {
        const uploadResult = await this.uploadToCloudinary(request);
        logger.info('Cloudinary fallback upload succeeded', {
          ...logContext,
          publicId: uploadResult.publicId,
        });
        return { uploadResult, fallbackReason };
      } catch (cloudinaryError) {
        const cloudinaryReason = toErrorMessage(cloudinaryError);
        logger.error('Cloudinary fallback upload failed after IPFS failure', {
          ...logContext,
          ipfsReason: fallbackReason,
          cloudinaryReason,
        });

        // Both providers are down: report a structured, retryable error.
        throw new StorageError(
          'ipfs',
          'upload',
          `IPFS upload failed (${fallbackReason}) and Cloudinary fallback failed (${cloudinaryReason})`,
          503,
        );
      }
    }
  }

  private async uploadToCloudinary(request: UploadRequest): Promise<ProviderUpload> {
    try {
      const cloudinaryUpload = await cloudinaryService.uploadBuffer(request.buffer);
      return {
        provider: 'cloudinary',
        url: cloudinaryUpload.secure_url,
        publicId: cloudinaryUpload.public_id,
        size: cloudinaryUpload.bytes,
        mimetype: request.mimetype,
        uploadedAt: new Date(cloudinaryUpload.created_at),
      };
    } catch (error) {
      throw new StorageError(
        'cloudinary',
        'upload',
        `Provider delegation failed: ${toErrorMessage(error)}`,
        502,
      );
    }
  }

  private async uploadToIpfs(request: UploadRequest): Promise<ProviderUpload> {
    const ipfsUpload = await this.withIpfsTimeout(
      ipfsService.upload({
        content: request.buffer,
        name: request.originalname,
      }),
      request,
    );

    return {
      provider: 'ipfs',
      url: ipfsUpload.gatewayUrl,
      cid: ipfsUpload.cid,
      size: ipfsUpload.size,
      mimetype: request.mimetype,
      uploadedAt: new Date(ipfsUpload.timestamp),
    };
  }

  /**
   * Rejects if IPFS pinning does not settle within IPFS_UPLOAD_TIMEOUT_MS.
   * A pin that completes after the deadline is not tracked by any
   * StorageRecord, so its CID is logged for manual reconciliation.
   */
  private withIpfsTimeout<T extends { cid: string }>(
    pending: Promise<T>,
    request: UploadRequest,
  ): Promise<T> {
    const timeoutMs = env.IPFS_UPLOAD_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return pending;
    }

    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(new Error(`IPFS pinning timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    pending.then(
      (late) => {
        if (timedOut) {
          logger.warn('IPFS pin completed after timeout; CID is not tracked by any StorageRecord', {
            userId: request.userId,
            originalname: request.originalname,
            cid: late.cid,
          });
        }
      },
      // Rejections are handled by the race below; swallow here to avoid an unhandled rejection.
      () => undefined,
    );

    return Promise.race([pending, timeout]).finally(() => clearTimeout(timer));
  }
}

export const storageOrchestratorService = new StorageOrchestratorService(storageProviderRegistry);
