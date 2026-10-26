// The one place the version comes from: package.json, inlined by `bun build`, so the health check, the dashboard and the release agree.
import pkg from '../package.json';
export const version: string = pkg.version;
