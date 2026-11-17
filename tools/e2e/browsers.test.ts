import {mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {readLock} from './browsers.ts';

describe('browsers.lock.json', () => {
  it('refuses an entry without a digest, a beta, `latest` and a path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'iw-browsers-'));
    const gd = {version: '0.37.1', sha256: 'a'.repeat(64)};
    for (const firefox of [
      [{version: '160.0'}],
      [{version: '160.0b9', sha256: 'a'.repeat(64)}],
      [{version: 'latest', sha256: 'a'.repeat(64)}],
      [{version: '../160.0', sha256: 'a'.repeat(64)}],
      [],
    ]) {
      const path = join(dir, 'lock.json');
      writeFileSync(path, JSON.stringify({firefox, geckodriver: gd}));
      expect(() => readLock(path), JSON.stringify(firefox)).toThrow();
    }
  });
});
