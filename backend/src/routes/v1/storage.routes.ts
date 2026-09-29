import { Router } from 'express';
import multer from 'multer';
import { resolveCid, uploadFile, uploadManifest, uploadMedia } from '../../controllers/storage.controller';

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
 * 
 * Response:
 *   - 201: Upload successful with saved record
 *   - 400: Invalid input or provider
 *   - 401: Authentication required
 *   - 502: Cloudinary error (requested provider was cloudinary)
 *   - 503: IPFS failed and the Cloudinary fallback also failed
 *
 * When storageProvider is "ipfs" and pinning fails or times out, the file is
 * stored on Cloudinary instead; the response reports provider,
 * requestedProvider and fallbackUsed.
 */
router.post('/upload', upload.single('file'), uploadFile);

/**
 * POST /api/v1/storage/media
 * Upload a media file (defaults to IPFS) and create the linked Asset.
 * IPFS pins are always requested as CIDv1; the returned IpfsHash is stored
 * as the Asset's storageReferenceId and returned as `mediaCid`.
 *
 * Response:
 *   - 201: { assetId, storageProvider, storageReferenceId, url, mediaCid, cidVersion }
 *   - 400: Missing file or invalid userId
 *   - 401: Authentication required
 *   - 502: Provider error or non-CIDv1 response
 */
router.post('/media', upload.single('file'), uploadMedia);
router.post('/manifest', uploadManifest);

/**
 * GET /api/v1/storage/resolve/:cid
 * Check that a stored CID resolves on the IPFS gateway and that its bytes
 * match the SHA-256 recorded at upload time.
 *
 * Response:
 *   - 200: { available, size, hashMatches, expectedSize, gatewayStatus, cid, checkedAt }
 *   - 400: Malformed CID
 *   - 404: CID has no storage record
 */
router.get('/resolve/:cid', resolveCid);

export default router;
