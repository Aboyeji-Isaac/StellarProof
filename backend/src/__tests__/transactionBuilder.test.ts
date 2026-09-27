import crypto from "crypto";
import {
  Account,
  Address,
  BASE_FEE,
  Keypair,
  Networks,
  SorobanDataBuilder,
  StrKey,
  Transaction,
  TransactionBuilder,
  hash as sha256Hash,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import {
  TX_TIMEOUT_SECONDS,
  buildContractCallTransaction,
  buildSignedContractTransaction,
  type SorobanTransactionSource,
} from "../utils/transactionBuilder";
import { XdrValidationError, buildMintArgs } from "../utils/xdr";
import { TransactionSimulationError } from "../errors/SorobanTransactionError";

const NETWORK = Networks.TESTNET;
const sha256 = (input: string): string =>
  crypto.createHash("sha256").update(input).digest("hex");

function contractId(): string {
  return StrKey.encodeContract(crypto.randomBytes(32));
}

function mintCall(target: string, to: string) {
  return {
    contractId: target,
    method: "mint",
    args: buildMintArgs({
      to,
      mediaCid: "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
      manifestHash: sha256("manifest"),
      attestationHash: sha256("attestation"),
    }),
  };
}

function invokeArgs(tx: Transaction): xdr.InvokeContractArgs {
  const op = tx.operations[0];
  if (op.type !== "invokeHostFunction") throw new Error("unexpected operation");
  return op.func.invokeContract();
}

const RESOURCE_FEE = 12345;

function simulationSuccess(): rpc.Api.SimulateTransactionSuccessResponse {
  return {
    _parsed: true,
    id: "1",
    latestLedger: 1,
    events: [],
    transactionData: new SorobanDataBuilder(),
    minResourceFee: String(RESOURCE_FEE),
    result: { auth: [], retval: xdr.ScVal.scvU64(new xdr.Uint64(BigInt(1))) },
  };
}

/** RPC stand-in: returns a fixed account and a successful simulation. */
function rpcFor(keypair: Keypair, sequence = "100"): jest.Mocked<SorobanTransactionSource> {
  return {
    getAccount: jest.fn().mockResolvedValue(new Account(keypair.publicKey(), sequence)),
    simulateTransaction: jest.fn().mockResolvedValue(simulationSuccess()),
  };
}

describe("buildContractCallTransaction", () => {
  const signer = Keypair.random();
  const target = contractId();

  it("uses BASE_FEE and a single contract invocation", () => {
    const tx = buildContractCallTransaction(
      new Account(signer.publicKey(), "7"),
      mintCall(target, signer.publicKey()),
      NETWORK
    );

    expect(tx.fee).toBe(BASE_FEE);
    expect(tx.operations).toHaveLength(1);
    expect(tx.source).toBe(signer.publicKey());
    expect(tx.sequence).toBe("8");
    expect(tx.networkPassphrase).toBe(NETWORK);
  });

  it(`enforces a ${TX_TIMEOUT_SECONDS}-second timeout`, () => {
    const before = Math.floor(Date.now() / 1000);
    const tx = buildContractCallTransaction(
      new Account(signer.publicKey(), "1"),
      mintCall(target, signer.publicKey()),
      NETWORK
    );
    const after = Math.floor(Date.now() / 1000);

    const maxTime = Number(tx.timeBounds?.maxTime);
    expect(TX_TIMEOUT_SECONDS).toBe(30);
    expect(maxTime).toBeGreaterThanOrEqual(before + TX_TIMEOUT_SECONDS);
    expect(maxTime).toBeLessThanOrEqual(after + TX_TIMEOUT_SECONDS);
  });

  it("serializes the contract address, function, and XDR-utility arguments in order", () => {
    const to = Keypair.random().publicKey();
    const tx = buildContractCallTransaction(
      new Account(signer.publicKey(), "1"),
      mintCall(target, to),
      NETWORK
    );

    const invoke = invokeArgs(tx);
    expect(Address.fromScAddress(invoke.contractAddress()).toString()).toBe(target);
    expect(invoke.functionName().toString()).toBe("mint");
    const [toArg, detailsArg] = invoke.args();
    expect(Address.fromScVal(toArg).toString()).toBe(to);
    expect(scValToNative(detailsArg)).toEqual({
      attestation_hash: sha256("attestation"),
      manifest_hash: sha256("manifest"),
      storage_id: "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
    });
  });

  it("rejects an invalid contract address", () => {
    expect(() =>
      buildContractCallTransaction(
        new Account(signer.publicKey(), "1"),
        { ...mintCall(target, signer.publicKey()), contractId: signer.publicKey() },
        NETWORK
      )
    ).toThrow(XdrValidationError);
  });

  it("rejects an empty method name", () => {
    expect(() =>
      buildContractCallTransaction(
        new Account(signer.publicKey(), "1"),
        { ...mintCall(target, signer.publicKey()), method: "" },
        NETWORK
      )
    ).toThrow(XdrValidationError);
  });
});

describe("buildSignedContractTransaction", () => {
  it("loads the signer's account and simulates the unsigned invocation", async () => {
    const keypair = Keypair.random();
    const client = rpcFor(keypair);
    let signaturesAtSimulation = -1;
    client.simulateTransaction.mockImplementation(async (tx: Transaction) => {
      signaturesAtSimulation = tx.signatures.length;
      return simulationSuccess();
    });

    await buildSignedContractTransaction({
      client,
      keypair,
      networkPassphrase: NETWORK,
      call: mintCall(contractId(), keypair.publicKey()),
    });

    expect(client.getAccount).toHaveBeenCalledWith(keypair.publicKey());
    expect(client.simulateTransaction).toHaveBeenCalledTimes(1);
    expect(signaturesAtSimulation).toBe(0);
  });

  it("signs with the supplied keypair", async () => {
    const keypair = Keypair.random();
    const { transaction } = await buildSignedContractTransaction({
      client: rpcFor(keypair),
      keypair,
      networkPassphrase: NETWORK,
      call: mintCall(contractId(), keypair.publicKey()),
    });

    expect(transaction.signatures).toHaveLength(1);
    const signature = transaction.signatures[0].signature();
    expect(keypair.verify(transaction.hash(), signature)).toBe(true);
    expect(Keypair.random().verify(transaction.hash(), signature)).toBe(false);
  });

  it("returns the network-scoped hash and a round-trippable signed XDR", async () => {
    const keypair = Keypair.random();
    const result = await buildSignedContractTransaction({
      client: rpcFor(keypair),
      keypair,
      networkPassphrase: NETWORK,
      call: mintCall(contractId(), keypair.publicKey()),
    });

    expect(result.hash).toMatch(/^[0-9a-f]{64}$/);
    const expectedHash = sha256Hash(result.transaction.signatureBase()).toString("hex");
    expect(result.hash).toBe(expectedHash);

    const decoded = TransactionBuilder.fromXDR(result.xdr, NETWORK) as Transaction;
    expect(decoded.hash().toString("hex")).toBe(result.hash);
    expect(decoded.signatures).toHaveLength(1);
    expect(decoded.fee).toBe(result.transaction.fee);
  });

  it("adds the simulated resource fee on top of BASE_FEE and keeps the timeout", async () => {
    const keypair = Keypair.random();
    const before = Math.floor(Date.now() / 1000);
    const result = await buildSignedContractTransaction({
      client: rpcFor(keypair),
      keypair,
      networkPassphrase: NETWORK,
      call: mintCall(contractId(), keypair.publicKey()),
    });

    expect(Number(result.transaction.fee)).toBe(Number(BASE_FEE) + RESOURCE_FEE);
    expect(Number(result.transaction.timeBounds?.maxTime)).toBeGreaterThanOrEqual(
      before + TX_TIMEOUT_SECONDS
    );
    expect(result.transaction.signatures).toHaveLength(1);
  });

  it("raises a non-retryable TransactionSimulationError when simulation fails", async () => {
    const keypair = Keypair.random();
    const client = rpcFor(keypair);
    client.simulateTransaction.mockResolvedValue({
      _parsed: true,
      id: "1",
      latestLedger: 1,
      events: [],
      error: "HostError: Certificate already exists for this manifest hash",
    });

    const err = await buildSignedContractTransaction({
      client,
      keypair,
      networkPassphrase: NETWORK,
      call: mintCall(contractId(), keypair.publicKey()),
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TransactionSimulationError);
    expect((err as TransactionSimulationError).retryable).toBe(false);
    expect((err as Error).message).toContain("Certificate already exists");
  });

  it("propagates RPC failures without signing", async () => {
    const keypair = Keypair.random();
    const client = rpcFor(keypair);
    client.simulateTransaction.mockRejectedValue(new Error("connect ECONNREFUSED"));

    await expect(
      buildSignedContractTransaction({
        client,
        keypair,
        networkPassphrase: NETWORK,
        call: mintCall(contractId(), keypair.publicKey()),
      })
    ).rejects.toThrow("ECONNREFUSED");
  });
});
