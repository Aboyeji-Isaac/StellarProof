/**
 * Domain types for VerificationRequestEvents: the durable queue of
 * verification requests consumed by the oracle verification worker.
 */

/**
 * Processing lifecycle of an event.
 *
 *   pending → processing → completed
 *                ↘ pending (retry scheduled) | failed
 *
 * A `processing` event whose lease has expired is reclaimable, which is how
 * work held by a crashed worker is recovered.
 */
export enum VerificationRequestEventStatus {
  PENDING = "pending",
  PROCESSING = "processing",
  COMPLETED = "completed",
  FAILED = "failed",
}

export interface IVerificationRequestEvent {
  _id: string;

  /** Idempotency key from the event source; unique per request. */
  eventId: string;

  /** IPFS CID of the media under verification. */
  mediaCid: string;
  /** IPFS CID of the manifest describing the media. */
  manifestCid: string;
  /** Stellar G-address that requested verification; receives the certificate. */
  requester: string;

  status: VerificationRequestEventStatus;
  /** Number of times the event has been claimed for processing. */
  attempts: number;
  /** Earliest time the event may be claimed. */
  nextAttemptAt: Date;
  /** Identity of the worker holding the lease. */
  lockedBy?: string;
  /** Lease expiry; after this another worker may reclaim the event. */
  lockedUntil?: Date;

  /** VerificationJob tracking this request's state machine. */
  verificationJobId?: string;
  /** SHA-256 of the media, recorded once verification has run. */
  contentHash?: string;
  /** SHA-256 of the manifest bytes, recorded once verification has run. */
  manifestHash?: string;
  /** Hash of the mint transaction currently in flight or confirmed. */
  transactionHash?: string;
  /** Certificate ID returned by `provenance.mint` once confirmed. */
  certificateId?: string;

  lastError?: string;
  completedAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}
