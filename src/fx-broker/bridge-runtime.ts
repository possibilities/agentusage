import { createHash } from 'node:crypto';
import { openSync, closeSync, readSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { VERSION } from '../version.ts';
import {
  FX_BRIDGE_MAX_LINE_BYTES,
  FX_BRIDGE_MAX_REQUEST_BODY_BYTES,
  FX_MAX_PROVIDER_ADMISSIONS,
  FX_PROVIDER_REQUEST_BUDGET_MS,
  FX_ROLLING_LEASE_MS,
} from './runtime-bounds.ts';

const sha256 = (value: string | Uint8Array): string =>
  createHash('sha256').update(value).digest('hex');

function fileSha256(path: string): string {
  const hash = createHash('sha256');
  const bytes = Buffer.allocUnsafe(64 * 1024);
  const fd = openSync(path, 'r');
  try {
    for (;;) {
      const count = readSync(fd, bytes, 0, bytes.byteLength, null);
      if (count === 0) break;
      hash.update(bytes.subarray(0, count));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

/**
 * Exact, privacy-safe identity for the running bridge implementation. Paths,
 * argv, environment, credentials, and provider/account values are excluded.
 */
export function bridgeRuntimeEvidence() {
  const entrypoint = realpathSync(process.argv[1]!);
  const bridgeSource = realpathSync(join(import.meta.dir, 'bridge.ts'));
  const identitySource = realpathSync(join(import.meta.dir, 'bridge-runtime.ts'));
  const boundsSource = realpathSync(join(import.meta.dir, 'runtime-bounds.ts'));
  const sourceSha256 = sha256(JSON.stringify({
    entrypoint_sha256: fileSha256(entrypoint),
    bridge_source_sha256: fileSha256(bridgeSource),
    identity_source_sha256: fileSha256(identitySource),
    runtime_bounds_source_sha256: fileSha256(boundsSource),
  }));
  const executableIdentitySha256 = fileSha256(realpathSync(process.execPath));
  const buildSha256 = sha256(JSON.stringify({
    product: 'agentusage',
    version: VERSION,
    runtime: 'bun',
    runtime_version: Bun.version,
    platform: process.platform,
    arch: process.arch,
    source_sha256: sourceSha256,
  }));
  return {
    schema_version: 1 as const,
    identity: {
      product: 'agentusage' as const,
      version: VERSION,
      runtime: 'bun' as const,
      runtime_version: Bun.version,
      executable_identity_sha256: executableIdentitySha256,
      source_sha256: sourceSha256,
      build_sha256: buildSha256,
    },
    bounds: {
      max_provider_admissions: FX_MAX_PROVIDER_ADMISSIONS,
      max_stdio_line_bytes: FX_BRIDGE_MAX_LINE_BYTES,
      max_http_request_body_bytes: FX_BRIDGE_MAX_REQUEST_BODY_BYTES,
      rolling_lease_ms: FX_ROLLING_LEASE_MS,
      provider_request_budget_ms: FX_PROVIDER_REQUEST_BUDGET_MS,
    },
  };
}
