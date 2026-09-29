import crypto from "crypto";
import mongoose from "mongoose";
import { Keypair } from "@stellar/stellar-sdk";
import { RegistryAdminService, type RegistryAdminStore } from "../services/registryAdmin.service";

describe("RegistryAdminService", () => {
  const adminUserId = new mongoose.Types.ObjectId().toString();
  const result = { transactionHash: crypto.randomBytes(32).toString("hex"), ledgerSequence: 42 };

  function harness() {
    const contract = {
      addTeeHash: jest.fn(async () => result),
      removeTeeHash: jest.fn(async () => result),
      addProvider: jest.fn(async () => result),
      removeProvider: jest.fn(async () => result),
    };
    const persisted = { _id: new mongoose.Types.ObjectId(), active: true, ...result };
    const store: RegistryAdminStore = {
      saveChange: jest.fn(async () => persisted),
      list: jest.fn(async () => [persisted]),
    };
    return { contract, store, service: new RegistryAdminService(() => contract, store) };
  }

  it("adds a normalized TEE hash and returns the persisted database record", async () => {
    const h = harness();
    const hash = crypto.randomBytes(32).toString("hex").toUpperCase();

    await expect(h.service.addTeeHash(hash, adminUserId)).resolves.toEqual(
      expect.objectContaining({ ledgerSequence: 42 })
    );
    expect(h.contract.addTeeHash).toHaveBeenCalledWith(hash.toLowerCase());
    expect(h.store.saveChange).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "tee_hash", value: hash.toLowerCase(), action: "add", result })
    );
  });

  it("removes a provider and records the deactivation", async () => {
    const h = harness();
    const provider = Keypair.random().publicKey();

    await h.service.removeProvider(provider, adminUserId);
    expect(h.contract.removeProvider).toHaveBeenCalledWith(provider);
    expect(h.store.saveChange).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "provider", value: provider, action: "remove" })
    );
  });

  it("lists active entries through the model store", async () => {
    const h = harness();
    await h.service.listTeeHashes();
    await h.service.listProviders();
    expect(h.store.list).toHaveBeenNthCalledWith(1, "tee_hash");
    expect(h.store.list).toHaveBeenNthCalledWith(2, "provider");
  });

  it("rejects invalid values before invoking the contract", async () => {
    const h = harness();
    expect(() => h.service.addTeeHash("bad", adminUserId)).toThrow(
      expect.objectContaining({ code: "INVALID_XDR_ARGUMENT" })
    );
    expect(() => h.service.addProvider("bad", adminUserId)).toThrow(
      expect.objectContaining({ code: "INVALID_PROVIDER" })
    );
    expect(h.contract.addTeeHash).not.toHaveBeenCalled();
    expect(h.contract.addProvider).not.toHaveBeenCalled();
  });
});
