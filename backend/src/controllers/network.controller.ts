import type { Request, Response, NextFunction } from 'express';
import { StatusCodes } from 'http-status-codes';
import { AppError } from '../errors/AppError';
import { sorobanService } from '../services/soroban.service';

const MAX_RECENT_FAILOVERS = 100;

class NetworkController {
  /**
   * GET /api/v1/network/rpc?limit=20
   */
  public async getRpcStatus(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const rawLimit = req.query.limit;
      const limit = rawLimit === undefined ? 20 : Number(rawLimit);

      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RECENT_FAILOVERS) {
        throw new AppError(
          `limit must be an integer between 1 and ${MAX_RECENT_FAILOVERS}`,
          StatusCodes.BAD_REQUEST,
          'INVALID_LIMIT',
        );
      }

      const status = await sorobanService.getNetworkStatus(limit);

      res.status(StatusCodes.OK).json({ success: true, data: status });
    } catch (error) {
      next(error);
    }
  }
}

export const networkController = new NetworkController();
