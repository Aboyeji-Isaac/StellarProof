import { Router } from 'express';
import {
  getCertificateById,
  verifyCertificate,
} from '../../controllers/certificate.controller';

const router = Router();

// Declared before '/:id' so '/verify/:certificateId' is not shadowed by it.
router.get('/verify/:certificateId', verifyCertificate);
router.get('/:id', getCertificateById);

export default router;
