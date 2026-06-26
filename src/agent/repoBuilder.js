import * as github from '../services/githubService.js';
import { addLog } from '../db/repo.js';

const LABELS = [
  { name: 'setup', color: 'c5def5' },
  { name: 'feature', color: '0e8a16' },
  { name: 'enhancement', color: 'a2eeef' },
  { name: 'docs', color: '0075ca' },
  { name: 'bug', color: 'd73a4a' },
  { name: 'in-progress', color: 'fbca04' },
  { name: 'completed', color: '5319e7' },
];

// Create the repo, seed a README, and create the standard label set.
export async function buildRepo(problem, runId) {
  await addLog(runId, `📦 Creating repo: ${problem.title}`);
  // If the name is taken (e.g. re-running the same brief), append a suffix so
  // the run doesn't fail on a 422.
  let repo;
  for (let n = 0; n < 50; n++) {
    const name = n === 0 ? problem.title : `${problem.title}-${n + 1}`;
    try {
      repo = await github.createRepo(name, problem.description || '');
      break;
    } catch (err) {
      if (err?.status === 422 && n < 49) {
        await addLog(runId, `ℹ️ "${name}" already exists — trying a new name…`);
        continue;
      }
      throw err;
    }
  }

  const base = repo.default_branch || 'main';
  // Initial commit: README (also initializes the default branch).
  const readme = `# ${problem.display_name || problem.title}\n\n${problem.description || ''}\n`;
  await github.putFile(repo.name, 'README.md', readme, 'chore: initialize repository', base);

  // Seed the standard planning docs so every project has a consistent structure.
  if (problem.analysis) {
    await github.putFile(repo.name, 'DESIGN.md', `# Design analysis\n\n${problem.analysis}\n`, 'docs: add design analysis', base);
  }
  if (problem.plan) {
    await github.putFile(repo.name, 'plan.md', `# Build plan\n\n${problem.plan}\n`, 'docs: add build plan', base);
  }
  if (problem.architecture) {
    await github.putFile(repo.name, 'ARCHITECTURE.md', `# Architecture\n\n${problem.architecture}\n`, 'docs: add architecture', base);
  }
  await github.putFile(
    repo.name,
    '.gitignore',
    'node_modules/\n.env\ndist/\ncoverage/\n*.log\n.DS_Store\n',
    'chore: add .gitignore',
    base
  );
  await addLog(runId, `✅ Created repo: ${repo.full_name}`, 'success');

  for (const label of LABELS) {
    await github.createLabel(repo.name, label.name, label.color);
  }
  await addLog(runId, `🏷️  Created ${LABELS.length} labels.`);

  return repo;
}
