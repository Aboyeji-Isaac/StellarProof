import { PinataSDK, type FileListResponse } from "pinata";
import { StatusCodes } from "http-status-codes";
import { env } from "../config/env";
import { AppError } from "../errors/AppError";
import type {
  IpfsPin,
  IpfsPinInput,
  IpfsPinListQuery,
  IpfsPinListResult,
  IpfsPinResult,
  IpfsUnpinResult,
  IpfsUploadInput,
  IpfsUploadResult,
} from "../types/ipfs.types";

/** CIDv0 (base58btc, "Qm...") or CIDv1 (base32 lowercase, "b..."). */
const CID_REGEX = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{58,})$/;

export const PIN_LIST_DEFAULT_LIMIT = 50;
export const PIN_LIST_MAX_LIMIT = 1000;

export const isValidCid = (cid: string): boolean => CID_REGEX.test(cid);

const toErrorMessage = (err: unknown, fallback: string): string =>
  err instanceof Error ? err.message : fallback;

class IpfsService {
  private readonly pinata: PinataSDK;

  constructor() {
    this.pinata = new PinataSDK({
      pinataJwt: env.PINATA_JWT,
      pinataGateway: env.PINATA_GATEWAY_URL,
    });
  }

  async upload(input: IpfsUploadInput): Promise<IpfsUploadResult> {
    const { content, name = "upload", metadata = {} } = input;

    try {
      let file: File;

      if (Buffer.isBuffer(content)) {
        // Use Uint8Array to satisfy BlobPart requirement and avoid SharedArrayBuffer issues
        file = new File([new Uint8Array(content)], name, { type: "application/octet-stream" });
      } else {
        const json = JSON.stringify(content);
        file = new File([json], `${name}.json`, { type: "application/json" });
      }

      // The Pinata SDK upload builder takes metadata through chained
      // name()/keyvalues() calls; it has no addMetadata() method.
      let builder = this.pinata.upload.public.file(file).name(name);
      if (Object.keys(metadata).length > 0) {
        builder = builder.keyvalues(metadata);
      }
      const response = await builder;

      const size: number = response.size ?? (Buffer.isBuffer(content) ? content.byteLength : Buffer.byteLength(JSON.stringify(content)));

      return {
        cid,
        cidVersion: 1,
        size,
        name: response.name ?? name,
        timestamp: new Date().toISOString(),
        gatewayUrl: `${env.PINATA_GATEWAY_URL}/${cid}`,
      };
    } catch (err: unknown) {
      if (err instanceof AppError) throw err;

      const message =
        err instanceof Error
          ? err.message
          : "IPFS upload failed — unknown error";

      throw new AppError(
        `IPFS upload failed: ${message}`,
        StatusCodes.BAD_GATEWAY,
        "IPFS_UPLOAD_FAILED"
      );
    }
  }

  /**
   * Pins content that already exists on the IPFS network by its CID.
   * Pinata queues the pin and retrieves the content asynchronously.
   */
  async pinMedia(input: IpfsPinInput): Promise<IpfsPinResult> {
    const { cid, name = cid, metadata = {} } = input;
    this.assertValidCid(cid);

    try {
      let builder = this.pinata.upload.public.cid(cid).name(name);
      if (Object.keys(metadata).length > 0) {
        builder = builder.keyvalues(metadata);
      }
      const response = await builder;

      return {
        id: response.id,
        cid: response.cid,
        name: response.name,
        status: response.status,
        queuedAt: response.date_queued,
      };
    } catch (err: unknown) {
      if (err instanceof AppError) throw err;
      throw new AppError(
        `IPFS pin failed: ${toErrorMessage(err, "unknown error")}`,
        StatusCodes.BAD_GATEWAY,
        "IPFS_PIN_FAILED"
      );
    }
  }

  /**
   * Releases every Pinata pin (file) holding the given CID.
   * Idempotent: a CID with no pins resolves with `unpinned: false`.
   */
  async unpinCid(cid: string): Promise<IpfsUnpinResult> {
    this.assertValidCid(cid);

    try {
      const files = await this.pinata.files.public.list().cid(cid).all();
      const fileIds = files.map((file) => file.id);

      if (fileIds.length === 0) {
        return { cid, unpinned: false, fileIds: [] };
      }

      // The SDK reports per-file outcomes as free text (HTTP statusText or an
      // error message), so confirm the release by re-listing the CID.
      const results = await this.pinata.files.public.delete(fileIds);
      const remaining = new Set(
        (await this.pinata.files.public.list().cid(cid).all()).map((file) => file.id)
      );

      if (remaining.size > 0) {
        const details = results
          .filter((result) => remaining.has(result.id))
          .map((result) => `${result.id} (${result.status})`)
          .join(", ");
        throw new AppError(
          `IPFS unpin failed for ${remaining.size} of ${fileIds.length} pin(s) of ${cid}` +
            (details ? `: ${details}` : ""),
          StatusCodes.BAD_GATEWAY,
          "IPFS_UNPIN_FAILED"
        );
      }

      return { cid, unpinned: true, fileIds };
    } catch (err: unknown) {
      if (err instanceof AppError) throw err;
      throw new AppError(
        `IPFS unpin failed: ${toErrorMessage(err, "unknown error")}`,
        StatusCodes.BAD_GATEWAY,
        "IPFS_UNPIN_FAILED"
      );
    }
  }

  /**
   * Lists one page of pinned files in the Pinata account, newest first.
   */
  async listPins(query: IpfsPinListQuery = {}): Promise<IpfsPinListResult> {
    const limit = query.limit ?? PIN_LIST_DEFAULT_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > PIN_LIST_MAX_LIMIT) {
      throw new AppError(
        `limit must be an integer between 1 and ${PIN_LIST_MAX_LIMIT}`,
        StatusCodes.BAD_REQUEST,
        "INVALID_PIN_LIST_LIMIT"
      );
    }
    if (query.cid !== undefined) {
      this.assertValidCid(query.cid);
    }

    try {
      let filter = this.pinata.files.public.list().order("DESC").limit(limit);
      if (query.cid) filter = filter.cid(query.cid);
      if (query.pageToken) filter = filter.pageToken(query.pageToken);

      const response: FileListResponse = await filter;

      return {
        pins: response.files.map((file) => ({
          id: file.id,
          cid: file.cid,
          name: file.name,
          size: file.size,
          mimeType: file.mime_type,
          keyvalues: file.keyvalues ?? {},
          createdAt: file.created_at,
        })),
        nextPageToken: response.next_page_token || null,
      };
    } catch (err: unknown) {
      if (err instanceof AppError) throw err;
      throw new AppError(
        `IPFS pin listing failed: ${toErrorMessage(err, "unknown error")}`,
        StatusCodes.BAD_GATEWAY,
        "IPFS_LIST_PINS_FAILED"
      );
    }
  }

  private assertValidCid(cid: string): void {
    if (!isValidCid(cid)) {
      throw new AppError(`Invalid IPFS CID: ${cid}`, StatusCodes.BAD_REQUEST, "INVALID_CID");
    }
  }
}

export const ipfsService = new IpfsService();
