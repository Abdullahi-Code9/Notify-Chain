import * as fs from 'fs';
import * as path from 'path';

/**
 * Read the application version from the nearest `package.json`.
 *
 * The result is the `version` field from `package.json` (e.g. `"1.0.0"`).
 * This is the canonical version source for the NotifyChain listener service.
 *
 * **Version source**: `listener/package.json`.  During a release the
 * `version` field in that file is bumped (e.g. via `npm version`), which
 * automatically keeps this value in sync with the running binary.
 *
 * The function walks up the directory tree from `__dirname` until it finds a
 * `package.json` that contains a `version` string, so it works correctly
 * whether the code runs from `src/` (ts-node / development) or `dist/`
 * (compiled / production).
 *
 * If the file cannot be found or parsed, `"unknown"` is returned so the
 * health endpoint always responds rather than crashing.
 */
export function getAppVersion(): string {
  try {
    let dir = __dirname;
    for (let i = 0; i < 6; i++) {
      const candidate = path.join(dir, 'package.json');
      if (fs.existsSync(candidate)) {
        const pkg = JSON.parse(fs.readFileSync(candidate, 'utf-8')) as {
          version?: string;
        };
        if (typeof pkg.version === 'string' && pkg.version.length > 0) {
          return pkg.version;
        }
      }
      const parent = path.dirname(dir);
      if (parent === dir) break; // filesystem root
      dir = parent;
    }
  } catch {
    // Defensive: never let a missing or malformed file crash the service.
  }
  return 'unknown';
}

/**
 * Application version resolved once at module load time so that repeated
 * `/health` calls have zero I/O cost.
 */
export const APP_VERSION: string = getAppVersion();
