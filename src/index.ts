/**
 * agentuse TypeScript library — the consumer surface for the profile picker the
 * Python daemon feeds. agentwrap imports this via `file:../agentuse`.
 */

export {
  DEFAULT_PROFILE,
  getStateDir,
  listProfiles,
  PICKER_SCHEMA_VERSION,
  pickProfile,
  resetClock,
  setClock,
  setStateDir,
} from "./api";
export {
  FileLock,
  FLOCK_CONSTANTS,
  flockFd,
  type LibcSyms,
  type LoadedLibc,
  loadLibc,
  readErrno,
  setCloexec,
} from "./flock";
