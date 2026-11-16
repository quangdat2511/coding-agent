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
const COMMIT_TITLE_LIMIT = 150;
const RECORD_FILE = "discord-thread.json";
// The Discord PR Review Relay workflow uploads the submitted review under this name.
const RELAY_ARTIFACT = "discord-review-event";
const REVIEW_VERDICTS: Record<string, string> = {
  APPROVED: "đã approve",
  CHANGES_REQUESTED: "yêu cầu sửa",
  COMMENTED: "đã comment review",
};
// GitHub sends review_requested right after opened when reviewers are picked while creating the
// pull request. Those reviewers are already mentioned in the new post.
const CREATION_WINDOW_MS = 2 * 60 * 1000;
// review_requested can arrive before the run that creates the post has uploaded its artifact.
const RECORD_WAIT_MS = 60 * 1000;
const RECORD_POLL_MS = 5 * 1000;
// Each single comment and each reply in a review thread is a COMMENTED review of its own. The relay
// workflow waits two minutes after a comment, and a newer review from the same reviewer cancels
// that wait, so a burst of comments reaches Discord as one note. Reviews closer together than this
// belong to one burst. It is a minute longer than the relay's wait, so a slow runner does not split
// a burst and lose its first comments.
export const REVIEW_BURST_MS = 3 * 60 * 1000;
const PAGE_SIZE = 100;
const DISCORD_API = "https://discord.com/api/v10";
// Discord asks bot clients to name themselves in this form.
const DISCORD_USER_AGENT = "DiscordBot (https://github.com, 1.0)";

type User = { login: string };

export type PullRequestEvent = {
  action: string;
  number: number;
  requested_reviewer?: User;
  // The head commit after a synchronize event.
  after?: string;
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
  // `archive` closes the post after the note, when the pull request is merged or closed.
  | { kind: "note"; message: DiscordMessage; archive?: boolean };

export type Config = { userIds: Record<string, string>; tagId?: string };

export type Push = { sha: string; title: string; reviewers: string[] };

export type Review = {
  id: number;
  state: string;
  login: string;
  submittedAt: string;
  body?: string;
};

// For each review that only replies in existing threads, the IDs of the comments it answered.
// A reply in the GitHub UI answers the first comment of its thread, so each ID is one thread.
export type Replies = Record<number, number[]>;

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
        archive: true,
      };
    default:
      return { kind: "skip", reason: `Nothing to post for ${event.action}.` };
  }
}

export function planPush(
  event: PullRequestEvent,
  record: ThreadRecord | undefined,
  config: Config,
  push: Push | undefined,
): Plan {
  if (event.pull_request.draft) return { kind: "skip", reason: "Draft pull request." };
  if (!record) return { kind: "skip", reason: "No post for this pull request." };
  if (!push) return { kind: "skip", reason: "No details about the push." };
  const content = [
    `Chủ PR vừa push code mới: \`${push.sha.slice(0, 7)}\` ${push.title}`,
    `Reviewer: ${people(push.reviewers, config.userIds)}`,
  ].join("\n");
  return { kind: "note", message: message(content, push.reviewers, config) };
}

function closeTogether(earlier: Review, later: Review): boolean {
  return Date.parse(later.submittedAt) - Date.parse(earlier.submittedAt) < REVIEW_BURST_MS;
}

// The COMMENTED reviews in the burst that ends at `review`: `review` itself when it is a comment,
// and the comments from the same reviewer just before it, oldest first. Returns undefined when
// `review` is a comment and the same reviewer submitted another review soon after it, because the
// run for that newer review reports this one too.
export function reviewBurst(review: Review, history: Review[]): Review[] | undefined {
  const login = review.login.toLowerCase();
  const own = history
    .filter((other) => other.login.toLowerCase() === login)
    .sort((a, b) => Date.parse(a.submittedAt) - Date.parse(b.submittedAt));
  const index = own.findIndex((other) => other.id === review.id);
  const commented = review.state === "COMMENTED";
  if (index === -1) return commented ? [review] : [];
  const next = own[index + 1];
  if (commented && next !== undefined && closeTogether(review, next)) return undefined;

  const burst = commented ? [review] : [];
  let later = review;
  for (const earlier of own.slice(0, index).reverse()) {
    if (earlier.state !== "COMMENTED" || !closeTogether(earlier, later)) break;
    burst.unshift(earlier);
    later = earlier;
  }
  return burst;
}

// What a burst of comments says: "đã comment review (2 lần), trả lời 10 thread" for a comment, or
// "đã approve, kèm 2 lần comment, trả lời 10 thread" for a verdict that follows comments.
function burstText(review: Review, verdict: string, burst: Review[], replies: Replies): string {
  let fresh = 0;
  const threads = new Set<number>();
  for (const item of burst) {
    const answered = item.body ? [] : (replies[item.id] ?? []);
    if (answered.length === 0) fresh++;
    for (const thread of answered) threads.add(thread);
  }
  const replied = threads.size > 0 ? `trả lời ${threads.size} thread` : "";
  if (review.state === "COMMENTED") {
    if (fresh === 0) return `đã ${replied}`;
    const count = fresh > 1 ? ` (${fresh} lần)` : "";
    return `${verdict}${count}${replied ? `, ${replied}` : ""}`;
  }
  const extra = [fresh > 0 ? `${fresh} lần comment` : "", replied].filter(Boolean);
  return extra.length > 0 ? `${verdict}, kèm ${extra.join(", ")}` : verdict;
}

export function planReview(
  author: string,
  review: Review,
  history: Review[],
  record: ThreadRecord | undefined,
  config: Config,
  replies: Replies = {},
): Plan {
  const verdict = REVIEW_VERDICTS[review.state];
  if (verdict === undefined) {
    return { kind: "skip", reason: `Nothing to post for a ${review.state} review.` };
  }
  // The author's replies to review threads also arrive as reviews.
  if (!review.login || review.login.toLowerCase() === author.toLowerCase()) {
    return { kind: "skip", reason: "The review is not from a reviewer." };
  }
  if (review.login.endsWith("[bot]")) return { kind: "skip", reason: "A bot reviewed." };
  if (!record) return { kind: "skip", reason: "No post for this pull request." };
  const burst = reviewBurst(review, history);
  if (burst === undefined) {
    return { kind: "skip", reason: "A newer review from the same reviewer reports this one." };
  }
  const text = burstText(review, verdict, burst, replies);
  const content = `${mention(review.login, config.userIds)} ${text}. ${mention(author, config.userIds)}`;
  return { kind: "note", message: message(content, [author], config) };
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

async function downloadArtifact(context: GitHubContext, id: number): Promise<string> {
  // GitHub redirects to signed storage, which must not receive the GitHub token.
  const path = `/actions/artifacts/${id}/zip`;
  let download = await githubFetch(context, path, { redirect: "manual" });
  const location = download.headers.get("location");
  if (location !== null) download = await context.fetch(location);
  if (!download.ok) throw new Error(`GitHub ${path} failed with ${download.status}.`);
  return readZipEntry(new Uint8Array(await download.arrayBuffer()));
}

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
  return parseRecordJson(await downloadArtifact(context, artifact.id));
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

// The requested reviewers and everyone who already reviewed, without the author or bots.
async function pushDetails(context: GitHubContext, event: PullRequestEvent): Promise<Push> {
  const sha = event.after;
  if (!sha) throw new Error("The synchronize event has no head commit.");
  const commit = (await github(context, `/commits/${sha}`)) as { commit?: { message?: string } };
  const [title = ""] = (commit.commit?.message ?? "").split("\n");
  const reviews = (await github(
    context,
    `/pulls/${context.number}/reviews?per_page=100`,
  )) as Array<{
    user?: User | null;
  }>;
  const author = event.pull_request.user.login.toLowerCase();
  const reviewers: string[] = [];
  const candidates = [
    ...event.pull_request.requested_reviewers.map((reviewer) => reviewer.login),
    ...reviews.map((review) => review.user?.login),
  ];
  for (const login of candidates) {
    if (!login || login.toLowerCase() === author || login.endsWith("[bot]")) continue;
    if (reviewers.some((known) => known.toLowerCase() === login.toLowerCase())) continue;
    reviewers.push(login);
  }
  const short =
    title.length <= COMMIT_TITLE_LIMIT ? title : `${title.slice(0, COMMIT_TITLE_LIMIT - 1)}…`;
  return { sha, title: short, reviewers };
}

// Every submitted review on the pull request, oldest first.
async function listReviews(context: GitHubContext): Promise<Review[]> {
  const reviews: Review[] = [];
  for (let page = 1; ; page++) {
    const batch = (await github(
      context,
      `/pulls/${context.number}/reviews?per_page=${PAGE_SIZE}&page=${page}`,
    )) as Array<{
      id?: unknown;
      state?: unknown;
      user?: User | null;
      submitted_at?: unknown;
      body?: unknown;
    }>;
    for (const item of batch) {
      const { id, state, submitted_at: submittedAt } = item;
      if (typeof id !== "number" || typeof state !== "string") continue;
      if (typeof submittedAt !== "string") continue;
      const body = typeof item.body === "string" ? item.body : "";
      reviews.push({ id, state, login: item.user?.login ?? "", submittedAt, body });
    }
    if (batch.length < PAGE_SIZE) return reviews;
  }
}

// The comments a review answered, when every comment in it is a reply in an existing thread.
// Empty when the review starts at least one new thread.
async function threadReplies(context: GitHubContext, reviewId: number): Promise<number[]> {
  const comments = (await github(
    context,
    `/pulls/${context.number}/reviews/${reviewId}/comments?per_page=${PAGE_SIZE}`,
  )) as Array<{ in_reply_to_id?: unknown }>;
  const answered: number[] = [];
  for (const comment of comments) {
    if (typeof comment.in_reply_to_id !== "number") return [];
    answered.push(comment.in_reply_to_id);
  }
  return answered;
}

type WorkflowRunEvent = { workflow_run: { id: number } };

// The relay workflow ran with the pull request's code, so only the pull request number and the
// review ID come from its artifact. The review itself is read back from GitHub.
async function postReview(
  env: Record<string, string | undefined>,
  dependencies: Dependencies,
  webhook: string,
  config: Config,
  event: WorkflowRunEvent,
): Promise<string> {
  const repository: GitHubContext = { env, fetch: dependencies.fetch, number: 0 };
  const { artifacts } = (await github(
    repository,
    `/actions/runs/${event.workflow_run.id}/artifacts`,
  )) as { artifacts: Artifact[] };
  const artifact = artifacts.find((candidate) => candidate.name === RELAY_ARTIFACT);
  if (artifact === undefined) return "The relay run left no review.";
  const relayed = JSON.parse(await downloadArtifact(repository, artifact.id)) as {
    pull_request?: { number?: unknown };
    review?: { id?: unknown };
  };
  const number = relayed.pull_request?.number;
  const reviewId = relayed.review?.id;
  if (!Number.isInteger(number) || !Number.isInteger(reviewId)) {
    throw new Error("The relayed review has no pull request number or review ID.");
  }

  const context: GitHubContext = { ...repository, number: number as number };
  const pr = (await github(context, `/pulls/${number}`)) as { base: { ref: string }; user: User };
  if (pr.base.ref !== "main") return "The pull request does not target main.";
  const history = await listReviews(context);
  const review = history.find((candidate) => candidate.id === reviewId);
  if (review === undefined) return "The review is not on the pull request.";
  const record = await findRecord(context);
  const first = planReview(pr.user.login, review, history, record, config);
  if (first.kind === "skip") return first.reason;
  // Only a review that gets a note pays for reading the comments of its burst.
  const replies: Replies = {};
  for (const item of reviewBurst(review, history) ?? []) {
    if (!item.body) replies[item.id] = await threadReplies(context, item.id);
  }
  const plan = planReview(pr.user.login, review, history, record, config, replies);
  if (plan.kind !== "note" || !record) return "Nothing to post.";
  await postToDiscord(dependencies.fetch, webhook, { thread_id: record.id }, plan.message);
  return `Posted to thread ${record.id}.`;
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

// A webhook cannot archive a thread, so this step needs a bot with the Manage Threads permission.
// The post is archived but not locked: Discord unarchives it when a later note arrives through the
// webhook, for example after a reopen. A failure leaves the post open and only warns, because the
// note itself already reached the post.
async function archivePost(
  fetchImpl: Fetch,
  token: string | undefined,
  id: string,
): Promise<string> {
  if (!token?.trim()) return "DISCORD_BOT_TOKEN is not set, so the post stays open.";
  const response = await fetchImpl(`${DISCORD_API}/channels/${id}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bot ${token.trim()}`,
      "Content-Type": "application/json",
      "User-Agent": DISCORD_USER_AGENT,
    },
    body: JSON.stringify({ archived: true }),
  });
  // The token is never part of the message.
  if (!response.ok) {
    const detail = await discordErrorDetail(response);
    return `::warning::Discord did not close post ${id}: ${response.status}${detail}.`;
  }
  return `Closed post ${id}.`;
}

// Discord answers one HTTP status for many causes, and its JSON error code tells them apart: for
// example 50001 when the bot cannot see the channel, 50013 when it lacks a permission. The message
// is cut to one short line, because it ends up in a workflow command.
async function discordErrorDetail(response: Response): Promise<string> {
  try {
    const { code, message } = (await response.json()) as { code?: unknown; message?: unknown };
    if (typeof code !== "number") return "";
    const text =
      typeof message === "string" ? message.replace(/\s+/g, " ").trim().slice(0, 100) : "";
    return text ? `, code ${code} (${text})` : `, code ${code}`;
  } catch {
    return "";
  }
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

  const payload: unknown = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, "utf8"));
  const config: Config = {
    userIds: parseUserIds(env.DISCORD_USER_IDS),
    tagId: env.DISCORD_FORUM_TAG_ID?.trim() || undefined,
  };
  if (env.GITHUB_EVENT_NAME === "workflow_run") {
    return postReview(env, dependencies, webhook, config, payload as WorkflowRunEvent);
  }

  const event = payload as PullRequestEvent;
  const context: GitHubContext = { env, fetch: dependencies.fetch, number: event.number };

  let record = await findRecord(context);
  if (!record && event.action === "review_requested" && !event.pull_request.draft) {
    for (let waited = 0; !record && waited < RECORD_WAIT_MS; waited += RECORD_POLL_MS) {
      await dependencies.sleep(RECORD_POLL_MS);
      record = await findRecord(context);
    }
  }

  let plan: Plan;
  if (event.action === "synchronize") {
    const ready = record && !event.pull_request.draft;
    plan = planPush(event, record, config, ready ? await pushDetails(context, event) : undefined);
  } else {
    plan = planEvent(event, record, config, dependencies.now());
  }
  if (plan.kind === "skip") return plan.reason;
  if (plan.kind === "note" && record) {
    await postToDiscord(dependencies.fetch, webhook, { thread_id: record.id }, plan.message);
    const posted = `Posted to thread ${record.id}.`;
    if (!plan.archive) return posted;
    // A ::warning:: line must start its own line to become an annotation.
    return `${posted}\n${await archivePost(dependencies.fetch, env.DISCORD_BOT_TOKEN, record.id)}`;
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
