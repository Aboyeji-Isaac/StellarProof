import mongoose, { Schema, Document } from 'mongoose';
import { StorageProvider } from '../types/storage.types';

/**
 * Storage Record Interface
 * Persists upload metadata for every file uploaded via the storage orchestrator.
 * Links uploads to users and tracks provider-specific identifiers.
 */
export interface IStorageRecord extends Document {
  userId: mongoose.Types.ObjectId;
  assetId?: mongoose.Types.ObjectId;  // Asset this media/manifest belongs to
  kind: StorageRecordKind;            // 'media' | 'manifest'
  provider: StorageProvider;
  url: string;
  cid?: string;              // IPFS Content ID
  publicId?: string;         // Cloudinary Public ID
  contentHash?: string;      // SHA-256 (hex) of the uploaded bytes
  fallbackFrom?: StorageProvider; // Requested provider when the upload fell back to `provider`
  size: number;              // File size in bytes
  mimetype: string;          // MIME type (e.g., image/png)
  originalFilename: string;  // Original uploaded filename
  uploadedAt: Date;
  requestedProvider: StorageProvider; // Provider the client asked for
  fallbackUsed: boolean;              // True when `provider` differs from `requestedProvider`
  fallbackReason?: string;            // Why the requested provider failed
  createdAt: Date;
  updatedAt: Date;
}

const StorageRecordSchema: Schema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'User ID is required'],
      index: true,
    },
    assetId: {
      type: Schema.Types.ObjectId,
      ref: 'Asset',
      index: true,
    },
    kind: {
      type: String,
      enum: ['media', 'manifest'],
      required: [true, 'Record kind is required'],
      default: 'media',
      index: true,
    },
    provider: {
      type: String,
      enum: ['cloudinary', 'ipfs'],
      required: [true, 'Storage provider is required'],
      index: true,
    },
    url: {
      type: String,
      required: [true, 'Storage URL is required'],
      unique: true,
      index: true,
    },
    cid: {
      type: String,
      // Content-addressed: identical bytes share a CID, so one record per CID.
      // Sparse so Cloudinary records (no CID) are not indexed.
      unique: true,
      sparse: true,
    },
    publicId: {
      type: String,
      sparse: true, // Only required for Cloudinary uploads
      index: true,
    },
    contentHash: {
      type: String,
      lowercase: true,
      match: [/^[a-f0-9]{64}$/, 'contentHash must be a SHA-256 hex digest'],
    },
    fallbackFrom: {
      type: String,
      enum: ['cloudinary', 'ipfs'],
    },
    size: {
      type: Number,
      required: [true, 'File size is required'],
    },
    mimetype: {
      type: String,
      required: [true, 'MIME type is required'],
    },
    originalFilename: {
      type: String,
      required: [true, 'Original filename is required'],
    },
    uploadedAt: {
      type: Date,
      default: Date.now,
      required: true,
    },
    requestedProvider: {
      type: String,
      enum: ['cloudinary', 'ipfs'],
      required: [true, 'Requested storage provider is required'],
    },
    fallbackUsed: {
      type: Boolean,
      default: false,
      index: true,
    },
    fallbackReason: {
      type: String,
      maxlength: 1000,
    },
  },
  { timestamps: true }
);

// Pre-upload deduplication lookup: identical bytes already pinned to a provider
StorageRecordSchema.index({ contentHash: 1, provider: 1 });

export default mongoose.model<IStorageRecord>('StorageRecord', StorageRecordSchema);
