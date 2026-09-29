import mongoose, { Schema, Document } from 'mongoose';
import { generateDeterministicHash } from '../utils/crypto';

/**
 * Manifest Interface
 * Based on the StellarProof README manifest schema design.
 * Stores the metadata related to a specific piece of digital media.
 */
export interface IManifest extends Document {
  contentHash: string;           // e.g. sha256:...
  creator: string;               // Stellar Public Key
  creatorId: mongoose.Types.ObjectId; // Reference to User model
  timestamp: Date;               // When the content was created
  metadata: {
    device?: string;
    location?: string;
    aiModel?: string;
    description?: string;
    tags?: string[];
    [key: string]: any;          // Allow arbitrary additional metadata
  };
  manifestHash?: string;         // The hash of this entire manifest document
  ipfsCid?: string;
  ipfsUrl?: string;
  ipfsUploadedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const ManifestSchema: Schema = new Schema(
  {
    contentHash: {
      type: String,
      required: true,
      index: true,
    },
    creator: {
      type: String,
      required: true,
    },
    creatorId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    timestamp: {
      type: Date,
      required: true,
      default: Date.now,
    },
    metadata: {
      device: String,
      location: String,
      aiModel: String,
      description: String,
      tags: [String],
    },
    manifestHash: {
      type: String,
      unique: true,
      sparse: true,
    },
    ipfsCid: {
      type: String,
      index: true,
    },
    ipfsUrl: {
      type: String,
    },
    ipfsUploadedAt: {
      type: Date,
    }
  },
  { 
    timestamps: true,
    strict: false // Allows dynamic keys inside metadata
  }
);

/**
 * Core business fields covered by manifestHash.
 * _id, __v, createdAt, updatedAt and IPFS fields are excluded so the hash is
 * purely based on the manifest content.
 */
export interface ManifestHashPayload {
  contentHash: string;
  creator: string;
  creatorId?: string;
  timestamp?: string;
  metadata: Record<string, unknown>;
}

/**
 * Builds the payload hashed into manifestHash. Metadata is read from the
 * plain-object form so arbitrary (non-schema) metadata keys are included.
 */
export function buildManifestHashPayload(manifest: IManifest): ManifestHashPayload {
  const plain = manifest.toObject({ depopulate: true, getters: false, virtuals: false });

  return {
    contentHash: manifest.contentHash,
    creator: manifest.creator,
    creatorId: manifest.creatorId ? manifest.creatorId.toString() : undefined,
    timestamp: manifest.timestamp ? manifest.timestamp.toISOString() : undefined,
    metadata: (plain.metadata as Record<string, unknown> | undefined) || {},
  };
}

// --- Pre-save hook for deterministic hashing ---
ManifestSchema.pre<IManifest>('save', function (next) {
  // Only recalculate the hash if relevant content fields have been modified
  if (
    this.isModified('contentHash') ||
    this.isModified('creator') ||
    this.isModified('creatorId') ||
    this.isModified('timestamp') ||
    this.isModified('metadata')
  ) {
    try {
      this.manifestHash = generateDeterministicHash(buildManifestHashPayload(this));
    } catch (error) {
      return next(error as Error);
    }
  }
  next();
});

export default mongoose.model<IManifest>('Manifest', ManifestSchema);
