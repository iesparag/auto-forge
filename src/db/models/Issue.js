import mongoose from 'mongoose';

const issueSchema = new mongoose.Schema({
  runId: { type: String, required: true, index: true },
  taskKey: { type: String, required: true }, // stable per-task id within a run
  githubIssueNumber: { type: Number, default: null },
  title: { type: String, default: '' },
  status: { type: String, default: 'pending' }, // pending | in_progress | verified | committed | completed | failed
  branch: { type: String, default: '' },
  files: { type: [String], default: [] }, // paths changed/committed for this task
  prNumber: { type: Number, default: null },
  prUrl: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now },
});

issueSchema.index({ runId: 1, taskKey: 1 }, { unique: true });

export default mongoose.model('Issue', issueSchema);
