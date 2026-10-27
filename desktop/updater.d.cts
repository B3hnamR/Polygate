import type { UpdateState, ReleaseInfo } from './releases.cjs';
type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export function portableTarget(file: string | undefined, packaged: boolean, platform?: string): string;
export function fetchAsset(url: string, fetcher: Fetcher, signal: AbortSignal): Promise<Response>;
export function downloadRelease(release: ReleaseInfo, directory: string, fetcher: Fetcher, onProgress?: (value: number) => void): Promise<{staged: string; expectedHash: string}>;
export function startHelper(script: string, configPath: string, directory: string): Promise<void>;
export function createPortableUpdater(options: {
  version: string; target: string; tempDir: string; resultPath: string; fetcher?: Fetcher;
  onState?: (state: UpdateState) => void; onReady?: () => void;
  launchHelper?: (script: string, configPath: string, directory: string) => Promise<void>;
}): {getState(): UpdateState; check(force?: boolean): Promise<UpdateState>; install(): Promise<UpdateState>};
