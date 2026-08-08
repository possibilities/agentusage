export interface RunResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  /** null when the process ran to completion (regardless of exit code). */
  error: "timeout" | "spawn-failed" | "output-cap" | null;
  /** True when the binary itself was missing (health maps to "absent"). */
  enoent: boolean;
}

export interface RunOptions {
  timeoutMs: number;
  maxOutputBytes: number;
}

/**
 * No-shell bounded subprocess run. Output beyond the cap aborts the run
 * rather than truncating silently: a capped provider payload is not
 * trustworthy input for balance decisions.
 */
export async function runBounded(argv: readonly string[], options: RunOptions): Promise<RunResult> {
  const result: RunResult = { ok: false, code: null, stdout: "", stderr: "", error: null, enoent: false };
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn({ cmd: [...argv], stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch (error) {
    result.error = "spawn-failed";
    result.enoent = /enoent|no such file|executable not found/i.test(String(error));
    return result;
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, options.timeoutMs);

  const readCapped = async (stream: ReadableStream<Uint8Array>): Promise<{ text: string; capped: boolean }> => {
    const decoder = new TextDecoder();
    let text = "";
    let bytes = 0;
    for await (const chunk of stream) {
      bytes += chunk.byteLength;
      if (bytes > options.maxOutputBytes) {
        proc.kill("SIGKILL");
        return { text, capped: true };
      }
      text += decoder.decode(chunk, { stream: true });
    }
    text += decoder.decode();
    return { text, capped: false };
  };

  try {
    const [out, err] = await Promise.all([
      readCapped(proc.stdout as ReadableStream<Uint8Array>),
      readCapped(proc.stderr as ReadableStream<Uint8Array>),
    ]);
    const code = await proc.exited;
    result.stdout = out.text;
    result.stderr = err.text;
    result.code = typeof code === "number" ? code : null;
    if (timedOut) result.error = "timeout";
    else if (out.capped || err.capped) result.error = "output-cap";
    result.ok = result.error === null && result.code === 0;
    return result;
  } finally {
    clearTimeout(timer);
  }
}
