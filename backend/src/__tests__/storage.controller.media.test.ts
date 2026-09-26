jest.mock("../config/env", () => ({
  __esModule: true,
  env: {
    PINATA_JWT: "test-jwt",
    PINATA_GATEWAY_URL: "https://gateway.pinata.cloud/ipfs",
  },
}));

jest.mock("../services/storage.service", () => ({
  __esModule: true,
  storageOrchestratorService: { orchestrate: jest.fn() },
}));

jest.mock("../services/asset.service", () => ({
  __esModule: true,
  assetService: { createFromUpload: jest.fn() },
}));

jest.mock("../services/ipfs.service", () => ({
  __esModule: true,
  ipfsService: { upload: jest.fn() },
}));

import mongoose from "mongoose";
import type { Request, Response } from "express";
import { StatusCodes } from "http-status-codes";
import { uploadMedia } from "../controllers/storage.controller";
import { storageOrchestratorService } from "../services/storage.service";
import { assetService } from "../services/asset.service";

const CID_V1 = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";

describe("storage.controller uploadMedia", () => {
  const userId = new mongoose.Types.ObjectId().toString();
  let req: Partial<Request>;
  let res: Partial<Response>;
  let next: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    req = {
      file: {
        buffer: Buffer.from("media"),
        originalname: "clip.mp4",
        mimetype: "video/mp4",
        size: 5,
      } as Express.Multer.File,
      body: { storageProvider: "ipfs" },
      user: { id: userId } as unknown as Request["user"],
    };
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    next = jest.fn();
  });

  it("returns the persisted CIDv1 as mediaCid", async () => {
    const upload = {
      provider: "ipfs",
      url: `https://gateway.pinata.cloud/ipfs/${CID_V1}`,
      cid: CID_V1,
      size: 5,
      mimetype: "video/mp4",
      uploadedAt: new Date(),
    };
    const assetId = new mongoose.Types.ObjectId();
    (storageOrchestratorService.orchestrate as jest.Mock).mockResolvedValue(upload);
    (assetService.createFromUpload as jest.Mock).mockResolvedValue({
      _id: assetId,
      storageProvider: "ipfs",
      storageReferenceId: CID_V1,
    });

    await uploadMedia(req as Request, res as Response, next);

    expect(next).not.toHaveBeenCalled();
    expect(assetService.createFromUpload).toHaveBeenCalledWith({
      creatorId: userId,
      fileName: "clip.mp4",
      upload,
    });
    expect(res.status).toHaveBeenCalledWith(StatusCodes.CREATED);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({
          assetId,
          storageReferenceId: CID_V1,
          mediaCid: CID_V1,
          cid: CID_V1,
          cidVersion: 1,
        }),
      })
    );
  });

  it("forwards a 400 when no file is attached", async () => {
    req.file = undefined;

    await uploadMedia(req as Request, res as Response, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    expect(storageOrchestratorService.orchestrate).not.toHaveBeenCalled();
  });

  it("forwards provider errors to the error handler", async () => {
    const failure = new Error("pinata unavailable");
    (storageOrchestratorService.orchestrate as jest.Mock).mockRejectedValue(failure);

    await uploadMedia(req as Request, res as Response, next);

    expect(next).toHaveBeenCalledWith(failure);
    expect(assetService.createFromUpload).not.toHaveBeenCalled();
  });
});
