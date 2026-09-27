/**
 * Typed errors for Soroban transaction submission and confirmation.
 *
 * `retryable` tells callers whether repeating the operation later can
 * succeed: a transaction that failed on-chain will fail again, whereas an
 * RPC outage says nothing about the transaction's outcome.
 */
import { StatusCodes } from "http-status-codes";
import { AppError } from "./AppError";
import type { TransactionFailureDiagnostics } from "../types/soroban.types";

export class SorobanTransactionError extends AppError {
  public readonly txHash?: string;
  public readonly retryable: boolean;

  constructor(
    message: string,
    statusCode: number,
    code: string,
    retryable: boolean,
    txHash?: string
  ) {
    super(message, statusCode, code);
    this.name = "SorobanTransactionError";
    this.retryable = retryable;
    this.txHash = txHash;
    Object.setPrototypeOf(this, SorobanTransactionError.prototype);
  }
}

/** The RPC endpoint could not be reached or returned an unusable response. */
export class SorobanRpcError extends SorobanTransactionError {
  constructor(message: string, txHash?: string) {
    super(message, StatusCodes.BAD_GATEWAY, "SOROBAN_RPC_ERROR", true, txHash);
    this.name = "SorobanRpcError";
    Object.setPrototypeOf(this, SorobanRpcError.prototype);
  }
}

/**
 * Simulation rejected the invocation (e.g. a contract panic such as a
 * duplicate certificate). Simulation is deterministic against current
 * ledger state, so resubmitting the same call will not help.
 */
export class TransactionSimulationError extends SorobanTransactionError {
  constructor(message: string) {
    super(message, StatusCodes.UNPROCESSABLE_ENTITY, "TX_SIMULATION_FAILED", false);
    this.name = "TransactionSimulationError";
    Object.setPrototypeOf(this, TransactionSimulationError.prototype);
  }
}

/**
 * Result codes for rejections that happened before the ledger and can
 * succeed if the transaction is rebuilt and resubmitted.
 */
const RETRYABLE_RESULT_CODES: ReadonlySet<string> = new Set([
  "tx_bad_seq",
  "tx_insufficient_fee",
  "tx_too_late",
]);

/** The transaction was rejected on submission or failed when applied. */
export class TransactionFailedError extends SorobanTransactionError {
  public readonly diagnostics: TransactionFailureDiagnostics;

  constructor(diagnostics: TransactionFailureDiagnostics) {
    const ops = diagnostics.operationResultCodes.length
      ? ` (operations: ${diagnostics.operationResultCodes.join(", ")})`
      : "";
    super(
      `Transaction ${diagnostics.txHash} failed with ${diagnostics.resultCode}${ops}`,
      StatusCodes.BAD_GATEWAY,
      "TX_FAILED",
      RETRYABLE_RESULT_CODES.has(diagnostics.resultCode),
      diagnostics.txHash
    );
    this.name = "TransactionFailedError";
    this.diagnostics = diagnostics;
    Object.setPrototypeOf(this, TransactionFailedError.prototype);
  }
}

/** The RPC asked the client to resubmit later (`TRY_AGAIN_LATER`). */
export class TransactionSubmissionError extends SorobanTransactionError {
  constructor(message: string, txHash: string) {
    super(message, StatusCodes.SERVICE_UNAVAILABLE, "TX_SUBMISSION_DEFERRED", true, txHash);
    this.name = "TransactionSubmissionError";
    Object.setPrototypeOf(this, TransactionSubmissionError.prototype);
  }
}

/**
 * The transaction did not reach a final state within the confirmation window.
 *
 * `outcomeUnknown` is true when RPC errors occurred during the window or the
 * window was shorter than the transaction's validity, so it may still land.
 * Otherwise every poll returned NOT_FOUND past the transaction's expiry and it
 * can never be included.
 */
export class TransactionConfirmationTimeoutError extends SorobanTransactionError {
  public readonly attempts: number;
  public readonly outcomeUnknown: boolean;

  constructor(txHash: string, timeoutMs: number, attempts: number, outcomeUnknown: boolean) {
    super(
      `Transaction ${txHash} was not confirmed within ${timeoutMs}ms (${attempts} polls)`,
      StatusCodes.GATEWAY_TIMEOUT,
      "TX_CONFIRMATION_TIMEOUT",
      outcomeUnknown,
      txHash
    );
    this.name = "TransactionConfirmationTimeoutError";
    this.attempts = attempts;
    this.outcomeUnknown = outcomeUnknown;
    Object.setPrototypeOf(this, TransactionConfirmationTimeoutError.prototype);
  }
}
