/**
 * Mongoose model for VerificationJob documents.
 *
 * Schema design decisions:
 * - `contentHash` is indexed (not unique): the same content may be re-submitted
 *   after a failed job.
 * - `ownerPublicKey` is indexed: efficient queries by submitter.
 * - `status` is indexed: efficient filtering by lifecycle state.
 * - TEE and blockchain fields are optional at schema level; the service layer
 *   enforces their presence when the associated state transition occurs.
 * - Timeline entries are persisted as an array of sub-documents so the full
 *   state-machine traversal can be audited.
 * - Timestamps are enabled via Mongoose options (adds `createdAt` / `updatedAt`).
 */
import { Schema, model, Document } from "mongoose";
import { VerificationStatus } from "../types/verification.types";
import type {
  IVerificationJob,
  IVerificationTimelineEntry,
} from "../types/verification.types";

export type VerificationJobDocument = IVerificationJob & Document;

const ALL_STATUSES = Object.values(VerificationStatus);

const VerificationTimelineEntrySchema = new Schema<IVerificationTimelineEntry>(
  {
    status: {
      type: String,
      required: [true, "timeline entry status is required"],
      enum: {
        values: ALL_STATUSES,
        message: `timeline entry status must be one of: ${ALL_STATUSES.join(", ")}`,
      },
    },
    timestamp: {
      type: Date,
      required: [true, "timeline entry timestamp is required"],
      default: Date.now,
    },
    message: {
      type: String,
      trim: true,
      default: undefined,
    },
    metadata: {
      type: Schema.Types.Mixed,
      default: undefined,
    },
  },
  { _id: false, versionKey: false }
);

const VerificationJobSchema = new Schema<VerificationJobDocument>(
  {
    manifestId: {
      type: Schema.Types.ObjectId,
      ref: "Manifest",
      index: true,
      default: undefined,
    },
    assetId: {
      type: Schema.Types.ObjectId,
      ref: "Asset",
      index: true,
      default: undefined,
    },
    ownerPublicKey: {
      type: String,
      required: [true, "ownerPublicKey is required"],
      trim: true,
      index: true,
    },
    contentHash: {
      type: String,
      required: [true, "contentHash is required"],
      trim: true,
      index: true,
    },
    manifestHash: {
      type: String,
      trim: true,
      index: true,
      default: undefined,
    },
    requestId: {
      type: String,
      trim: true,
      index: true,
      default: undefined,
    },
    status: {
      type: String,
      required: [true, "status is required"],
      enum: {
        values: ALL_STATUSES,
        message: `status must be one of: ${ALL_STATUSES.join(", ")}`,
      },
      default: VerificationStatus.PENDING,
      index: true,
    },

    // Timeline of state-machine transitions
    timeline: {
      type: [VerificationTimelineEntrySchema],
      default: [],
    },

    // TE attestation fields
    teeAttestationHash: {
      type: String,
      trim: true,
      default: undefined,
    },
    teeSignature: {
      type: String,
      trim: true,
      default: undefined,
    },
    codeMeasurementHash: {
      type: String,
      trim: true,
      default: undefined,
    },

    // Blockchain fields
    stellarTransactionHash: {
      type: String,
      trim: true,
      default: undefined,
    },
    attestationTransactionHash: {
      type: String,
      trim: true,
      default: undefined,
    },
    certificateId: {
      type: String,
      trim: true,
      index: true,
      default: undefined,
    },

    // Failure fields
    errorMessage: {
      type: String,
      trim: true,
      default: undefined,
    },

    webhookUrl: {
      type: String,
      trim: true,
      default: undefined,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

export const VerificationJobModel = model<VerificationJobDocument>(
  "VerificationJob",
  VerificationJobSchema
);
