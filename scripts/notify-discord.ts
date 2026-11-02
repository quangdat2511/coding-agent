import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";

// Each ready pull request gets one post in the team's Discord forum channel. The workflow uploads
// the post's thread ID as an artifact named after the pull request, so later events reach the same
// post without leaving anything on the pull request. Posts created before that kept the thread ID
// in a hidden marker on a pull request comment, which is still read.

const MARKER = /<!-- discord-thread: (\{.*?\}) -->/;
const BOT_LOGIN = "github-actions[bot]";
const WEBHOOK_USERNAME = "GitHub PR";
const THREAD_NAME_LIMIT = 100;
const RECORD_FILE = "discord-thread.json";
// GitHub sends review_requested right after opened when reviewers are picked while creating the
// pull request. Those reviewers are already mentioned in the new post.
const CREATION_WINDOW_MS = 2 * 60 * 1000;
// review_requested can arrive before the run that creates the post has uploaded its artifact.
const RECORD_WAIT_MS = 60 * 1000;
const RECORD_POLL_MS = 5 * 1000;

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

export function artifactName(number: number): string {
  return `discord-thread-pr-${number}`;
}

export function parseRecordJson(json: string): ThreadRecord | undefined {
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

export function parseRecord(body: string): ThreadRecord | undefined {
  const json = MARKER.exec(body)?.[1];
  return json === undefined ? undefined : parseRecordJson(json);
}

// Artifacts download as a zip holding the one uploaded file. The central directory has the real
// sizes even when the entry was streamed with a data descriptor.
export function readZipEntry(zip: Uint8Array): string {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let end = zip.length - 22;
  while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end--;
  if (end < 0) throw new Error("The artifact is not a zip file.");
  const central = view.getUint32(end + 16, true);
  if (view.getUint32(central, true) !== 0x02014b50) {
    throw new Error("The artifact zip has no central directory.");
  }
  const method = view.getUint16(central + 10, true);
  const size = view.getUint32(central + 20, true);
  const local = view.getUint32(central + 42, true);
  const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
  const data = zip.subarray(start, start + size);
  if (method === 0) return new TextDecoder().decode(data);
  if (method === 8) return new TextDecoder().decode(inflateRawSync(data));
  throw new Error(`The artifact zip uses unsupported compression method ${method}.`);
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
    case "converted_to_draft":
      if (!record) return { kind: "skip", reason: "No post for this pull request." };
      return {
        kind: "note",
        message: message("PR đã chuyển về Draft, tạm dừng review.", [], config),
      };
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

function githubFetch(context: GitHubContext, path: string, init: RequestInit = {}) {
  const api = context.env.GITHUB_API_URL ?? "https://api.github.com";
  return context.fetch(`${api}/repos/${context.env.GITHUB_REPOSITORY}${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${context.env.GITHUB_TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
}

async function github(context: GitHubContext, path: string): Promise<unknown> {
  const response = await githubFetch(context, path);
  if (!response.ok) throw new Error(`GitHub ${path} failed with ${response.status}.`);
  return response.json();
}

type Artifact = { id: number; name: string; expired: boolean; created_at: string };

async function findArtifactRecord(context: GitHubContext): Promise<ThreadRecord | undefined> {
  const name = artifactName(context.number);
  const { artifacts } = (await github(context, `/actions/artifacts?name=${name}&per_page=100`)) as {
    artifacts: Artifact[];
  };
  // If a pull request ever got two posts, later events keep going to the first one.
  const [artifact] = artifacts
    .filter((candidate) => candidate.name === name && !candidate.expired)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  if (artifact === undefined) return undefined;

  // GitHub redirects to signed storage, which must not receive the GitHub token.
  const path = `/actions/artifacts/${artifact.id}/zip`;
  let download = await githubFetch(context, path, { redirect: "manual" });
  const location = download.headers.get("location");
  if (location !== null) download = await context.fetch(location);
  if (!download.ok) throw new Error(`GitHub ${path} failed with ${download.status}.`);
  return parseRecordJson(readZipEntry(new Uint8Array(await download.arrayBuffer())));
}

async function findCommentRecord(context: GitHubContext): Promise<ThreadRecord | undefined> {
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

async function findRecord(context: GitHubContext): Promise<ThreadRecord | undefined> {
  return (await findArtifactRecord(context)) ?? (await findCommentRecord(context));
}

// The workflow's next step uploads the written file as the pull request's artifact.
async function saveRecord(
  output: string,
  temp: string,
  number: number,
  record: ThreadRecord,
): Promise<void> {
  const directory = join(temp, "discord-thread");
  await mkdir(directory, { recursive: true });
  const path = join(directory, RECORD_FILE);
  await writeFile(path, JSON.stringify(record));
  await appendFile(output, `artifact-name=${artifactName(number)}\nrecord-path=${path}\n`);
}

class DiscordError extends Error {
  readonly status: number;

  constructor(status: number) {
    // The webhook URL carries its token, so errors report the status only.
    super(`Discord webhook failed with ${status}.`);
    this.status = status;
  }
}

async function postToDiscord(
  fetchImpl: Fetch,
  webhook: string,
  query: Record<string, string>,
  payload: DiscordMessage,
): Promise<unknown> {
  const url = new URL(webhook);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  const response = await fetchImpl(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, username: WEBHOOK_USERNAME }),
  });
  if (!response.ok) throw new DiscordError(response.status);
  return response.status === 204 ? undefined : response.json();
}

async function createPost(
  fetchImpl: Fetch,
  webhook: string,
  message: DiscordMessage,
): Promise<{ created: unknown; untagged: boolean }> {
  try {
    return {
      created: await postToDiscord(fetchImpl, webhook, { wait: "true" }, message),
      untagged: false,
    };
  } catch (error) {
    // A wrong or deleted forum tag makes Discord reject the post; the post still matters more
    // than the tag, so create it untagged.
    if (!(error instanceof DiscordError) || error.status !== 400 || !message.applied_tags) {
      throw error;
    }
    const untagged = { ...message, applied_tags: undefined };
    return {
      created: await postToDiscord(fetchImpl, webhook, { wait: "true" }, untagged),
      untagged: true,
    };
  }
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
    for (let waited = 0; !record && waited < RECORD_WAIT_MS; waited += RECORD_POLL_MS) {
      await dependencies.sleep(RECORD_POLL_MS);
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
    // Without these the thread ID could not be saved, and a later event would post a second time.
    const { GITHUB_OUTPUT: output, RUNNER_TEMP: temp } = env;
    if (!output || !temp) {
      throw new Error("GITHUB_OUTPUT and RUNNER_TEMP must be set to save the post's thread ID.");
    }
    const { created, untagged } = await createPost(dependencies.fetch, webhook, plan.message);
    const id = (created as { channel_id?: string } | undefined)?.channel_id;
    if (id === undefined) throw new Error("Discord did not return the new post's thread ID.");
    await saveRecord(output, temp, event.number, {
      id,
      mentioned: plan.mentioned,
      createdAt: new Date(dependencies.now()).toISOString(),
    });
    // A ::warning:: line becomes an annotation on the workflow run, so a bad tag gets noticed.
    return untagged
      ? `::warning::Created post ${id} without the forum tag: Discord rejected DISCORD_FORUM_TAG_ID.`
      : `Created post ${id}.`;
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
