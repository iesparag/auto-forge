import { mkdir, writeFile, readFile, rm, readdir, stat } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { spawn } from 'child_process';

// Per-run workspace where generated code is written, installed, and verified
// BEFORE being committed to GitHub. This executes AI-generated code locally —
// see the security note in the README.

const ROOT = path.join(process.cwd(), 'data', 'workspaces');
// Dedicated npm cache to avoid the user's (possibly permission-broken) global ~/.npm cache.
const NPM_CACHE = path.join(process.cwd(), 'data', 'npm-cache');
const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage']);
const MAX_CONTEXT_BYTES = 50 * 1024; // skip huge files when building context

export async function createWorkspace(runId) {
  const dir = path.join(ROOT, String(runId));
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function cleanupWorkspace(runId) {
  await rm(path.join(ROOT, String(runId)), { recursive: true, force: true }).catch(() => {});
}

// Shallow-clone an existing repo into the workspace so the real test suite can
// run and Claude gets the full codebase as context. `token` (optional) is used
// for private repos. Returns { ok, output }.
export async function cloneRepo(dir, owner, repo, token) {
  // Ensure the destination is empty (a leftover clone would make git fail).
  await rm(dir, { recursive: true, force: true }).catch(() => {});
  await mkdir(dir, { recursive: true });
  const auth = token ? `${encodeURIComponent(token)}@` : '';
  const url = `https://${auth}github.com/${owner}/${repo}.git`;
  const { code, output } = await run('git', ['clone', '--depth', '1', url, '.'], {
    cwd: dir,
    timeout: 120000,
  });
  return { ok: code === 0, output };
}

export async function writeFiles(dir, files) {
  for (const f of files) {
    if (!f || !f.path) continue;
    // Reject path traversal outside the workspace.
    const full = path.resolve(dir, f.path);
    if (!full.startsWith(path.resolve(dir) + path.sep) && full !== path.resolve(dir)) continue;
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, f.content ?? '');
  }
}

// Recursively walk source files (skipping deps/build dirs).
async function walk(dir, base = dir) {
  let entries = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (IGNORE_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(await walk(full, base)));
    } else if (e.isFile()) {
      out.push(path.relative(base, full));
    }
  }
  return out;
}

// Read the current project as a { relativePath: content } map for prompt context.
export async function readProject(dir) {
  const files = await walk(dir);
  const map = {};
  for (const rel of files) {
    if (rel === 'package-lock.json' || rel.endsWith('.lock')) continue;
    try {
      const full = path.join(dir, rel);
      const s = await stat(full);
      if (s.size > MAX_CONTEXT_BYTES) continue;
      map[rel] = await readFile(full, 'utf8');
    } catch {
      /* skip unreadable */
    }
  }
  return map;
}

// Run a command, capturing combined output with a timeout. Never throws.
function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'], // no stdin → test runners won't wait for input
      env: { ...process.env, ...(opts.env || {}) },
    });
    let out = '';
    const onData = (d) => {
      out += d.toString();
      if (out.length > 20000) out = out.slice(-20000); // keep tail
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      out += `\n[timed out after ${opts.timeout || 120000}ms]`;
    }, opts.timeout || 120000);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, output: out + `\n[spawn error: ${err.message}]` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, output: out });
    });
  });
}

// Pull the meaningful cause out of npm's noisy output (skip the "complete log"
// pointer and keep the actual error lines).
function npmCause(output) {
  const lines = (output || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const errLines = lines.filter(
    (l) => /npm error|ERR!|E404|ETARGET|ENOTFOUND|EACCES|EEXIST|notarget|404|cannot find|No matching version/i.test(l) &&
      !/complete log of this run|debug-0\.log|npm error A complete/i.test(l)
  );
  const pick = (errLines.length ? errLines : lines).slice(0, 8).join('\n');
  return pick || 'unknown npm error';
}

// Parse the number of failing tests from a test runner's output.
function parseFailCount(out) {
  let m = out.match(/#\s*fail\s+(\d+)/i); // node --test
  if (m) return parseInt(m[1], 10);
  m = out.match(/(\d+)\s+failed/i); // vitest/jest "Tests 3 failed"
  if (m) return parseInt(m[1], 10);
  return out ? 1 : 0;
}

// Pull failing test names + first assertion lines for a readable summary.
function testFailureSummary(out, failCount) {
  const lines = out.split('\n').map((l) => l.trim());
  const names = lines.filter((l) => /^(✖|×|✗|not ok)/.test(l)).slice(0, 8);
  const errs = lines
    .filter((l) => /AssertionError|Error:|Expected|Received|to (be|equal|deep)/i.test(l))
    .slice(0, 6);
  const head = `Failing tests (${failCount}):`;
  const detail = [...names, ...errs].join('\n') || '(see full output below)';
  return `${head}\n${detail}\n\n--- output tail ---\n${out.trim().slice(-2500)}`;
}

// Verify the project. Returns { ok, output, stage, failCount }.
//   stage: 'syntax' | 'install' | 'test' | 'build' | 'none'
//   failCount: number of failing tests (test stage); -1 for hard failures
//              (syntax/install) that must always be fixed; 0 when ok.
// onStep(message) is called as each phase starts, for live progress logging.
export async function verify(dir, onStep = () => {}) {
  const files = await walk(dir);
  const jsFiles = files.filter((f) => /\.(js|mjs|cjs)$/.test(f));

  // 1. Syntax checks (hard fail).
  const syntaxErrors = [];
  for (const rel of jsFiles) {
    const { code, output } = await run(process.execPath, ['--check', rel], { cwd: dir, timeout: 15000 });
    if (code !== 0) syntaxErrors.push(`Syntax error in ${rel}:\n${output.trim()}`);
  }
  if (syntaxErrors.length) {
    return { ok: false, stage: 'syntax', failCount: -1, output: syntaxErrors.join('\n\n') };
  }

  const pkgPath = path.join(dir, 'package.json');
  if (!existsSync(pkgPath)) {
    return { ok: true, stage: 'none', failCount: 0, output: 'Syntax OK (no package.json).' };
  }

  let pkg = {};
  try {
    pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
  } catch (e) {
    return { ok: false, stage: 'syntax', failCount: -1, output: `package.json is not valid JSON: ${e.message}` };
  }

  // 2. Install (hard fail).
  const hasDeps =
    Object.keys(pkg.dependencies || {}).length || Object.keys(pkg.devDependencies || {}).length;
  if (hasDeps) {
    onStep('📦 Installing dependencies (first run can take ~1 min)…');
    await mkdir(NPM_CACHE, { recursive: true });
    const install = await run(
      'npm',
      ['install', '--no-audit', '--no-fund', '--loglevel=error', '--cache', NPM_CACHE],
      { cwd: dir, timeout: 180000 }
    );
    if (install.code !== 0) {
      return { ok: false, stage: 'install', failCount: -1, output: `npm install failed:\n${npmCause(install.output)}` };
    }
  }

  // 3. Test / build (soft fail — failCount lets callers ignore pre-existing failures).
  const testEnv = { CI: 'true', npm_config_cache: NPM_CACHE };
  const scripts = pkg.scripts || {};
  const realTest = scripts.test && !/no test specified/i.test(scripts.test);
  if (realTest) {
    onStep('🧪 Running tests…');
    const t = await run('npm', ['test'], { cwd: dir, timeout: 180000, env: testEnv });
    if (t.code === 0) return { ok: true, stage: 'test', failCount: 0, output: 'Tests passed.' };
    const failCount = parseFailCount(t.output);
    return { ok: false, stage: 'test', failCount, output: testFailureSummary(t.output, failCount) };
  }
  if (scripts.build) {
    const b = await run('npm', ['run', 'build'], { cwd: dir, timeout: 180000, env: testEnv });
    if (b.code === 0) return { ok: true, stage: 'build', failCount: 0, output: 'Build passed.' };
    return { ok: false, stage: 'build', failCount: 1, output: `npm run build failed:\n${b.output.trim().slice(-2500)}` };
  }

  return { ok: true, stage: 'none', failCount: 0, output: 'Syntax OK, dependencies installed (no test/build).' };
}
