import * as github from '../services/githubService.js';
import { addLog } from '../db/repo.js';

// Commit files sequentially onto a branch of the target repo, each authored by
// the configured user (name/email applied inside githubService).
export async function pushFiles(target, files, commitMessage, branch, runId) {
  let count = 0;
  for (const file of files) {
    if (!file || !file.path) continue;
    const message = `${commitMessage} (${file.path})`;
    await github.putFile(target.commitRepo, file.path, file.content ?? '', message, branch, target.commitOwner);
    count++;
  }
  await addLog(runId, `💾 Committed ${count} file(s) to ${branch}.`);
  return count;
}
