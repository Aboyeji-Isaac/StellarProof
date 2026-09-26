import { Router } from 'express';
import multer from 'multer';
import { uploadFile, uploadManifest, uploadMedia, verifyContentHash } from '../../controllers/storage.controller';

/**
 * Storage Routes - v1
 * Mount at /api/v1/storage
 */
const router = Router();

/**
 * Configure multer for in-memory file uploads
 * Stores file buffer in memory for direct streaming to providers
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 100 * 1024 * 1024, // 100 MB limit
  },
  fileFilter: (_req, file, cb) => {
    // Allow all MIME types - provider-specific validation if needed
    cb(null, true);
  },
});

/**
 * POST /api/v1/storage/upload
 * Upload a file to the specified storage provider (Cloudinary or IPFS)
 * 
 * Request:
 *   - file: multipart form data file
 *   - storageProvider: 'cloudinary' | 'ipfs' (in form data or JSON body)
 *   - userId: string (if not using auth middleware)
 *   - contentHash: optional SHA-256 hex of the file; verified before storage
 * 
 * Response:
 *   - 201: Upload successful with saved record
 *   - 400: Invalid input, provider or contentHash format
 *   - 422: contentHash does not match the uploaded bytes (nothing is stored)
 *   - 401: Authentication required
 *   - 502: Provider error (upstream failure)
 */
router.post('/upload', upload.single('file'), uploadFile);
router.post('/media', upload.single('file'), uploadMedia);
router.post('/manifest', uploadManifest);

/**
 * POST /api/v1/storage/verify-hash
 * Pre-upload hash-consistency check. Nothing is written.
 *
 * Request (multipart/form-data):
 *   - file: the media file
 *   - contentHash: SHA-256 hex digest computed by the client (required)
 *   - userId: string (if not using auth middleware)
 *
 * Response:
 *   - 200: Hash matches; includes existing StorageRecords for the same content
 *   - 400: Missing file, missing/malformed contentHash, or invalid userId
 *   - 401: Authentication required
 *   - 422: contentHash does not match the uploaded bytes
 */
router.post('/verify-hash', upload.single('file'), verifyContentHash);

export default router;
