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
import { env } from "../config/env";
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
import { RegistryAuthorizationService } from "../services/registryAuthorization.service";
import { SorobanContractQueryClient } from "../services/contracts/ContractReader";
import { RegistryContract } from "../services/contracts/RegistryContract";
import { OracleContract } from "../services/contracts/OracleContract";
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
  authorization?: Pick<RegistryAuthorizationService, "assertAuthorized">;
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
          "MAX_ATTEMPTS_EXCEEDED"
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
        job = await jobs.createJob({ ownerPublicKey: event.requester, contentHash: result.contentHash });
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
      if (!job.codeMeasurementHash) {
        throw new AppError(
          "Cannot submit attestation without a TEE measurement hash",
          409,
          "MISSING_TEE_MEASUREMENT"
        );
      }
      await this.deps.authorization?.assertAuthorized(
        job.codeMeasurementHash,
        this.deps.oracle.keypair.publicKey()
      );
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
      transactionHash: confirmed.txHash,
      ...(certificateId !== undefined ? { certificateId } : {}),
    });
    this.deps.logger.info("Verification worker: certificate minted", {
      workerId: this.workerId,
      eventId: event.eventId,
      jobId: id,
      txHash: confirmed.txHash,
      ledger: confirmed.ledger,
      certificateId,
    });
    return "completed";
  }

  /**
   * Submits the mint transaction for a job in `tee_verifying` and returns
   * its hash once the RPC accepts it. If a previous attempt already submitted
   * a transaction, that transaction's outcome is resolved first so a
   * certificate is never minted twice.
   */
  private async submitAttestation(
    event: IVerificationRequestEvent,
    job: IVerificationJob,
    manifestHash: string | undefined
  ): Promise<string> {
    const { events, soroban, oracle } = this.deps;

    if (event.transactionHash) {
      try {
        await soroban.getTransactionWithConfirmation(event.transactionHash);
        return event.transactionHash;
      } catch (err) {
        if (!transactionDidNotLand(err)) throw err;
        this.deps.logger.warn("Verification worker: previous mint transaction did not land, rebuilding", {
          workerId: this.workerId,
          eventId: event.eventId,
          txHash: event.transactionHash,
          error: describeError(err),
        });
        await events.recordTransaction(event._id, this.workerId, null);
      }
    }

    if (!manifestHash || !job.teeAttestationHash) {
      throw new AppError(
        "Cannot build mint transaction: manifest hash or attestation hash missing",
        409,
        "MISSING_ATTESTATION_DATA"
      );
    }

    const signed = await soroban.buildMintTransaction(oracle.keypair, oracle.provenanceContractId, {
      to: event.requester,
      mediaCid: event.mediaCid,
      manifestHash,
      attestationHash: job.teeAttestationHash,
    });

    // Persist the hash before sending so a crash mid-submit can be resolved.
    await events.recordTransaction(event._id, this.workerId, signed.hash);
    try {
      await soroban.submitTransaction(signed);
    } catch (err) {
      if (err instanceof TransactionFailedError || err instanceof TransactionSubmissionError) {
        // Rejected before reaching a ledger: this hash can never land.
        await events.recordTransaction(event._id, this.workerId, null);
      }
      throw err;
    }

    this.deps.logger.info("Verification worker: mint transaction submitted", {
      workerId: this.workerId,
      eventId: event.eventId,
      jobId: String(job._id),
      txHash: signed.hash,
    });
    return signed.hash;
  }

  private async settleFromTerminalJob(
    event: IVerificationRequestEvent,
    job: IVerificationJob
  ): Promise<"completed" | "rejected"> {
    if (job.status === VerificationStatus.COMPLETED && job.stellarTransactionHash) {
      await this.deps.events.markCompleted(event._id, this.workerId, {
        transactionHash: job.stellarTransactionHash,
      });
      return "completed";
    }
    await this.deps.events.markFailed(
      event._id,
      this.workerId,
      job.errorMessage ?? `Verification job ended in '${job.status}'`
    );
    return "rejected";
  }

  private async handleFailure(
    event: IVerificationRequestEvent,
    jobId: string | undefined,
    err: unknown
  ): Promise<void> {
    const message = describeError(err);
    const ctx = {
      workerId: this.workerId,
      eventId: event.eventId,
      jobId,
      attempt: event.attempts,
      error: message,
      ...(err instanceof AppError && err.code ? { code: err.code } : {}),
      ...(err instanceof TransactionFailedError ? { diagnostics: err.diagnostics } : {}),
    };

    if (err instanceof LeaseLostError) {
      this.deps.logger.warn("Verification worker: lease lost, abandoning event", ctx);
      return;
    }

    try {
      if (isRetryableError(err) && event.attempts < this.deps.config.maxAttempts) {
        const delay = Math.min(
          this.deps.config.retryBaseMs * 2 ** (event.attempts - 1),
          MAX_RETRY_DELAY_MS
        );
        const nextAttemptAt = new Date(this.now().getTime() + delay);
        await this.deps.events.scheduleRetry(event._id, this.workerId, nextAttemptAt, message);
        this.deps.logger.warn("Verification worker: retry scheduled", {
          ...ctx,
          nextAttemptAt: nextAttemptAt.toISOString(),
        });
        return;
      }

      await this.failJob(jobId, message);
      await this.deps.events.markFailed(event._id, this.workerId, message);
      this.deps.logger.error("Verification worker: event failed", ctx);
    } catch (recordErr) {
      // The event stays leased; it is reclaimed once the lease expires.
      this.deps.logger.error("Verification worker: could not record failure", {
        ...ctx,
        recordError: describeError(recordErr),
      });
    }
  }

  private async failJob(jobId: string | undefined, message: string): Promise<void> {
    if (!jobId) return;
    const job = await this.deps.jobs.getJob(jobId);
    if (isTerminal(job.status)) return;
    await this.deps.jobs.updateJobStatus(jobId, {
      status: VerificationStatus.FAILED,
      errorMessage: message,
    });
  }
}

/** Builds a worker wired to the production services and configuration. */
export function createVerificationWorker(): VerificationWorker {
  const oracle = loadOracleConfig();
  const queryClient = new SorobanContractQueryClient(oracle.keypair.publicKey());
  const authorization = new RegistryAuthorizationService(
    new RegistryContract(env.STELLAR_REGISTRY_CONTRACT_ID, queryClient),
    new OracleContract(env.STELLAR_ORACLE_CONTRACT_ID, queryClient)
  );

  return new VerificationWorker({
    events: verificationRequestEventService,
    jobs: verificationService,
    verifier: spvVerifierService,
    attestations: attestationService,
    authorization,
    soroban: sorobanService,
    oracle,
    config: loadVerificationWorkerConfig(),
    logger,
  });
}

export interface ShutdownOptions {
  onStopped: () => Promise<void>;
  exit: (code: number) => void;
  forceExitAfterMs?: number;
}

/**
 * Installs SIGINT/SIGTERM handlers that stop the worker (letting the current
 * event finish), run `onStopped`, then exit. Returns an uninstaller.
 */
export function installShutdownHandlers(
  worker: VerificationWorker,
  { onStopped, exit, forceExitAfterMs = 30_000 }: ShutdownOptions
): () => void {
  let shuttingDown = false;

  const handler = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("Verification worker: shutdown signal received", { signal, workerId: worker.id });

    setTimeout(() => {
      logger.error("Verification worker: forced exit after shutdown timeout", { workerId: worker.id });
      exit(1);
    }, forceExitAfterMs).unref();

    void worker
      .stop()
      .then(onStopped)
      .then(() => exit(0))
      .catch((err: unknown) => {
        logger.error("Verification worker: error during shutdown", { error: describeError(err) });
        exit(1);
      });
  };

  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
  return () => {
    process.off("SIGINT", handler);
    process.off("SIGTERM", handler);
  };
}

async function main(): Promise<void> {
  const worker = createVerificationWorker();
  await connectDatabase();
  installShutdownHandlers(worker, {
    onStopped: disconnectDatabase,
    exit: (code) => process.exit(code),
  });
  worker.start();
}

if (require.main === module) {
  main().catch((err: unknown) => {
    logger.error("Verification worker: fatal startup error", { error: describeError(err) });
    process.exit(1);
  });
}
