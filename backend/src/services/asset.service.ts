import Asset, { IAsset } from "../models/Asset.model";
import mongoose from "mongoose";
import { StatusCodes } from "http-status-codes";
import { AppError } from "../errors/AppError";
import { isCidV1 } from "../utils/cid";
import type { UploadResult } from "../types/storage.types";

class AssetService {
  /**
   * Creates a new asset record in the database.
   */
  async createAsset(data: {
    creatorId: string;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    storageProvider: "mongodb" | "ipfs" | "s3" | "cloudinary";
    storageReferenceId: string;
    isEncrypted?: boolean;
  }): Promise<IAsset> {
    const asset = new Asset({
      ...data,
      creatorId: new mongoose.Types.ObjectId(data.creatorId),
    });
    return await asset.save();
  }

  /**
   * Retrieves an asset by its ID.
   */
  async getAssetById(id: string): Promise<IAsset | null> {
    return await Asset.findById(id);
  }

  /**
   * Links a completed storage upload to a new Asset.
   *
   * For IPFS uploads the canonical CIDv1 (mediaCid) is persisted as the
   * Asset's storageReferenceId so on-chain registration and verification can
   * reference it. The persisted document is re-read and returned so callers
   * always respond with database state.
   */
  async createFromUpload(params: {
    creatorId: string;
    fileName: string;
    upload: UploadResult;
  }): Promise<IAsset> {
    const { creatorId, fileName, upload } = params;

    let storageReferenceId: string;
    if (upload.provider === "ipfs") {
      if (!upload.cid || !isCidV1(upload.cid)) {
        throw new AppError(
          "IPFS upload did not produce a CIDv1 mediaCid",
          StatusCodes.BAD_GATEWAY,
          "IPFS_CID_VERSION_MISMATCH"
        );
      }
      storageReferenceId = upload.cid;
    } else {
      storageReferenceId = upload.url;
    }

    const created = await this.createAsset({
      creatorId,
      fileName,
      mimeType: upload.mimetype,
      sizeBytes: upload.size,
      storageProvider: upload.provider,
      storageReferenceId,
      isEncrypted: false,
    });

    const persisted = await this.getAssetById(String(created._id));
    if (!persisted) {
      throw new AppError(
        "Failed to retrieve asset from database after creation",
        StatusCodes.INTERNAL_SERVER_ERROR,
        "DB_RETRIEVAL_FAILED"
      );
    }

    return persisted;
  }
}

export const assetService = new AssetService();
