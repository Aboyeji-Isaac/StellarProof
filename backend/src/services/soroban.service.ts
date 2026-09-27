/**
 * Soroban RPC access for oracle-side contract calls: building signed
 * transactions, submitting them, and confirming finality.
 *
 * Finality rule: a transaction is only reported successful once the RPC
 * returns `SUCCESS` for it. `NOT_FOUND` is always treated as pending, and a
 * transaction that never leaves pending surfaces as a timeout error rather
 * than a success.
 */
import { Keypair, Transaction, rpc, xdr } from "@stellar/stellar-sdk";
import { StatusCodes } from "http-status-codes";
import { env } from "../config/env";
import { AppError } from "../errors/AppError";
import {
  SorobanRpcError,
  TransactionConfirmationTimeoutError,
  TransactionFailedError,
  TransactionSubmissionError,
} from "../errors/SorobanTransactionError";
import {
  TX_TIMEOUT_SECONDS,
  buildSignedContractTransaction,
  type SignedContractTransaction,
  type SorobanTransactionSource,
} from "../utils/transactionBuilder";
import { buildMintArgs, type MintArgs } from "../utils/xdr";
import logger from "../utils/logger";
import type {
  SuccessfulTransactionStatus,
  TransactionConfirmationOptions,
  TransactionFailureDiagnostics,
  TransactionStatusResult,
} from "../types/soroban.types";

/** The subset of `rpc.Server` this service depends on. */
export interface SorobanRpcClient extends SorobanTransactionSource {
  getTransaction(hash: string): Promise<rpc.Api.GetTransactionResponse>;
  sendTransaction(tx: Transaction): Promise<rpc.Api.SendTransactionResponse>;
}

/** Time source, injectable so polling can be exercised deterministically. */
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

const TX_HASH_REGEX = /^[0-9a-f]{64}$/;
const MAX_DIAGNOSTIC_EVENTS = 20;

function toSnakeCase(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

function describeOperationResult(result: xdr.OperationResult): string {
  const outer = result.switch().name;
  if (outer !== "opInner") return toSnakeCase(outer);
  const inner = result.tr().value() as { switch(): { name: string } };
  return toSnakeCase(inner.switch().name);
}

function operationResultsOf(result: xdr.TransactionResult): xdr.OperationResult[] {
  const body = result.result();
  switch (body.switch().name) {
    case "txSuccess":
    case "txFailed":
      return body.results();
    case "txFeeBumpInnerSuccess":
    case "txFeeBumpInnerFailed": {
      const inner = body.innerResultPair().result().result();
      const innerCode = inner.switch().name;
      return innerCode === "txSuccess" || innerCode === "txFailed" ? inner.results() : [];
    }
    default:
      return [];
  }
}

/** Extracts result codes and diagnostic events from a transaction result. */
export function extractFailureDiagnostics(
  txHash: string,
  result: xdr.TransactionResult | undefined,
  diagnosticEvents: xdr.DiagnosticEvent[] | undefined,
  ledger?: number
): TransactionFailureDiagnostics {
  let resultCode = "unknown";
  let operationResultCodes: string[] = [];

  if (result) {
    try {
      resultCode = toSnakeCase(result.result().switch().name);
      operationResultCodes = operationResultsOf(result).map(describeOperationResult);
    } catch (err) {
      logger.warn("Soroban: could not decode transaction result", {
        txHash,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    txHash,
    resultCode,
    operationResultCodes,
    diagnosticEventsXdr: (diagnosticEvents ?? [])
      .slice(0, MAX_DIAGNOSTIC_EVENTS)
      .map((event) => event.toXDR("base64")),
    ...(ledger !== undefined ? { ledger } : {}),
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class SorobanService {
  constructor(
    private readonly client: SorobanRpcClient,
    private readonly networkPassphrase: string,
    private readonly confirmationDefaults: TransactionConfirmationOptions,
    private readonly clock: Clock = systemClock
  ) {}

  /** Builds, prepares and signs a `provenance.mint` invocation. */
  async buildMintTransaction(
    keypair: Keypair,
    contractId: string,
    args: MintArgs
  ): Promise<SignedContractTransaction> {
    try {
      return await buildSignedContractTransaction({
        client: this.client,
        keypair,
        networkPassphrase: this.networkPassphrase,
        call: { contractId, method: "mint", args: buildMintArgs(args) },
      });
    } catch (err) {
      if (err instanceof AppError) throw err;
      // Account lookup or simulation failed at the RPC layer.
      throw new SorobanRpcError(`Failed to prepare mint transaction: ${errorMessage(err)}`);
    }
  }

  /**
   * Submits a signed transaction. Resolves once the RPC has accepted it
   * (`PENDING` or `DUPLICATE`); acceptance is not finality.
   */
  async submitTransaction(signed: SignedContractTransaction): Promise<void> {
    let response: rpc.Api.SendTransactionResponse;
    try {
      response = await this.client.sendTransaction(signed.transaction);
    } catch (err) {
      throw new SorobanRpcError(`sendTransaction failed: ${errorMessage(err)}`, signed.hash);
    }

    switch (response.status) {
      case "PENDING":
      case "DUPLICATE":
        return;
      case "TRY_AGAIN_LATER":
        throw new TransactionSubmissionError(
          `RPC deferred transaction ${signed.hash}; resubmit later`,
          signed.hash
        );
      case "ERROR":
        throw new TransactionFailedError(
          extractFailureDiagnostics(signed.hash, response.errorResult, response.diagnosticEvents)
        );
      default:
        throw new SorobanRpcError(
          `Unexpected sendTransaction status: ${String(response.status)}`,
          signed.hash
        );
    }
  }

  /** Reads a transaction's current status once. `NOT_FOUND` maps to `PENDING`. */
  async getTransactionStatus(txHash: string): Promise<TransactionStatusResult> {
    if (!TX_HASH_REGEX.test(txHash)) {
      throw new AppError(
        `Invalid transaction hash: '${txHash}'`,
        StatusCodes.BAD_REQUEST,
        "INVALID_TX_HASH"
      );
    }

    let response: rpc.Api.GetTransactionResponse;
    try {
      response = await this.client.getTransaction(txHash);
    } catch (err) {
      throw new SorobanRpcError(`getTransaction failed: ${errorMessage(err)}`, txHash);
    }

    switch (response.status) {
      case rpc.Api.GetTransactionStatus.NOT_FOUND:
        return { status: "PENDING", txHash, latestLedger: response.latestLedger };
      case rpc.Api.GetTransactionStatus.SUCCESS:
        return {
          status: "SUCCESS",
          txHash,
          ledger: response.ledger,
          createdAt: response.createdAt,
          ...(response.returnValue ? { returnValue: response.returnValue } : {}),
        };
      case rpc.Api.GetTransactionStatus.FAILED:
        return {
          status: "FAILED",
          txHash,
          diagnostics: extractFailureDiagnostics(
            txHash,
            response.resultXdr,
            response.diagnosticEventsXdr,
            response.ledger
          ),
        };
      default:
        // Never infer success from a status this client does not understand.
        throw new SorobanRpcError(
          `Unexpected getTransaction status: ${String((response as { status: unknown }).status)}`,
          txHash
        );
    }
  }

  /**
   * Polls until the transaction is final.
   *
   * @returns the `SUCCESS` status.
   * @throws TransactionFailedError when the transaction failed on-chain.
   * @throws TransactionConfirmationTimeoutError when no final state is seen in time.
   * @throws SorobanRpcError after too many consecutive RPC errors.
   */
  async getTransactionWithConfirmation(
    txHash: string,
    options: Partial<TransactionConfirmationOptions> = {}
  ): Promise<SuccessfulTransactionStatus> {
    const { pollIntervalMs, timeoutMs, maxConsecutiveRpcErrors } = {
      ...this.confirmationDefaults,
      ...options,
    };
    const deadline = this.clock.now() + timeoutMs;
    let attempts = 0;
    let consecutiveRpcErrors = 0;
    let sawRpcError = false;

    for (;;) {
      attempts += 1;
      try {
        const status = await this.getTransactionStatus(txHash);
        consecutiveRpcErrors = 0;

        if (status.status === "SUCCESS") {
          logger.info("Soroban: transaction confirmed", {
            txHash,
            ledger: status.ledger,
            attempts,
          });
          return status;
        }
        if (status.status === "FAILED") {
          logger.warn("Soroban: transaction failed", { ...status.diagnostics, attempts });
          throw new TransactionFailedError(status.diagnostics);
        }
      } catch (err) {
        if (!(err instanceof SorobanRpcError)) throw err;
        sawRpcError = true;
        consecutiveRpcErrors += 1;
        logger.warn("Soroban: RPC error while polling transaction", {
          txHash,
          attempts,
          consecutiveRpcErrors,
          error: err.message,
        });
        if (consecutiveRpcErrors >= maxConsecutiveRpcErrors) throw err;
      }

      const remaining = deadline - this.clock.now();
      if (remaining <= 0) {
        const outcomeUnknown = sawRpcError || timeoutMs <= TX_TIMEOUT_SECONDS * 1000;
        throw new TransactionConfirmationTimeoutError(txHash, timeoutMs, attempts, outcomeUnknown);
      }
      await this.clock.sleep(Math.min(pollIntervalMs, remaining));
    }
  }
}

export const sorobanService = new SorobanService(
  new rpc.Server(env.STELLAR_RPC_URL, {
    allowHttp: env.STELLAR_RPC_URL.startsWith("http://"),
  }),
  env.STELLAR_NETWORK_PASSPHRASE,
  {
    pollIntervalMs: env.STELLAR_TX_POLL_INTERVAL_MS,
    timeoutMs: env.STELLAR_TX_CONFIRMATION_TIMEOUT_MS,
    maxConsecutiveRpcErrors: env.STELLAR_TX_MAX_CONSECUTIVE_RPC_ERRORS,
  }
);
