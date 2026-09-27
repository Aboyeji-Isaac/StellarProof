/**
 * Domain types for Soroban transaction submission and finality tracking.
 */
import type { xdr } from "@stellar/stellar-sdk";

/** Structured detail extracted from a failed or rejected transaction. */
export interface TransactionFailureDiagnostics {
  txHash: string;
  /** Transaction-level result code in snake_case, e.g. `tx_failed`, `tx_bad_seq`. */
  resultCode: string;
  /** Per-operation result codes, e.g. `invoke_host_function_trapped`. */
  operationResultCodes: string[];
  /** Base64 `DiagnosticEvent` XDR emitted by the host, capped in length. */
  diagnosticEventsXdr: string[];
  /** Ledger the failure was recorded in; absent for pre-ledger rejections. */
  ledger?: number;
}

export interface PendingTransactionStatus {
  status: "PENDING";
  txHash: string;
  latestLedger: number;
}

export interface SuccessfulTransactionStatus {
  status: "SUCCESS";
  txHash: string;
  ledger: number;
  /** Ledger close time, unix seconds. */
  createdAt: number;
  /** Contract function return value, when the RPC provides one. */
  returnValue?: xdr.ScVal;
}

export interface FailedTransactionStatus {
  status: "FAILED";
  txHash: string;
  diagnostics: TransactionFailureDiagnostics;
}

/**
 * Normalised transaction status. RPC `NOT_FOUND` maps to `PENDING`: the
 * transaction is either still in flight or not yet visible to this node.
 */
export type TransactionStatusResult =
  | PendingTransactionStatus
  | SuccessfulTransactionStatus
  | FailedTransactionStatus;

export interface TransactionConfirmationOptions {
  pollIntervalMs: number;
  timeoutMs: number;
  /** Consecutive RPC errors tolerated before polling aborts. */
  maxConsecutiveRpcErrors: number;
}
