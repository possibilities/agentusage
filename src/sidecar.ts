import { readPrivate, writePrivate } from './accounts/storage.ts';

export const writeSidecar = writePrivate;

export interface SidecarRead<T> {
  value: T | null;
  state: 'ok' | 'absent' | 'malformed';
}

export function readSidecar<T>(
  path: string,
  validate: (value: unknown) => T | null,
): SidecarRead<T> {
  try {
    return readPrivate<SidecarRead<T>>(
      path,
      (raw) => {
        const value = validate(raw);
        return value === null
          ? { value: null, state: 'malformed' as const }
          : { value, state: 'ok' as const };
      },
      () => ({ value: null, state: 'absent' as const }),
    );
  } catch {
    return { value: null, state: 'malformed' };
  }
}
