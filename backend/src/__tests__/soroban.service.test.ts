/**
 * SorobanService unit tests.
 *
 * The RPC transport is replaced by a stub `rpc.Server` injected through the
 * constructor; transactions, accounts and XDR results are real SDK objects.
 */
jest.mock('../config/env', () => ({
  __esModule: true,
  env: {
    NODE_ENV: 'test',
    STELLAR_RPC_URL: 'https://soroban-testnet.stellar.org',
    STELLAR_NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015',
    STELLAR_RPC_TIMEOUT_MS: 30000,
  },
}));

jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import {
  Account,
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  rpc,
  xdr,
} from '@stellar/stellar-sdk';
import { AppError } from '../errors/AppError';
import { SorobanService, defaultSorobanConfig, sorobanService } from '../services/soroban.service';

type RpcStub = {
  getAccount: jest.Mock;
  getEvents: jest.Mock;
  simulateTransaction: jest.Mock;
  sendTransaction: jest.Mock;
  getTransaction: jest.Mock;
};

const source = Keypair.random();
const TX_HASH = 'a'.repeat(64);

function buildStub(): RpcStub {
  return {
    getAccount: jest.fn(),
    getEvents: jest.fn(),
    simulateTransaction: jest.fn(),
    sendTransaction: jest.fn(),
    getTransaction: jest.fn(),
  };
}

function buildService(stub: RpcStub, timeoutMs = 1000) {
  return new SorobanService(
    { rpcUrl: 'https://rpc.example', networkPassphrase: Networks.TESTNET, timeoutMs, allowHttp: false },
    stub as unknown as rpc.Server
  );
}

function signedTransaction() {
  const tx = new TransactionBuilder(new Account(source.publicKey(), '1'), {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.bumpSequence({ bumpTo: '10' }))
    .setTimeout(30)
    .build();
  tx.sign(source);
  return tx;
}

async function expectAppError(promise: Promise<unknown>, statusCode: number, code: string) {
  const error = await promise.then(
    () => {
      throw new Error('expected rejection');
    },
    (err: unknown) => err
  );
  expect(error).toBeInstanceOf(AppError);
  expect(error).toMatchObject({ statusCode, code });
  return error as AppError;
}

let stub: RpcStub;
let service: SorobanService;

beforeEach(() => {
  stub = buildStub();
  service = buildService(stub);
});

describe('configuration', () => {
  it('reads RPC URL and passphrase from config/env', () => {
    expect(defaultSorobanConfig()).toEqual({
      rpcUrl: 'https://soroban-testnet.stellar.org',
      networkPassphrase: 'Test SDF Network ; September 2015',
      timeoutMs: 30000,
      allowHttp: false,
    });
    expect(sorobanService.networkPassphrase).toBe('Test SDF Network ; September 2015');
  });

  it('rejects a non-positive timeout at construction', () => {
    expect(
      () =>
        new SorobanService({
          rpcUrl: 'https://rpc.example',
          networkPassphrase: Networks.TESTNET,
          timeoutMs: 0,
          allowHttp: false,
        })
    ).toThrow(/STELLAR_RPC_TIMEOUT_MS/);
  });

  it('refuses plain-http RPC URLs unless explicitly allowed', () => {
    const config = { rpcUrl: 'http://localhost:8000/soroban/rpc', networkPassphrase: Networks.TESTNET, timeoutMs: 1000 };

    expect(() => new SorobanService({ ...config, allowHttp: false })).toThrow(/insecure/i);
    expect(() => new SorobanService({ ...config, allowHttp: true })).not.toThrow();
  });
});

describe('loadAccount', () => {
  it('returns the account with its sequence number', async () => {
    stub.getAccount.mockResolvedValue(new Account(source.publicKey(), '42'));

    const account = await service.loadAccount(source.publicKey());

    expect(stub.getAccount).toHaveBeenCalledWith(source.publicKey());
    expect(account.sequenceNumber()).toBe('42');
  });

  it('rejects malformed addresses without calling RPC', async () => {
    await expectAppError(service.loadAccount('GNOTANADDRESS'), 400, 'INVALID_STELLAR_ADDRESS');
    expect(stub.getAccount).not.toHaveBeenCalled();
  });

  it('maps the SDK "account not found" payload to 404', async () => {
    stub.getAccount.mockRejectedValue({ code: 404, message: `Account not found: ${source.publicKey()}` });

    await expectAppError(service.loadAccount(source.publicKey()), 404, 'STELLAR_ACCOUNT_NOT_FOUND');
  });
});

describe('getEvents', () => {
  it('passes the request through and returns the response', async () => {
    const response = { events: [], latestLedger: 1000, cursor: '' };
    stub.getEvents.mockResolvedValue(response);
    const request = { startLedger: 900, filters: [{ type: 'contract' as const, contractIds: [] }] };

    await expect(service.getEvents(request)).resolves.toBe(response);
    expect(stub.getEvents).toHaveBeenCalledWith(request);
  });

  it('maps JSON-RPC invalid params to 400', async () => {
    stub.getEvents.mockRejectedValue({ code: -32602, message: 'startLedger must be within the ledger range' });

    const error = await expectAppError(service.getEvents({ startLedger: 1, filters: [] }), 400, 'SOROBAN_INVALID_REQUEST');
    expect(error.message).toContain('startLedger must be within the ledger range');
  });

  it('maps other JSON-RPC errors to 502', async () => {
    stub.getEvents.mockRejectedValue({ code: -32603, message: 'internal error' });

    await expectAppError(service.getEvents({ startLedger: 1, filters: [] }), 502, 'SOROBAN_RPC_ERROR');
  });
});

describe('simulate', () => {
  it('returns successful simulations', async () => {
    const response = {
      id: '1',
      latestLedger: 100,
      events: [],
      _parsed: true,
      transactionData: {},
      minResourceFee: '100',
      cost: { cpuInsns: '0', memBytes: '0' },
    };
    stub.simulateTransaction.mockResolvedValue(response);
    const tx = signedTransaction();

    await expect(service.simulate(tx)).resolves.toBe(response);
    expect(stub.simulateTransaction).toHaveBeenCalledWith(tx);
  });

  it('raises simulation errors as 422', async () => {
    stub.simulateTransaction.mockResolvedValue({
      id: '1',
      latestLedger: 100,
      events: [],
      _parsed: true,
      error: 'HostError: Error(Contract, #3)',
    });

    const error = await expectAppError(service.simulate(signedTransaction()), 422, 'SOROBAN_SIMULATION_FAILED');
    expect(error.message).toContain('Error(Contract, #3)');
  });
});

describe('sendTransaction', () => {
  it.each(['PENDING', 'DUPLICATE'] as const)('returns %s submissions', async (status) => {
    const response = { status, hash: TX_HASH, latestLedger: 100, latestLedgerCloseTime: 0 };
    stub.sendTransaction.mockResolvedValue(response);

    await expect(service.sendTransaction(signedTransaction())).resolves.toBe(response);
  });

  it('maps TRY_AGAIN_LATER to 503', async () => {
    stub.sendTransaction.mockResolvedValue({ status: 'TRY_AGAIN_LATER', hash: TX_HASH, latestLedger: 100, latestLedgerCloseTime: 0 });

    await expectAppError(service.sendTransaction(signedTransaction()), 503, 'SOROBAN_TRY_AGAIN_LATER');
  });

  it('maps ERROR to 422 with the transaction result code', async () => {
    // TransactionResult { feeCharged: 100, result: txBadSeq, ext: v0 }
    const errorResult = xdr.TransactionResult.fromXDR('AAAAAAAAAGT////7AAAAAA==', 'base64');
    stub.sendTransaction.mockResolvedValue({
      status: 'ERROR',
      hash: TX_HASH,
      latestLedger: 100,
      latestLedgerCloseTime: 0,
      errorResult,
    });

    const error = await expectAppError(service.sendTransaction(signedTransaction()), 422, 'SOROBAN_TRANSACTION_REJECTED');
    expect(error.message).toContain('txBadSeq');
  });
});

describe('getTransaction', () => {
  it('returns NOT_FOUND as data rather than an error', async () => {
    const response = { status: 'NOT_FOUND', txHash: TX_HASH, latestLedger: 100 };
    stub.getTransaction.mockResolvedValue(response);

    await expect(service.getTransaction(TX_HASH.toUpperCase())).resolves.toBe(response);
    expect(stub.getTransaction).toHaveBeenCalledWith(TX_HASH);
  });

  it('rejects malformed hashes without calling RPC', async () => {
    await expectAppError(service.getTransaction('abc'), 400, 'INVALID_TRANSACTION_HASH');
    expect(stub.getTransaction).not.toHaveBeenCalled();
  });
});

describe('transport failures', () => {
  const axiosError = (fields: Record<string, unknown>) => ({ isAxiosError: true, message: 'request failed', ...fields });

  it('maps HTTP 429 to 429', async () => {
    stub.getTransaction.mockRejectedValue(axiosError({ response: { status: 429 } }));

    await expectAppError(service.getTransaction(TX_HASH), 429, 'SOROBAN_RPC_RATE_LIMITED');
  });

  it('maps HTTP 5xx to 502', async () => {
    stub.getTransaction.mockRejectedValue(axiosError({ response: { status: 503 } }));

    await expectAppError(service.getTransaction(TX_HASH), 502, 'SOROBAN_RPC_UNAVAILABLE');
  });

  it('maps connection failures to 503', async () => {
    stub.getTransaction.mockRejectedValue(axiosError({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' }));

    await expectAppError(service.getTransaction(TX_HASH), 503, 'SOROBAN_RPC_UNREACHABLE');
  });

  it('maps transport timeouts to 504', async () => {
    stub.getTransaction.mockRejectedValue(axiosError({ code: 'ECONNABORTED', message: 'timeout exceeded' }));

    await expectAppError(service.getTransaction(TX_HASH), 504, 'SOROBAN_RPC_TIMEOUT');
  });

  it('fails with 504 when the RPC does not answer within the configured timeout', async () => {
    const slowService = buildService(stub, 20);
    stub.getTransaction.mockReturnValue(new Promise(() => undefined));

    const error = await expectAppError(slowService.getTransaction(TX_HASH), 504, 'SOROBAN_RPC_TIMEOUT');
    expect(error.message).toContain('20ms');
  });

  it('maps unknown errors to 502', async () => {
    stub.getEvents.mockRejectedValue(new Error('unexpected XDR'));

    await expectAppError(service.getEvents({ startLedger: 1, filters: [] }), 502, 'SOROBAN_RPC_ERROR');
  });
});
