/**
 * Filesystem path containment for export/archive operations (#1209).
 *
 * User-influenced paths are resolved against an approved root. Absolute paths,
 * traversal, encoded separators and symlinked ancestors are rejected so a file
 * operation cannot escape the storage directory.
 */

import * as fs from 'fs';
import * as path from 'path';

export class UnsafePathError extends Error {
  readonly name = 'UnsafePathError';
  constructor(reason: string) {
    super(`Invalid export path: ${reason}`);
    Object.setPrototypeOf(this, UnsafePathError.prototype);
  }
}

/** True when the input attempts encoding tricks commonly used for traversal. */
function hasEncodedTraversal(input: string): boolean {
  // Reject percent encoding entirely: legitimate export filenames do not need
  // it, and accepting any encoding reintroduces ambiguous %2e/%2f/%5c paths.
  return /%[0-9a-f]{2}/i.test(input);
}

/**
 * Resolves `userPath` inside `root`, rejecting anything that escapes it.
 *
 * The root itself must be absolute. Symlinks are checked on every existing
 * path component, including the root, so a symlinked directory cannot be used
 * to redirect the write outside the approved tree.
 */
export function resolveSafePath(userPath: string, root: string): string {
  if (typeof userPath !== 'string' || userPath.length === 0) {
    throw new UnsafePathError('path must be a non-empty string');
  }
  if (userPath.includes('\0')) throw new UnsafePathError('NUL byte in path');
  if (hasEncodedTraversal(userPath)) {
    throw new UnsafePathError('percent-encoded path segments are not allowed');
  }
  if (path.isAbsolute(userPath) || /^[a-zA-Z]:[\\/]/.test(userPath)) {
    throw new UnsafePathError('absolute paths are not allowed');
  }
  if (userPath.includes('\\')) {
    throw new UnsafePathError('backslash separators are not allowed');
  }

  const rootPath = path.resolve(root);
  const resolved = path.resolve(rootPath, userPath);
  const relative = path.relative(rootPath, resolved);
  if (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) {
    throw new UnsafePathError('path escapes the approved directory');
  }

  assertNoSymlink(rootPath);
  let current = rootPath;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    assertNoSymlink(current);
  }

  return resolved;
}

function assertNoSymlink(target: string): void {
  try {
    if (fs.lstatSync(target).isSymbolicLink()) {
      throw new UnsafePathError('symbolic links are not allowed in export paths');
    }
  } catch (error) {
    if (error instanceof UnsafePathError) throw error;
    // Missing path components will be created by the caller; nothing to check.
  }
}
