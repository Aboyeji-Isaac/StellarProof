import {
  Account,
  FeeBumpTransaction,
  StrKey,
  Transaction,
  rpc,
} from "@stellar/stellar-sdk";
import { StatusCodes } from "http-status-codes";
import { env } from "../config/env";
import { AppError } from "../errors/AppError";
import logger from "../utils/logger";

/**
 * Soroban RPC Service
 *
 * Single entry point for every on-chain interaction. Wraps
 * `@stellar/stellar-sdk`'s `rpc.Server`, reads its configuration from
 * `config/env`, bounds every call with a timeout and converts RPC failures
 * into typed `AppError`s, so controllers never handle raw RPC internals.
 */

export type SorobanOperation =
  | "loadAccount"
  | "getEvents"
  | "simulate"
  | "sendTransaction"
  | "getTransaction";

export type SorobanTransaction = Transaction | FeeBumpTransaction;

export type SimulationResult =
  | rpc.Api.SimulateTransactionSuccessResponse
  | rpc.Api.SimulateTransactionRestoreResponse;

/** Accepted submissions: queued for inclusion or already known to the network */
export type SubmittedTransaction = rpc.Api.SendTransactionResponse & {
  status: "PENDING" | "DUPLICATE";
};

export interface SorobanServiceConfig {
  rpcUrl: string;
  networkPassphrase: string;
  timeoutMs: number;
  allowHttp: boolean;
}

/** Error object thrown by the SDK for JSON-RPC errors and missing ledger entries */
interface RpcErrorPayload {
  code: number;
  message: string;
  data?: unknown;
}

/** Subset of an axios error the SDK surfaces for transport failures */
interface HttpTransportError {
  isAxiosError: true;
  code?: string;
  message: string;
  response?: { status: number };
}

const TRANSACTION_HASH_PATTERN = /^[0-9a-f]{64}$/i;

const JSON_RPC_INVALID_REQUEST = -32600;
const JSON_RPC_INVALID_PARAMS = -32602;

class SorobanRpcTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`timed out after ${timeoutMs}ms`);
    this.name = "SorobanRpcTimeoutError";
  }
}

function isRpcErrorPayload(error: unknown): error is RpcErrorPayload {
  return (
    typeof error === "object" &&
    error !== null &&
    !(error instanceof Error) &&
    typeof (error as RpcErrorPayload).code === "number" &&
    typeof (error as RpcErrorPayload).message === "string"
  );
}

function isHttpTransportError(error: unknown): error is HttpTransportError {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as HttpTransportError).isAxiosError === true
  );
}

export function defaultSorobanConfig(): SorobanServiceConfig {
  return {
    rpcUrl: env.STELLAR_RPC_URL,
    networkPassphrase: env.STELLAR_NETWORK_PASSPHRASE,
    timeoutMs: env.STELLAR_RPC_TIMEOUT_MS,
    // Plain-http RPC (local quickstart node) is never allowed in production
    allowHttp: env.NODE_ENV !== "production" && env.STELLAR_RPC_URL.startsWith("http://"),
  };
}

export class SorobanService {
  private readonly server: rpc.Server;
  private readonly timeoutMs: number;
  readonly networkPassphrase: string;

  constructor(config: SorobanServiceConfig = defaultSorobanConfig(), server?: rpc.Server) {
    if (!Number.isInteger(config.timeoutMs) || config.timeoutMs <= 0) {
      throw new Error(`[Config] STELLAR_RPC_TIMEOUT_MS must be a positive integer, got ${config.timeoutMs}`);
    }

    this.server = server ?? new rpc.Server(config.rpcUrl, { allowHttp: config.allowHttp });
    this.timeoutMs = config.timeoutMs;
    this.networkPassphrase = config.networkPassphrase;
  }

  /**
   * Load an account with its current sequence number, ready for
   * `TransactionBuilder`.
   */
  async loadAccount(publicKey: string): Promise<Account> {
    if (!StrKey.isValidEd25519PublicKey(publicKey)) {
      throw new AppError("Invalid Stellar account address", StatusCodes.BAD_REQUEST, "INVALID_STELLAR_ADDRESS");
    }

    try {
      return await this.call("loadAccount", () => this.server.getAccount(publicKey));
    } catch (error) {
      if (error instanceof AppError && error.statusCode === StatusCodes.NOT_FOUND) {
        throw new AppError(
          `Stellar account not found: ${publicKey}`,
          StatusCodes.NOT_FOUND,
          "STELLAR_ACCOUNT_NOT_FOUND"
        );
      }
      throw error;
    }
  }

  /** Fetch contract / system / diagnostic events. */
  async getEvents(request: rpc.Server.GetEventsRequest): Promise<rpc.Api.GetEventsResponse> {
    return this.call("getEvents", () => this.server.getEvents(request));
  }

  /**
   * Simulate a transaction. Simulation errors (contract traps, invalid
   * arguments) are raised as 422 so callers never submit a failing tx.
   */
  async simulate(transaction: SorobanTransaction): Promise<SimulationResult> {
    const response = await this.call("simulate", () => this.server.simulateTransaction(transaction));

    if (rpc.Api.isSimulationError(response)) {
      throw new AppError(
        `Soroban simulation failed: ${response.error}`,
        StatusCodes.UNPROCESSABLE_ENTITY,
        "SOROBAN_SIMULATION_FAILED"
      );
    }

    return response;
  }

  /**
   * Submit a signed transaction. Only PENDING and DUPLICATE are returned;
   * rejected submissions become 422 and back-pressure becomes 503.
   */
  async sendTransaction(transaction: SorobanTransaction): Promise<SubmittedTransaction> {
    const response = await this.call("sendTransaction", () => this.server.sendTransaction(transaction));

    switch (response.status) {
      case "PENDING":
      case "DUPLICATE":
        return response as SubmittedTransaction;

      case "TRY_AGAIN_LATER":
        throw new AppError(
          "Soroban RPC is congested; retry the submission later",
          StatusCodes.SERVICE_UNAVAILABLE,
          "SOROBAN_TRY_AGAIN_LATER"
        );

      case "ERROR": {
        const resultCode = response.errorResult?.result().switch().name ?? "unknown";
        throw new AppError(
          `Soroban transaction ${response.hash} rejected: ${resultCode}`,
          StatusCodes.UNPROCESSABLE_ENTITY,
          "SOROBAN_TRANSACTION_REJECTED"
        );
      }

      default: {
        const unexpected: never = response.status;
        throw new AppError(
          `Unexpected sendTransaction status: ${String(unexpected)}`,
          StatusCodes.BAD_GATEWAY,
          "SOROBAN_RPC_ERROR"
        );
      }
    }
  }

  /**
   * Look up a transaction by hash. NOT_FOUND is a normal status (not yet
   * ingested or outside retention) and is returned rather than thrown.
   */
  async getTransaction(hash: string): Promise<rpc.Api.GetTransactionResponse> {
    if (!TRANSACTION_HASH_PATTERN.test(hash)) {
      throw new AppError("Invalid transaction hash", StatusCodes.BAD_REQUEST, "INVALID_TRANSACTION_HASH");
    }

    return this.call("getTransaction", () => this.server.getTransaction(hash.toLowerCase()));
  }

  /** Run an RPC call with the configured timeout and map failures to AppError. */
  private async call<T>(operation: SorobanOperation, fn: () => Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new SorobanRpcTimeoutError(this.timeoutMs)), this.timeoutMs);
    });

    try {
      return await Promise.race([fn(), timeout]);
    } catch (error) {
      throw this.toAppError(operation, error);
    } finally {
      clearTimeout(timer);
    }
  }

  private toAppError(operation: SorobanOperation, error: unknown): AppError {
    if (error instanceof AppError) {
      return error;
    }

    const prefix = `Soroban RPC ${operation} failed`;

    if (error instanceof SorobanRpcTimeoutError) {
      logger.warn(prefix, { operation, reason: error.message });
      return new AppError(`${prefix}: ${error.message}`, StatusCodes.GATEWAY_TIMEOUT, "SOROBAN_RPC_TIMEOUT");
    }

    if (isRpcErrorPayload(error)) {
      if (error.code === StatusCodes.NOT_FOUND) {
        return new AppError(`${prefix}: ${error.message}`, StatusCodes.NOT_FOUND, "SOROBAN_NOT_FOUND");
      }
      if (error.code === JSON_RPC_INVALID_PARAMS || error.code === JSON_RPC_INVALID_REQUEST) {
        return new AppError(`${prefix}: ${error.message}`, StatusCodes.BAD_REQUEST, "SOROBAN_INVALID_REQUEST");
      }
      logger.warn(prefix, { operation, rpcCode: error.code, reason: error.message });
      return new AppError(`${prefix}: ${error.message}`, StatusCodes.BAD_GATEWAY, "SOROBAN_RPC_ERROR");
    }

    if (isHttpTransportError(error)) {
      const status = error.response?.status;
      logger.warn(prefix, { operation, httpStatus: status, code: error.code, reason: error.message });

      if (status === StatusCodes.TOO_MANY_REQUESTS) {
        return new AppError(`${prefix}: rate limited`, StatusCodes.TOO_MANY_REQUESTS, "SOROBAN_RPC_RATE_LIMITED");
      }
      if (status === undefined) {
        const timedOut = error.code === "ECONNABORTED" || error.code === "ETIMEDOUT";
        return timedOut
          ? new AppError(`${prefix}: ${error.message}`, StatusCodes.GATEWAY_TIMEOUT, "SOROBAN_RPC_TIMEOUT")
          : new AppError(`${prefix}: ${error.message}`, StatusCodes.SERVICE_UNAVAILABLE, "SOROBAN_RPC_UNREACHABLE");
      }
      return new AppError(`${prefix}: HTTP ${status}`, StatusCodes.BAD_GATEWAY, "SOROBAN_RPC_UNAVAILABLE");
    }

    const reason = error instanceof Error ? error.message : String(error);
    logger.warn(prefix, { operation, reason });
    return new AppError(`${prefix}: ${reason}`, StatusCodes.BAD_GATEWAY, "SOROBAN_RPC_ERROR");
  }
}

export const sorobanService = new SorobanService();
