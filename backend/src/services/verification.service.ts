import mongoose from "mongoose";
import { StatusCodes } from "http-status-codes";

import { VerificationJobModel } from "../models/verificationJob.model";
import { AppError } from "../errors/AppError";
import { VerificationStateError } from "../errors/VerificationStateError";
import Manifest from "../models/Manifest.model";
import { ipfsService } from "./ipfs.service";
import { generateDeterministicHash } from "../utils/crypto";
import {
  VerificationStatus,
  VALID_TRANSITIONS,
} from "../types/verification.types";
import type {
  IVerificationJob,
  CreateVerificationJobDTO,
  UpdateVerificationStatusDTO,
  OracleCallbackDTO,
} from "../types/verification.types";

function assertValidObjectId(id: string): void {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new AppError(
      `Invalid job ID: '${id}'`,
      StatusCodes.BAD_REQUEST,
      "INVALID_ID"
    );
  }
}

function assertValidTransition(
  currentStatus: VerificationStatus,
  nextStatus: VerificationStatus
): void {
  const allowed = VALID_TRANSITIONS[currentStatus];
  if (!allowed.has(nextStatus)) {
    throw new VerificationStateError(currentStatus, nextStatus);
  }
}

/**
 * Appends an immutable timeline entry to a job document in memory.
 * Callers are responsible for persisting the change via `job.save()`.
 * `txHash` is only recorded when the transition actually carries one
 * (e.g. entering `minting`); it is omitted otherwise.
 */
function recordTimelineEntry(
  job: { timeline: Array<{ stage: VerificationStatus; at: Date; txHash?: string }> },
  stage: VerificationStatus,
  txHash?: string
): void {
  job.timeline.push({
    stage,
    at: new Date(),
    ...(txHash ? { txHash } : {}),
  });
}

async function createJob(dto: CreateVerificationJobDTO): Promise<IVerificationJob> {
  const job = await VerificationJobModel.create({
    ownerPublicKey: dto.ownerPublicKey,
    contentHash: dto.contentHash,
    status: VerificationStatus.PENDING,
    ...(dto.webhookUrl ? { webhookUrl: dto.webhookUrl } : {}),
    timeline: [{ stage: VerificationStatus.PENDING, at: new Date() }],
  });

  return job.toObject<IVerificationJob>();
}

async function getJob(id: string): Promise<IVerificationJob> {
  assertValidObjectId(id);

  const job = await VerificationJobModel.findById(id).lean<IVerificationJob>();
  if (!job) {
    throw new AppError(
      `Verification job not found: '${id}'`,
      StatusCodes.NOT_FOUND,
      "JOB_NOT_FOUND"
    );
  }

  return job;
}

async function getJobsByOwner(ownerPublicKey: string): Promise<IVerificationJob[]> {
  return VerificationJobModel.find({ ownerPublicKey })
    .sort({ createdAt: -1 })
    .lean<IVerificationJob[]>();
}

async function updateJobStatus(
  id: string,
  dto: UpdateVerificationStatusDTO
): Promise<IVerificationJob> {
  assertValidObjectId(id);

  const job = await VerificationJobModel.findById(id);
  if (!job) {
    throw new AppError(
      `Verification job not found: '${id}'`,
      StatusCodes.NOT_FOUND,
      "JOB_NOT_FOUND"
    );
  }

  const currentStatus = job.status as VerificationStatus;
  const nextStatus = dto.status;

  assertValidTransition(currentStatus, nextStatus);

  if (nextStatus === VerificationStatus.TEE_VERIFYING) {
    if (!dto.teeAttestationHash || !dto.teeSignature || !dto.codeMeasurementHash) {
      throw new AppError(
        "Transitioning to 'tee_verifying' requires teeAttestationHash, teeSignature, and codeMeasurementHash",
        StatusCodes.CONFLICT,
        "MISSING_TEE_FIELDS"
      );
    }
  }

  if (nextStatus === VerificationStatus.MINTING) {
    if (!dto.stellarTransactionHash) {
      throw new AppError(
        "Transitioning to 'minting' requires stellarTransactionHash",
        StatusCodes.CONFLICT,
        "MISSING_TRANSACTION_HASH"
      );
    }
  }

  if (nextStatus === VerificationStatus.FAILED) {
    if (!dto.errorMessage) {
      throw new AppError(
        "Transitioning to 'failed' requires errorMessage",
        StatusCodes.CONFLICT,
        "MISSING_ERROR_MESSAGE"
      );
    }
  }

  job.status = nextStatus;

  if (dto.teeAttestationHash !== undefined) job.teeAttestationHash = dto.teeAttestationHash;
  if (dto.teeSignature !== undefined) job.teeSignature = dto.teeSignature;
  if (dto.codeMeasurementHash !== undefined) job.codeMeasurementHash = dto.codeMeasurementHash;
  if (dto.stellarTransactionHash !== undefined)
    job.stellarTransactionHash = dto.stellarTransactionHash;
  if (dto.errorMessage !== undefined) job.errorMessage = dto.errorMessage;

  recordTimelineEntry(job, nextStatus, dto.stellarTransactionHash);

  await job.save();

  return job.toObject<IVerificationJob>();
}

/**
 * Handles the TEE oracle callback which provides attestation data.
 * This stores the attestation fields and advances the job to `minting`.
 */
async function receiveOracleAttestation(
  dto: OracleCallbackDTO
): Promise<IVerificationJob> {
  assertValidObjectId(dto.jobId);

  const job = await VerificationJobModel.findById(dto.jobId);
  if (!job) {
    throw new AppError(
      `Verification job not found: '${dto.jobId}'`,
      StatusCodes.NOT_FOUND,
      "JOB_NOT_FOUND"
    );
  }

  const currentStatus = job.status as VerificationStatus;
  const nextStatus = VerificationStatus.MINTING;

  // Ensure the state machine permits this transition
  assertValidTransition(currentStatus, nextStatus);

  job.teeAttestationHash = dto.teeAttestationHash;
  job.teeSignature = dto.teeSignature;
  job.status = nextStatus;

  recordTimelineEntry(job, nextStatus);

  await job.save();

  return job.toObject<IVerificationJob>();
}

export const verificationService = {
  createJob,
  getJob,
  getJobsByOwner,
  updateJobStatus,
  receiveOracleAttestation,
  verifyManifestIntegrity,
} as const;

/**
 * Fetches the manifest's stored JSON from IPFS, recomputes its deterministic
 * hash, and compares it against the manifestHash recorded on the Manifest
 * document (the on-chain/stored claim). On mismatch, the job is transitioned
 * to `failed` with a descriptive error.
 */
async function verifyManifestIntegrity(jobId: string): Promise<IVerificationJob> {
  assertValidObjectId(jobId);

  const job = await VerificationJobModel.findById(jobId);
  if (!job) {
    throw new AppError(
      `Verification job not found: '${jobId}'`,
      StatusCodes.NOT_FOUND,
      "JOB_NOT_FOUND"
    );
  }

  if (!job.manifestId) {
    throw new AppError(
      `Verification job '${jobId}' has no associated manifest`,
      StatusCodes.BAD_REQUEST,
      "MANIFEST_ID_MISSING"
    );
  }

  const manifest = await Manifest.findById(job.manifestId);
  if (!manifest) {
    throw new AppError(
      `Manifest not found: '${job.manifestId}'`,
      StatusCodes.NOT_FOUND,
      "MANIFEST_NOT_FOUND"
    );
  }

  if (!manifest.ipfsCid && !manifest.ipfsUrl) {
    throw new AppError(
      `Manifest '${job.manifestId}' has no IPFS reference to fetch`,
      StatusCodes.BAD_REQUEST,
      "MANIFEST_IPFS_REF_MISSING"
    );
  }

  const fetchedManifestJson = await ipfsService.fetchManifestJson(
    manifest.ipfsUrl ?? (manifest.ipfsCid as string)
  );

  const recomputedHash = generateDeterministicHash(fetchedManifestJson);
  const onChainHash = manifest.manifestHash;

  if (recomputedHash !== onChainHash) {
    return updateJobStatus(jobId, {
      status: VerificationStatus.FAILED,
      errorMessage: `Manifest integrity check failed: recomputed hash '${recomputedHash}' does not match recorded hash '${onChainHash}'`,
    });
  }

  return job.toObject<IVerificationJob>();
}
