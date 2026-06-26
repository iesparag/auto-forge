import { Octokit } from '@octokit/rest';
import { getSettings } from '../db/repo.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Build an Octokit + the configured identity. `owner` defaults to the user.
async function ctx(owner) {
  const settings = await getSettings();
  if (!settings.github_token) throw new Error('GitHub token is not configured. Set it in Settings.');
  return {
    kit: new Octokit({ auth: settings.github_token }),
    self: settings.github_username,
    owner: owner || settings.github_username,
    authorName: settings.github_username,
    authorEmail: settings.github_email,
  };
}

// Rate-limit guard: 1s spacing; on 429/secondary limit wait 60s and retry once.
async function call(fn) {
  await sleep(1000);
  try {
    return await fn();
  } catch (err) {
    if (err?.status === 429 || /rate limit/i.test(err?.message || '')) {
      await sleep(60000);
      return fn();
    }
    throw err;
  }
}

// Parse "owner/name" or a GitHub URL into { owner, repo }.
export function parseRepo(input) {
  if (!input) return null;
  const s = String(input).trim().replace(/\.git$/, '');
  const m = s.match(/github\.com[/:]([^/]+)\/([^/]+)/) || s.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

export async function createRepo(name, description) {
  const { kit } = await ctx();
  const { data } = await call(() =>
    kit.repos.createForAuthenticatedUser({ name, description, private: false, auto_init: false })
  );
  return data;
}

export async function getRepo(owner, repo) {
  const { kit } = await ctx(owner);
  const { data } = await call(() => kit.repos.get({ owner, repo }));
  return data;
}

// Fork a repo to the authenticated user and wait until it's queryable.
export async function forkRepo(owner, repo) {
  const { kit, self } = await ctx(owner);
  await call(() => kit.repos.createFork({ owner, repo }));
  for (let i = 0; i < 10; i++) {
    await sleep(3000);
    try {
      const { data } = await kit.repos.get({ owner: self, repo });
      return data; // fork ready
    } catch {
      /* still forking */
    }
  }
  throw new Error('Fork did not become available in time.');
}

export async function listOpenIssues(owner, repo, limit = 10) {
  const { kit } = await ctx(owner);
  const { data } = await call(() =>
    kit.issues.listForRepo({ owner, repo, state: 'open', per_page: limit })
  );
  // Exclude pull requests (the issues API returns PRs too).
  return data.filter((i) => !i.pull_request).map((i) => ({ number: i.number, title: i.title, body: i.body || '' }));
}

export async function createLabel(repo, label, color = 'ededed', owner) {
  const { kit, owner: o } = await ctx(owner);
  try {
    await call(() => kit.issues.createLabel({ owner: o, repo, name: label, color }));
  } catch (err) {
    if (err?.status !== 422) throw err; // already exists
  }
}

export async function createIssue(repo, title, body, labels = [], owner) {
  const { kit, owner: o } = await ctx(owner);
  const { data } = await call(() => kit.issues.create({ owner: o, repo, title, body, labels }));
  return data;
}

export async function addIssueComment(repo, issueNumber, body, owner) {
  const { kit, owner: o } = await ctx(owner);
  await call(() => kit.issues.createComment({ owner: o, repo, issue_number: issueNumber, body }));
}

export async function addLabels(repo, issueNumber, labels, owner) {
  const { kit, owner: o } = await ctx(owner);
  try {
    await call(() => kit.issues.addLabels({ owner: o, repo, issue_number: issueNumber, labels }));
  } catch (err) {
    if (err?.status !== 404 && err?.status !== 422) throw err; // label may not exist on external repo
  }
}

export async function closeIssue(repo, issueNumber, owner) {
  const { kit, owner: o } = await ctx(owner);
  await call(() => kit.issues.update({ owner: o, repo, issue_number: issueNumber, state: 'closed' }));
}

export async function getDefaultBranch(repo, owner) {
  const { kit, owner: o } = await ctx(owner);
  const { data } = await call(() => kit.repos.get({ owner: o, repo }));
  return data.default_branch;
}

export async function getBranchSha(repo, branch, owner) {
  const { kit, owner: o } = await ctx(owner);
  const { data } = await call(() => kit.git.getRef({ owner: o, repo, ref: `heads/${branch}` }));
  return data.object.sha;
}

export async function createBranch(repo, newBranch, fromBranch, owner) {
  const { kit, owner: o } = await ctx(owner);
  const sha = await getBranchSha(repo, fromBranch, o);
  await call(() => kit.git.createRef({ owner: o, repo, ref: `refs/heads/${newBranch}`, sha }));
  return newBranch;
}

export async function getFileSha(repo, path, branch, owner) {
  const { kit, owner: o } = await ctx(owner);
  try {
    const { data } = await call(() => kit.repos.getContent({ owner: o, repo, path, ref: branch }));
    return Array.isArray(data) ? null : data.sha;
  } catch (err) {
    if (err?.status === 404) return null;
    throw err;
  }
}

// Create/update a file, committed as the configured user (never as Claude).
export async function putFile(repo, path, content, message, branch, owner) {
  const { kit, owner: o, authorName, authorEmail } = await ctx(owner);
  const sha = await getFileSha(repo, path, branch, o);
  const params = {
    owner: o,
    repo,
    path,
    message,
    content: Buffer.from(content, 'utf8').toString('base64'),
    branch,
  };
  if (authorName && authorEmail) {
    params.author = { name: authorName, email: authorEmail };
    params.committer = { name: authorName, email: authorEmail };
  }
  if (sha) params.sha = sha;
  const { data } = await call(() => kit.repos.createOrUpdateFileContents(params));
  return data;
}

// Open a PR. For same-repo PRs, owner = repo owner and head = branch.
// For fork→upstream PRs, owner = upstream owner and head = "forkOwner:branch".
export async function createPR({ owner, repo, head, base, title, body }) {
  const { kit, owner: o } = await ctx(owner);
  const { data } = await call(() => kit.pulls.create({ owner: o, repo, head, base, title, body }));
  return data;
}

export async function mergePR(repo, prNumber, owner) {
  const { kit, owner: o } = await ctx(owner);
  const { data } = await call(() =>
    kit.pulls.merge({ owner: o, repo, pull_number: prNumber, merge_method: 'squash' })
  );
  return data;
}

// Full list of file paths in the repo's default branch.
export async function getTree(repo, owner) {
  const { kit, owner: o } = await ctx(owner);
  const meta = await call(() => kit.repos.get({ owner: o, repo }));
  const branch = meta.data.default_branch;
  const { data } = await call(() =>
    kit.git.getTree({ owner: o, repo, tree_sha: branch, recursive: 'true' })
  );
  return (data.tree || []).filter((t) => t.type === 'blob').map((t) => t.path).sort();
}

// Raw text content of a single file.
export async function getFileContent(repo, path, owner) {
  const { kit, owner: o } = await ctx(owner);
  const { data } = await call(() => kit.repos.getContent({ owner: o, repo, path }));
  if (Array.isArray(data) || !data.content) return '';
  return Buffer.from(data.content, 'base64').toString('utf8');
}

export async function testToken() {
  const { kit } = await ctx();
  const { data } = await call(() => kit.users.getAuthenticated());
  return { ok: true, login: data.login };
}
