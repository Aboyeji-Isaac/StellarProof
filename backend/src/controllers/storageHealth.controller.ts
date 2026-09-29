import { Request, Response, NextFunction } from 'express';
import { StatusCodes } from 'http-status-codes';
import { storageProviderRegistry } from '../services/storage.service';

/**
 * Storage Provider Health Controller
 * Exposes the ranked storage provider registry maintained in MongoDB.
 */

/**
 * GET /api/v1/storage/providers/health
 * Returns the current preferred/failover ranking, refreshing stale entries.
 */
export const getProviderHealth = async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const providers = await storageProviderRegistry.getRankedProviders();

    res.status(StatusCodes.OK).json({
      success: true,
      data: {
        preferredProvider: providers.find((p) => p.status === 'healthy')?.provider ?? null,
        providers,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/v1/storage/providers/health/refresh
 * Forces an immediate health check of every provider.
 */
export const refreshProviderHealth = async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const providers = await storageProviderRegistry.refresh();

    res.status(StatusCodes.OK).json({
      success: true,
      data: {
        preferredProvider: providers.find((p) => p.status === 'healthy')?.provider ?? null,
        providers,
      },
    });
  } catch (error) {
    next(error);
  }
};
