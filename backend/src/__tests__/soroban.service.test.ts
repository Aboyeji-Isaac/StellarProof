import crypto from "crypto";
import {
  Account,
  Keypair,
  Networks,
  SorobanDataBuilder,
  StrKey,
  Transaction,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";

jest.mock("../config/env", () => ({
  env: {
    STELLAR_RPC_URL: "https://rpc.invalid",
    STELLAR_NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
    STELLAR_TX_POLL_INTERVAL_MS: 1_000,
    STELLAR_TX_CONFIRMATION_TIMEOUT_MS: 60_000,
    STELLAR_TX_MAX_CONSECUTIVE_RPC_ERRORS: 3,
  },
}));
jest.mock("../utils/logger", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
  SorobanService,
  extractFailureDiagnostics,
  type Clock,
  type SorobanRpcClient,
} from "../services/soroban.service";
import {
  SorobanRpcError,
  TransactionConfirmationTimeoutError,
  TransactionFailedError,
  TransactionSimulationError,
  TransactionSubmissionError,
} from "../errors/SorobanTransactionError";
import type { SignedContractTransaction } from "../utils/transactionBuilder";

const { GetTransactionStatus } = rpc.Api;
const TX_HASH = crypto.randomBytes(32).toString("hex");
const DEFAULTS = { pollIntervalMs: 1_000, timeoutMs: 60_000, maxConsecutiveRpcErrors: 3 };

/** Virtual clock: sleeping advances time instantly. */
function virtualClock(): Clock & { sleeps: number[] } {
  let now = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    },
  };
}

function rpcClient(): jest.Mocked<SorobanRpcClient> {
  return {
    getAccount: jest.fn(),
    simulateTransaction: jest.fn(),
    getTransaction: jest.fn(),
    sendTransaction: jest.fn(),
  };
}

const ledgerInfo = {
  txHash: TX_HASH,
  latestLedger: 100,
  latestLedgerCloseTime: 0,
  oldestLedger: 1,
  oldestLedgerCloseTime: 0,
};

function notFound(): rpc.Api.GetTransactionResponse {
  return { ...ledgerInfo, status: GetTransactionStatus.NOT_FOUND };
}

function txResult(result: xdr.TransactionResultResult): xdr.TransactionResult {
  return new xdr.TransactionResult({
    feeCharged: xdr.Int64.fromString("100"),
    result,
    ext: xdr.TransactionResultExt.fromXDR(Buffer.alloc(4)),
  });
}

const trappedResult = () =>
  txResult(
    xdr.TransactionResultResult.txFailed([
      xdr.OperationResult.opInner(
        xdr.OperationResultTr.invokeHostFunction(
          xdr.InvokeHostFunctionResult.invokeHostFunctionTrapped()
        )
      ),
    ])
  );

/** A host `diagnostic` event with topic `error` and data "boom". */
const DIAGNOSTIC_EVENT_XDR =
  "AAAAAAAAAAAAAAAAAAAAAgAAAAAAAAABAAAADwAAAAVlcnJvcgAAAAAAAA4AAAAEYm9vbQ==";

function settled() {
  return {
    ...ledgerInfo,
    ledger: 42,
    createdAt: 1_700_000_000,
    applicationOrder: 1,
    feeBump: false,
    envelopeXdr: {} as xdr.TransactionEnvelope,
    resultMetaXdr: {} as xdr.TransactionMeta,
  };
}

function success(returnValue?: xdr.ScVal): rpc.Api.GetTransactionResponse {
  return {
    ...settled(),
    status: GetTransactionStatus.SUCCESS,
    resultXdr: txResult(xdr.TransactionResultResult.txSuccess([])),
    returnValue,
  };
}

function failed(): rpc.Api.GetTransactionResponse {
  return {
    ...settled(),
    status: GetTransactionStatus.FAILED,
    resultXdr: trappedResult(),
    diagnosticEventsXdr: [xdr.DiagnosticEvent.fromXDR(DIAGNOSTIC_EVENT_XDR, "base64")],
  };
}

function service(client: SorobanRpcClient, clock: Clock) {
  return new SorobanService(client, Networks.TESTNET, DEFAULTS, clock);
}

describe("SorobanService.getTransactionStatus", () => {
  it("maps NOT_FOUND to PENDING", async () => {
    const client = rpcClient();
    client.getTransaction.mockResolvedValue(notFound());

    await expect(service(client, virtualClock()).getTransactionStatus(TX_HASH)).resolves.toEqual({
      status: "PENDING",
      txHash: TX_HASH,
      latestLedger: 100,
    });
  });

  it("rejects malformed hashes without calling the RPC", async () => {
    const client = rpcClient();
    await expect(
      service(client, virtualClock()).getTransactionStatus("not-a-hash")
    ).rejects.toMatchObject({ code: "INVALID_TX_HASH" });
    expect(client.getTransaction).not.toHaveBeenCalled();
  });

  it("wraps transport errors as retryable SorobanRpcError", async () => {
    const client = rpcClient();
    client.getTransaction.mockRejectedValue(new Error("ECONNRESET"));

    const err = await service(client, virtualClock())
      .getTransactionStatus(TX_HASH)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SorobanRpcError);
    expect((err as SorobanRpcError).retryable).toBe(true);
  });

  it("never reports an unrecognised status as success", async () => {
    const client = rpcClient();
    client.getTransaction.mockResolvedValue({
      ...ledgerInfo,
      status: "UNKNOWN",
    } as unknown as rpc.Api.GetTransactionResponse);

    await expect(service(client, virtualClock()).getTransactionStatus(TX_HASH)).rejects.toThrow(
      SorobanRpcError
    );
  });
});

describe("SorobanService.getTransactionWithConfirmation", () => {
  it("keeps polling while NOT_FOUND and resolves on SUCCESS", async () => {
    const client = rpcClient();
    const returnValue = xdr.ScVal.scvU64(new xdr.Uint64(BigInt(7)));
    client.getTransaction
      .mockResolvedValueOnce(notFound())
      .mockResolvedValueOnce(notFound())
      .mockResolvedValueOnce(success(returnValue));
    const clock = virtualClock();

    const result = await service(client, clock).getTransactionWithConfirmation(TX_HASH);

    expect(result).toMatchObject({ status: "SUCCESS", txHash: TX_HASH, ledger: 42 });
    expect(result.returnValue).toBe(returnValue);
    expect(client.getTransaction).toHaveBeenCalledTimes(3);
    expect(clock.sleeps).toEqual([1_000, 1_000]);
  });

  it("moves from pending to failure and surfaces tx_failed diagnostics", async () => {
    const client = rpcClient();
    client.getTransaction.mockResolvedValueOnce(notFound()).mockResolvedValueOnce(failed());

    const err = await service(client, virtualClock())
      .getTransactionWithConfirmation(TX_HASH)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TransactionFailedError);
    const failure = err as TransactionFailedError;
    expect(failure.retryable).toBe(false);
    expect(failure.code).toBe("TX_FAILED");
    expect(failure.message).toContain("tx_failed");
    expect(failure.diagnostics).toMatchObject({
      txHash: TX_HASH,
      resultCode: "tx_failed",
      operationResultCodes: ["invoke_host_function_trapped"],
      ledger: 42,
    });
    expect(failure.diagnostics.diagnosticEventsXdr).toEqual([DIAGNOSTIC_EVENT_XDR]);
  });

  it("times out as an expired transaction when every poll is NOT_FOUND", async () => {
    const client = rpcClient();
    client.getTransaction.mockResolvedValue(notFound());
    const clock = virtualClock();

    const err = await service(client, clock)
      .getTransactionWithConfirmation(TX_HASH, { timeoutMs: 45_000, pollIntervalMs: 10_000 })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TransactionConfirmationTimeoutError);
    const timeout = err as TransactionConfirmationTimeoutError;
    expect(timeout.outcomeUnknown).toBe(false);
    expect(timeout.retryable).toBe(false);
    // Polls at t=0,10,20,30,40,45s then stops; the final sleep is clamped to the deadline.
    expect(client.getTransaction).toHaveBeenCalledTimes(6);
    expect(clock.sleeps).toEqual([10_000, 10_000, 10_000, 10_000, 5_000]);
  });

  it("marks the timeout outcome unknown when the window is shorter than tx validity", async () => {
    const client = rpcClient();
    client.getTransaction.mockResolvedValue(notFound());

    const err = await service(client, virtualClock())
      .getTransactionWithConfirmation(TX_HASH, { timeoutMs: 5_000 })
      .catch((e: unknown) => e);

    expect((err as TransactionConfirmationTimeoutError).outcomeUnknown).toBe(true);
  });

  it("tolerates transient RPC errors and still confirms", async () => {
    const client = rpcClient();
    client.getTransaction
      .mockRejectedValueOnce(new Error("503 Service Unavailable"))
      .mockResolvedValueOnce(notFound())
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValueOnce(success());

    await expect(
      service(client, virtualClock()).getTransactionWithConfirmation(TX_HASH)
    ).resolves.toMatchObject({ status: "SUCCESS" });
  });

  it("aborts after the configured number of consecutive RPC errors", async () => {
    const client = rpcClient();
    client.getTransaction.mockRejectedValue(new Error("ECONNREFUSED"));

    await expect(
      service(client, virtualClock()).getTransactionWithConfirmation(TX_HASH)
    ).rejects.toThrow(SorobanRpcError);
    expect(client.getTransaction).toHaveBeenCalledTimes(DEFAULTS.maxConsecutiveRpcErrors);
  });

  it("flags a timeout after RPC errors as retryable (outcome unknown)", async () => {
    const client = rpcClient();
    client.getTransaction
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValue(notFound());

    const err = await service(client, virtualClock())
      .getTransactionWithConfirmation(TX_HASH, { timeoutMs: 40_000, pollIntervalMs: 10_000 })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TransactionConfirmationTimeoutError);
    expect((err as TransactionConfirmationTimeoutError).retryable).toBe(true);
  });
});

describe("SorobanService.submitTransaction", () => {
  function signed(): SignedContractTransaction {
    return { hash: TX_HASH, xdr: "AAAA", transaction: {} as Transaction };
  }

  it.each(["PENDING", "DUPLICATE"] as const)("accepts %s", async (status) => {
    const client = rpcClient();
    client.sendTransaction.mockResolvedValue({
      status,
      hash: TX_HASH,
      latestLedger: 1,
      latestLedgerCloseTime: 0,
    });
    await expect(service(client, virtualClock()).submitTransaction(signed())).resolves.toBeUndefined();
  });

  it("raises a retryable error on TRY_AGAIN_LATER", async () => {
    const client = rpcClient();
    client.sendTransaction.mockResolvedValue({
      status: "TRY_AGAIN_LATER",
      hash: TX_HASH,
      latestLedger: 1,
      latestLedgerCloseTime: 0,
    });
    const err = await service(client, virtualClock())
      .submitTransaction(signed())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransactionSubmissionError);
    expect((err as TransactionSubmissionError).retryable).toBe(true);
  });

  it("surfaces rejection diagnostics on ERROR", async () => {
    const client = rpcClient();
    client.sendTransaction.mockResolvedValue({
      status: "ERROR",
      hash: TX_HASH,
      latestLedger: 1,
      latestLedgerCloseTime: 0,
      errorResult: txResult(xdr.TransactionResultResult.txBadSeq()),
    });
    const err = await service(client, virtualClock())
      .submitTransaction(signed())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransactionFailedError);
    expect((err as TransactionFailedError).diagnostics.resultCode).toBe("tx_bad_seq");
    // A stale sequence number is fixed by rebuilding the transaction.
    expect((err as TransactionFailedError).retryable).toBe(true);
  });
});

describe("SorobanService.buildMintTransaction", () => {
  it("builds a signed mint invocation through the transaction builder", async () => {
    const keypair = Keypair.random();
    const client = rpcClient();
    client.getAccount.mockResolvedValue(new Account(keypair.publicKey(), "1"));
    client.simulateTransaction.mockResolvedValue({
      _parsed: true,
      id: "1",
      latestLedger: 1,
      events: [],
      transactionData: new SorobanDataBuilder(),
      minResourceFee: "100",
      result: { auth: [], retval: xdr.ScVal.scvU64(new xdr.Uint64(BigInt(1))) },
    });

    const result = await service(client, virtualClock()).buildMintTransaction(
      keypair,
      StrKey.encodeContract(crypto.randomBytes(32)),
      {
        to: Keypair.random().publicKey(),
        mediaCid: "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
        manifestHash: crypto.randomBytes(32).toString("hex"),
        attestationHash: crypto.randomBytes(32).toString("hex"),
      }
    );

    expect(result.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.transaction.signatures).toHaveLength(1);
  });

  it("keeps contract simulation failures non-retryable", async () => {
    const keypair = Keypair.random();
    const client = rpcClient();
    client.getAccount.mockResolvedValue(new Account(keypair.publicKey(), "1"));
    client.simulateTransaction.mockResolvedValue({
      _parsed: true,
      id: "1",
      latestLedger: 1,
      events: [],
      error: "HostError: Certificate already exists for this manifest hash",
    });

    const err = await service(client, virtualClock())
      .buildMintTransaction(keypair, StrKey.encodeContract(crypto.randomBytes(32)), {
        to: keypair.publicKey(),
        mediaCid: "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
        manifestHash: crypto.randomBytes(32).toString("hex"),
        attestationHash: crypto.randomBytes(32).toString("hex"),
      })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TransactionSimulationError);
    expect((err as TransactionSimulationError).retryable).toBe(false);
  });

  it("wraps RPC transport failures as retryable RPC errors", async () => {
    const keypair = Keypair.random();
    const client = rpcClient();
    client.getAccount.mockRejectedValue(new Error("account not found"));

    await expect(
      service(client, virtualClock()).buildMintTransaction(
        keypair,
        StrKey.encodeContract(crypto.randomBytes(32)),
        {
          to: keypair.publicKey(),
          mediaCid: "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
          manifestHash: crypto.randomBytes(32).toString("hex"),
          attestationHash: crypto.randomBytes(32).toString("hex"),
        }
      )
    ).rejects.toThrow(SorobanRpcError);
  });
});

describe("extractFailureDiagnostics", () => {
  it("returns an unknown code when no result is available", () => {
    expect(extractFailureDiagnostics(TX_HASH, undefined, undefined)).toEqual({
      txHash: TX_HASH,
      resultCode: "unknown",
      operationResultCodes: [],
      diagnosticEventsXdr: [],
    });
  });
});
