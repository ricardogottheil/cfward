import { buildCommand, buildRouteMap } from "@stricli/core";
import type { CfwardContext, NoFlags } from "./context.js";
import list, { type ListFlags } from "./list.js";
import login, { type LoginFlags } from "./login.js";
import logout, { type LogoutFlags } from "./logout.js";
import run, { type RunFlags } from "./run.js";
import status, { type StatusFlags } from "./status.js";
import use from "./use.js";

/** Values reach the commands as typed, and are validated where they are used. */
const asIs = (input: string): string => input;

const PROFILE_FLAG = {
  kind: "parsed",
  parse: asIs,
  brief: "Profile to use, overriding the one .cfward.json names",
  placeholder: "name",
  optional: true,
} as const;

/**
 * No `--token` flag exists anywhere in this application, and none may be
 * added. Invariant 2: an argument is visible in `ps` to every other user on
 * the machine and lands in the shell history file. The token arrives at a
 * masked prompt or on stdin, and nowhere else.
 */
const loginCommand = buildCommand<LoginFlags, [], CfwardContext>({
  func: login,
  parameters: {
    flags: {
      profile: {
        kind: "parsed",
        parse: asIs,
        brief: "Name to store the token under",
        placeholder: "name",
        optional: true,
      },
      accountId: {
        kind: "parsed",
        parse: asIs,
        brief: "Skip the account picker and use this account id",
        placeholder: "id",
        optional: true,
      },
      stdin: {
        kind: "boolean",
        brief: "Read the token from stdin instead of prompting (implied when stdin is not a terminal)",
      },
      force: {
        kind: "boolean",
        brief: "Replace the token of an existing profile without asking",
      },
    },
    aliases: { p: "profile" },
  },
  docs: {
    brief: "Store a Cloudflare API token for a profile",
    fullDescription:
      "Prompts for a token, verifies it against Cloudflare, offers a picker " +
      "when the token reaches more than one account, and stores it encrypted. " +
      "Nothing is written to the repository.",
    customUsage: [
      {
        input: "--profile production",
        brief: "Prompt for the token and pick an account",
      },
      {
        input: "--profile production --stdin",
        brief: 'Read it from a pipe: echo "$CF_TOKEN" | cfward login --profile production --stdin',
      },
    ],
  },
});

const listCommand = buildCommand<ListFlags, [], CfwardContext>({
  func: list,
  parameters: {
    flags: {
      tokens: {
        kind: "boolean",
        brief: "Also show a masked fingerprint of each token (reads the store, so it may prompt)",
      },
    },
  },
  docs: {
    brief: "List the profiles stored on this machine",
    fullDescription:
      "Reads unencrypted metadata only, so it neither unlocks the keychain nor " +
      "asks for the vault passphrase unless --tokens is given.",
  },
});

const useCommand = buildCommand<NoFlags, [string], CfwardContext>({
  func: use,
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        {
          parse: asIs,
          brief: "Profile this project should deploy with",
          placeholder: "profile",
        },
      ],
    },
  },
  docs: {
    brief: "Write .cfward.json so this project selects a profile",
    fullDescription:
      "The file is committed and holds the profile name and nothing else. " +
      "Every clone then resolves the same account without any flags.",
  },
});

const runCommand = buildCommand<RunFlags, string[], CfwardContext>({
  func: run,
  parameters: {
    flags: { profile: PROFILE_FLAG },
    aliases: { p: "profile" },
    positional: {
      kind: "array",
      parameter: {
        parse: asIs,
        brief: "Command to run, with its own arguments",
        placeholder: "command",
      },
      minimum: 1,
    },
  },
  docs: {
    brief: "Run a command with the profile's credentials in its environment",
    fullDescription:
      "The token is placed in the child process environment only, and the " +
      "child's stdout and stderr are filtered before they reach the terminal. " +
      "The child's exit code is this command's exit code.",
    customUsage: [
      { input: "-- wrangler deploy", brief: "Deploy with the profile .cfward.json names" },
      { input: "--profile staging -- wrangler deploy", brief: "Override it for one run" },
    ],
  },
});

const statusCommand = buildCommand<StatusFlags, [], CfwardContext>({
  func: status,
  parameters: {
    flags: { profile: PROFILE_FLAG },
    aliases: { p: "profile" },
  },
  docs: {
    brief: "Show which profile this directory resolves to, and whether its token still works",
  },
});

const logoutCommand = buildCommand<LogoutFlags, [string], CfwardContext>({
  func: logout,
  parameters: {
    flags: {
      force: { kind: "boolean", brief: "Remove it without asking" },
    },
    positional: {
      kind: "tuple",
      parameters: [
        { parse: asIs, brief: "Profile to remove", placeholder: "profile" },
      ],
    },
  },
  docs: {
    brief: "Remove a profile and its token from this machine",
  },
});

export const routes = buildRouteMap({
  routes: {
    login: loginCommand,
    list: listCommand,
    use: useCommand,
    run: runCommand,
    status: statusCommand,
    logout: logoutCommand,
  },
  docs: {
    brief: "Manage multiple Cloudflare accounts across projects, with tokens encrypted at rest",
  },
});
