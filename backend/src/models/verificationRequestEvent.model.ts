/**
 * Mongoose model for VerificationRequestEvent documents.
 *
 * Schema design decisions:
 * - `eventId` is unique: the same request can never be enqueued twice.
 * - Compound indexes back the worker's claim query (due pending events and
 *   processing events whose lease has expired).
 * - `verificationJobId` links the event to the VerificationJob whose state
 *   machine the worker drives.
 */
import { Schema, model, Document } from "mongoose";
import { VerificationRequestEventStatus } from "../types/verificationRequestEvent.types";
import type { IVerificationRequestEvent } from "../types/verificationRequestEvent.types";

export type VerificationRequestEventDocument = Omit<
  IVerificationRequestEvent,
  "_id" | "verificationJobId"
> &
  Document & { verificationJobId?: Schema.Types.ObjectId };

const ALL_STATUSES = Object.values(VerificationRequestEventStatus);

const VerificationRequestEventSchema = new Schema<VerificationRequestEventDocument>(
  {
    eventId: {
      type: String,
      required: [true, "eventId is required"],
      trim: true,
      unique: true,
    },
    mediaCid: {
      type: String,
      required: [true, "mediaCid is required"],
      trim: true,
    },
    manifestCid: {
      type: String,
      required: [true, "manifestCid is required"],
      trim: true,
    },
    requester: {
      type: String,
      required: [true, "requester is required"],
      trim: true,
      index: true,
    },
    status: {
      type: String,
      required: true,
      enum: {
        values: ALL_STATUSES,
        message: `status must be one of: ${ALL_STATUSES.join(", ")}`,
      },
      default: VerificationRequestEventStatus.PENDING,
    },
    attempts: { type: Number, required: true, default: 0, min: 0 },
    nextAttemptAt: { type: Date, required: true, default: Date.now },
    lockedBy: { type: String, default: undefined },
    lockedUntil: { type: Date, default: undefined },

    verificationJobId: {
      type: Schema.Types.ObjectId,
      ref: "VerificationJob",
      index: true,
      default: undefined,
    },
    contentHash: { type: String, trim: true, default: undefined },
    manifestHash: { type: String, trim: true, default: undefined },
    transactionHash: { type: String, trim: true, default: undefined },
    certificateId: { type: String, trim: true, default: undefined },

    lastError: { type: String, default: undefined },
    completedAt: { type: Date, default: undefined },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

VerificationRequestEventSchema.index({ status: 1, nextAttemptAt: 1 });
VerificationRequestEventSchema.index({ status: 1, lockedUntil: 1 });

export const VerificationRequestEventModel = model<VerificationRequestEventDocument>(
  "VerificationRequestEvent",
  VerificationRequestEventSchema
);
