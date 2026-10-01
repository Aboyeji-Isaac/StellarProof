/**
 * Integration test — GET /api/v1/certificates/verify/:certificateId
 *
 * Mounts the real certificate router through Express and drives it with
 * supertest. The service is spied on so the HTTP contract (path parameter
 * validation, controller envelope, error propagation) is exercised without
 * touching Stellar or MongoDB.
 */
import request from "supertest";
import express, { type Application, type NextFunction, type Request, type Response } from "express";
import certificateRoutes from "../routes/certificate.routes";
import { AppError } from "../errors/AppError";
import { certificateService } from "../services/certificate.service";

/** Minimal stand-in for the global AppError-aware handler. */
function testErrorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      success: false,
      error: err.message,
      ...(err.code ? { code: err.code } : {}),
    });
    return;
  }
  res.status(500).json({ success: false, error: String(err) });
}

function buildTestApp(): Application {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/certificates", certificateRoutes);
  app.use(testErrorHandler);
  return app;
}

describe("GET /api/v1/certificates/verify/:certificateId", () => {
  const app = buildTestApp();

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("returns the { valid, details } verification envelope", async () => {
    const result = {
      valid: true,
      details: {
        certificateId: "41",
        network: "testnet",
        contractAddress: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
        offChain: { certificateId: "41" },
        onChain: { certificateId: "41" },
        checks: {
          storageId: true,
          manifestHash: true,
          attestationHash: true,
          creator: true,
          timestamp: true,
        },
        mismatches: [],
      },
    };
    const spy = jest
      .spyOn(certificateService, "verifyCertificate")
      .mockResolvedValue(result as never);

    const res = await request(app).get("/api/v1/certificates/verify/41");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: result });
    expect(spy).toHaveBeenCalledWith("41");
  });

  it("propagates a 404 from the service", async () => {
    jest
      .spyOn(certificateService, "verifyCertificate")
      .mockRejectedValue(
        new AppError("Certificate not found", 404, "CERTIFICATE_NOT_FOUND")
      );

    const res = await request(app).get("/api/v1/certificates/verify/999");

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("CERTIFICATE_NOT_FOUND");
  });

  it("rejects a whitespace-only certificate id with 400", async () => {
    const res = await request(app).get("/api/v1/certificates/verify/%20");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid path parameters");
  });
});
