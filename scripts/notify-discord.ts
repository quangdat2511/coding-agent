import { readFile } from "node:fs/promises";

// Each ready pull request gets one post in the team's Discord forum channel. The post's thread ID
// lives in a hidden marker on a pull request comment, so later events reach the same post.

const MARKER = /<!-- discord-thread: (\{.*?\}) -->/;
const BOT_LOGIN = "github-actions[bot]";
const WEBHOOK_USERNAME = "GitHub PR";
const THREAD_NAME_LIMIT = 100;
// GitHub sends review_requested right after opened when reviewers are picked while creating the
// pull request. Those reviewers are already mentioned in the new post.
const CREATION_WINDOW_MS = 2 * 60 * 1000;
// review_requested can arrive before the run that creates the post has saved its marker.
const MARKER_WAIT_MS = 60 * 1000;
const MARKER_POLL_MS = 5 * 1000;

type User = { login: string };

export type PullRequestEvent = {
  action: string;
  number: number;
  requested_reviewer?: User;
  pull_request: {
    title: string;
    html_url: string;
    draft: boolean;
    merged: boolean;
    user: User;
    requested_reviewers: User[];
  };
};

export type ThreadRecord = { id: string; mentioned: string[]; createdAt: string };

export type DiscordMessage = {
  content: string;
  thread_name?: string;
  applied_tags?: string[];
  allowed_mentions: { parse: string[]; users: string[] };
};

export type Plan =
  | { kind: "skip"; reason: string }
  | { kind: "create"; message: DiscordMessage; mentioned: string[] }
  | { kind: "note"; message: DiscordMessage };

export type Config = { userIds: Record<string, string>; tagId?: string };

export function parseUserIds(raw: string | undefined): Record<string, string> {
  if (!raw?.trim()) return {};
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("DISCORD_USER_IDS must be a JSON object from GitHub login to Discord user ID.");
  }
  const userIds: Record<string, string> = {};
  for (const [login, id] of Object.entries(parsed)) {
    if (typeof id !== "string" || !/^\d+$/.test(id)) {
      throw new Error(`DISCORD_USER_IDS has an invalid Discord user ID for ${login}.`);
    }
    userIds[login.toLowerCase()] = id;
  }
  return userIds;
}

export function parseRecord(body: string): ThreadRecord | undefined {
  const json = MARKER.exec(body)?.[1];
  if (json === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(json);
    if (typeof value !== "object" || value === null) return undefined;
    const { id, mentioned, createdAt } = value as Record<string, unknown>;
    if (typeof id !== "string" || !/^\d+$/.test(id)) return undefined;
    if (!Array.isArray(mentioned) || !mentioned.every((login) => typeof login === "string")) {
      return undefined;
    }
    if (typeof createdAt !== "string") return undefined;
    return { id, mentioned, createdAt };
  } catch {
    return undefined;
  }
}

export function formatRecord(record: ThreadRecord): string {
  return `<!-- discord-thread: ${JSON.stringify(record)} -->`;
}

function mention(login: string, userIds: Record<string, string>): string {
  const id = userIds[login.toLowerCase()];
  return id === undefined ? `@${login}` : `<@${id}>`;
}

function people(logins: string[], userIds: Record<string, string>): string {
  return logins.length === 0
    ? "chưa có"
    : logins.map((login) => mention(login, userIds)).join(", ");
}

function message(content: string, logins: string[], config: Config): DiscordMessage {
  const users = new Set<string>();
  for (const login of logins) {
    const id = config.userIds[login.toLowerCase()];
    if (id !== undefined) users.add(id);
  }
  return { content, allowed_mentions: { parse: [], users: [...users] } };
}

function threadName(title: string): string {
  return title.length <= THREAD_NAME_LIMIT ? title : `${title.slice(0, THREAD_NAME_LIMIT - 1)}…`;
}

function createPlan(event: PullRequestEvent, config: Config): Plan {
  const pr = event.pull_request;
  const reviewers = pr.requested_reviewers.map((reviewer) => reviewer.login);
  const content = [
    `PR #${event.number}: <${pr.html_url}>`,
    `Chủ PR: ${mention(pr.user.login, config.userIds)}`,
    `Reviewer: ${people(reviewers, config.userIds)}`,
  ].join("\n");
  const post = message(content, [pr.user.login, ...reviewers], config);
  post.thread_name = threadName(pr.title);
  if (config.tagId) post.applied_tags = [config.tagId];
  const mentioned = [pr.user.login, ...reviewers].map((login) => login.toLowerCase());
  return { kind: "create", message: post, mentioned };
}

export function planEvent(
  event: PullRequestEvent,
  record: ThreadRecord | undefined,
  config: Config,
  now: number,
): Plan {
  const pr = event.pull_request;
  const reviewers = pr.requested_reviewers.map((reviewer) => reviewer.login);
  switch (event.action) {
    case "opened":
      if (pr.draft) return { kind: "skip", reason: "Draft pull request." };
      if (record) return { kind: "skip", reason: "The post already exists." };
      return createPlan(event, config);
    case "ready_for_review":
      if (!record) return createPlan(event, config);
      return {
        kind: "note",
        message: message(
          `PR đã sẵn sàng review lại. Reviewer: ${people(reviewers, config.userIds)}`,
          reviewers,
          config,
        ),
      };
    case "reopened":
      if (pr.draft) return { kind: "skip", reason: "Draft pull request." };
      if (!record) return createPlan(event, config);
      return { kind: "note", message: message("PR được mở lại.", [], config) };
    case "review_requested": {
      const reviewer = event.requested_reviewer?.login;
      if (reviewer === undefined) return { kind: "skip", reason: "A team was requested." };
      if (pr.draft) return { kind: "skip", reason: "Draft pull request." };
      if (!record) return { kind: "skip", reason: "No post for this pull request." };
      const justCreated = now - Date.parse(record.createdAt) < CREATION_WINDOW_MS;
      if (justCreated && record.mentioned.includes(reviewer.toLowerCase())) {
        return { kind: "skip", reason: `${reviewer} is already mentioned in the new post.` };
      }
      return {
        kind: "note",
        message: message(
          `${mention(reviewer, config.userIds)} được request review.`,
          [reviewer],
          config,
        ),
      };
    }
    case "closed":
      if (!record) return { kind: "skip", reason: "No post for this pull request." };
      return {
        kind: "note",
        message: message(
          pr.merged ? "PR đã được merge vào `main`." : "PR đã đóng, không merge.",
          [],
          config,
        ),
      };
    default:
      return { kind: "skip", reason: `Nothing to post for ${event.action}.` };
  }
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export type Dependencies = {
  fetch: Fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
};

const defaults: Dependencies = {
  fetch: (url, init) => fetch(url, init),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

type GitHubContext = {
  env: Record<string, string | undefined>;
  fetch: Fetch;
  number: number;
};

async function github(context: GitHubContext, path: string, init: RequestInit = {}) {
  const api = context.env.GITHUB_API_URL ?? "https://api.github.com";
  const response = await context.fetch(`${api}/repos/${context.env.GITHUB_REPOSITORY}${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${context.env.GITHUB_TOKEN}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) throw new Error(`GitHub ${path} failed with ${response.status}.`);
  return (await response.json()) as unknown;
}

async function findRecord(context: GitHubContext): Promise<ThreadRecord | undefined> {
  const comments = (await github(
    context,
    `/issues/${context.number}/comments?per_page=100`,
  )) as Array<{ body?: string; user?: User }>;
  for (const comment of comments) {
    if (comment.user?.login !== BOT_LOGIN) continue;
    const record = parseRecord(comment.body ?? "");
    if (record) return record;
  }
  return undefined;
}

async function saveRecord(context: GitHubContext, record: ThreadRecord): Promise<void> {
  const body = [
    "Đã tạo post cho PR này trong kênh #ticket-forum trên Discord.",
    formatRecord(record),
  ].join("\n\n");
  await github(context, `/issues/${context.number}/comments`, {
    method: "POST",
    body: JSON.stringify({ body }),
  });
}

async function postToDiscord(
  fetchImpl: Fetch,
  webhook: string,
  query: Record<string, string>,
  payload: DiscordMessage,
): Promise<unknown> {
  const url = new URL(webhook);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  // The webhook URL carries its token, so errors report the status only.
  const response = await fetchImpl(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, username: WEBHOOK_USERNAME }),
  });
  if (!response.ok) throw new Error(`Discord webhook failed with ${response.status}.`);
  return response.status === 204 ? undefined : response.json();
}

export async function run(
  env: Record<string, string | undefined>,
  dependencies: Dependencies = defaults,
): Promise<string> {
  const webhook = env.DISCORD_WEBHOOK_URL;
  if (!webhook) return "DISCORD_WEBHOOK_URL is not set; skipping.";
  if (!env.GITHUB_EVENT_PATH) throw new Error("GITHUB_EVENT_PATH is not set.");

  const event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, "utf8")) as PullRequestEvent;
  const config: Config = {
    userIds: parseUserIds(env.DISCORD_USER_IDS),
    tagId: env.DISCORD_FORUM_TAG_ID?.trim() || undefined,
  };
  const context: GitHubContext = { env, fetch: dependencies.fetch, number: event.number };

  let record = await findRecord(context);
  if (!record && event.action === "review_requested" && !event.pull_request.draft) {
    for (let waited = 0; !record && waited < MARKER_WAIT_MS; waited += MARKER_POLL_MS) {
      await dependencies.sleep(MARKER_POLL_MS);
      record = await findRecord(context);
    }
  }

  const plan = planEvent(event, record, config, dependencies.now());
  if (plan.kind === "skip") return plan.reason;
  if (plan.kind === "note" && record) {
    await postToDiscord(dependencies.fetch, webhook, { thread_id: record.id }, plan.message);
    return `Posted to thread ${record.id}.`;
  }
  if (plan.kind === "create") {
    const created = (await postToDiscord(
      dependencies.fetch,
      webhook,
      { wait: "true" },
      plan.message,
    )) as { channel_id?: string } | undefined;
    const id = created?.channel_id;
    if (id === undefined) throw new Error("Discord did not return the new post's thread ID.");
    await saveRecord(context, {
      id,
      mentioned: plan.mentioned,
      createdAt: new Date(dependencies.now()).toISOString(),
    });
    return `Created post ${id}.`;
  }
  return "Nothing to post.";
}

if (import.meta.main) {
  try {
    console.log(await run(process.env));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
