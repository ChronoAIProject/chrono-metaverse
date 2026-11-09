// 复制自 CMA web/build/identity.ts，内容未改动。
import type { Plugin } from 'vite';

export interface BuildIdentity {
  readonly version: string;
  readonly revision: string;
  readonly local: boolean;
}

/** Deployability is explicit: Vite's production optimization is also used locally. */
export function buildIdentity(env: Readonly<Record<string, string | undefined>>): BuildIdentity {
  const mode = env.CHRONO_BUILD_ARTIFACT ?? 'local';
  if (mode !== 'local' && mode !== 'promotable') {
    throw new Error('CHRONO_BUILD_ARTIFACT must be local or promotable');
  }
  const version = env.CHRONO_BUILD?.trim() ?? 'dev';
  const revision = env.CHRONO_BUILD_SHA?.trim() ?? '';
  if (mode === 'promotable') {
    const release = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
    if (!/^[0-9a-f]{40}$/.test(revision)) {
      throw new Error('Promotable web artifacts require CHRONO_BUILD_SHA with a full commit SHA');
    }
    if (!release.test(version) && version !== `git-${revision.slice(0, 12)}`) {
      throw new Error(
        'Promotable web artifacts require a release version or matching git-<12-char SHA>',
      );
    }
  }
  return { version: version || 'dev', revision, local: mode === 'local' };
}

/** Evidence for image verification; the browser never fetches this file. */
export function buildIdentityEvidence(identity: BuildIdentity): Plugin {
  return {
    name: 'cma-build-identity',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'build-info.json',
        source: JSON.stringify(identity),
      });
    },
  };
}
