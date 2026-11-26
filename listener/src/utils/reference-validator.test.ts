import { validateExternalReference } from './reference-validator';
import { validateNotificationMetadata } from './metadata-validator';
const CID = 'QmYwAPJzv5CZsnAzt8auVZRnLXQ2rJxfp6tS6eQ9K5mXpZ';
const AR = 'a'.repeat(43);
describe('external reference validation (#1259)', () => {
  it.each([`ipfs://${CID}`, `ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi`, `ipfs://${CID}/file.json`, `ar://${AR}`, `https://arweave.net/${AR}`])('accepts %s', (r) => {
    expect(() => validateExternalReference(r)).not.toThrow();
  });
  it.each(['http://example.com/x', 'https://internal.local/admin', 'file:///etc/passwd', 'ipfs://abc', `ipfs://${CID}/../../etc/passwd`, `ar://${AR}?url=http://169.254.169.254`, '', 'javascript:alert(1)'])('rejects %s', (r) => {
    expect(() => validateExternalReference(r)).toThrow(/valid ipfs:\/\/ or ar:\/\//);
  });
  it('does not echo untrusted references in errors', () => {
    try { validateNotificationMetadata({ source: 'test', dataUri: 'https://secret.internal/path?token=abc' }); throw new Error('expected failure'); }
    catch (e) { expect((e as Error).message).not.toContain('secret.internal'); expect((e as Error).message).not.toContain('abc'); }
  });
  it('validates dataUri through metadata', () => {
    expect(() => validateNotificationMetadata({ source: 'test', dataUri: `ipfs://${CID}` })).not.toThrow();
    expect(() => validateNotificationMetadata({ source: 'test', dataUri: 'http://evil.example' })).toThrow(/IPFS or Arweave/);
  });
});
