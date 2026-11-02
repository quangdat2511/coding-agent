import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Config,
  type Dependencies,
  formatRecord,
  type PullRequestEvent,
  parseRecord,
  parseUserIds,
  planEvent,
  run,
  type ThreadRecord,
} from "../notify-discord.ts";

const NOW = Date.parse("2026-11-02T10:00:00Z");
const config: Config = { userIds: { alice: "111", bob: "222" } };

function event(overrides: Partial<PullRequestEvent> = {}, draft = false): PullRequestEvent {
  return {
    action: "opened",
    number: 7,
    pull_request: {
      title: "CDA-1 feat: add login",
      html_url: "https://github.com/acme/repo/pull/7",
      draft,
      merged: false,
      user: { login: "Alice" },
      requested_reviewers: [{ login: "bob" }, { login: "carol" }],
    },
    ...overrides,
  };
}

function record(overrides: Partial<ThreadRecord> = {}): ThreadRecord {
  return {
    id: "999",
    mentioned: ["alice", "bob", "carol"],
    createdAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

describe("parseUserIds", () => {
  it("maps lowercased GitHub logins to Discord user IDs", () => {
    expect(parseUserIds('{"Alice":"111"}')).toEqual({ alice: "111" });
    expect(parseUserIds(undefined)).toEqual({});
    expect(parseUserIds("  ")).toEqual({});
  });

  it("rejects anything but an object of numeric IDs", () => {
    expect(() => parseUserIds("[]")).toThrow("JSON object");
    expect(() => parseUserIds('{"alice":"@alice"}')).toThrow("alice");
  });
});

describe("thread record marker", () => {
  it("round-trips through a comment body", () => {
    const body = `Đã tạo post.\n\n${formatRecord(record())}`;
    expect(parseRecord(body)).toEqual(record());
  });

  it("ignores a missing or malformed marker", () => {
    expect(parseRecord("no marker")).toBeUndefined();
    expect(parseRecord('<!-- discord-thread: {"id":"abc"} -->')).toBeUndefined();
    expect(parseRecord("<!-- discord-thread: {not json} -->")).toBeUndefined();
  });
});

describe("planEvent", () => {
  it("creates a post that mentions the author and the requested reviewers", () => {
    const plan = planEvent(event(), undefined, { ...config, tagId: "555" }, NOW);
    expect(plan.kind).toBe("create");
    if (plan.kind !== "create") return;
    expect(plan.message.thread_name).toBe("CDA-1 feat: add login");
    expect(plan.message.content).toContain("<https://github.com/acme/repo/pull/7>");
    expect(plan.message.content).toContain("Chủ PR: <@111>");
    expect(plan.message.content).toContain("Reviewer: <@222>, @carol");
    expect(plan.message.allowed_mentions).toEqual({ parse: [], users: ["111", "222"] });
    expect(plan.message.applied_tags).toEqual(["555"]);
    expect(plan.mentioned).toEqual(["alice", "bob", "carol"]);
  });

  it("leaves the tag out when none is configured and shortens long titles", () => {
    const long = event();
    long.pull_request.title = "x".repeat(150);
    const plan = planEvent(long, undefined, config, NOW);
    if (plan.kind !== "create") throw new Error(`expected create, got ${plan.kind}`);
    expect(plan.message.applied_tags).toBeUndefined();
    expect(plan.message.thread_name).toHaveLength(100);
    expect(plan.message.thread_name?.endsWith("…")).toBe(true);
  });

  it("skips drafts and pull requests that already have a post", () => {
    expect(planEvent(event({}, true), undefined, config, NOW).kind).toBe("skip");
    expect(planEvent(event(), record(), config, NOW).kind).toBe("skip");
  });

  it("creates the post when a draft becomes ready, and notes a second ready", () => {
    const ready = event({ action: "ready_for_review" });
    expect(planEvent(ready, undefined, config, NOW).kind).toBe("create");
    const again = planEvent(ready, record(), config, NOW);
    expect(again.kind).toBe("note");
    if (again.kind !== "note") return;
    expect(again.message.content).toBe("PR đã sẵn sàng review lại. Reviewer: <@222>, @carol");
    expect(again.message.thread_name).toBeUndefined();
  });

  it("mentions a reviewer requested after the post was created", () => {
    const requested = event({ action: "review_requested", requested_reviewer: { login: "Bob" } });
    expect(planEvent(requested, record(), config, NOW + 30_000).kind).toBe("skip");

    const later = planEvent(requested, record(), config, NOW + 10 * 60_000);
    expect(later.kind).toBe("note");
    if (later.kind !== "note") return;
    expect(later.message.content).toBe("<@222> được request review.");
    expect(later.message.allowed_mentions.users).toEqual(["222"]);

    const newcomer = planEvent(requested, record({ mentioned: ["alice"] }), config, NOW + 30_000);
    expect(newcomer.kind).toBe("note");
  });

  it("skips review requests without a post, on drafts, or for teams", () => {
    const requested = event({ action: "review_requested", requested_reviewer: { login: "bob" } });
    expect(planEvent(requested, undefined, config, NOW).kind).toBe("skip");
    const draft = event({ action: "review_requested", requested_reviewer: { login: "bob" } }, true);
    expect(planEvent(draft, record(), config, NOW).kind).toBe("skip");
    expect(planEvent(event({ action: "review_requested" }), record(), config, NOW).kind).toBe(
      "skip",
    );
  });

  it("notes a merge or a close in the existing post", () => {
    const merged = event({ action: "closed" });
    merged.pull_request.merged = true;
    const plan = planEvent(merged, record(), config, NOW);
    if (plan.kind !== "note") throw new Error(`expected note, got ${plan.kind}`);
    expect(plan.message.content).toBe("PR đã được merge vào `main`.");

    const closed = planEvent(event({ action: "closed" }), record(), config, NOW);
    if (closed.kind !== "note") throw new Error(`expected note, got ${closed.kind}`);
    expect(closed.message.content).toBe("PR đã đóng, không merge.");
    expect(planEvent(event({ action: "closed" }), undefined, config, NOW).kind).toBe("skip");
  });
});

describe("run", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true })));
  });

  type Call = { method: string; url: string; body: unknown };

  async function setup(payload: PullRequestEvent, comments: unknown[][]) {
    const directory = await mkdtemp(join(tmpdir(), "notify-discord-"));
    directories.push(directory);
    const eventPath = join(directory, "event.json");
    await writeFile(eventPath, JSON.stringify(payload));

    const calls: Call[] = [];
    const sleeps: number[] = [];
    const listings = [...comments];
    const dependencies: Dependencies = {
      fetch: async (url, init = {}) => {
        const method = init.method ?? "GET";
        calls.push({ method, url, body: init.body ? JSON.parse(String(init.body)) : undefined });
        if (url.startsWith("https://discord.test/")) {
          return new Response(JSON.stringify({ id: "1", channel_id: "4242" }), { status: 200 });
        }
        if (method === "GET") {
          return new Response(JSON.stringify(listings.shift() ?? []), { status: 200 });
        }
        return new Response("{}", { status: 201 });
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      now: () => NOW,
    };
    const env = {
      DISCORD_WEBHOOK_URL: "https://discord.test/api/webhooks/1/token",
      DISCORD_USER_IDS: '{"alice":"111","bob":"222"}',
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_REPOSITORY: "acme/repo",
      GITHUB_API_URL: "https://api.github.test",
      GITHUB_TOKEN: "token",
    };
    return { calls, sleeps, dependencies, env };
  }

  it("skips without calling anything when the webhook secret is missing", async () => {
    const { calls, dependencies, env } = await setup(event(), []);
    const result = await run({ ...env, DISCORD_WEBHOOK_URL: "" }, dependencies);
    expect(result).toContain("skipping");
    expect(calls).toHaveLength(0);
  });

  it("creates the post and saves its thread ID on the pull request", async () => {
    const { calls, dependencies, env } = await setup(event(), [[]]);
    expect(await run(env, dependencies)).toBe("Created post 4242.");

    const [listing, post, comment] = calls;
    expect(listing?.url).toBe(
      "https://api.github.test/repos/acme/repo/issues/7/comments?per_page=100",
    );
    expect(post?.url).toBe("https://discord.test/api/webhooks/1/token?wait=true");
    expect(post?.body).toMatchObject({
      thread_name: "CDA-1 feat: add login",
      username: "GitHub PR",
    });
    expect(comment?.url).toBe("https://api.github.test/repos/acme/repo/issues/7/comments");
    const saved = parseRecord((comment?.body as { body?: string } | undefined)?.body ?? "");
    expect(saved).toEqual({
      id: "4242",
      mentioned: ["alice", "bob", "carol"],
      createdAt: new Date(NOW).toISOString(),
    });
  });

  it("waits for the post before mentioning a requested reviewer", async () => {
    const marker = { user: { login: "github-actions[bot]" }, body: formatRecord(record()) };
    const requested = event({ action: "review_requested", requested_reviewer: { login: "dave" } });
    const { calls, sleeps, dependencies, env } = await setup(requested, [[], [], [marker]]);

    expect(await run(env, dependencies)).toBe("Posted to thread 999.");
    expect(sleeps).toEqual([5000, 5000]);
    const post = calls.at(-1);
    expect(post?.url).toBe("https://discord.test/api/webhooks/1/token?thread_id=999");
    expect(post?.body).toMatchObject({ content: "@dave được request review." });
  });

  it("ignores markers that github-actions did not write", async () => {
    const forged = { user: { login: "mallory" }, body: formatRecord(record()) };
    const { calls, dependencies, env } = await setup(event({ action: "closed" }), [[forged]]);
    expect(await run(env, dependencies)).toBe("No post for this pull request.");
    expect(calls).toHaveLength(1);
  });

  it("reports a failed webhook call without the webhook URL", async () => {
    const { dependencies, env } = await setup(event(), [[]]);
    const failing: Dependencies = {
      ...dependencies,
      fetch: async (url, init) =>
        url.startsWith("https://discord.test/")
          ? new Response("rate limited", { status: 429 })
          : dependencies.fetch(url, init),
    };
    await expect(run(env, failing)).rejects.toThrow("Discord webhook failed with 429.");
  });

  it("creates the post untagged when Discord rejects the forum tag", async () => {
    const { calls, dependencies, env } = await setup(event(), [[]]);
    let rejected: unknown;
    const rejecting: Dependencies = {
      ...dependencies,
      fetch: async (url, init) => {
        if (url.startsWith("https://discord.test/") && rejected === undefined) {
          rejected = JSON.parse(String(init?.body));
          return new Response('{"message":"Invalid Form Body"}', { status: 400 });
        }
        return dependencies.fetch(url, init);
      },
    };

    expect(await run({ ...env, DISCORD_FORUM_TAG_ID: "555" }, rejecting)).toBe(
      "::warning::Created post 4242 without the forum tag: Discord rejected DISCORD_FORUM_TAG_ID.",
    );
    expect(rejected).toMatchObject({ applied_tags: ["555"] });
    const retry = calls.find((call) => call.url.startsWith("https://discord.test/"));
    expect(retry?.body).toMatchObject({ thread_name: "CDA-1 feat: add login" });
    expect((retry?.body as { applied_tags?: string[] } | undefined)?.applied_tags).toBeUndefined();
    expect(calls.at(-1)?.url).toBe("https://api.github.test/repos/acme/repo/issues/7/comments");
  });

  it("does not retry a rejected post that has no tag", async () => {
    const { dependencies, env } = await setup(event(), [[]]);
    let posts = 0;
    const rejecting: Dependencies = {
      ...dependencies,
      fetch: async (url, init) => {
        if (!url.startsWith("https://discord.test/")) return dependencies.fetch(url, init);
        posts++;
        return new Response('{"message":"Invalid Form Body"}', { status: 400 });
      },
    };

    await expect(run(env, rejecting)).rejects.toThrow("Discord webhook failed with 400.");
    expect(posts).toBe(1);
  });
});
