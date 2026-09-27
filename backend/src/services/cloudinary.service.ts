import { cloudinary } from "../config/cloudinary";
import { AppError } from "../errors/AppError";
import { StatusCodes } from "http-status-codes";
import type { CloudinaryUploadResult } from "../types/cloudinary.types";
import { UploadApiResponse } from "cloudinary";

class CloudinaryService {
  /**
   * Uploads a file buffer to Cloudinary using upload stream.
   * 
   * @param buffer - File buffer to upload
   * @param folder - Cloudinary folder name
   * @returns Promise<CloudinaryUploadResult>
   */
  async uploadBuffer(
    buffer: Buffer,
    folder: string = "stellarproof"
  ): Promise<CloudinaryUploadResult> {
    return new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        { folder, resource_type: "auto" },
        (error, result) => {
          if (error) {
            return reject(
              new AppError(
                `Cloudinary upload failed: ${error.message}`,
                StatusCodes.INTERNAL_SERVER_ERROR,
                "CLOUDINARY_UPLOAD_FAILED"
              )
            );
          }

          if (!result) {
            return reject(
              new AppError(
                "Cloudinary upload failed: No result returned",
                StatusCodes.INTERNAL_SERVER_ERROR,
                "CLOUDINARY_UPLOAD_FAILED"
              )
            );
          }

          const uploadResult = result as UploadApiResponse;

          resolve({
            secure_url: uploadResult.secure_url,
            public_id: uploadResult.public_id,
            format: uploadResult.format,
            resource_type: uploadResult.resource_type,
            bytes: uploadResult.bytes,
            width: uploadResult.width,
            height: uploadResult.height,
            folder: uploadResult.folder,
            created_at: uploadResult.created_at,
          });
        }
      );

      uploadStream.end(buffer);
    });
  }

  /**
   * Liveness probe using the Cloudinary Admin API ping endpoint.
   * Throws if Cloudinary is not configured or unreachable.
   */
  async ping(): Promise<void> {
    const { cloud_name, api_key, api_secret } = cloudinary.config();
    if (!cloud_name || !api_key || !api_secret) {
      throw new Error("Cloudinary is not configured");
    }

    const response = await cloudinary.api.ping();
    if (response?.status !== "ok") {
      throw new Error(`Unexpected Cloudinary ping status: ${String(response?.status)}`);
    }
  }
}

export const cloudinaryService = new CloudinaryService();
