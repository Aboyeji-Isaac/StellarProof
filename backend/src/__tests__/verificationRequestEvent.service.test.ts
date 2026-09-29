import mongoose from "mongoose";
import {
  LeaseLostError,
  verificationRequestEventService,
} from "../services/verificationRequestEvent.service";
import { VerificationRequestEventModel } from "../models/verificationRequestEvent.model";
import { VerificationRequestEventStatus } from "../types/verificationRequestEvent.types";

jest.mock("../models/verificationRequestEvent.model");

const Model = VerificationRequestEventModel as unknown as {
  findOneAndUpdate: jest.Mock;
  updateOne: jest.Mock;
};

const NOW = new Date("2026-01-01T00:00:00Z");
const EVENT_ID = new mongoose.Types.ObjectId().toHexString();

describe("verificationRequestEventService.claimNext", () => {
  beforeEach(() => jest.clearAllMocks());

  it("atomically claims a due pending event or an expired lease", async () => {
    const jobId = new mongoose.Types.ObjectId();
    Model.findOneAndUpdate.mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        _id: new mongoose.Types.ObjectId(EVENT_ID),
        eventId: "evt-1",
        verificationJobId: jobId,
        attempts: 1,
      }),
    });

    const event = await verificationRequestEventService.claimNext({
      workerId: "w1",
      leaseMs: 60_000,
      now: NOW,
    });

    const [filter, update, options] = Model.findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({
      $or: [
        { status: VerificationRequestEventStatus.PENDING, nextAttemptAt: { $lte: NOW } },
        { status: VerificationRequestEventStatus.PROCESSING, lockedUntil: { $lte: NOW } },
      ],
    });
    expect(update).toEqual({
      $set: {
        status: VerificationRequestEventStatus.PROCESSING,
        lockedBy: "w1",
        lockedUntil: new Date(NOW.getTime() + 60_000),
      },
      $inc: { attempts: 1 },
    });
    expect(options).toEqual({ sort: { nextAttemptAt: 1, createdAt: 1 }, new: true });
    expect(event).toMatchObject({ _id: EVENT_ID, verificationJobId: jobId.toHexString(), attempts: 1 });
  });

  it("returns null when nothing is due", async () => {
    Model.findOneAndUpdate.mockReturnValue({ lean: jest.fn().mockResolvedValue(null) });
    await expect(
      verificationRequestEventService.claimNext({ workerId: "w1", leaseMs: 1, now: NOW })
    ).resolves.toBeNull();
  });
});

describe("verificationRequestEventService lease-guarded writes", () => {
  beforeEach(() => jest.clearAllMocks());

  it("scopes every write to the lease holder", async () => {
    Model.updateOne.mockResolvedValue({ matchedCount: 1 });

    await verificationRequestEventService.markFailed(EVENT_ID, "w1", "boom");

    expect(Model.updateOne).toHaveBeenCalledWith(
      { _id: EVENT_ID, status: VerificationRequestEventStatus.PROCESSING, lockedBy: "w1" },
      {
        $set: { status: VerificationRequestEventStatus.FAILED, lastError: "boom" },
        $unset: { lockedBy: 1, lockedUntil: 1 },
      }
    );
  });

  it("throws LeaseLostError when another worker owns the event", async () => {
    Model.updateOne.mockResolvedValue({ matchedCount: 0 });

    await expect(
      verificationRequestEventService.scheduleRetry(EVENT_ID, "w1", NOW, "later")
    ).rejects.toThrow(LeaseLostError);
  });

  it("attaches a job only once", async () => {
    Model.updateOne.mockResolvedValue({ matchedCount: 1 });
    const jobId = new mongoose.Types.ObjectId().toHexString();

    await verificationRequestEventService.attachJob(EVENT_ID, "w1", jobId);

    const [filter, update] = Model.updateOne.mock.calls[0];
    expect(filter.verificationJobId).toEqual({ $exists: false });
    expect(String(update.$set.verificationJobId)).toBe(jobId);
  });

  it("clears the in-flight transaction hash when given null", async () => {
    Model.updateOne.mockResolvedValue({ matchedCount: 1 });

    await verificationRequestEventService.recordTransaction(EVENT_ID, "w1", null);

    expect(Model.updateOne.mock.calls[0][1]).toEqual({ $unset: { transactionHash: 1 } });
  });

  it("releases the lease and records the outcome on completion", async () => {
    Model.updateOne.mockResolvedValue({ matchedCount: 1 });

    await verificationRequestEventService.markCompleted(EVENT_ID, "w1", {
      transactionHash: "a".repeat(64),
      certificateId: "5",
    });

    const update = Model.updateOne.mock.calls[0][1];
    expect(update.$set).toMatchObject({
      status: VerificationRequestEventStatus.COMPLETED,
      transactionHash: "a".repeat(64),
      certificateId: "5",
    });
    expect(update.$unset).toEqual({ lockedBy: 1, lockedUntil: 1, lastError: 1 });
  });
});
