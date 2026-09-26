import { rpc } from '@stellar/stellar-sdk';
import { StatusCodes } from 'http-status-codes';
import { env } from '../config/env';
import { AppError } from '../errors/AppError';
import RpcFailoverEvent from '../models/RpcFailoverEvent.model';
import logger from '../utils/logger';
import type {
  RpcCircuitState,
  RpcEndpointStatus,
  RpcFailoverEventInput,
  RpcFailoverOptions,
  RpcNetworkStatus,
} from '../types/soroban.types';

/** Transport-level error codes that indicate the endpoint, not the request, failed. */
const NETWORK_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'ERR_NETWORK',
  'ERR_BAD_RESPONSE',
]);

interface TransportErrorLike {
  code?: unknown;
  message?: unknown;
  isAxiosError?: unknown;
  response?: { status?: unknown };
}

/**
 * Returns true when an error means the RPC endpoint itself is unavailable
 * (connection failure, timeout, 5xx, 429). JSON-RPC errors such as a failed
 * simulation are request-level and must not trigger a failover.
 */
export function isRpcNetworkError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const err = error as TransportErrorLike;

  if (typeof err.code === 'string' && NETWORK_ERROR_CODES.has(err.code)) return true;

  const status = err.response?.status;
  if (typeof status === 'number') return status >= 500 || status === 429;

  // Axios error with no response at all: the request never completed.
  return err.isAxiosError === true && err.response === undefined;
}

/** Origin-only form of an endpoint so credentials in paths/queries are never logged. */
export function redactEndpoint(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '[invalid-url]';
  }
}

function describeError(error: unknown): { reason: string; errorCode?: string } {
  const err = (error ?? {}) as TransportErrorLike;
  const status = err.response?.status;
  const reason = error instanceof Error ? error.message : typeof err.message === 'string' ? err.message : String(error);
  const errorCode = typeof err.code === 'string' ? err.code : typeof status === 'number' ? `HTTP_${status}` : undefined;
  return { reason: reason.slice(0, 1000), errorCode };
}

interface EndpointState {
  url: string;
  label: string;
  server: rpc.Server;
  consecutiveFailures: number;
  openedAt?: number;
  lastError?: string;
}

/**
 * Multi-endpoint Soroban RPC client with a per-endpoint circuit breaker.
 *
 * Calls go to the highest-priority endpoint whose circuit is not open. On a
 * network-level failure the call is retried on the next endpoint and a
 * failover event is logged and persisted. After `failureThreshold`
 * consecutive failures an endpoint's circuit opens for `cooldownMs`; the
 * first call after the cooldown is a half-open trial that either closes the
 * circuit or re-opens it.
 */
export class RpcFailover {
  private readonly endpoints: EndpointState[];

  constructor(
    urls: string[],
    private readonly options: RpcFailoverOptions,
    serverFactory: (url: string) => rpc.Server = (url) =>
      new rpc.Server(url, { allowHttp: options.allowHttp, timeout: options.timeoutMs }),
  ) {
    this.endpoints = [];
    for (const url of urls) {
      try {
        this.endpoints.push({ url, label: redactEndpoint(url), server: serverFactory(url), consecutiveFailures: 0 });
      } catch (error) {
        logger.error('Skipping unusable Stellar RPC endpoint', {
          endpoint: redactEndpoint(url),
          error: describeError(error).reason,
        });
      }
    }

    if (this.endpoints.length === 0) {
      throw new Error('No usable Stellar RPC endpoints configured');
    }
  }

  /**
   * Runs an RPC operation with failover across the configured endpoints.
   */
  async execute<T>(operation: string, call: (server: rpc.Server) => Promise<T>): Promise<T> {
    const candidates = this.endpoints.filter((endpoint) => this.stateOf(endpoint) !== 'open');

    if (candidates.length === 0) {
      logger.error('All Stellar RPC circuits are open', { event: 'rpc_unavailable', operation });
      throw new AppError(
        'All Stellar RPC endpoints are temporarily unavailable',
        StatusCodes.SERVICE_UNAVAILABLE,
        'RPC_UNAVAILABLE',
      );
    }

    let lastError: unknown;
    for (let i = 0; i < candidates.length; i++) {
      const endpoint = candidates[i];
      try {
        const result = await call(endpoint.server);
        this.recordSuccess(endpoint);
        return result;
      } catch (error) {
        if (!isRpcNetworkError(error)) {
          // Request-level error (bad params, failed simulation, ...): the
          // endpoint is healthy, so surface it without rotating.
          this.recordSuccess(endpoint);
          throw error;
        }

        lastError = error;
        const circuitOpened = this.recordFailure(endpoint, error);
        const next = candidates[i + 1];
        const { reason, errorCode } = describeError(error);

        this.logFailover({
          operation,
          fromEndpoint: endpoint.label,
          toEndpoint: next?.label,
          reason,
          errorCode,
          circuitOpened,
        });
      }
    }

    throw new AppError(
      `All Stellar RPC endpoints failed for ${operation}: ${describeError(lastError).reason}`,
      StatusCodes.BAD_GATEWAY,
      'RPC_ALL_ENDPOINTS_FAILED',
    );
  }

  /** Current circuit state of every endpoint, in failover order. */
  getEndpointStatuses(): RpcEndpointStatus[] {
    return this.endpoints.map((endpoint, index) => {
      const state = this.stateOf(endpoint);
      return {
        priority: index + 1,
        endpoint: endpoint.label,
        state,
        consecutiveFailures: endpoint.consecutiveFailures,
        openedAt: endpoint.openedAt !== undefined ? new Date(endpoint.openedAt) : undefined,
        retryAt:
          endpoint.openedAt !== undefined ? new Date(endpoint.openedAt + this.options.cooldownMs) : undefined,
        lastError: endpoint.lastError,
      };
    });
  }

  /** Redacted endpoint the next call will use, or null if all circuits are open. */
  getActiveEndpoint(): string | null {
    return this.endpoints.find((endpoint) => this.stateOf(endpoint) !== 'open')?.label ?? null;
  }

  private stateOf(endpoint: EndpointState): RpcCircuitState {
    if (endpoint.openedAt === undefined) return 'closed';
    return Date.now() - endpoint.openedAt >= this.options.cooldownMs ? 'half_open' : 'open';
  }

  private recordSuccess(endpoint: EndpointState): void {
    if (endpoint.openedAt !== undefined) {
      logger.info('Stellar RPC circuit closed', { event: 'rpc_circuit_closed', endpoint: endpoint.label });
    }
    endpoint.consecutiveFailures = 0;
    endpoint.openedAt = undefined;
    endpoint.lastError = undefined;
  }

  /** Returns true when this failure opened (or re-opened) the circuit. */
  private recordFailure(endpoint: EndpointState, error: unknown): boolean {
    const wasHalfOpen = this.stateOf(endpoint) === 'half_open';
    endpoint.consecutiveFailures += 1;
    endpoint.lastError = describeError(error).reason;

    if (wasHalfOpen || endpoint.consecutiveFailures >= this.options.failureThreshold) {
      endpoint.openedAt = Date.now();
      logger.warn('Stellar RPC circuit opened', {
        event: 'rpc_circuit_opened',
        endpoint: endpoint.label,
        consecutiveFailures: endpoint.consecutiveFailures,
        cooldownMs: this.options.cooldownMs,
      });
      return true;
    }
    return false;
  }

  private logFailover(event: RpcFailoverEventInput): void {
    logger.warn('Stellar RPC failover', { event: 'rpc_failover', ...event });

    // Persisting the audit record must never delay or break the RPC call.
    RpcFailoverEvent.create({ ...event, occurredAt: new Date() }).catch((error: unknown) => {
      logger.error('Failed to persist RPC failover event', { error: describeError(error).reason });
    });
  }
}

class SorobanService {
  private failover: RpcFailover | null = null;

  /** Shared failover-aware RPC client, created on first use. */
  get rpc(): RpcFailover {
    if (!this.failover) {
      this.failover = new RpcFailover(env.STELLAR_RPC_URLS, {
        failureThreshold: env.STELLAR_RPC_FAILURE_THRESHOLD,
        cooldownMs: env.STELLAR_RPC_COOLDOWN_MS,
        timeoutMs: env.STELLAR_RPC_TIMEOUT_MS,
        allowHttp: env.NODE_ENV !== 'production',
      });
    }
    return this.failover;
  }

  /**
   * Runs any Soroban RPC call with transparent endpoint failover.
   * e.g. `sorobanService.execute('simulateTransaction', (s) => s.simulateTransaction(tx))`
   */
  execute<T>(operation: string, call: (server: rpc.Server) => Promise<T>): Promise<T> {
    return this.rpc.execute(operation, call);
  }

  async getLatestLedger(): Promise<rpc.Api.GetLatestLedgerResponse> {
    return this.execute('getLatestLedger', (server) => server.getLatestLedger());
  }

  /**
   * Live network status: latest ledger (fetched through failover), circuit
   * state of each endpoint, and the most recent failover events from MongoDB.
   */
  async getNetworkStatus(recentLimit = 20): Promise<RpcNetworkStatus> {
    const [latestLedger, recentFailovers] = await Promise.all([
      this.getLatestLedger(),
      RpcFailoverEvent.find({}, { _id: 0, __v: 0 })
        .sort({ occurredAt: -1 })
        .limit(recentLimit)
        .lean<RpcNetworkStatus['recentFailovers']>(),
    ]);

    return {
      activeEndpoint: this.rpc.getActiveEndpoint(),
      latestLedger: {
        sequence: latestLedger.sequence,
        protocolVersion: latestLedger.protocolVersion,
        id: latestLedger.id,
      },
      endpoints: this.rpc.getEndpointStatuses(),
      recentFailovers,
    };
  }
}

export const sorobanService = new SorobanService();
