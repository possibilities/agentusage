// The fleet agent contract: agentusage's one machine-readable self-description,
// emitted as `agentusage guide --json`. This module is authored once; --help,
// --agent-help, and --agent-teaser all render from CONTRACT below rather than
// carrying their own hand-written text. See ~/code/agentstart's
// config/agent-contract/README.md for the contract this implements.

import { VERSION } from "./version.ts";

export interface Argument {
  name: string;
  type: "string" | "boolean" | "integer" | "number";
  description: string;
  format?: "path" | "url" | "duration" | "ref" | "json";
  direction?: "in" | "out";
  required?: boolean;
  positional?: boolean;
  repeatable?: boolean;
  choices?: string[];
  default?: unknown;
  aliases?: string[];
  csv?: boolean;
  minimum?: number;
  maximum?: number;
  role?: "call" | "output-format" | "store-selection" | "meta";
}

export interface Constraint {
  kind: "one_of" | "at_least_one" | "conflicts" | "requires";
  arguments: string[];
  required?: boolean;
  description?: string;
}

export interface Example {
  invocation: string;
  description: string;
}

export interface Stdin {
  accepts: "text" | "json";
  required?: boolean;
  description: string;
}

export interface Command {
  name: string;
  summary: string;
  audience: "agent" | "operator" | "internal";
  mutates?: boolean;
  guidance?: string;
  arguments?: Argument[];
  subcommands?: Command[];
  stdin?: Stdin;
  constraints?: Constraint[];
  examples?: Example[];
  blocking?: boolean;
  aliases?: string[];
  deprecated?: string;
}

export interface Contract {
  contract_version: 1;
  meta: {
    name: string;
    version: string;
    purpose: string;
    audience: "agent" | "operator";
  };
  global_arguments?: Argument[];
  commands: Command[];
}

const JSON_FLAG: Argument = {
  name: "--json",
  type: "boolean",
  description: "Emit the stable schema_version envelope instead of human-readable text.",
  role: "output-format",
};

const FOCUS_TARGET_ARG: Argument = {
  name: "target",
  type: "string",
  description:
    "Which focus to act on. fable and non-fable split Claude launches by intent; claude, codex, and grok are provider-wide and override them.",
  positional: true,
  required: true,
  choices: ["fable", "non-fable", "claude", "codex", "grok"],
};

export const CONTRACT: Contract = {
  contract_version: 1,
  meta: {
    name: "agentusage",
    version: VERSION,
    purpose:
      "Claude, Codex, and Grok account usage observations, launch-account balancing, and focus pinning over their swap tools. Chooses an account for a launcher and prints it; launching itself stays with the launcher.",
    audience: "operator",
  },
  commands: [
    {
      name: "usage",
      summary: "Show current usage — live TUI, snapshot, or --json",
      audience: "operator",
      mutates: false,
      blocking: true,
      guidance:
        "Blocking by default: a bare call or --watch renders the live TUI and does not return until the caller quits it. Pass --snapshot or --json for a one-shot render that returns promptly.",
      arguments: [
        { name: "--snapshot", type: "boolean", description: "Force snapshot output even inside a TTY." },
        { name: "--watch", type: "boolean", description: "Force the live watch view." },
        {
          name: "--timeout",
          type: "string",
          description: "Max wait for a first observation, e.g. 500ms, 2s.",
          format: "duration",
        },
        JSON_FLAG,
      ],
      constraints: [
        {
          kind: "conflicts",
          arguments: ["--json", "--watch"],
          description: "--json is a one-shot render; --watch is the live TUI. Pick one.",
        },
      ],
    },
    {
      name: "status",
      summary: "Show observation health, active focuses, and what balance would choose right now",
      audience: "operator",
      mutates: false,
      arguments: [JSON_FLAG],
    },
    {
      name: "balance",
      summary: "Choose a launch account for a provider and print it",
      audience: "operator",
      subcommands: [
        {
          name: "claude",
          summary: "Choose (and by default reserve) a Claude route for the next launch",
          audience: "operator",
          mutates: true,
          guidance:
            "Reserves the chosen slot's reservation ledger entry unless --dry-run is given. Launching stays with `cswap run <slot> --share-history`.",
          arguments: [
            { name: "--fable", type: "boolean", description: "Prefer a fable-eligible route." },
            { name: "--no-fable", type: "boolean", description: "Exclude fable-eligible routes." },
            { name: "--model", type: "string", description: "Model the launch will use, for eligibility filtering." },
            {
              name: "--account",
              type: "string",
              description: "Request a specific route, by route id or claude-N.",
              format: "ref",
            },
            {
              name: "--dry-run",
              type: "boolean",
              description: "Preview the selection without reserving the slot.",
            },
            JSON_FLAG,
          ],
          constraints: [{ kind: "conflicts", arguments: ["--fable", "--no-fable"] }],
          examples: [
            {
              invocation: "agentusage balance claude --json",
              description: "Pick a Claude account and reserve it, machine-readable.",
            },
            {
              invocation: "agentusage balance claude --fable --json",
              description: "Pick a Fable-eligible route.",
            },
          ],
        },
        {
          name: "codex",
          summary: "Choose a Codex account for the next launch, optionally claiming a lease",
          audience: "operator",
          mutates: true,
          guidance: "Claims a lease via codex-swap only when --claim is given; otherwise this only selects and prints.",
          arguments: [
            {
              name: "--model",
              type: "string",
              description: "Model the launch will use; a spark model routes through spark-headroom selection.",
            },
            {
              name: "--strategy",
              type: "string",
              description: "Selection strategy for the plain (non-spark) path.",
              choices: ["best", "next-available"],
            },
            { name: "--claim", type: "boolean", description: "Claim a lease on the chosen account via codex-swap." },
            {
              name: "--allow-unknown",
              type: "boolean",
              description: "Allow selecting an account codex-swap has not reported usage for yet.",
            },
            JSON_FLAG,
          ],
          examples: [
            {
              invocation: "agentusage balance codex --json",
              description: "Pick a Codex account and print it without claiming a lease.",
            },
            {
              invocation: "agentusage balance codex --claim --json",
              description: "Pick a Codex account and claim a lease on it via codex-swap.",
            },
            {
              invocation: "agentusage balance codex --model gpt-5.3-codex-spark --json",
              description: "Spark model: routes through spark-headroom selection.",
            },
          ],
        },
        {
          name: "grok",
          summary: "Choose a Grok account, optionally claiming a short reservation",
          audience: "operator",
          mutates: true,
          guidance:
            "Delegates selection to grok-swap. Without --claim it is a dry-run preview; --claim creates a short provider-owned reservation. No Grok harness activation is performed.",
          arguments: [
            {
              name: "--strategy",
              type: "string",
              description: "Provider selection strategy.",
              choices: ["best", "next-available"],
            },
            {
              name: "--account",
              type: "string",
              description: "Gate selection to one exact accountKey or grok-N display name.",
              format: "ref",
            },
            { name: "--claim", type: "boolean", description: "Create a short grok-swap reservation." },
            { name: "--dry-run", type: "boolean", description: "Explicitly preview without reserving (the default)." },
            {
              name: "--reserve-seconds",
              type: "integer",
              description: "Reservation lifetime when --claim is present.",
              minimum: 1,
              maximum: 300,
            },
            {
              name: "--allow-unknown",
              type: "boolean",
              description: "Allow accounts without a known billing observation.",
            },
            JSON_FLAG,
          ],
          constraints: [
            { kind: "conflicts", arguments: ["--claim", "--dry-run"] },
            { kind: "conflicts", arguments: ["--strategy", "--account"] },
            { kind: "requires", arguments: ["--reserve-seconds", "--claim"] },
          ],
          examples: [
            {
              invocation: "agentusage balance grok --json",
              description: "Preview the best Grok account without reserving it.",
            },
            {
              invocation: "agentusage balance grok --claim --json",
              description: "Pick a Grok account and reserve it briefly.",
            },
          ],
        },
      ],
    },
    {
      name: "focus",
      summary: "Pin future launches to one account, per provider or per fable intent",
      audience: "operator",
      guidance:
        "The focus target is an argument rather than a command name: `focus set fable claude-2 permanent`. The older target-first spellings (`focus fable set claude-2 permanent`, `focus codex clear`) are still accepted for every target and action and behave identically.",
      subcommands: [
        {
          name: "show",
          summary: "Show the effective focus for one target",
          audience: "operator",
          mutates: false,
          arguments: [FOCUS_TARGET_ARG, JSON_FLAG],
          examples: [
            { invocation: "agentusage focus show claude --json", description: "Is a provider-wide Claude focus active?" },
          ],
        },
        {
          name: "set",
          summary: "Pin one target's launches to one account",
          audience: "operator",
          mutates: true,
          guidance:
            "Lifetimes current-reset and cycle-end read the observed reset window, so target non-fable accepts only permanent and absolute. ref is a Claude route for fable/non-fable/claude, a Codex accountKey for codex, and an accountKey or grok-N for grok.",
          arguments: [
            FOCUS_TARGET_ARG,
            {
              name: "ref",
              type: "string",
              description:
                "Account to pin to: a Claude route for fable/non-fable/claude, a Codex accountKey for codex, or an accountKey/grok-N for grok.",
              positional: true,
              required: true,
              format: "ref",
            },
            {
              name: "lifetime",
              type: "string",
              description:
                "How long the focus holds. current-reset and cycle-end need an observed reset window and are refused when target is non-fable.",
              positional: true,
              required: true,
              choices: ["permanent", "absolute", "current-reset", "cycle-end"],
            },
            {
              name: "deadline",
              type: "string",
              description: "UTC timestamp (with offset or Z). Required only when lifetime is absolute.",
              positional: true,
            },
            {
              name: "--expect-reset",
              type: "string",
              description:
                "UTC timestamp: confirm the observed reset time before pinning current-reset/cycle-end; refuses on mismatch.",
            },
            {
              name: "--require-eligible",
              type: "boolean",
              description: "Refuse instead of warning when the target is not currently launch-eligible.",
            },
            JSON_FLAG,
          ],
          examples: [
            {
              invocation: "agentusage focus set fable claude-2 permanent",
              description: "All Fable launches go to claude-2.",
            },
            {
              invocation: "agentusage focus set fable claude-2 cycle-end",
              description: "…until the observed Fable window resets or hits 100%.",
            },
            {
              invocation: "agentusage focus set non-fable claude-1 absolute 2026-08-12T00:00:00Z",
              description: "Pin non-Fable launches to claude-1 until that UTC deadline.",
            },
            {
              invocation: "agentusage focus set claude claude-1 cycle-end",
              description: "Everything Claude goes to claude-1 until its week resets or hits 100%.",
            },
            {
              invocation: "agentusage focus set codex <accountKey> current-reset",
              description: "Pin every Codex launch to one account until its observed reset.",
            },
            {
              invocation: "agentusage focus set grok grok-1 current-reset",
              description: "Pin Grok selection until its included-allowance reset.",
            },
            {
              invocation: "agentusage focus claude set claude-1 cycle-end",
              description: "The older target-first order, still accepted and identical to `focus set claude claude-1 cycle-end`.",
            },
          ],
        },
        {
          name: "clear",
          summary: "Remove one target's focus",
          audience: "operator",
          mutates: true,
          arguments: [FOCUS_TARGET_ARG, JSON_FLAG],
          examples: [{ invocation: "agentusage focus clear fable", description: "Stop pinning Fable launches." }],
        },
      ],
    },
    {
      name: "recover",
      summary: "Run cswap recovery for one Claude route",
      audience: "operator",
      mutates: true,
      arguments: [
        {
          name: "ref",
          type: "string",
          description: "Route, by route id or claude-N.",
          positional: true,
          required: true,
          format: "ref",
        },
        JSON_FLAG,
      ],
    },
    {
      name: "refresh",
      summary: "Force a fresh observation, bypassing the freshness ceiling",
      audience: "operator",
      mutates: true,
      arguments: [
        {
          name: "scope",
          type: "string",
          description: "Which provider to refresh.",
          positional: true,
          choices: ["claude", "codex", "grok", "all"],
          default: "all",
        },
        JSON_FLAG,
      ],
    },
    {
      name: "daemon",
      summary: "Run or check the background observation daemon",
      audience: "operator",
      subcommands: [
        {
          name: "run",
          summary: "Run the observation daemon in the foreground",
          audience: "operator",
          mutates: true,
          blocking: true,
          arguments: [],
        },
        {
          name: "status",
          summary: "Show whether the observation daemon is running",
          audience: "operator",
          mutates: false,
          arguments: [],
        },
      ],
    },
    {
      name: "guide",
      summary: "Print this fleet agent contract",
      audience: "internal",
      mutates: false,
      arguments: [JSON_FLAG],
    },
    {
      name: "help",
      summary: "Print usage",
      audience: "operator",
      mutates: false,
      aliases: ["--help", "-h"],
      arguments: [],
    },
    {
      name: "version",
      summary: "Print the installed version",
      audience: "operator",
      mutates: false,
      aliases: ["--version"],
      arguments: [],
    },
  ],
};

export function guideEnvelope(): { schema_version: 1; ok: true; error: null; data: Contract } {
  return { schema_version: 1, ok: true, error: null, data: CONTRACT };
}

// ---------------------------------------------------------------------------
// Renders. --help, --agent-help, and --agent-teaser are views of CONTRACT,
// never a second authorship of it.

function argUsageToken(argument: Argument): string {
  if (argument.positional === true) {
    const choices = argument.choices !== undefined ? argument.choices.join("|") : argument.name;
    return argument.required === true ? `<${choices}>` : `[${choices}]`;
  }
  const value = argument.type === "boolean" ? "" : ` <${argument.choices?.join("|") ?? argument.name.replace(/^--/u, "")}>`;
  return argument.required === true ? `${argument.name}${value}` : `[${argument.name}${value}]`;
}

function leafUsageLine(path: string[], command: Command): string {
  const tokens = (command.arguments ?? []).map(argUsageToken);
  return `agentusage ${path.join(" ")}${tokens.length > 0 ? ` ${tokens.join(" ")}` : ""}`;
}

function walkLeaves(commands: Command[], prefix: string[], into: { path: string[]; command: Command }[]): void {
  for (const command of commands) {
    const path = [...prefix, command.name];
    if (command.subcommands !== undefined) walkLeaves(command.subcommands, path, into);
    else into.push({ path, command });
  }
}

export function renderHelp(): string {
  const leaves: { path: string[]; command: Command }[] = [];
  walkLeaves(CONTRACT.commands, [], leaves);
  const lines: string[] = [`agentusage ${CONTRACT.meta.version} — ${CONTRACT.meta.purpose}`, "", "Usage:"];
  for (const { path, command } of leaves) {
    lines.push(`  ${leafUsageLine(path, command)}`);
  }
  lines.push("");
  lines.push(
    "The usage viewer is sidecar-backed and daemon-independent. `balance` chooses",
    "an account and prints it — launching stays with the launcher (cswap run",
    "<slot> --share-history / codex-swap run --account <key>). Grok selection",
    "currently stops before harness activation. A provider focus",
    "(focus set claude|codex|grok) pins every launch for that provider to one account",
    "and overrides the fable/non-fable focuses; observed lifetimes follow the",
    "provider's binding allowance. The older target-first order still works.",
  );
  return lines.join("\n");
}

export function renderAgentHelp(): string {
  const leaves: { path: string[]; command: Command }[] = [];
  walkLeaves(CONTRACT.commands, [], leaves);
  const lines: string[] = [`${CONTRACT.meta.name} ${CONTRACT.meta.version} — ${CONTRACT.meta.purpose}`, ""];
  for (const { path, command } of leaves) {
    const flags = command.audience === "internal" ? " [internal]" : "";
    const blocking = command.blocking === true ? " [blocking]" : "";
    const aliases = command.aliases !== undefined && command.aliases.length > 0 ? ` (aka ${command.aliases.join(", ")})` : "";
    const deprecated = command.deprecated !== undefined ? ` [deprecated: use ${command.deprecated}]` : "";
    lines.push(
      `${path.join(" ")}${flags}${blocking}${aliases}${deprecated} — ${command.summary} (mutates: ${command.mutates === true})`,
    );
    for (const argument of command.arguments ?? []) {
      const req = argument.required === true ? ", required" : "";
      const choices = argument.choices !== undefined ? `, one of ${argument.choices.join("|")}` : "";
      lines.push(`  ${argument.name} (${argument.type}${req}${choices}) — ${argument.description}`);
    }
    for (const example of command.examples ?? []) {
      lines.push(`  e.g. ${example.invocation}  — ${example.description}`);
    }
  }
  lines.push("", "Full machine-readable contract: agentusage guide --json");
  return lines.join("\n");
}

export function renderAgentTeaser(): string {
  return `${CONTRACT.meta.name} — ${CONTRACT.meta.purpose} Run \`agentusage guide --json\` for the full contract.`;
}
