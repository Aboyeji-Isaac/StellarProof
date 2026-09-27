/**
 * Centralised environment configuration.
 * All process.env reads happen here. Downstream modules import from `env`
 * and never access process.env directly.
 *
 * The service will exit at startup if any required variable is absent,
 * preventing silent misconfiguration at request time.
 */
import "dotenv/config";

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    console.error(`[Config] Missing required environment variable: ${key}`);
    process.exit(1);
  }
  return value;
}

function optionalEnv(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

function optionalPositiveIntEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    console.error(`[Config] ${key} must be a positive integer, received: ${raw}`);
    process.exit(1);
  }
  return value;
}

export const env = {
  NODE_ENV: optionalEnv("NODE_ENV", "development"),
  PORT: parseInt(optionalEnv("PORT", "4000"), 10),

  /** MongoDB connection string, e.g. mongodb://localhost:27017/stellarproof */
  MONGODB_URI: requireEnv("MONGODB_URI"),

  /** Soroban/Stellar RPC endpoint, e.g. https://soroban-testnet.stellar.org */
  STELLAR_RPC_URL: requireEnv("STELLAR_RPC_URL"),

  /**
   * Network passphrase used when building simulation transactions.
   * Testnet: "Test SDF Network ; September 2015"
   * Mainnet: "Public Global Stellar Network ; September 2015"
   */
  STELLAR_NETWORK_PASSPHRASE: requireEnv("STELLAR_NETWORK_PASSPHRASE"),

  /**
   * Name of the balance-query entry point on the NFT Soroban contract.
   * Defaults to "balance" (SEP-41 standard). Override if the deployed
   * contract uses a different function name (e.g. "balance_of").
   */
  STELLAR_NFT_BALANCE_FN: optionalEnv("STELLAR_NFT_BALANCE_FN", "balance"),

  /**
   * C-address of the deployed Provenance contract whose `mint` the oracle
   * worker invokes. Only required by the verification worker, which validates
   * it at startup so the API server can run without oracle configuration.
   */
  STELLAR_PROVENANCE_CONTRACT_ID: optionalEnv("STELLAR_PROVENANCE_CONTRACT_ID", ""),

  /**
   * S-secret of the oracle account authorised as the Provenance contract's
   * minter. Only required by the verification worker. Never log this value.
   */
  STELLAR_ORACLE_SECRET_KEY: optionalEnv("STELLAR_ORACLE_SECRET_KEY", ""),

  /**
   * SHA-256 hex measurement of the trusted verifier build, registered in the
   * Registry contract's TEE hash list. Only required by the verification worker.
   */
  ORACLE_CODE_MEASUREMENT_HASH: optionalEnv("ORACLE_CODE_MEASUREMENT_HASH", ""),

  /** Delay between getTransaction polls while awaiting finality. */
  STELLAR_TX_POLL_INTERVAL_MS: optionalPositiveIntEnv("STELLAR_TX_POLL_INTERVAL_MS", 2_000),

  /**
   * Maximum time to wait for a submitted transaction to reach a final state.
   * Must exceed the 30-second transaction timeout so an unconfirmed
   * transaction is known to have expired once this elapses.
   */
  STELLAR_TX_CONFIRMATION_TIMEOUT_MS: optionalPositiveIntEnv(
    "STELLAR_TX_CONFIRMATION_TIMEOUT_MS",
    60_000
  ),

  /** Consecutive RPC errors tolerated while polling before giving up. */
  STELLAR_TX_MAX_CONSECUTIVE_RPC_ERRORS: optionalPositiveIntEnv(
    "STELLAR_TX_MAX_CONSECUTIVE_RPC_ERRORS",
    5
  ),

  /** Delay between verification worker polling cycles. */
  VERIFICATION_WORKER_POLL_INTERVAL_MS: optionalPositiveIntEnv(
    "VERIFICATION_WORKER_POLL_INTERVAL_MS",
    5_000
  ),

  /** Maximum events processed per polling cycle. */
  VERIFICATION_WORKER_BATCH_SIZE: optionalPositiveIntEnv("VERIFICATION_WORKER_BATCH_SIZE", 10),

  /** Processing attempts per event before it is marked failed. */
  VERIFICATION_WORKER_MAX_ATTEMPTS: optionalPositiveIntEnv("VERIFICATION_WORKER_MAX_ATTEMPTS", 3),

  /** Base delay for exponential retry back-off after a retryable failure. */
  VERIFICATION_WORKER_RETRY_BASE_MS: optionalPositiveIntEnv(
    "VERIFICATION_WORKER_RETRY_BASE_MS",
    30_000
  ),

  /**
   * How long a claimed event stays locked to one worker. A crashed worker's
   * lease expires after this window and the event becomes reclaimable.
   */
  VERIFICATION_WORKER_LEASE_MS: optionalPositiveIntEnv("VERIFICATION_WORKER_LEASE_MS", 300_000),

  /** Timeout for each IPFS gateway fetch performed by the SPV verifier. */
  SPV_FETCH_TIMEOUT_MS: optionalPositiveIntEnv("SPV_FETCH_TIMEOUT_MS", 30_000),

  /** Upper bound on media bytes the SPV verifier will download and hash. */
  SPV_MAX_MEDIA_BYTES: optionalPositiveIntEnv("SPV_MAX_MEDIA_BYTES", 104_857_600),

  /** Upper bound on manifest bytes the SPV verifier will download. */
  SPV_MAX_MANIFEST_BYTES: optionalPositiveIntEnv("SPV_MAX_MANIFEST_BYTES", 1_048_576),
  /** Allowed CORS origin for the frontend. */
  CORS_ORIGIN: optionalEnv("CORS_ORIGIN", "http://localhost:3000"),

  /** Morgan log format: 'dev' | 'combined' | 'tiny' etc. */
  LOG_LEVEL: optionalEnv("LOG_LEVEL", "dev"),

  /** Secret used to sign and verify JWTs */
  JWT_SECRET: requireEnv("JWT_SECRET"),

  /** JWT expiry duration, e.g. '7d', '24h' */
  JWT_EXPIRES_IN: optionalEnv("JWT_EXPIRES_IN", "7d"),

  /** Cloudinary Cloud Name */
  CLOUDINARY_CLOUD_NAME: optionalEnv("CLOUDINARY_CLOUD_NAME", ""),

  /** Cloudinary API Key */
  CLOUDINARY_API_KEY: optionalEnv("CLOUDINARY_API_KEY", ""),

  /** Cloudinary API Secret */
  CLOUDINARY_API_SECRET: optionalEnv("CLOUDINARY_API_SECRET", ""),

  /** Pinata JWT for IPFS uploads (v3 API) */
  PINATA_JWT: requireEnv("PINATA_JWT"),

  /** Pinata public gateway base URL */
  PINATA_GATEWAY_URL: optionalEnv("PINATA_GATEWAY_URL", "https://gateway.pinata.cloud/ipfs"),
} as const;
