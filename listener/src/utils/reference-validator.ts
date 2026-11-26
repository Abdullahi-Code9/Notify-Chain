/** Validation for externally supplied content references (#1259). */
export const MAX_REFERENCE_LENGTH = 256;
const IPFS_CID_V0 = /^Qm[1-9A-HJ-NP-Za-km-z]{44}(\/[A-Za-z0-9._-]+)*$/;
const IPFS_CID_V1 = /^b[a-z2-7]{50,60}(\/[A-Za-z0-9._-]+)*$/;
const ARWEAVE_ID = /^[A-Za-z0-9_-]{43}$|^[0-9a-fA-F]{64}$/;
const ARWEAVE_HTTPS = /^https:\/\/arweave\.net\/([A-Za-z0-9_-]{43}|[0-9a-fA-F]{64})$/;

export class ReferenceValidationError extends Error {
  constructor(label: string) {
    super(`${label} must be a valid ipfs:// or ar:// reference`);
    this.name = 'ReferenceValidationError';
  }
}

/** Validate without resolving, fetching or normalising the reference. */
export function validateExternalReference(value: unknown, label = 'reference'): void {
  if (typeof value !== 'string' || !value || value.length > MAX_REFERENCE_LENGTH) {
    throw new ReferenceValidationError(label);
  }
  if (/[\s?@#]|^\/\//.test(value) || value.includes('..')) {
    throw new ReferenceValidationError(label);
  }
  if (value.startsWith('ipfs://')) {
    const cid = value.slice(7);
    if (IPFS_CID_V0.test(cid) || IPFS_CID_V1.test(cid)) return;
  } else if (value.startsWith('ar://')) {
    if (ARWEAVE_ID.test(value.slice(5))) return;
  } else if (ARWEAVE_HTTPS.test(value)) {
    return;
  }
  throw new ReferenceValidationError(label);
}
