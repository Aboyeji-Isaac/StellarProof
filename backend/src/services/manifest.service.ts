import { StatusCodes } from "http-status-codes";
import mongoose from "mongoose";
import { z } from "zod";
import { SPVModel } from "../models/spv.model";
import ManifestModel, { IManifest, buildManifestHashPayload } from "../models/Manifest.model";
import { AppError } from "../errors/AppError";
import { ipfsService } from "./ipfs.service";
import { generateDeterministicHash, sortObjectKeys } from "../utils/crypto";
import type { IUser } from "../models/User.model";
import type {
  IManifestEntry,
  ListManifestsQuery,
  ManifestIpfsUploadResult,
  ManifestListResult,
} from "../types/manifest.types";

const STELLAR_PUBLIC_KEY_REGEX = /^G[A-Z2-7]{55}$/;

const createManifestBodySchema = z.object({
  contentHash: z.string().min(1, "contentHash is required"),
  creator: z
    .string()
    .regex(STELLAR_PUBLIC_KEY_REGEX, "Invalid Stellar public key (G...)")
    .optional(),
  timestamp: z
    .preprocess((value) => {
      if (typeof value === "string") {
        return new Date(value);
      }
      return value;
    }, z.date().refine((date) => !Number.isNaN(date.getTime()), {
      message: "Invalid timestamp",
    }))
    .optional(),
  metadata: z.record(z.unknown()).optional(),
}).strict();

const EXCLUDED_FIELDS = { encryptedPayload: 0 } as const;

class ManifestService {
  /**
   * Returns a paginated list of manifests owned by the given Stellar public key.
   */
  public async listManifests(query: ListManifestsQuery): Promise<ManifestListResult> {
    const { ownerPublicKey, limit, skip } = query;

    if (limit < 1 || limit > 100) {
      throw new AppError("limit must be between 1 and 100", StatusCodes.BAD_REQUEST, "INVALID_PAGINATION");
    }

    if (skip < 0) {
      throw new AppError("skip must be a non-negative integer", StatusCodes.BAD_REQUEST, "INVALID_PAGINATION");
    }

    const filter = { ownerPublicKey };

    const [manifests, total] = await Promise.all([
      SPVModel.find(filter, EXCLUDED_FIELDS)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean<IManifestEntry[]>(),
      SPVModel.countDocuments(filter),
    ]);

    return { manifests, total, limit, skip };
  }

  public prepareManifestPayload(payload: unknown, user: IUser): Partial<IManifest> {
    const result = createManifestBodySchema.safeParse(payload);
    if (!result.success) {
      throw new AppError(
        "Invalid manifest payload",
        StatusCodes.BAD_REQUEST,
        "INVALID_MANIFEST_PAYLOAD"
      );
    }

    const { contentHash, creator, timestamp, metadata } = result.data;
    const userPublicKey = user.stellarPublicKey;

    if (userPublicKey && creator && creator !== userPublicKey) {
      throw new AppError(
        "Creator public key does not match authenticated user",
        StatusCodes.FORBIDDEN,
        "CREATOR_MISMATCH"
      );
    }

    const effectiveCreator = userPublicKey ?? creator;
    if (!effectiveCreator) {
      throw new AppError(
        "Creator public key is required when the authenticated user has no connected wallet",
        StatusCodes.BAD_REQUEST,
        "CREATOR_REQUIRED"
      );
    }

    return {
      contentHash,
      creator: effectiveCreator,
      creatorId: user.id,
      timestamp: timestamp ?? new Date(),
      metadata,
    };
  }

  /**
   * Recursively sanitizes dynamic objects.
   * - Strips HTML/XML tags to prevent XSS.
   * - Truncates strings to 1000 characters to prevent DB bloat.
   */
  private sanitizePayload(val: unknown): unknown {
    if (typeof val === 'string') {
      const sanitized = val.replace(/<[^>]*>?/gm, '');
      return sanitized.substring(0, 1000);
    }
    if (Array.isArray(val)) {
      return val.map((item) => this.sanitizePayload(item));
    }
    if (val !== null && typeof val === 'object') {
      const sanitizedObj: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(val)) {
        sanitizedObj[key] = this.sanitizePayload(value);
      }
      return sanitizedObj;
    }
    return val;
  }

  /**
   * Validates, sanitizes, and saves a manifest payload.
   */
  public async processManifest(payload: any): Promise<IManifest> {
    if (!payload || !payload.creator || !payload.creatorId || !payload.contentHash || !payload.timestamp) {
      throw new Error('Validation Error: "contentHash", "creator", "creatorId", and "timestamp" are strictly required.');
    }

    const sanitizedMetadata = this.sanitizePayload(payload.metadata || {});

    const newManifest = new ManifestModel({
      contentHash: payload.contentHash,
      creator: payload.creator,
      creatorId: payload.creatorId,
      timestamp: new Date(payload.timestamp),
      metadata: sanitizedMetadata,
    });

    return await newManifest.save();
  }

  /**
   * Serializes the manifest deterministically (sorted keys, manifestHash from
   * utils/crypto.ts), pins it to IPFS via Pinata and persists ipfsCid/ipfsUrl
   * on the Manifest document so verification requests can reference the
   * manifestCid.
   *
   * Pinning is idempotent: a manifest that already has an ipfsCid is returned
   * unchanged instead of being pinned again.
   */
  public async uploadManifestToPinata(manifest: IManifest): Promise<ManifestIpfsUploadResult> {
    const manifestId = String(manifest._id);

    if (manifest.ipfsCid && manifest.ipfsUrl && manifest.ipfsUploadedAt && manifest.manifestHash) {
      return this.toIpfsUploadResult(manifest, false);
    }

    const hashPayload = buildManifestHashPayload(manifest);
    const manifestHash = generateDeterministicHash(hashPayload);

    if (manifest.manifestHash && manifest.manifestHash !== manifestHash) {
      throw new AppError(
        "Stored manifestHash does not match the manifest content",
        StatusCodes.CONFLICT,
        "MANIFEST_HASH_MISMATCH"
      );
    }

    // Sorted-key object: JSON.stringify preserves insertion order, so the
    // pinned bytes are identical to canonicalStringify(document).
    const document = sortObjectKeys({ ...hashPayload, manifestHash });

    const upload = await ipfsService.upload({
      content: document,
      name: `manifest-${manifestId}`,
      metadata: { manifestId, manifestHash },
    });

    manifest.manifestHash = manifestHash;
    manifest.ipfsCid = upload.cid;
    manifest.ipfsUrl = upload.gatewayUrl;
    manifest.ipfsUploadedAt = new Date(upload.timestamp);
    await manifest.save();

    const persisted = await ManifestModel.findById(manifestId);
    if (!persisted || !persisted.ipfsCid) {
      throw new AppError(
        "Failed to persist manifest IPFS reference",
        StatusCodes.INTERNAL_SERVER_ERROR,
        "MANIFEST_PERSIST_FAILED"
      );
    }

    return this.toIpfsUploadResult(persisted, true);
  }

  /**
   * Loads a manifest by id, enforces ownership when a requester is supplied,
   * and pins it via uploadManifestToPinata.
   */
  public async publishManifestById(
    manifestId: string,
    requesterId?: string
  ): Promise<ManifestIpfsUploadResult> {
    if (!mongoose.Types.ObjectId.isValid(manifestId)) {
      throw new AppError("Valid manifestId is required", StatusCodes.BAD_REQUEST, "INVALID_MANIFEST_ID");
    }

    const manifest = await ManifestModel.findById(manifestId);
    if (!manifest) {
      throw new AppError("Manifest not found", StatusCodes.NOT_FOUND, "MANIFEST_NOT_FOUND");
    }

    if (requesterId && manifest.creatorId?.toString() !== requesterId) {
      throw new AppError(
        "You do not have permission to publish this manifest",
        StatusCodes.FORBIDDEN,
        "MANIFEST_FORBIDDEN"
      );
    }

    return this.uploadManifestToPinata(manifest);
  }

  private toIpfsUploadResult(manifest: IManifest, newlyPinned: boolean): ManifestIpfsUploadResult {
    return {
      manifestId: String(manifest._id),
      manifestHash: manifest.manifestHash as string,
      manifestCid: manifest.ipfsCid as string,
      ipfsUrl: manifest.ipfsUrl as string,
      ipfsUploadedAt: manifest.ipfsUploadedAt as Date,
      newlyPinned,
    };
  }
}

export const manifestService = new ManifestService();