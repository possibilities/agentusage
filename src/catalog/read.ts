import { closeSync, openSync, readSync } from 'node:fs';
import { CATALOG_AUDIT_MAX_BYTES, CatalogInputError } from './types.ts';

export function readBoundedJson(path: string): unknown {
  let fd: number;
  try {
    fd = path === '-' ? 0 : openSync(path, 'r');
  } catch {
    throw new CatalogInputError('input-read-failed');
  }
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, CATALOG_AUDIT_MAX_BYTES + 1 - total));
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (count === 0) break;
      total += count;
      if (total > CATALOG_AUDIT_MAX_BYTES) throw new CatalogInputError('input-too-large');
      chunks.push(chunk.subarray(0, count));
    }
  } catch (error) {
    if (error instanceof CatalogInputError) throw error;
    throw new CatalogInputError('input-read-failed');
  } finally {
    if (path !== '-') closeSync(fd);
  }
  try {
    return JSON.parse(Buffer.concat(chunks, total).toString('utf8'));
  } catch {
    throw new CatalogInputError('invalid-json');
  }
}
