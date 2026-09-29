import mongoose, { Schema, Document } from 'mongoose';
import type { ProviderHealthStatus, StorageProvider } from '../types/storage.types';

/**
 * Storage Provider Health
 * One document per storage provider holding the latest health-check result.
 * Shared by every API instance so the failover ranking is consistent across
 * the deployment.
 */
export interface IStorageProviderHealth extends Document {
  provider: StorageProvider;
  status: ProviderHealthStatus;
  latencyMs?: number;
  consecutiveFailures: number;
  lastError?: string;
  lastCheckedAt: Date;
  lastHealthyAt?: Date;
  /** Whether the result came from an active probe or an observed upload. */
  source: 'probe' | 'upload';
  createdAt: Date;
  updatedAt: Date;
}

const StorageProviderHealthSchema: Schema = new Schema(
  {
    provider: {
      type: String,
      enum: ['cloudinary', 'ipfs'],
      required: [true, 'Storage provider is required'],
      unique: true,
    },
    status: {
      type: String,
      enum: ['healthy', 'unhealthy'],
      required: true,
    },
    latencyMs: {
      type: Number,
      min: 0,
    },
    consecutiveFailures: {
      type: Number,
      default: 0,
      min: 0,
    },
    lastError: {
      type: String,
      maxlength: 1000,
    },
    lastCheckedAt: {
      type: Date,
      required: true,
    },
    lastHealthyAt: {
      type: Date,
    },
    source: {
      type: String,
      enum: ['probe', 'upload'],
      required: true,
    },
  },
  { timestamps: true }
);

export default mongoose.model<IStorageProviderHealth>('StorageProviderHealth', StorageProviderHealthSchema);
