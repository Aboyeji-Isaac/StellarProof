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

/**
 * Ordered list of Soroban RPC endpoints: the required primary followed by
 * the optional STELLAR_RPC_URL_2 / STELLAR_RPC_URL_3 fallbacks. Blank and
 * duplicate entries are dropped; malformed URLs abort startup.
 */
function rpcUrlList(): string[] {
  const urls = [
    requireEnv("STELLAR_RPC_URL"),
    optionalEnv("STELLAR_RPC_URL_2", ""),
    optionalEnv("STELLAR_RPC_URL_3", ""),
  ]
    .map((url) => url.trim())
    .filter((url) => url.length > 0);

  for (const url of urls) {
    try {
      new URL(url);
    } catch {
      console.error(`[Config] Invalid Stellar RPC URL configured: ${url}`);
      process.exit(1);
    }
  }

  return Array.from(new Set(urls));
}

export const env = {
  NODE_ENV: optionalEnv("NODE_ENV", "development"),
  PORT: parseInt(optionalEnv("PORT", "4000"), 10),

  /** MongoDB connection string, e.g. mongodb://localhost:27017/stellarproof */
  MONGODB_URI: requireEnv("MONGODB_URI"),

  /** Soroban/Stellar RPC endpoint, e.g. https://soroban-testnet.stellar.org */
  STELLAR_RPC_URL: requireEnv("STELLAR_RPC_URL"),

  /** Optional backup RPC endpoints used when the primary fails. */
  STELLAR_RPC_URL_2: optionalEnv("STELLAR_RPC_URL_2", ""),
  STELLAR_RPC_URL_3: optionalEnv("STELLAR_RPC_URL_3", ""),

  /** Primary + backup RPC endpoints in failover order. */
  STELLAR_RPC_URLS: rpcUrlList(),

  /** Consecutive network failures before an endpoint's circuit opens. */
  STELLAR_RPC_FAILURE_THRESHOLD: parseInt(optionalEnv("STELLAR_RPC_FAILURE_THRESHOLD", "3"), 10),

  /** How long an open circuit stays open before a half-open trial (ms). */
  STELLAR_RPC_COOLDOWN_MS: parseInt(optionalEnv("STELLAR_RPC_COOLDOWN_MS", "30000"), 10),

  /** Per-request timeout for RPC calls (ms). */
  STELLAR_RPC_TIMEOUT_MS: parseInt(optionalEnv("STELLAR_RPC_TIMEOUT_MS", "10000"), 10),

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
