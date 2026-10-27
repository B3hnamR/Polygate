import { existsSync, readFileSync } from 'node:fs';
import { createReleaseChecker, type UpdateKind } from '../desktop/releases.cjs';
import { version } from './version';

function installKind(): UpdateKind {
  if (process.env.POLYGATE_INSTALL_KIND === 'docker' || existsSync('/.dockerenv')) return 'docker';
  try {
    if (process.platform === 'linux' && readFileSync('/usr/local/bin/polygate', 'utf8').includes('polygate-cli')) return 'linux';
  } catch { /* A source checkout or standalone package has no installed manager. */ }
  return 'manual';
}
const checker = createReleaseChecker({ version, kind: installKind() });
export const checkForUpdates = (force = false) => checker.check(force);
