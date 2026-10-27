export type UpdateKind = 'windows' | 'linux' | 'docker' | 'manual';
export type UpdateState = {
  currentVersion: string; latestVersion: string; available: boolean; releaseUrl: string; checkedAt: number;
  status: 'idle' | 'checking' | 'current' | 'available' | 'error' | 'downloading' | 'installing';
  error: string; kind: UpdateKind; canInstall: boolean; progress?: number;
};
export type ReleaseAsset = { name: string; url: string; size: number; digest?: string };
export type ReleaseInfo = { version: string; url: string; assets: ReleaseAsset[] };
export const REPO: string;
export const RELEASES_URL: string;
export const API_URL: string;
export const MAX_DOWNLOAD: number;
export function isNewer(latest: string, current: string): boolean;
export function releaseInfo(data: unknown): ReleaseInfo;
export function readLimited(response: Response, maxBytes: number): Promise<string>;
export function fetchLatestRelease(fetcher?: typeof fetch): Promise<ReleaseInfo>;
export function createReleaseChecker(options: {version: string; kind?: UpdateKind; fetcher?: typeof fetch; now?: () => number; onState?: (state: UpdateState) => void}): {
  getState(): UpdateState; getRelease(): ReleaseInfo | null; check(force?: boolean): Promise<UpdateState>;
};
