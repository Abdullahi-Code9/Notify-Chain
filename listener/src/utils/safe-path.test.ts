import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveSafePath, UnsafePathError } from './safe-path';

describe('export path containment (#1209)', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'notify-safe-path-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('accepts a plain filename inside the approved directory', () => {
    expect(resolveSafePath('export.json', root)).toBe(path.join(root, 'export.json'));
  });

  it('accepts a nested filename and creates no directories itself', () => {
    expect(resolveSafePath('reports/export.csv', root)).toBe(
      path.join(root, 'reports', 'export.csv'),
    );
    expect(fs.existsSync(path.join(root, 'reports'))).toBe(false);
  });

  it.each([
    '../outside.json',
    '../../etc/passwd',
    '/tmp/outside.json',
    'C:\\Windows\\Temp\\outside.json',
    'nested\\..\\outside.json',
    'nested/%2e%2e/outside.json',
    'nested/%2Foutside.json',
    'export\0.json',
  ])('rejects unsafe path %s', (candidate) => {
    expect(() => resolveSafePath(candidate, root)).toThrow(UnsafePathError);
  });

  it('rejects an empty path', () => {
    expect(() => resolveSafePath('', root)).toThrow(UnsafePathError);
  });

  it('rejects traversal that resolves inside another sibling directory', () => {
    expect(() => resolveSafePath('../sibling/export.json', root)).toThrow(UnsafePathError);
  });

  it('rejects symlinked parent directories and symlinked destination files', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'notify-outside-'));
    try {
      fs.symlinkSync(outside, path.join(root, 'link'), 'dir');
      expect(() => resolveSafePath('link/export.json', root)).toThrow(/symbolic links/);

      fs.writeFileSync(path.join(outside, 'export.json'), 'secret');
      fs.symlinkSync(path.join(outside, 'export.json'), path.join(root, 'export.json'));
      expect(() => resolveSafePath('export.json', root)).toThrow(/symbolic links/);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
