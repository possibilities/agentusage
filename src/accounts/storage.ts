import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { dlopen, FFIType } from 'bun:ffi';

export class AccountError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/** Kernel locks have no stale-file stealing race and are released on process exit. */
const libc = dlopen(
  process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6',
  {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  },
);

export function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  checkPrivateDirectory(path);
}

export function checkPrivateDirectory(path: string): void {
  try {
    const st = lstatSync(path);
    if (
      !st.isDirectory() ||
      st.isSymbolicLink() ||
      (st.mode & 0o077) !== 0 ||
      st.uid !== process.getuid?.()
    ) {
      throw new AccountError(
        'unsafe-state',
        'Account state directory must be owned by you, private, and not a symlink',
      );
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
}

export function readPrivate<T>(
  path: string,
  validate: (value: unknown) => T,
  missing: () => T,
): T {
  checkPrivateDirectory(dirname(path));
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return missing();
    throw new AccountError(
      'unsafe-state',
      'Cannot safely open private account state',
    );
  }
  try {
    const st = fstatSync(fd);
    if (
      !st.isFile() ||
      st.nlink !== 1 ||
      (st.mode & 0o077) !== 0 ||
      st.uid !== process.getuid?.() ||
      st.size > 4 * 1024 * 1024
    ) {
      throw new AccountError(
        'unsafe-state',
        'Account state must be a private, bounded regular file owned by you',
      );
    }
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(fd, 'utf8'));
    } catch {
      throw new AccountError(
        'invalid-state',
        'Account state contains invalid JSON',
      );
    }
    return validate(value);
  } finally {
    closeSync(fd);
  }
}

export function writePrivate(path: string, value: unknown): void {
  privateDirectory(dirname(path));
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  const fd = openSync(
    temporary,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    try {
      const serialized = JSON.stringify(value) + '\n';
      if (Buffer.byteLength(serialized) > 4 * 1024 * 1024)
        throw new AccountError('state-too-large', 'Account state exceeded its size limit');
      writeFileSync(fd, serialized);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // Refuse a foreign leaf even though rename would not follow its symlink.
    try {
      const st = lstatSync(path);
      if (
        !st.isFile() ||
        st.nlink !== 1 ||
        st.isSymbolicLink() ||
        (st.mode & 0o077) !== 0 ||
        st.uid !== process.getuid?.()
      )
        throw new AccountError(
          'unsafe-state',
          'Refusing to replace unsafe account state',
        );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    renameSync(temporary, path);
    const directory = openSync(
      dirname(path),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } finally {
    try {
      unlinkSync(temporary);
    } catch {}
  }
}

function openLock(path: string): number {
  privateDirectory(dirname(path));
  const fd = openSync(
    path,
    constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW,
    0o600,
  );
  const st = fstatSync(fd);
  if (
    !st.isFile() ||
    st.nlink !== 1 ||
    (st.mode & 0o077) !== 0 ||
    st.uid !== process.getuid?.()
  ) {
    closeSync(fd);
    throw new AccountError(
      'unsafe-state',
      'Account lock must be a private regular file',
    );
  }
  return fd;
}

function unlock(fd: number): () => void {
  let closed = false;
  return () => {
    if (!closed) {
      closed = true;
      libc.symbols.flock(fd, 8);
      closeSync(fd);
    }
  };
}

export function tryLockFile(path: string): () => void {
  const fd = openLock(path);
  if (libc.symbols.flock(fd, 2 | 4) !== 0) {
    closeSync(fd);
    throw new AccountError('busy', 'Account state is busy; retry shortly', 503);
  }
  return unlock(fd);
}

export async function lockFile(
  path: string,
  waitMs = 30_000,
): Promise<() => void> {
  const fd = openLock(path);
  const deadline = Date.now() + waitMs;
  while (libc.symbols.flock(fd, 2 | 4) !== 0) {
    if (Date.now() >= deadline) {
      closeSync(fd);
      throw new AccountError(
        'busy',
        'Account state is busy; retry shortly',
        503,
      );
    }
    await Bun.sleep(20);
  }
  return unlock(fd);
}

export async function withLock<T>(
  path: string,
  fn: () => T | Promise<T>,
  waitMs = 30_000,
): Promise<T> {
  const release = await lockFile(path, waitMs);
  try {
    return await fn();
  } finally {
    release();
  }
}

export const record = (x: unknown): Record<string, unknown> | null =>
  typeof x === 'object' && x !== null && !Array.isArray(x)
    ? (x as Record<string, unknown>)
    : null;
export const nonempty = (x: unknown): x is string =>
  typeof x === 'string' &&
  x.length > 0 &&
  x.length < 65_536 &&
  !/[\x00-\x1f\x7f]/u.test(x);
