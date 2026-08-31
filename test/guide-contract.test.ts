import { describe, expect, test } from "bun:test";
import { CONTRACT, guideEnvelope } from "../src/guide.ts";

// The fleet agent contract (~/code/agentstart/config/agent-contract) is
// normative and executed by agentstart's own validator, not restated here.
// This test only proves agentusage's contract keeps conforming, by running
// the same interpreter agentstart ships.

const VALIDATOR_PATH = `${process.env.HOME}/code/agentstart/scripts/validate-agent-contract.ts`;

describe("guide --json contract", () => {
  test("envelope wraps contract_version 1 with ok:true", () => {
    const envelope = guideEnvelope();
    expect(envelope.schema_version).toBe(1);
    expect(envelope.ok).toBe(true);
    expect(envelope.error).toBeNull();
    expect(envelope.data.contract_version).toBe(1);
  });

  test("meta.audience is operator and no command claims agent audience", () => {
    expect(CONTRACT.meta.audience).toBe("operator");
    const walk = (commands: typeof CONTRACT.commands): void => {
      for (const command of commands) {
        expect(command.audience).not.toBe("agent");
        if (command.subcommands !== undefined) walk(command.subcommands);
      }
    };
    walk(CONTRACT.commands);
  });

  test("conforms to the fleet agent contract, version 1", async () => {
    const validator = Bun.file(VALIDATOR_PATH);
    if (!(await validator.exists())) {
      console.warn(`skipping: ${VALIDATOR_PATH} not present on this machine`);
      return;
    }
    const run = Bun.spawnSync(["bun", VALIDATOR_PATH, "--file", "/dev/stdin"], {
      stdin: Buffer.from(JSON.stringify(guideEnvelope())),
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = run.stdout.toString();
    const stderr = run.stderr.toString();
    expect(stderr + stdout).not.toContain("is not conformant");
    expect(run.exitCode).toBe(0);
  });
});
