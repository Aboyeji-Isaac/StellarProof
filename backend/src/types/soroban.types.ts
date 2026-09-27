/**
 * Types for Soroban RPC access with multi-endpoint failover.
 */

/**
 * Circuit breaker state for a single RPC endpoint.
 * - closed:    endpoint is in rotation
 * - open:      endpoint is skipped until the cooldown elapses
 * - half_open: cooldown elapsed; the next request is a trial
 */
export type RpcCircuitState = 'closed' | 'open' | 'half_open';

export interface RpcEndpointStatus {
  /** Position in the failover order (1 = primary). */
  priority: number;
  /** Redacted endpoint (origin only) so API keys in paths/queries never leak. */
  endpoint: string;
  state: RpcCircuitState;
  consecutiveFailures: number;
  openedAt?: Date;
  retryAt?: Date;
  lastError?: string;
}

export interface RpcFailoverOptions {
  failureThreshold: number;
  cooldownMs: number;
  timeoutMs: number;
  allowHttp: boolean;
}

export interface RpcFailoverEventInput {
  operation: string;
  fromEndpoint: string;
  toEndpoint?: string;
  reason: string;
  errorCode?: string;
  circuitOpened: boolean;
}

export interface RpcNetworkStatus {
  activeEndpoint: string | null;
  latestLedger: {
    sequence: number;
    protocolVersion: string;
    id: string;
  };
  endpoints: RpcEndpointStatus[];
  recentFailovers: Array<{
    operation: string;
    fromEndpoint: string;
    toEndpoint?: string;
    reason: string;
    errorCode?: string;
    circuitOpened: boolean;
    occurredAt: Date;
  }>;
}
