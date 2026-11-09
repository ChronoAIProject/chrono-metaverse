// 复制自 CMA web/build/identity.test.ts，内容未改动。
import { describe, expect, it } from 'vitest';
import { buildIdentity } from './identity';

const revision = '0123456789abcdef'.repeat(2) + '01234567';
const artifact = { CHRONO_BUILD_ARTIFACT: 'promotable', CHRONO_BUILD_SHA: revision };

describe('immutable web identity', () => {
  it('keeps local development and optimized local builds usable', () => {
    expect(buildIdentity({})).toEqual({ version: 'dev', revision: '', local: true });
  });

  it.each(['v1.2.3', `git-${revision.slice(0, 12)}`])('accepts immutable %s', (version) => {
    expect(buildIdentity({ ...artifact, CHRONO_BUILD: version })).toEqual({
      version,
      revision,
      local: false,
    });
  });

  it.each([undefined, '', ' ', 'dev', 'development', 'git-aaaaaaaaaaaa'])(
    'rejects version %s',
    (version) => {
      expect(() => buildIdentity({ ...artifact, CHRONO_BUILD: version })).toThrow();
    },
  );

  it.each([undefined, '', ' ', 'dev', 'development', revision.slice(0, 12)])(
    'rejects revision %s',
    (sha) => {
      expect(() =>
        buildIdentity({ ...artifact, CHRONO_BUILD: 'v1.2.3', CHRONO_BUILD_SHA: sha }),
      ).toThrow();
    },
  );

  it('rejects an explicitly blank or misspelled artifact mode', () => {
    for (const mode of ['', 'production']) {
      expect(() => buildIdentity({ CHRONO_BUILD_ARTIFACT: mode })).toThrow();
    }
  });
});
