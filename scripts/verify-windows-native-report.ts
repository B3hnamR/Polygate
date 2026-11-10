export const expectedWindowsNativeTests = [
  'atomically replaces an executable with spaces and apostrophes in its path',
  'rejects tampered bytes while preserving the original',
  'a portable executable named after its version is renamed to the new version, and any other name is left alone',
  'one click downloads, verifies, closes the old process, replaces the file, and launches the replacement',
  'the helper waits for the old app without failing when it has already gone',
  'alternate-case backup paths and exclusions never turn an existing Windows file into an addition',
  'Undo coalesces alternate-case identities across persisted Windows turns',
] as const;

// PowerShell parses JUnit XML; this validates the resulting testcase records.
// Bun also emits filtered-out cases as skipped, so report-wide counts are invalid.
export function verifyWindowsNativeReport(report: unknown) {
  if (!Array.isArray(report)) throw new Error('Native report must contain testcase records');
  const seen = new Set<string>();
  for (const entry of report) {
    if (!entry || typeof entry.name !== 'string' || typeof entry.blocked !== 'boolean') throw new Error('Invalid native testcase record');
    const expected = expectedWindowsNativeTests.find(name => entry.name === name);
    if (!expected) {
      // The CLI uses an unanchored union. A renamed/prefixed matching case must
      // not silently replace or supplement one of the seven exact definitions.
      if (expectedWindowsNativeTests.some(name => entry.name.includes(name))) throw new Error(`Unexpected matching native testcase: ${entry.name}`);
      continue;
    }
    if (seen.has(expected)) throw new Error(`Duplicate native testcase: ${expected}`);
    if (entry.blocked) throw new Error(`Native testcase skipped, failed, or retried: ${expected}`);
    seen.add(expected);
  }
  const missing = expectedWindowsNativeTests.filter(name => !seen.has(name));
  if (missing.length) throw new Error(`Missing native testcases: ${missing.join('; ')}`);
  return seen.size;
}

if (import.meta.main) {
  const count = verifyWindowsNativeReport(JSON.parse(await Bun.stdin.text()));
  console.log(`Verified exactly ${count} native Windows tests without skips, failures, or retries.`);
}
