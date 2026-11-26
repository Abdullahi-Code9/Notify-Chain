import { formatCrashDiagnostic } from './crash-diagnostics';
describe('safe crash diagnostics (#1262)', () => {
  const old = process.env.NODE_ENV;
  afterEach(() => { process.env.NODE_ENV = old; });
  it('redacts secrets and omits stacks in production', () => {
    process.env.NODE_ENV = 'production';
    const error = new Error('failed for nck_0123456789abcdef_' + 'a'.repeat(43));
    error.stack = `${error.message}\n at secret.internal.host`;
    const result = formatCrashDiagnostic(error);
    expect(JSON.stringify(result)).not.toContain('nck_');
    expect(JSON.stringify(result)).not.toContain('secret.internal.host');
    expect(result.stack).toBeUndefined();
  });
});
