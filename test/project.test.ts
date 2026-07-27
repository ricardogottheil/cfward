import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveProject } from "../src/project/resolve.js";
import { ProjectError } from "../src/project/types.js";

let root: string;

/** Absolute path to `<root>/<segments>`, creating every directory on the way. */
async function tree(...segments: string[]): Promise<string> {
  const dir = join(root, ...segments);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function writeConfig(dir: string, contents: unknown): Promise<void> {
  await writeFile(
    join(dir, ".cfward.json"),
    typeof contents === "string" ? contents : JSON.stringify(contents),
  );
}

beforeEach(async () => {
  // realpath because macOS hands out /var/... temp paths that are symlinks to
  // /private/var/..., and the walk compares path strings.
  root = await realpath(await mkdtemp(join(tmpdir(), "cfward-project-")));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("resolveProject", () => {
  it("finds a config in the starting directory", async () => {
    const repo = await tree("repo");
    await writeConfig(repo, { profile: "production" });

    const found = await resolveProject(repo, { home: root });

    expect(found).toEqual({
      profile: "production",
      configPath: join(repo, ".cfward.json"),
      root: repo,
    });
  });

  it("walks up from a nested directory", async () => {
    const repo = await tree("repo");
    const deep = await tree("repo", "packages", "api", "src");
    await writeConfig(repo, { profile: "staging" });

    const found = await resolveProject(deep, { home: root });

    expect(found?.profile).toBe("staging");
    expect(found?.root).toBe(repo);
  });

  it("returns the nearest config when several are stacked", async () => {
    const repo = await tree("repo");
    const inner = await tree("repo", "packages", "api");
    await writeConfig(repo, { profile: "outer" });
    await writeConfig(inner, { profile: "inner" });

    const found = await resolveProject(join(inner, "src"), { home: root });

    expect(found?.profile).toBe("inner");
  });

  it("returns null when nothing is found", async () => {
    const repo = await tree("repo");
    await mkdir(join(repo, ".git"));

    expect(await resolveProject(repo, { home: root })).toBeNull();
  });

  it("stops at the git repository root", async () => {
    // The config sits ABOVE the repo. A parent checkout must not get to pick
    // the Cloudflare account for a repo nested inside it.
    await writeConfig(root, { profile: "outer-workspace" });
    const repo = await tree("repo");
    await mkdir(join(repo, ".git"));
    const deep = await tree("repo", "src", "handlers");

    expect(await resolveProject(deep, { home: root })).toBeNull();
  });

  it("still finds a config sitting at the git repository root", async () => {
    const repo = await tree("repo");
    await mkdir(join(repo, ".git"));
    await writeConfig(repo, { profile: "production" });
    const deep = await tree("repo", "src");

    expect((await resolveProject(deep, { home: root }))?.profile).toBe(
      "production",
    );
  });

  it("treats a .git file as a boundary, for worktrees and submodules", async () => {
    await writeConfig(root, { profile: "outer-workspace" });
    const worktree = await tree("worktree");
    await writeFile(join(worktree, ".git"), "gitdir: /elsewhere/.git/worktrees/x");

    expect(await resolveProject(worktree, { home: root })).toBeNull();
  });

  it("stops at $HOME", async () => {
    const home = await tree("home", "alice");
    const project = await tree("home", "alice", "scratch", "thing");
    // Above $HOME, so it must never be reached.
    await writeConfig(root, { profile: "should-not-be-used" });

    expect(await resolveProject(project, { home })).toBeNull();
  });

  it("uses a config in $HOME as a personal default", async () => {
    const home = await tree("home", "alice");
    await writeConfig(home, { profile: "personal" });
    const project = await tree("home", "alice", "scratch");

    expect((await resolveProject(project, { home }))?.profile).toBe("personal");
  });

  it("throws rather than walking past a malformed config", async () => {
    await writeConfig(root, { profile: "outer" });
    const repo = await tree("repo");
    await writeConfig(repo, "{ not json");

    await expect(resolveProject(repo, { home: root })).rejects.toMatchObject({
      code: "CONFIG_INVALID_JSON",
    });
  });

  it("reports a config that is a directory instead of a file", async () => {
    const repo = await tree("repo");
    await mkdir(join(repo, ".cfward.json"));

    await expect(resolveProject(repo, { home: root })).rejects.toMatchObject({
      code: "CONFIG_UNREADABLE",
    });
  });
});

describe("config validation", () => {
  async function resolveWith(contents: unknown) {
    const repo = await tree("repo");
    await writeConfig(repo, contents);
    return resolveProject(repo, { home: root });
  }

  it("accepts the documented schema", async () => {
    expect((await resolveWith({ profile: "acme-client" }))?.profile).toBe(
      "acme-client",
    );
  });

  it("rejects a non-object document", async () => {
    await expect(resolveWith(["production"])).rejects.toMatchObject({
      code: "CONFIG_NOT_OBJECT",
    });
  });

  it("rejects a missing profile", async () => {
    await expect(resolveWith({})).rejects.toMatchObject({
      code: "CONFIG_MISSING_PROFILE",
    });
  });

  it("rejects a non-string profile", async () => {
    await expect(resolveWith({ profile: 42 })).rejects.toMatchObject({
      code: "CONFIG_INVALID_PROFILE",
    });
  });

  it("accepts a profile at the 36-character limit", async () => {
    const name = "a".repeat(36);

    expect((await resolveWith({ profile: name }))?.profile).toBe(name);
  });

  it("rejects a profile one character over the limit", async () => {
    await expect(
      // A dot keeps this out of TOKEN_SHAPED's charset, so it is judged purely
      // on length rather than on shape.
      resolveWith({ profile: `${"a".repeat(36)}.` }),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID_PROFILE" });
  });

  it("never reports an accepted-length name as a leaked credential", async () => {
    // The reason MAX_PROFILE_LENGTH sits below TOKEN_SHAPED's floor: at 36
    // characters the shape check cannot fire, so no legitimate name is ever
    // met with "rotate your token".
    for (const length of [1, 20, 35, 36]) {
      const name = "a".repeat(length);
      expect((await resolveWith({ profile: name }))?.profile).toBe(name);
    }
  });

  it("reports a 37-character alphanumeric name as a suspected credential", async () => {
    // Past the boundary both rules could apply, and assertNoSecrets runs first.
    // Pinned because the choice is deliberate: at that length the value really
    // could be a global API key, and the louder error is the safer one.
    await expect(
      resolveWith({ profile: "a".repeat(37) }),
    ).rejects.toMatchObject({ code: "CONFIG_SECRET_IN_FILE" });
  });

  it("rejects a profile with path separators", async () => {
    await expect(resolveWith({ profile: "../../etc" })).rejects.toMatchObject({
      code: "CONFIG_INVALID_PROFILE",
    });
  });

  it("rejects unknown keys", async () => {
    await expect(
      resolveWith({ profile: "production", accountId: "abc123" }),
    ).rejects.toMatchObject({ code: "CONFIG_UNKNOWN_KEY" });
  });

  it.each([
    ["apiToken", { profile: "production", apiToken: "x" }],
    ["api_token", { profile: "production", api_token: "x" }],
    ["CLOUDFLARE_API_TOKEN", { profile: "production", CLOUDFLARE_API_TOKEN: "x" }],
    ["secret", { profile: "production", secret: "x" }],
    ["password", { profile: "production", password: "x" }],
  ])("rejects a key named like a credential: %s", async (_name, contents) => {
    await expect(resolveWith(contents)).rejects.toMatchObject({
      code: "CONFIG_SECRET_IN_FILE",
    });
  });

  it("rejects a credential key nested anywhere in the document", async () => {
    await expect(
      resolveWith({ profile: "production", env: { prod: { apiToken: "x" } } }),
    ).rejects.toMatchObject({ code: "CONFIG_SECRET_IN_FILE" });
  });

  it("rejects a token-shaped value hiding under an innocent key", async () => {
    await expect(
      resolveWith({ profile: "aaaaaaaabbbbbbbbccccccccddddddddeeeeeeee" }),
    ).rejects.toMatchObject({ code: "CONFIG_SECRET_IN_FILE" });
  });

  /** Runs the resolver expecting it to reject, and hands back the error. */
  async function rejectionOf(contents: unknown): Promise<ProjectError> {
    try {
      await resolveWith(contents);
    } catch (err) {
      expect(err).toBeInstanceOf(ProjectError);
      return err as ProjectError;
    }
    throw new Error("expected the config to be rejected");
  }

  it("explains why a committed credential cannot simply be deleted", async () => {
    const error = await rejectionOf({ profile: "production", apiToken: "x" });

    expect(error.hint).toMatch(/git history/);
    expect(error.hint).toMatch(/rotate/i);
    expect(error.hint).toMatch(/cfward login/);
  });

  it("never echoes the suspicious value back", async () => {
    const leaked = "aaaaaaaabbbbbbbbccccccccddddddddeeeeeeee";
    const error = await rejectionOf({ profile: leaked });

    expect(error.message).not.toContain(leaked);
    expect(error.hint ?? "").not.toContain(leaked);
  });
});

