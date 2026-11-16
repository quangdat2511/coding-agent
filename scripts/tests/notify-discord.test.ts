import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import {
  type Config,
  type Dependencies,
  type PullRequestEvent,
  parseRecord,
  parseUserIds,
  planEvent,
  planPush,
  planReview,
  type Replies,
  type Review,
  readZipEntry,
  reviewBurst,
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

// The comment marker that posts created before the artifact kept on their pull request.
function marker(value: ThreadRecord): string {
  return `<!-- discord-thread: ${JSON.stringify(value)} -->`;
}

// A one-file zip as upload-artifact makes it. A streamed entry leaves its sizes out of the local
// header and writes them in a data descriptor after the data, as zip streaming libraries do.
function zip(content: string, method: 0 | 8, streamed = false): Uint8Array {
  const name = new TextEncoder().encode("discord-thread.json");
  const raw = new TextEncoder().encode(content);
  const data = method === 8 ? new Uint8Array(deflateRawSync(raw)) : raw;
  const descriptor = new Uint8Array(streamed ? 16 : 0);

  const local = new DataView(new ArrayBuffer(30));
  local.setUint32(0, 0x04034b50, true);
  local.setUint16(6, streamed ? 0x08 : 0, true);
  local.setUint16(8, method, true);
  local.setUint32(18, streamed ? 0 : data.length, true);
  local.setUint32(22, streamed ? 0 : raw.length, true);
  local.setUint16(26, name.length, true);

  const central = new DataView(new ArrayBuffer(46));
  central.setUint32(0, 0x02014b50, true);
  central.setUint16(10, method, true);
  central.setUint32(20, data.length, true);
  central.setUint32(24, raw.length, true);
  central.setUint16(28, name.length, true);

  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, 1, true);
  end.setUint16(10, 1, true);
  end.setUint32(12, 46 + name.length, true);
  end.setUint32(16, 30 + name.length + data.length + descriptor.length, true);

  const parts = [
    new Uint8Array(local.buffer),
    name,
    data,
    descriptor,
    new Uint8Array(central.buffer),
    name,
    new Uint8Array(end.buffer),
  ];
  const bytes = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
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
  it("is read from an older post's comment body", () => {
    expect(parseRecord(`Đã tạo post.\n\n${marker(record())}`)).toEqual(record());
  });

  it("ignores a missing or malformed marker", () => {
    expect(parseRecord("no marker")).toBeUndefined();
    expect(parseRecord('<!-- discord-thread: {"id":"abc"} -->')).toBeUndefined();
    expect(parseRecord("<!-- discord-thread: {not json} -->")).toBeUndefined();
  });
});

describe("readZipEntry", () => {
  it("reads stored, deflated, and streamed entries", () => {
    const json = JSON.stringify(record());
    expect(readZipEntry(zip(json, 0))).toBe(json);
    expect(readZipEntry(zip(json, 8))).toBe(json);
    expect(readZipEntry(zip(json, 8, true))).toBe(json);
  });

  it("rejects bytes that are not a zip", () => {
    expect(() => readZipEntry(new TextEncoder().encode("not a zip at all, honestly"))).toThrow(
      "not a zip",
    );
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

  it("notes a pull request going back to draft without pinging anyone", () => {
    const draft = event({ action: "converted_to_draft" }, true);
    const plan = planEvent(draft, record(), config, NOW);
    if (plan.kind !== "note") throw new Error(`expected note, got ${plan.kind}`);
    expect(plan.message.content).toBe("PR đã chuyển về Draft, tạm dừng review.");
    expect(plan.message.allowed_mentions.users).toEqual([]);
    expect(plan.archive).toBeUndefined();
    expect(planEvent(draft, undefined, config, NOW).kind).toBe("skip");
  });

  it("notes a merge or a close in the existing post", () => {
    const merged = event({ action: "closed" });
    merged.pull_request.merged = true;
    const plan = planEvent(merged, record(), config, NOW);
    if (plan.kind !== "note") throw new Error(`expected note, got ${plan.kind}`);
    expect(plan.message.content).toBe("PR đã được merge vào `main`.");

    expect(plan.archive).toBe(true);

    const closed = planEvent(event({ action: "closed" }), record(), config, NOW);
    if (closed.kind !== "note") throw new Error(`expected note, got ${closed.kind}`);
    expect(closed.message.content).toBe("PR đã đóng, không merge.");
    expect(closed.archive).toBe(true);
    expect(planEvent(event({ action: "closed" }), undefined, config, NOW).kind).toBe("skip");
  });
});

describe("planPush", () => {
  const push = { sha: "abcdef1234567890", title: "fix the summary", reviewers: ["bob", "carol"] };

  it("notes the head commit and pings the reviewers", () => {
    const plan = planPush(event({ action: "synchronize" }), record(), config, push);
    if (plan.kind !== "note") throw new Error(`expected note, got ${plan.kind}`);
    expect(plan.message.content).toBe(
      "Chủ PR vừa push code mới: `abcdef1` fix the summary\nReviewer: <@222>, @carol",
    );
    expect(plan.message.allowed_mentions.users).toEqual(["222"]);
  });

  it("skips drafts, pull requests without a post, and missing details", () => {
    expect(planPush(event({ action: "synchronize" }, true), record(), config, push).kind).toBe(
      "skip",
    );
    expect(planPush(event({ action: "synchronize" }), undefined, config, push).kind).toBe("skip");
    expect(planPush(event({ action: "synchronize" }), record(), config, undefined).kind).toBe(
      "skip",
    );
  });
});

// A review submitted `minutes` after NOW.
function review(id: number, state: string, login: string, minutes = 0): Review {
  return { id, state, login, submittedAt: new Date(NOW + minutes * 60 * 1000).toISOString() };
}

function noteFor(subject: Review, history: Review[] = [subject], replies: Replies = {}): string {
  const plan = planReview("Alice", subject, history, record(), config, replies);
  if (plan.kind !== "note") throw new Error(`expected note, got ${plan.kind}`);
  return plan.message.content;
}

// The IDs of the reviews in a burst.
function burstIds(subject: Review, history: Review[]): number[] | undefined {
  return reviewBurst(subject, history)?.map((item) => item.id);
}

describe("reviewBurst", () => {
  it("collects the comments that came less than three minutes apart", () => {
    const history = [
      review(1, "COMMENTED", "bob", 0),
      review(2, "COMMENTED", "bob", 4),
      review(3, "COMMENTED", "Bob", 6),
      review(4, "COMMENTED", "carol", 7),
      review(5, "COMMENTED", "bob", 8),
    ];
    expect(burstIds(review(5, "COMMENTED", "bob", 8), history)).toEqual([2, 3, 5]);
    expect(burstIds(review(1, "COMMENTED", "bob", 0), history)).toEqual([1]);
  });

  it("leaves a comment to the newer review from the same reviewer", () => {
    const history = [review(1, "COMMENTED", "bob", 0), review(2, "APPROVED", "bob", 2)];
    expect(burstIds(review(1, "COMMENTED", "bob", 0), history)).toBeUndefined();
    expect(burstIds(review(2, "APPROVED", "bob", 2), history)).toEqual([1]);
  });

  it("stops at an earlier verdict, which was already reported", () => {
    const history = [
      review(1, "COMMENTED", "bob", 0),
      review(2, "CHANGES_REQUESTED", "bob", 1),
      review(3, "COMMENTED", "bob", 2),
    ];
    expect(burstIds(review(3, "COMMENTED", "bob", 2), history)).toEqual([3]);
  });

  it("reports a review it cannot find on its own", () => {
    expect(burstIds(review(9, "COMMENTED", "bob"), [])).toEqual([9]);
    expect(burstIds(review(9, "APPROVED", "bob"), [])).toEqual([]);
  });
});

describe("planReview", () => {
  it("names the verdict and pings only the author", () => {
    const approved = planReview("Alice", review(1, "APPROVED", "bob"), [], record(), config);
    if (approved.kind !== "note") throw new Error(`expected note, got ${approved.kind}`);
    expect(approved.message.content).toBe("<@222> đã approve. <@111>");
    expect(approved.message.allowed_mentions.users).toEqual(["111"]);

    expect(noteFor(review(2, "CHANGES_REQUESTED", "carol"))).toBe("@carol yêu cầu sửa. <@111>");
    expect(noteFor(review(3, "COMMENTED", "bob"))).toBe("<@222> đã comment review. <@111>");
  });

  it("counts a burst of comments in one note", () => {
    const history = [1, 2, 3].map((minute) => review(minute, "COMMENTED", "bob", minute));
    expect(noteFor(review(3, "COMMENTED", "bob", 3), history)).toBe(
      "<@222> đã comment review (3 lần). <@111>",
    );
    const approved = review(4, "APPROVED", "bob", 4);
    expect(noteFor(approved, [...history, approved])).toBe(
      "<@222> đã approve, kèm 3 lần comment. <@111>",
    );
  });

  it("counts replies in existing threads apart from new comments", () => {
    // Reviews 1 to 3 answer old threads, as when the reviewer replies "fixed" and resolves them.
    const history = [1, 2, 3, 4].map((minute) => review(minute, "COMMENTED", "bob", minute));
    const replies: Replies = { 1: [101], 2: [102], 3: [102, 103], 4: [] };
    const last = review(4, "COMMENTED", "bob", 4);
    expect(noteFor(last, history, replies)).toBe(
      "<@222> đã comment review, trả lời 3 thread. <@111>",
    );
    expect(noteFor(review(3, "COMMENTED", "bob", 3), history.slice(0, 3), replies)).toBe(
      "<@222> đã trả lời 3 thread. <@111>",
    );
    const approved = review(5, "APPROVED", "bob", 5);
    expect(noteFor(approved, [...history, approved], replies)).toBe(
      "<@222> đã approve, kèm 1 lần comment, trả lời 3 thread. <@111>",
    );
  });

  it("counts a review with a body as a new comment even when it also replies", () => {
    const withBody = { ...review(1, "COMMENTED", "bob"), body: "Nhìn chung ổn." };
    expect(noteFor(withBody, [withBody], { 1: [101] })).toBe("<@222> đã comment review. <@111>");
  });

  it("skips the author's own replies, bots, dismissed reviews, missing posts, and older comments", () => {
    const skipped = (subject: Review, found = record(), history = [subject]) =>
      planReview("Alice", subject, history, found, config).kind;
    expect(skipped(review(1, "COMMENTED", "alice"))).toBe("skip");
    expect(skipped(review(2, "COMMENTED", "copilot[bot]"))).toBe("skip");
    expect(skipped(review(3, "DISMISSED", "bob"))).toBe("skip");
    const approved = review(4, "APPROVED", "bob");
    expect(planReview("Alice", approved, [approved], undefined, config).kind).toBe("skip");
    const older = review(5, "COMMENTED", "bob", 0);
    expect(skipped(older, record(), [older, review(6, "COMMENTED", "bob", 1)])).toBe("skip");
  });
});

describe("run", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true })));
  });

  type Call = { method: string; url: string; body: unknown; headers: unknown };
  type Artifact = { id: number; name: string; expired: boolean; created_at: string };
  type Fixture = {
    artifacts?: Artifact[][];
    blobs?: Record<number, Uint8Array>;
    comments?: unknown[][];
    // Other GitHub API responses, by full URL.
    responses?: Record<string, unknown>;
    eventName?: string;
    // The status the Discord bot API answers with when the script closes a post.
    archiveStatus?: number;
    // The body of that answer, as Discord sends it.
    archiveError?: string;
  };

  const API = "https://api.github.test/repos/acme/repo";
  const WEBHOOK = "https://discord.test/api/webhooks/1/token";
  const CHANNELS = "https://discord.com/api/v10/channels";

  function artifact(id: number, createdAt: string, expired = false): Artifact {
    return { id, name: "discord-thread-pr-7", expired, created_at: createdAt };
  }

  async function setup(payload: unknown, fixture: Fixture = {}) {
    const directory = await mkdtemp(join(tmpdir(), "notify-discord-"));
    directories.push(directory);
    const eventPath = join(directory, "event.json");
    await writeFile(eventPath, JSON.stringify(payload));

    const calls: Call[] = [];
    const sleeps: number[] = [];
    const artifactListings = [...(fixture.artifacts ?? [])];
    const commentListings = [...(fixture.comments ?? [])];
    const dependencies: Dependencies = {
      fetch: async (url, init = {}) => {
        const method = init.method ?? "GET";
        const body = init.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ method, url, body, headers: init.headers });
        if (url.startsWith("https://discord.test/")) {
          return new Response(JSON.stringify({ id: "1", channel_id: "4242" }), { status: 200 });
        }
        if (url.startsWith(`${CHANNELS}/`)) {
          const body = fixture.archiveError ?? "{}";
          return new Response(body, { status: fixture.archiveStatus ?? 200 });
        }
        if (url === `${API}/actions/artifacts?name=discord-thread-pr-7&per_page=100`) {
          return Response.json({ artifacts: artifactListings.shift() ?? [] });
        }
        const download = /\/actions\/artifacts\/(\d+)\/zip$/.exec(url);
        if (download) {
          const location = `https://blob.test/${download[1]}`;
          return new Response(null, { status: 302, headers: { location } });
        }
        const blob = fixture.blobs?.[Number(url.replace("https://blob.test/", ""))];
        if (blob) return new Response(blob, { status: 200 });
        if (url === `${API}/issues/7/comments?per_page=100`) {
          return Response.json(commentListings.shift() ?? []);
        }
        const response = fixture.responses?.[url];
        if (response !== undefined) return Response.json(response);
        return new Response("unexpected request", { status: 500 });
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      now: () => NOW,
    };
    const env = {
      DISCORD_WEBHOOK_URL: WEBHOOK,
      DISCORD_USER_IDS: '{"alice":"111","bob":"222"}',
      GITHUB_EVENT_NAME: fixture.eventName ?? "pull_request_target",
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_OUTPUT: join(directory, "output"),
      GITHUB_REPOSITORY: "acme/repo",
      GITHUB_API_URL: "https://api.github.test",
      GITHUB_TOKEN: "token",
      RUNNER_TEMP: directory,
    };
    return { calls, sleeps, dependencies, env, directory };
  }

  it("skips without calling anything when the webhook secret is missing", async () => {
    const { calls, dependencies, env } = await setup(event());
    const result = await run({ ...env, DISCORD_WEBHOOK_URL: "" }, dependencies);
    expect(result).toContain("skipping");
    expect(calls).toHaveLength(0);
  });

  it("creates the post and hands its thread ID to the upload step", async () => {
    const { calls, dependencies, env, directory } = await setup(event());
    expect(await run(env, dependencies)).toBe("Created post 4242.");

    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `GET ${API}/actions/artifacts?name=discord-thread-pr-7&per_page=100`,
      `GET ${API}/issues/7/comments?per_page=100`,
      `POST ${WEBHOOK}?wait=true`,
    ]);
    expect(calls[2]?.body).toMatchObject({
      thread_name: "CDA-1 feat: add login",
      username: "GitHub PR",
    });

    const recordPath = join(directory, "discord-thread", "discord-thread.json");
    expect(await readFile(env.GITHUB_OUTPUT, "utf8")).toBe(
      `artifact-name=discord-thread-pr-7\nrecord-path=${recordPath}\n`,
    );
    expect(JSON.parse(await readFile(recordPath, "utf8"))).toEqual({
      id: "4242",
      mentioned: ["alice", "bob", "carol"],
      createdAt: new Date(NOW).toISOString(),
    });
  });

  it("does not create a post whose thread ID it could not save", async () => {
    const { calls, dependencies, env } = await setup(event());
    await expect(run({ ...env, GITHUB_OUTPUT: "" }, dependencies)).rejects.toThrow(
      "GITHUB_OUTPUT and RUNNER_TEMP",
    );
    expect(calls.some((call) => call.url.startsWith("https://discord.test/"))).toBe(false);
  });

  it("finds the post through the oldest live artifact", async () => {
    const merged = event({ action: "closed" });
    merged.pull_request.merged = true;
    const { calls, dependencies, env } = await setup(merged, {
      artifacts: [
        [
          artifact(6, "2026-11-03T00:00:00Z"),
          artifact(5, "2026-11-01T00:00:00Z", true),
          artifact(7, "2026-11-02T00:00:00Z"),
        ],
      ],
      blobs: { 7: zip(JSON.stringify(record()), 0) },
    });

    expect(await run(env, dependencies)).toBe(
      "Posted to thread 999.\nDISCORD_BOT_TOKEN is not set, so the post stays open.",
    );
    const download = calls.find((call) => call.url === "https://blob.test/7");
    expect(download?.headers).toBeUndefined();
    expect(calls.at(-1)?.url).toBe(`${WEBHOOK}?thread_id=999`);
    expect(calls.at(-1)?.body).toMatchObject({ content: "PR đã được merge vào `main`." });
  });

  it("falls back to the comment marker of a post created before the artifact", async () => {
    const legacy = { user: { login: "github-actions[bot]" }, body: marker(record()) };
    const { calls, dependencies, env } = await setup(event({ action: "closed" }), {
      comments: [[legacy]],
    });
    expect(await run(env, dependencies)).toStartWith("Posted to thread 999.\n");
    expect(calls.at(-1)?.url).toBe(`${WEBHOOK}?thread_id=999`);
  });

  it("closes the post with the bot token after noting a merge", async () => {
    const merged = event({ action: "closed" });
    merged.pull_request.merged = true;
    const { calls, dependencies, env } = await setup(merged, {
      comments: [[{ user: { login: "github-actions[bot]" }, body: marker(record()) }]],
    });

    const result = await run({ ...env, DISCORD_BOT_TOKEN: " bot-token " }, dependencies);
    expect(result).toBe("Posted to thread 999.\nClosed post 999.");
    expect(calls.slice(-2).map((call) => `${call.method} ${call.url}`)).toEqual([
      `POST ${WEBHOOK}?thread_id=999`,
      `PATCH ${CHANNELS}/999`,
    ]);
    expect(calls.at(-1)?.body).toEqual({ archived: true });
    expect(calls.at(-1)?.headers).toMatchObject({ Authorization: "Bot bot-token" });
  });

  it("only warns when Discord refuses to close the post", async () => {
    const { calls, dependencies, env } = await setup(event({ action: "closed" }), {
      comments: [[{ user: { login: "github-actions[bot]" }, body: marker(record()) }]],
      archiveStatus: 403,
    });

    const result = await run({ ...env, DISCORD_BOT_TOKEN: "bot-token" }, dependencies);
    expect(result).toBe("Posted to thread 999.\n::warning::Discord did not close post 999: 403.");
    expect(result).not.toContain("bot-token");
    expect(calls.some((call) => call.url === `${WEBHOOK}?thread_id=999`)).toBe(true);
  });

  it("names Discord's error code when it refuses to close the post", async () => {
    const { dependencies, env } = await setup(event({ action: "closed" }), {
      comments: [[{ user: { login: "github-actions[bot]" }, body: marker(record()) }]],
      archiveStatus: 403,
      archiveError: JSON.stringify({ message: "Missing\nPermissions", code: 50013 }),
    });

    expect(await run({ ...env, DISCORD_BOT_TOKEN: "bot-token" }, dependencies)).toBe(
      "Posted to thread 999.\n::warning::Discord did not close post 999: 403, code 50013 (Missing Permissions).",
    );
  });

  it("does not close the post for a note that is not a merge or a close", async () => {
    const { calls, dependencies, env } = await setup(event({ action: "converted_to_draft" }), {
      comments: [[{ user: { login: "github-actions[bot]" }, body: marker(record()) }]],
    });
    expect(await run({ ...env, DISCORD_BOT_TOKEN: "bot-token" }, dependencies)).toBe(
      "Posted to thread 999.",
    );
    expect(calls.some((call) => call.url.startsWith(CHANNELS))).toBe(false);
  });

  it("ignores comment markers that github-actions did not write", async () => {
    const forged = { user: { login: "mallory" }, body: marker(record()) };
    const { calls, dependencies, env } = await setup(event({ action: "closed" }), {
      comments: [[forged]],
    });
    expect(await run(env, dependencies)).toBe("No post for this pull request.");
    expect(calls).toHaveLength(2);
  });

  it("waits for the post's artifact before mentioning a requested reviewer", async () => {
    const requested = event({ action: "review_requested", requested_reviewer: { login: "dave" } });
    const { calls, sleeps, dependencies, env } = await setup(requested, {
      artifacts: [[], [], [artifact(7, "2026-11-02T00:00:00Z")]],
      blobs: { 7: zip(JSON.stringify(record()), 8, true) },
    });

    expect(await run(env, dependencies)).toBe("Posted to thread 999.");
    expect(sleeps).toEqual([5000, 5000]);
    expect(calls.at(-1)?.url).toBe(`${WEBHOOK}?thread_id=999`);
    expect(calls.at(-1)?.body).toMatchObject({ content: "@dave được request review." });
  });

  it("reports a failed webhook call without the webhook URL", async () => {
    const { dependencies, env } = await setup(event());
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
    const { calls, dependencies, env } = await setup(event());
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
    expect(await readFile(env.GITHUB_OUTPUT, "utf8")).toContain("discord-thread-pr-7");
  });

  it("does not retry a rejected post that has no tag", async () => {
    const { dependencies, env } = await setup(event());
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

  it("notes a push and pings the requested reviewers and the people who reviewed", async () => {
    const pushed = event({ action: "synchronize", after: "abcdef1234567890" });
    const { calls, dependencies, env } = await setup(pushed, {
      artifacts: [[artifact(7, "2026-11-02T00:00:00Z")]],
      blobs: { 7: zip(JSON.stringify(record()), 0) },
      responses: {
        [`${API}/commits/abcdef1234567890`]: { commit: { message: "fix the summary\n\nDetails." } },
        [`${API}/pulls/7/reviews?per_page=100`]: [
          { user: { login: "dave" } },
          { user: { login: "Alice" } },
          { user: { login: "bob" } },
          { user: { login: "copilot[bot]" } },
        ],
      },
    });

    expect(await run(env, dependencies)).toBe("Posted to thread 999.");
    expect(calls.at(-1)?.url).toBe(`${WEBHOOK}?thread_id=999`);
    expect(calls.at(-1)?.body).toMatchObject({
      content:
        "Chủ PR vừa push code mới: `abcdef1` fix the summary\nReviewer: <@222>, @carol, @dave",
      allowed_mentions: { parse: [], users: ["222"] },
    });
  });

  it("does not read the push when the pull request has no post", async () => {
    const pushed = event({ action: "synchronize", after: "abcdef1234567890" });
    const { calls, dependencies, env } = await setup(pushed);
    expect(await run(env, dependencies)).toBe("No post for this pull request.");
    expect(calls.some((call) => call.url.includes("/commits/"))).toBe(false);
  });

  function relay(review: unknown) {
    const responses: Record<string, unknown> = {
      [`${API}/actions/runs/123/artifacts`]: {
        artifacts: [
          { id: 50, name: "discord-review-event", expired: false, created_at: "2026-11-02" },
        ],
      },
      [`${API}/pulls/7`]: { base: { ref: "main" }, user: { login: "Alice" } },
      [`${API}/pulls/7/reviews?per_page=100&page=1`]: [
        { id: 55, state: "APPROVED", user: { login: "bob" }, submitted_at: "2026-11-02T10:00:00Z" },
      ],
    };
    return {
      eventName: "workflow_run",
      artifacts: [[artifact(7, "2026-11-02T00:00:00Z")]],
      blobs: { 7: zip(JSON.stringify(record()), 0), 50: zip(JSON.stringify(review), 0) },
      responses,
    };
  }

  // GitHub review objects, `minutes` after NOW.
  function reviews(count: number, state: string, login: string, from: number) {
    return Array.from({ length: count }, (_, index) => ({
      id: from + index,
      state,
      user: { login },
      submitted_at: new Date(NOW + (from + index) * 60 * 1000).toISOString(),
    }));
  }

  it("reads every page of reviews and splits thread replies from new comments", async () => {
    const fixture = relay({ pull_request: { number: 7 }, review: { id: 101 } });
    fixture.responses[`${API}/pulls/7/reviews?per_page=100&page=1`] = [
      ...reviews(98, "COMMENTED", "carol", 0),
      ...reviews(2, "COMMENTED", "bob", 98),
    ];
    fixture.responses[`${API}/pulls/7/reviews?per_page=100&page=2`] = [
      ...reviews(2, "COMMENTED", "bob", 100),
    ];
    const comments = (id: number) => `${API}/pulls/7/reviews/${id}/comments?per_page=100`;
    // Reviews 98 and 99 reply in old threads. Review 100 replies and also opens a new thread.
    fixture.responses[comments(98)] = [{ in_reply_to_id: 7001 }];
    fixture.responses[comments(99)] = [{ in_reply_to_id: 7002 }];
    fixture.responses[comments(100)] = [{ in_reply_to_id: 7003 }, { in_reply_to_id: null }];
    fixture.responses[comments(101)] = [{}];
    const { calls, dependencies, env } = await setup({ workflow_run: { id: 123 } }, fixture);

    expect(await run(env, dependencies)).toBe("Posted to thread 999.");
    expect(calls.at(-1)?.body).toMatchObject({
      content: "<@222> đã comment review (2 lần), trả lời 2 thread. <@111>",
    });
    const read = calls.filter((call) => call.url.endsWith("/comments?per_page=100"));
    expect(read.map((call) => call.url)).toEqual([98, 99, 100, 101].map(comments));
  });

  it("does not post a relayed comment that a newer review reports", async () => {
    const fixture = relay({ pull_request: { number: 7 }, review: { id: 1 } });
    fixture.responses[`${API}/pulls/7/reviews?per_page=100&page=1`] = reviews(
      2,
      "COMMENTED",
      "bob",
      1,
    );
    const { calls, dependencies, env } = await setup({ workflow_run: { id: 123 } }, fixture);

    expect(await run(env, dependencies)).toBe(
      "A newer review from the same reviewer reports this one.",
    );
    expect(calls.some((call) => call.url.startsWith("https://discord.test/"))).toBe(false);
  });

  it("posts a relayed review after reading it back from GitHub", async () => {
    const fixture = relay({ pull_request: { number: 7 }, review: { id: 55 } });
    const { calls, dependencies, env } = await setup({ workflow_run: { id: 123 } }, fixture);

    expect(await run(env, dependencies)).toBe("Posted to thread 999.");
    expect(calls.at(-1)?.url).toBe(`${WEBHOOK}?thread_id=999`);
    expect(calls.at(-1)?.body).toMatchObject({
      content: "<@222> đã approve. <@111>",
      allowed_mentions: { parse: [], users: ["111"] },
    });
  });

  it("ignores a relayed review on a pull request that does not target main", async () => {
    const fixture = relay({ pull_request: { number: 7 }, review: { id: 55 } });
    fixture.responses[`${API}/pulls/7`] = { base: { ref: "develop" }, user: { login: "Alice" } };
    const { dependencies, env } = await setup({ workflow_run: { id: 123 } }, fixture);
    expect(await run(env, dependencies)).toBe("The pull request does not target main.");
  });

  it("rejects a relayed review without a numeric pull request and review ID", async () => {
    const fixture = relay({ pull_request: { number: "7" }, review: { id: 55 } });
    const { dependencies, env } = await setup({ workflow_run: { id: 123 } }, fixture);
    await expect(run(env, dependencies)).rejects.toThrow("no pull request number or review ID");
  });
});
