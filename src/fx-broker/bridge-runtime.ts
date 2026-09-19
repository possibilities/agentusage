import { createHash } from 'node:crypto';
import { openSync, closeSync, readSync, realpathSync } from 'node:fs';
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

// Capture the executable bytes during module initialization, before broker
// preparation can await provider or state work.
const LOADED_EXECUTABLE_SHA256 = fileSha256(realpathSync(process.execPath));

/**
 * Exact, privacy-safe identity for the running bridge implementation. Paths,
 * argv, environment, credentials, and provider/account values are excluded.
 */
export function bridgeRuntimeEvidence(
  loadedBridgeSources: Readonly<Record<string, string>>,
) {
  const bounds = {
    max_provider_admissions: FX_MAX_PROVIDER_ADMISSIONS,
    max_stdio_line_bytes: FX_BRIDGE_MAX_LINE_BYTES,
    max_http_request_body_bytes: FX_BRIDGE_MAX_REQUEST_BODY_BYTES,
    rolling_lease_ms: FX_ROLLING_LEASE_MS,
    provider_request_budget_ms: FX_PROVIDER_REQUEST_BUDGET_MS,
  };
  const sourceSha256 = sha256(JSON.stringify({
    bridge_runtime_evidence: bridgeRuntimeEvidence.toString(),
    file_sha256: fileSha256.toString(),
    sha256: sha256.toString(),
    ...Object.fromEntries(
      Object.entries(loadedBridgeSources).sort(([left], [right]) =>
        left.localeCompare(right)),
    ),
  }));
  const buildSha256 = sha256(JSON.stringify({
    product: 'agentusage',
    version: VERSION,
    runtime: 'bun',
    runtime_version: Bun.version,
    platform: process.platform,
    arch: process.arch,
    executable_identity_sha256: LOADED_EXECUTABLE_SHA256,
    source_sha256: sourceSha256,
    bounds,
  }));
  return {
    schema_version: 1 as const,
    identity: {
      product: 'agentusage' as const,
      version: VERSION,
      runtime: 'bun' as const,
      runtime_version: Bun.version,
      executable_identity_sha256: LOADED_EXECUTABLE_SHA256,
      source_sha256: sourceSha256,
      build_sha256: buildSha256,
    },
    bounds,
  };
}
