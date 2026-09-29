/**
 * Verification worker: a long-running process that drives each
 * VerificationRequestEvent through the off-chain pipeline.
 *
 *   claim event → SPV verify → create/advance VerificationJob
 *     → attest → build + sign provenance.mint → submit
 *     → wait for SUCCESS → complete job
 *
 * Guarantees:
 * - One cycle at a time per worker (the next cycle is scheduled only after
 *   the current one finishes).
 * - One worker per event (atomic claim + lease; see the event service).
 * - A job is marked completed only after the mint transaction is confirmed
 *   `SUCCESS` on-chain.
 * - Each event is processed in isolation: its failure is recorded and the
 *   worker moves on.
 * - Processing resumes from the job's current state, so a crash at any step
 *   is recovered when the event's lease expires and it is reclaimed.
 *
 * Run standalone: `pnpm worker:verification` (dev) or `pnpm start:worker`.
 */
import os from "os";
import crypto from "crypto";
import { Keypair, scValToNative } from "@stellar/stellar-sdk";
import { connectDatabase, disconnectDatabase } from "../config/database";
import {
  loadOracleConfig,
  loadVerificationWorkerConfig,
  type OracleConfig,
  type VerificationWorkerConfig,
} from "../config/oracle";
import { AppError } from "../errors/AppError";
import {
  SorobanTransactionError,
  TransactionConfirmationTimeoutError,
  TransactionFailedError,
  TransactionSubmissionError,
} from "../errors/SorobanTransactionError";
import { attestationService, type Attestation, type AttestationInput } from "../services/attestation.service";
import { sorobanService, type SorobanService } from "../services/soroban.service";
import {
  SpvFetchError,
  spvVerifierService,
  type SpvVerificationRequest,
  type SpvVerificationResult,
} from "../services/spvVerifier.service";
import { verificationService } from "../services/verification.service";
import {
  LeaseLostError,
  verificationRequestEventService,
  type VerificationRequestEventServiceType,
} from "../services/verificationRequestEvent.service";
import logger from "../utils/logger";
import { VerificationStatus, type IVerificationJob } from "../types/verification.types";
import type { IVerificationRequestEvent } from "../types/verificationRequestEvent.types";

/** Upper bound on retry back-off regardless of attempt count. */
const MAX_RETRY_DELAY_MS = 15 * 60 * 1000;

type Logger = Pick<typeof logger, "info" | "warn" | "error" | "debug">;

export interface VerificationWorkerDeps {
  events: Pick<
    VerificationRequestEventServiceType,
    | "claimNext"
    | "attachJob"
    | "recordVerification"
    | "recordTransaction"
    | "markCompleted"
    | "markFailed"
    | "scheduleRetry"
  >;
  jobs: Pick<typeof verificationService, "createJob" | "getJob" | "updateJobStatus">;
  verifier: { verify(request: SpvVerificationRequest): Promise<SpvVerificationResult> };
  attestations: {
    createAttestation(input: AttestationInput, keypair: Keypair, codeMeasurementHash: string): Attestation;
  };
  soroban: Pick<
    SorobanService,
    "buildMintTransaction" | "submitTransaction" | "getTransactionWithConfirmation"
  >;
  oracle: OracleConfig;
  config: VerificationWorkerConfig;
  logger: Logger;
  workerId?: string;
  now?: () => Date;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Whether a later attempt could succeed. Unknown (non-application) errors,
 * such as a dropped database connection, are treated as transient.
 */
export function isRetryableError(err: unknown): boolean {
  if (err instanceof SorobanTransactionError) return err.retryable;
  if (err instanceof SpvFetchError) return err.retryable;
  if (err instanceof AppError) return false;
  return true;
}

/** True when a previously submitted transaction definitely did not take effect. */
function transactionDidNotLand(err: unknown): boolean {
  return (
    (err instanceof TransactionFailedError && err.diagnostics.ledger !== undefined) ||
    (err instanceof TransactionConfirmationTimeoutError && !err.outcomeUnknown)
  );
}

function isTerminal(status: VerificationStatus): boolean {
  return status === VerificationStatus.COMPLETED || status === VerificationStatus.FAILED;
}

export class VerificationWorker {
  private readonly workerId: string;
  private readonly now: () => Date;
  private timer: NodeJS.Timeout | null = null;
  private currentCycle: Promise<number> | null = null;
  private running = false;
  private stopRequested = false;

  constructor(private readonly deps: VerificationWorkerDeps) {
    this.workerId =
      deps.workerId ?? `${os.hostname()}:${process.pid}:${crypto.randomBytes(4).toString("hex")}`;
    this.now = deps.now ?? (() => new Date());
  }

  get id(): string {
    return this.workerId;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Starts polling immediately, then every `pollIntervalMs` after each cycle ends. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopRequested = false;
    this.deps.logger.info("Verification worker: started", {
      workerId: this.workerId,
      pollIntervalMs: this.deps.config.pollIntervalMs,
      batchSize: this.deps.config.batchSize,
      oracle: this.deps.oracle.keypair.publicKey(),
    });
    this.scheduleNext(0);
  }

  /** Stops scheduling new cycles and waits for the in-flight cycle to finish. */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.stopRequested = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.currentCycle) {
      await this.currentCycle;
    }
    this.deps.logger.info("Verification worker: stopped", { workerId: this.workerId });
  }

  private scheduleNext(delayMs: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runCycle().finally(() => this.scheduleNext(this.deps.config.pollIntervalMs));
    }, delayMs);
  }

  /**
   * Claims and processes up to `batchSize` due events. Returns the number
   * processed. Overlapping calls are rejected rather than run concurrently.
   */
  async runCycle(): Promise<number> {
    if (this.currentCycle) {
      this.deps.logger.warn("Verification worker: cycle skipped, previous cycle still running", {
        workerId: this.workerId,
      });
      return 0;
    }

    this.currentCycle = this.drainBatch();
    try {
      return await this.currentCycle;
    } finally {
      this.currentCycle = null;
    }
  }

  private async drainBatch(): Promise<number> {
    let processed = 0;
    while (processed < this.deps.config.batchSize) {
      // Finish the event in hand on shutdown, but do not claim another.
      if (this.stopRequested) break;

      let event: IVerificationRequestEvent | null;
      try {
        event = await this.deps.events.claimNext({
          workerId: this.workerId,
          leaseMs: this.deps.config.leaseMs,
          now: this.now(),
        });
      } catch (err) {
        this.deps.logger.error("Verification worker: failed to claim event", {
          workerId: this.workerId,
          error: describeError(err),
        });
        break;
      }
      if (!event) break;

      await this.processEvent(event);
      processed += 1;
    }
    return processed;
  }

  /** Runs one event to completion, retry, or failure. Never throws. */
  async processEvent(event: IVerificationRequestEvent): Promise<void> {
    const ctx = { workerId: this.workerId, eventId: event.eventId, attempt: event.attempts };
    let jobId = event.verificationJobId;

    try {
      if (event.attempts > this.deps.config.maxAttempts) {
        throw new AppError(
          `Exceeded ${this.deps.config.maxAttempts} processing attempts`,
          500,
          "MAX_ATTEMPS_EXCEEDED"
        );
      }

      this.deps.logger.info("Verification worker: processing event", ctx);
      const outcome = await this.advance(event, (id) => {
        jobId = id;
      });
      this.deps.logger.info("Verification worker: event finished", { ...ctx, jobId, outcome });
    } catch (err) {
      await this.handleFailure(event, jobId, err);
    }
  }

  /** Drives the event's job from its current state to a terminal state. */
  private async advance(
    event: IVerificationRequestEvent,
    onJob: (jobId: string) => void
  ): Promise<"completed" | "rejected"> {
    const { events, jobs } = this.deps;
    let job: IVerificationJob | null = event.verificationJobId
      ? await jobs.getJob(event.verificationJobId)
      : null;

    if (job && isTerminal(job.status)) {
      return this.settleFromTerminalJob(event, job);
    }

    let manifestHash = event.manifestHash;

    // Stage 1: verification (fresh event, or crash before attestation).
    if (!job || job.status === VerificationStatus.PENDING || job.status === VerificationStatus.PROCESSING) {
      const result = await this.deps.verifier.verify({
        mediaCid: event.mediaCid,
        manifestCid: event.manifestCid,
        requester: event.requester,
      });

      if (!job) {
        job = await jobs.createJob({ wnerPublicKey: event.requester, contentHash: result.contentHash });
        await events.attachJob(event._id, this.workerId, String(job._id));
      }
      const id = String(job._id);
      onJob(id);
      await events.recordVerification(event._id, this.workerId, {
        contentHash: result.contentHash,
        manifestHash: result.manifestHash,
      });
      manifestHash = result.manifestHash;

      if (job.status === VerificationStatus.PENDING) {
        job = await jobs.updateJobStatus(id, { status: VerificationStatus.PROCESSING });
      }

      if (!result.verified) {
        const reason = `SPV verification failed: ${result.reason ?? "unknown reason"}`;
        await jobs.updateJobStatus(id, { status: VerificationStatus.FAILED, errorMessage: reason });
        await events.markFailed(event._id, this.workerId, reason);
        this.deps.logger.warn("Verification worker: verification rejected", {
          workerId: this.workerId,
          eventId: event.eventId,
          jobId: id,
          reason,
        });
        return "rejected";
      }

      const attestation = this.deps.attestations.createAttestation(
        {
          eventId: event.eventId,
          requester: event.requester,
          mediaCid: event.mediaCid,
          manifestCid: event.manifestCid,
          contentHash: result.contentHash,
          manifestHash: result.manifestHash,
        },
        this.deps.oracle.keypair,
        this.deps.oracle.codeMeasurementHash
      );

      job = await jobs.updateJobStatus(id, {
        status: VerificationStatus.TEE_VERIFYING,
        teeAttestationHash: attestation.attestationHash,
        teeSignature: attestation.signature,
        codeMeasurementHash: attestation.codeMeasurementHash,
      });
    }

    const id = String(job._id);
    onJob(id);

    // Stage 2: attestation transaction.
    if (job.status === VerificationStatus.TEE_VERIFYING) {
      const txHash = await this.submitAttestation(event, job, manifestHash);
      job = await jobs.updateJobStatus(id, {
        status: VerificationStatus.MINTING,
        stellarTransactionHash: txHash,
      });
    }

    // Stage 3: finality. The job completes only after on-chain SUCCESS.
    if (job.status !== VerificationStatus.MINTING || !job.stellarTransactionHash) {
      throw new AppError(`Job ${id} is in unexpected state '${job.status}'`, 409, "UNEXPECTED_JOB_STATE");
    }

    const confirmed = await this.deps.soroban.getTransactionWithConfirmation(job.stellarTransactionHash);
    const certificateId =
      confirmed.returnValue !== undefined ? String(scValToNative(confirmed.returnValue)) : undefined;

    await jobs.updateJobStatus(id, { status: VerificationStatus.COMPLETED });
    await events.markCompleted(event._id, this.workerId, {
      transactionHash: confirmed.txH