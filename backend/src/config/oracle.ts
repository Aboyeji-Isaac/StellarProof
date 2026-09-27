/**
 * Oracle worker configuration, resolved from `env` and validated once at
 * worker startup. Kept separate from `env.ts` so the API server does not
 * require oracle credentials to boot.
 */
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { StatusCodes } from "http-status-codes";
import { env } from "./env";
import { AppError } from "../errors/AppError";
import { TX_TIMEOUT_SECONDS } from "../utils/transactionBuilder";

export interface OracleConfig {
  /** Signs mint transactions and attestations. Never log this object. */
  keypair: Keypair;
  provenanceContractId: string;
  codeMeasurementHash: string;
}

export interface VerificationWorkerConfig {
  pollIntervalMs: number;
  batchSize: number;
  maxAttempts: number;
  retryBaseMs: number;
  leaseMs: number;
}

type OracleEnv = Pick<
  typeof env,
  "STELLAR_ORACLE_SECRET_KEY" | "STELLAR_PROVENANCE_CONTRACT_ID" | "ORACLE_CODE_MEASUREMENT_HASH"
>;

type WorkerEnv = Pick<
  typeof env,
  | "VERIFICATION_WORKER_POLL_INTERVAL_MS"
  | "VERIFICATION_WORKER_BATCH_SIZE"
  | "VERIFICATION_WORKER_MAX_ATTEMPTS"
  | "VERIFICATION_WORKER_RETRY_BASE_MS"
  | "VERIFICATION_WORKER_LEASE_MS"
  | "STELLAR_TX_CONFIRMATION_TIMEOUT_MS"
  | "SPV_FETCH_TIMEOUT_MS"
>;

function configError(message: string): AppError {
  return new AppError(message, StatusCodes.INTERNAL_SERVER_ERROR, "ORACLE_CONFIG_INVALID");
}

export function loadOracleConfig(source: OracleEnv = env): OracleConfig {
  if (!StrKey.isValidEd25519SecretSeed(source.STELLAR_ORACLE_SECRET_KEY)) {
    // The value itself is deliberately never included in the message.
    throw configError("STELLAR_ORACLE_SECRET_KEY must be set to a valid Stellar secret seed (S...)");
  }
  if (!StrKey.isValidContract(source.STELLAR_PROVENANCE_CONTRACT_ID)) {
    throw configError("STELLAR_PROVENANCE_CONTRACT_ID must be set to a valid contract address (C...)");
  }
  if (!/^[0-9a-fA-F]{64}$/.test(source.ORACLE_CODE_MEASUREMENT_HASH)) {
    throw configError("ORACLE_CODE_MEASUREMENT_HASH must be a 64-character SHA-256 hex digest");
  }

  return {
    keypair: Keypair.fromSecret(source.STELLAR_ORACLE_SECRET_KEY),
    provenanceContractId: source.STELLAR_PROVENANCE_CONTRACT_ID,
    codeMeasurementHash: source.ORACLE_CODE_MEASUREMENT_HASH.toLowerCase(),
  };
}

export function loadVerificationWorkerConfig(source: WorkerEnv = env): VerificationWorkerConfig {
  const txValidityMs = TX_TIMEOUT_SECONDS * 1000;
  if (source.STELLAR_TX_CONFIRMATION_TIMEOUT_MS <= txValidityMs) {
    throw configError(
      `STELLAR_TX_CONFIRMATION_TIMEOUT_MS must exceed the ${txValidityMs}ms transaction validity window`
    );
  }

  // A lease must outlive one full processing pass (two gateway fetches plus,
  // on recovery, two finality waits) or a healthy worker's event could be reclaimed.
  const minLeaseMs =
    2 * source.STELLAR_TX_CONFIRMATION_TIMEOUT_MS + 2 * source.SPV_FETCH_TIMEOUT_MS;
  if (source.VERIFICATION_WORKER_LEASE_MS <= minLeaseMs) {
    throw configError(
      `VERIFICATION_WORKER_LEASE_MS must exceed ${minLeaseMs}ms (2 × confirmation timeout + 2 × fetch timeout)`
    );
  }

  return {
    pollIntervalMs: source.VERIFICATION_WORKER_POLL_INTERVAL_MS,
    batchSize: source.VERIFICATION_WORKER_BATCH_SIZE,
    maxAttempts: source.VERIFICATION_WORKER_MAX_ATTEMPTS,
    retryBaseMs: source.VERIFICATION_WORKER_RETRY_BASE_MS,
    leaseMs: source.VERIFICATION_WORKER_LEASE_MS,
  };
}
