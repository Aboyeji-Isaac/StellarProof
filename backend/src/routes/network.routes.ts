import { Router } from 'express';
import { networkController } from '../controllers/network.controller';

const router = Router();

/**
 * GET /api/v1/network/rpc?limit=20
 * Soroban RPC status: latest ledger (fetched with endpoint failover), the
 * circuit-breaker state of each configured endpoint (redacted to origin),
 * and the most recent failover events stored in MongoDB.
 */
router.get('/rpc', networkController.getRpcStatus.bind(networkController));

export default router;
