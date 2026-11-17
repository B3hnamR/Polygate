import { realpathSync } from 'node:fs';
import path from 'node:path';

export const folderKey = (folder: string) => {
  try { folder = realpathSync(folder); } catch {}
  const resolved = path.resolve(folder);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

export function foldersOverlap(a: string, b: string) {
  if (!a || !b) return false;
  const x = folderKey(a), y = folderKey(b);
  const contains = (parent: string, child: string) => {
    const rel = path.relative(parent, child);
    return !rel || rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
  };
  return contains(x, y) || contains(y, x);
}
