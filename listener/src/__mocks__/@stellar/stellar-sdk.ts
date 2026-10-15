/**
 * Jest stand-in for @stellar/stellar-sdk.
 *
 * The listener does not depend on the real package. This double only has to
 * preserve the dispatch contract production code uses: `switch()` returns the
 * same tag as `xdr.ScValType.scvX()`, and `scValToNative` yields a plain value.
 */

const SC_VAL_KINDS = [
  'scvBool',
  'scvVoid',
  'scvU32',
  'scvI32',
  'scvU64',
  'scvI64',
  'scvTimepoint',
  'scvString',
  'scvSymbol',
  'scvAddress',
  'scvMap',
] as const;

type ScValKind = (typeof SC_VAL_KINDS)[number];

class MockScVal {
  constructor(
    private readonly kind: ScValKind,
    private readonly value: unknown,
  ) {}

  switch(): ScValKind {
    return this.kind;
  }

  sym(): { toString(): string } {
    return { toString: () => String(this.value) };
  }

  str(): { toString(): string } {
    return { toString: () => String(this.value) };
  }

  address(): { toString(): string } {
    return { toString: () => String(this.value) };
  }

  u32(): number {
    return Number(this.value);
  }

  i32(): number {
    return Number(this.value);
  }

  u64(): unknown {
    return this.value;
  }

  i64(): unknown {
    return this.value;
  }

  b(): boolean {
    return Boolean(this.value);
  }

  toXDR(format?: string): string {
    const text = String(this.value ?? '');
    return format === 'base64' ? Buffer.from(text, 'utf8').toString('base64') : text;
  }

  toString(): string {
    return String(this.value ?? '');
  }
}

function scVal(kind: ScValKind, value: unknown = ''): MockScVal {
  return new MockScVal(kind, value);
}

export const ScValType = {
  scvBool: () => 'scvBool' as const,
  scvVoid: () => 'scvVoid' as const,
  scvU32: () => 'scvU32' as const,
  scvI32: () => 'scvI32' as const,
  scvU64: () => 'scvU64' as const,
  scvI64: () => 'scvI64' as const,
  scvTimepoint: () => 'scvTimepoint' as const,
  scvString: () => 'scvString' as const,
  scvSymbol: () => 'scvSymbol' as const,
  scvAddress: () => 'scvAddress' as const,
  scvMap: () => 'scvMap' as const,
};

export const ScVal = {
  scvBool: (value: boolean) => scVal('scvBool', value),
  scvVoid: () => scVal('scvVoid'),
  scvU32: (value: number) => scVal('scvU32', value),
  scvI32: (value: number) => scVal('scvI32', value),
  scvU64: (value: number | string | bigint) => scVal('scvU64', value),
  scvI64: (value: number | string | bigint) => scVal('scvI64', value),
  scvString: (value: string) => scVal('scvString', value),
  scvSymbol: (value: string) => scVal('scvSymbol', value),
  scvAddress: (value: string) => scVal('scvAddress', value),
  scvMap: (value: Record<string, unknown>) => scVal('scvMap', value),
};

export const xdr = {
  ScVal,
  ScValType,
};

function callOn(target: object, name: string): unknown {
  const accessor = (target as Record<string, unknown>)[name];
  if (typeof accessor !== 'function') return undefined;
  return (accessor as (this: object) => unknown).call(target);
}

function readText(target: object, name: string): string | null {
  const value = callOn(target, name);
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') {
    return String(value);
  }
  if (typeof (value as { toString?: () => string }).toString === 'function') {
    return (value as { toString: () => string }).toString();
  }
  return null;
}

export function scValToNative(val: unknown): unknown {
  if (val == null || typeof val !== 'object') return val ?? null;
  const target = val as { switch?: () => unknown; value?: unknown };
  if (typeof target.switch !== 'function') return val;

  const tag = target.switch();
  const name = typeof tag === 'string' ? tag : (tag as { name?: string } | undefined)?.name;

  switch (name) {
    case 'scvSymbol':
      return readText(val, 'sym');
    case 'scvString':
      return readText(val, 'str');
    case 'scvAddress':
      return readText(val, 'address');
    case 'scvU32':
      return Number(callOn(val, 'u32'));
    case 'scvI32':
      return Number(callOn(val, 'i32'));
    case 'scvU64':
      return callOn(val, 'u64');
    case 'scvI64':
      return callOn(val, 'i64');
    case 'scvBool':
      return callOn(val, 'b');
    case 'scvMap':
      return target.value && typeof target.value === 'object' ? target.value : val;
    case 'scvVoid':
      return null;
    default:
      return null;
  }
}

export const rpc = {
  Server: jest.fn().mockImplementation(() => ({
    getHealth: jest.fn().mockResolvedValue({ status: 'healthy' }),
    getEvents: jest.fn().mockResolvedValue({ events: [] }),
    getLatestLedger: jest.fn().mockResolvedValue({ sequence: 1 }),
  })),
};

export const Contract = jest.fn().mockImplementation(() => ({
  call: jest.fn(),
}));

export const Keypair = {
  random: jest.fn().mockReturnValue({
    publicKey: jest.fn().mockReturnValue('GABC1234'),
    secret: jest.fn().mockReturnValue('SECRET'),
  }),
};

export const Account = jest.fn().mockImplementation((publicKey: string, sequence: string) => ({
  publicKey: () => publicKey,
  sequence,
}));

export const Networks = {
  TESTNET: 'Test SDF Network ; September 2015',
  MAINNET: 'Public Global Stellar Network ; September 2015',
};

export const BASE_FEE = '100';

export const TransactionBuilder = jest.fn().mockImplementation(() => ({
  addOperation: jest.fn().mockReturnThis(),
  setTimeout: jest.fn().mockReturnThis(),
  build: jest.fn().mockReturnValue({ toXDR: jest.fn() }),
}));

export default {
  rpc,
  xdr,
  scValToNative,
  Contract,
  Keypair,
  Account,
  Networks,
  BASE_FEE,
  TransactionBuilder,
};
