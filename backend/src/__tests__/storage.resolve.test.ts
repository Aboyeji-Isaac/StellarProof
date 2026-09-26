/**
 * GET /api/v1/storage/resolve/:cid
 *
 * Covers the gateway fetch (streaming SHA-256, timeout, size cap) and the
 * full route -> controller -> service -> model path. The Pinata gateway is
 * stubbed at the `fetch` boundary and the StorageRecord query is stubbed at
 * the Mongoose boundary so the suite runs without network or database access.
 */
jest.mock('../config/env', () => ({
  __esModule: true,
  env: {
    NODE_ENV: 'test',
    MONGODB_URI: 'mongodb://localhost:27017/test',
    JWT_SECRET: 'test-secret',
    CLOUDINARY_CLOUD_NAME: 'test',
    CLOUDINARY_API_KEY: 'test',
    CLOUDINARY_API_SECRET: 'test',
    PINATA_JWT: 'test',
    PINATA_GATEWAY_URL: 'https://gateway.example/ipfs/',
    IPFS_RESOLVE_TIMEOUT_MS: 200,
    IPFS_RESOLVE_MAX_BYTES: 1024,
  },
}));

jest.mock('../services/cloudinary.service', () => ({
  __esModule: true,
  cloudinaryService: { uploadBuffer: jest.fn() },
}));

import { createHash } from 'crypto';
import express from 'express';
import request from 'supertest';
import storageRoutes from '../routes/v1/storage.routes';
import { globalErrorHandler } from '../middlewares/errorHandler';
import StorageRecord from '../models/StorageRecord.model';
import { ipfsService } from '../services/ipfs.service';
import { isValidCid } from '../services/storage.service';

const CID_V0 = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
const CID_V1 = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';

const content = Buffer.from('stellarproof resolve test payload');
const contentSha256 = createHash('sha256').update(content).digest('hex');

function streamResponse(body: Buffer, init: ResponseInit = {}): Response {
  return new Response(new Uint8Array(body), { status: 200, ...init });
}

function mockRecord(record: { cid: string; size: number; contentHash?: string } | null) {
  const exec = jest.fn().mockResolvedValue(record);
  const query = { sort: jest.fn().mockReturnThis(), select: jest.fn().mockReturnThis(), exec };
  return jest.spyOn(StorageRecord, 'findOne').mockReturnValue(query as never);
}

function buildApp() {
  const app = express();
  app.use('/api/v1/storage', storageRoutes);
  app.use(globalErrorHandler);
  return app;
}

const fetchMock = jest.fn<Promise<Response>, [string, RequestInit?]>();

beforeEach(() => {
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
  jest.restoreAllMocks();
});

describe('isValidCid', () => {
  it.each([CID_V0, CID_V1])('accepts %s', (cid) => {
    expect(isValidCid(cid)).toBe(true);
  });

  it.each(['', 'Qm123', 'not-a-cid', `${CID_V0}0`, CID_V1.toUpperCase(), '../etc/passwd'])(
    'rejects %p',
    (cid) => {
      expect(isValidCid(cid)).toBe(false);
    }
  );
});

describe('ipfsService.fetchFromGateway', () => {
  const options = { timeoutMs: 200, maxBytes: 1024 };

  it('streams the object and returns its size and SHA-256', async () => {
    fetchMock.mockResolvedValue(streamResponse(content));

    const result = await ipfsService.fetchFromGateway(CID_V0, options);

    expect(result).toEqual({ status: 'ok', size: content.length, sha256: contentSha256 });
    expect(fetchMock).toHaveBeenCalledWith(
      `https://gateway.example/ipfs/${CID_V0}`,
      expect.objectContaining({ method: 'GET', signal: expect.any(AbortSignal) })
    );
  });

  it('reports not_found for 404 responses', async () => {
    fetchMock.mockResolvedValue(new Response('missing', { status: 404 }));

    await expect(ipfsService.fetchFromGateway(CID_V0, options)).resolves.toEqual({
      status: 'not_found',
      httpStatus: 404,
    });
  });

  it('reports unreachable for gateway errors', async () => {
    fetchMock.mockResolvedValue(new Response('bad gateway', { status: 502 }));

    await expect(ipfsService.fetchFromGateway(CID_V0, options)).resolves.toEqual({
      status: 'unreachable',
      httpStatus: 502,
    });
  });

  it('reports unreachable for network failures', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));

    await expect(ipfsService.fetchFromGateway(CID_V0, options)).resolves.toEqual({
      status: 'unreachable',
    });
  });

  it('rejects objects whose Content-Length exceeds the cap without reading them', async () => {
    const response = streamResponse(Buffer.alloc(10), { headers: { 'content-length': '4096' } });
    const cancel = jest.spyOn(response.body!, 'cancel');
    fetchMock.mockResolvedValue(response);

    await expect(ipfsService.fetchFromGateway(CID_V0, options)).resolves.toEqual({
      status: 'too_large',
      declaredSize: 4096,
    });
    expect(cancel).toHaveBeenCalled();
  });

  it('aborts the download once streamed bytes exceed the cap', async () => {
    fetchMock.mockResolvedValue(streamResponse(Buffer.alloc(2048)));

    await expect(ipfsService.fetchFromGateway(CID_V0, options)).resolves.toEqual({
      status: 'too_large',
      declaredSize: null,
    });
  });

  it('reports timeout when the gateway does not respond in time', async () => {
    fetchMock.mockImplementation(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('The operation was aborted.', 'AbortError'))
          );
        })
    );

    await expect(ipfsService.fetchFromGateway(CID_V0, { ...options, timeoutMs: 20 })).resolves.toEqual({
      status: 'timeout',
    });
  });
});

describe('GET /api/v1/storage/resolve/:cid', () => {
  const app = buildApp();

  it('returns available + hashMatches=true when gateway bytes match the stored hash', async () => {
    const findOne = mockRecord({ cid: CID_V1, size: content.length, contentHash: contentSha256 });
    fetchMock.mockResolvedValue(streamResponse(content));

    const res = await request(app).get(`/api/v1/storage/resolve/${CID_V1}`);

    expect(res.status).toBe(200);
    expect(findOne).toHaveBeenCalledWith({ cid: CID_V1 });
    expect(res.body).toEqual({
      success: true,
      data: {
        cid: CID_V1,
        available: true,
        size: content.length,
        hashMatches: true,
        expectedSize: content.length,
        gatewayStatus: 'ok',
        checkedAt: expect.any(String),
      },
    });
  });

  it('accepts a stored hash in "sha256:<hex>" form', async () => {
    mockRecord({ cid: CID_V0, size: content.length, contentHash: `sha256:${contentSha256}` });
    fetchMock.mockResolvedValue(streamResponse(content));

    const res = await request(app).get(`/api/v1/storage/resolve/${CID_V0}`);

    expect(res.body.data.hashMatches).toBe(true);
  });

  it('returns hashMatches=false when gateway bytes differ from the stored hash', async () => {
    mockRecord({ cid: CID_V0, size: content.length, contentHash: contentSha256 });
    fetchMock.mockResolvedValue(streamResponse(Buffer.from('tampered payload')));

    const res = await request(app).get(`/api/v1/storage/resolve/${CID_V0}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ available: true, hashMatches: false, gatewayStatus: 'ok' });
  });

  it('returns hashMatches=null for legacy records without a contentHash', async () => {
    mockRecord({ cid: CID_V0, size: content.length });
    fetchMock.mockResolvedValue(streamResponse(content));

    const res = await request(app).get(`/api/v1/storage/resolve/${CID_V0}`);

    expect(res.body.data).toMatchObject({ available: true, size: content.length, hashMatches: null });
  });

  it('returns available=false while the pin has not propagated', async () => {
    mockRecord({ cid: CID_V0, size: content.length, contentHash: contentSha256 });
    fetchMock.mockResolvedValue(new Response('not found', { status: 404 }));

    const res = await request(app).get(`/api/v1/storage/resolve/${CID_V0}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      available: false,
      size: null,
      hashMatches: null,
      expectedSize: content.length,
      gatewayStatus: 'not_found',
    });
  });

  it('reports available with unverified hash for objects above the size cap', async () => {
    mockRecord({ cid: CID_V0, size: 4096, contentHash: contentSha256 });
    fetchMock.mockResolvedValue(streamResponse(Buffer.alloc(10), { headers: { 'content-length': '4096' } }));

    const res = await request(app).get(`/api/v1/storage/resolve/${CID_V0}`);

    expect(res.body.data).toMatchObject({
      available: true,
      size: 4096,
      hashMatches: null,
      gatewayStatus: 'too_large',
    });
  });

  it('returns 404 when the CID has no storage record', async () => {
    mockRecord(null);

    const res = await request(app).get(`/api/v1/storage/resolve/${CID_V0}`);

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ success: false, code: 'CID_NOT_FOUND' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 400 for a malformed CID without touching the database or gateway', async () => {
    const findOne = jest.spyOn(StorageRecord, 'findOne');

    const res = await request(app).get('/api/v1/storage/resolve/not-a-cid');

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false, code: 'INVALID_CID' });
    expect(findOne).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
