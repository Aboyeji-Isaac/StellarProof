import {
  UploadRequest,
  UploadResult,
  StorageProvider,
  StorageError,
  STORAGE_PROVIDERS,
  type ProviderHealthSnapshot,
} from '../types/storage.types';
import { cloudinaryService } from './cloudinary.service';
import { ipfsService } from './ipfs.service';
import StorageRecord from '../models/StorageRecord.model';
import StorageProviderHealth, { IStorageProviderHealth } from '../models/StorageProviderHealth.model';
import { AppError } from '../errors/AppError';
import { env } from '../config/env';
import logger from '../utils/logger';

type ProviderProbe = () => Promise<void>;

export interface StorageProviderRegistryOptions {
  /** Provider preference, most preferred first. */
  priority: StorageProvider[];
  /** How long a stored health result is trusted before re-checking (ms). */
  ttlMs: number;
  /** Per-probe timeout (ms). */
  timeoutMs: number;
}

/**
 * Parses a comma-separated provider list, dropping unknown/duplicate names
 * and appending any supported provider that was not listed.
 */
export function parseProviderPriority(value: string): StorageProvider[] {
  const listed = value
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter((name): name is StorageProvider => (STORAGE_PROVIDERS as readonly string[]).includes(name));

  const unique = Array.from(new Set(listed));
  for (const provider of STORAGE_PROVIDERS) {
    if (!unique.includes(provider)) unique.push(provider);
  }
  return unique;
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 1000);
}

async function withTimeout(probe: ProviderProbe, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Health check timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    await Promise.race([probe(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Storage Provider Registry
 * Health-checks each storage provider, persists the result in MongoDB and
 * maintains a preferred/failover ranking the orchestrator consults before
 * every upload.
 */
export class StorageProviderRegistry {
  private refreshInFlight: Promise<ProviderHealthSnapshot[]> | null = null;

  constructor(
    private readonly probes: Record<StorageProvider, ProviderProbe>,
    private readonly options: StorageProviderRegistryOptions,
  ) {}

  /**
   * Probes a single provider and persists the outcome.
   */
  async checkProvider(provider: StorageProvider): Promise<IStorageProviderHealth> {
    const startedAt = Date.now();
    try {
      await withTimeout(this.probes[provider], this.options.timeoutMs);
      return await this.recordSuccess(provider, Date.now() - startedAt, 'probe');
    } catch (error) {
      return await this.recordFailure(provider, error, 'probe');
    }
  }

  /**
   * Probes every provider concurrently and returns the new ranking.
   * Concurrent callers share a single in-flight refresh.
   */
  async refresh(): Promise<ProviderHealthSnapshot[]> {
    if (!this.refreshInFlight) {
      this.refreshInFlight = (async () => {
        try {
          const records = await Promise.all(this.options.priority.map((p) => this.checkProvider(p)));
          return this.rank(records);
        } finally {
          this.refreshInFlight = null;
        }
      })();
    }
    return this.refreshInFlight;
  }

  /**
   * Returns the ranked provider list from the database, refreshing first
   * when any provider has no result or its result is older than the TTL.
   */
  async getRankedProviders(options: { refreshIfStale?: boolean } = {}): Promise<ProviderHealthSnapshot[]> {
    const { refreshIfStale = true } = options;
    const records = await StorageProviderHealth.find({ provider: { $in: this.options.priority } });

    if (refreshIfStale && this.isStale(records)) {
      return this.refresh();
    }
    return this.rank(records);
  }

  /**
   * Ordered list of providers to attempt for an upload.
   * Healthy providers come before unhealthy ones; within each group the
   * requested provider is tried first, then the configured priority.
   * Unhealthy providers are kept as a last resort because health data can
   * lag behind a recovery. If the registry itself fails, the requested
   * provider followed by the configured priority is used so uploads are
   * never blocked by health-check bookkeeping.
   */
  async getUploadCandidates(requested: StorageProvider): Promise<StorageProvider[]> {
    try {
      const ranked = await this.getRankedProviders();
      const byStatus = (status: 'healthy' | 'unhealthy') => {
        const group = ranked.filter((s) => s.status === status).map((s) => s.provider);
        return group.includes(requested) ? [requested, ...group.filter((p) => p !== requested)] : group;
      };
      return [...byStatus('healthy'), ...byStatus('unhealthy')];
    } catch (error) {
      logger.warn('Storage provider registry unavailable; using static priority', {
        error: errorMessage(error),
      });
      return [requested, ...this.options.priority.filter((p) => p !== requested)];
    }
  }

  async recordSuccess(
    provider: StorageProvider,
    latencyMs: number,
    source: 'probe' | 'upload',
  ): Promise<IStorageProviderHealth> {
    const now = new Date();
    const record = await StorageProviderHealth.findOneAndUpdate(
      { provider },
      {
        $set: { status: 'healthy', latencyMs, consecutiveFailures: 0, lastCheckedAt: now, lastHealthyAt: now, source },
        $unset: { lastError: 1 },
      },
      { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true },
    );
    return record as IStorageProviderHealth;
  }

  async recordFailure(
    provider: StorageProvider,
    error: unknown,
    source: 'probe' | 'upload',
  ): Promise<IStorageProviderHealth> {
    const lastError = errorMessage(error);
    logger.warn('Storage provider marked unhealthy', { provider, source, error: lastError });

    const record = await StorageProviderHealth.findOneAndUpdate(
      { provider },
      {
        $set: { status: 'unhealthy', lastError, lastCheckedAt: new Date(), source },
        $unset: { latencyMs: 1 },
        $inc: { consecutiveFailures: 1 },
      },
      { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true },
    );
    return record as IStorageProviderHealth;
  }

  private isStale(records: IStorageProviderHealth[]): boolean {
    if (records.length < this.options.priority.length) return true;
    const cutoff = Date.now() - this.options.ttlMs;
    return records.some((r) => r.lastCheckedAt.getTime() < cutoff);
  }

  private rank(records: IStorageProviderHealth[]): ProviderHealthSnapshot[] {
    const priorityIndex = (p: StorageProvider) => this.options.priority.indexOf(p);

    return [...records]
      .sort((a, b) => {
        if (a.status !== b.status) return a.status === 'healthy' ? -1 : 1;
        return priorityIndex(a.provider) - priorityIndex(b.provider);
      })
      .map((r, index) => ({
        provider: r.provider,
        rank: index + 1,
        status: r.status,
        latencyMs: r.latencyMs,
        consecutiveFailures: r.consecutiveFailures,
        lastError: r.lastError,
        lastCheckedAt: r.lastCheckedAt,
        lastHealthyAt: r.lastHealthyAt,
        source: r.source,
      }));
  }
}

export const storageProviderRegistry = new StorageProviderRegistry(
  {
    ipfs: () => ipfsService.healthCheck(),
    cloudinary: () => cloudinaryService.ping(),
  },
  {
    priority: parseProviderPriority(env.STORAGE_PROVIDER_PRIORITY),
    ttlMs: env.STORAGE_HEALTH_TTL_MS,
    timeoutMs: env.STORAGE_HEALTH_CHECK_TIMEOUT_MS,
  },
);

/**
 * Storage Orchestrator Service
 * Factory that routes upload requests to the appropriate provider (Cloudinary or IPFS)
 * Consults the provider registry before each upload and fails over to the
 * next ranked provider when the preferred one is unhealthy or errors.
 * Ensures all uploads are persisted to MongoDB before returning
 */
class StorageOrchestratorService {
  constructor(private readonly registry: StorageProviderRegistry) {}

  /**
   * Orchestrate the upload based on the requested storage provider
   * Routes to the best available provider, persists result to DB, and returns saved record
   */
  async orchestrate(request: UploadRequest): Promise<UploadResult> {
    // Validate provider
    if (!STORAGE_PROVIDERS.includes(request.storageProvider)) {
      throw new StorageError(
        null,
        'orchestrate',
        `Invalid storage provider: ${request.storageProvider}. Supported providers: ${STORAGE_PROVIDERS.join(', ')}`,
        400,
      );
    }

    const candidates = await this.registry.getUploadCandidates(request.storageProvider);
    const failures: string[] = [];
    let uploadResult: UploadResult | undefined;

    for (const provider of candidates) {
      const startedAt = Date.now();
      try {
        uploadResult = await this.uploadToProvider(provider, request);
        await this.registry
          .recordSuccess(provider, Date.now() - startedAt, 'upload')
          .catch((err: unknown) => logger.warn('Failed to record provider success', { provider, error: errorMessage(err) }));
        break;
      } catch (error) {
        // Client errors (e.g. a rejected file) will not succeed elsewhere.
        if (error instanceof AppError && error.statusCode < 500) {
          throw new StorageError(provider, 'upload', error.message, error.statusCode);
        }

        failures.push(`${provider}: ${errorMessage(error)}`);
        await this.registry
          .recordFailure(provider, error, 'upload')
          .catch((err: unknown) => logger.warn('Failed to record provider failure', { provider, error: errorMessage(err) }));
      }
    }

    if (!uploadResult) {
      throw new StorageError(
        request.storageProvider,
        'orchestrate',
        `All storage providers failed: ${failures.join('; ')}`,
        502,
      );
    }

    const failedOver = uploadResult.provider !== request.storageProvider;
    if (failedOver) {
      logger.warn('Storage upload failed over to secondary provider', {
        requestedProvider: request.storageProvider,
        provider: uploadResult.provider,
        failures,
      });
    }

    // Persist result to MongoDB
    const storageRecord = new StorageRecord({
      userId: request.userId,
      provider: uploadResult.provider,
      url: uploadResult.url,
      cid: uploadResult.cid,
      publicId: uploadResult.publicId,
      size: uploadResult.size,
      mimetype: uploadResult.mimetype,
      originalFilename: request.originalname,
      uploadedAt: uploadResult.uploadedAt,
    });

    try {
      const savedRecord = await storageRecord.save();

      // Return the saved record (not the provider result)
      // Ensures response data always comes from MongoDB
      return {
        provider: savedRecord.provider,
        url: savedRecord.url,
        cid: savedRecord.cid,
        publicId: savedRecord.publicId,
        size: savedRecord.size,
        mimetype: savedRecord.mimetype,
        uploadedAt: savedRecord.uploadedAt,
        requestedProvider: request.storageProvider,
        failedOver,
      };
    } catch (dbError) {
      throw new StorageError(
        uploadResult.provider,
        'persist',
        `Failed to persist upload record to database: ${dbError instanceof Error ? dbError.message : String(dbError)}`,
        500,
      );
    }
  }

  private async uploadToProvider(provider: StorageProvider, request: UploadRequest): Promise<UploadResult> {
    switch (provider) {
      case 'cloudinary': {
        const cloudinaryUpload = await cloudinaryService.uploadBuffer(request.buffer);
        return {
          provider: 'cloudinary',
          url: cloudinaryUpload.secure_url,
          publicId: cloudinaryUpload.public_id,
          size: cloudinaryUpload.bytes,
          mimetype: request.mimetype,
          uploadedAt: new Date(cloudinaryUpload.created_at),
        };
      }

      case 'ipfs': {
        const ipfsUpload = await ipfsService.upload({
          content: request.buffer,
          name: request.originalname,
        });
        return {
          provider: 'ipfs',
          url: ipfsUpload.gatewayUrl,
          cid: ipfsUpload.cid,
          size: ipfsUpload.size,
          mimetype: request.mimetype,
          uploadedAt: new Date(ipfsUpload.timestamp),
        };
      }

      default: {
        // TypeScript exhaustiveness check
        const _exhaustive: never = provider;
        throw new StorageError(null, 'orchestrate', `Unhandled provider: ${String(_exhaustive)}`, 500);
      }
    }
  }
}

export const storageOrchestratorService = new StorageOrchestratorService(storageProviderRegistry);
