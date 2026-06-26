import mongoose from 'mongoose';

// _id is a UUID string (set explicitly by the orchestrator).
const runSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    projectId: { type: String, default: null, index: true },
    userMessage: { type: String, default: '' }, // the prompt that triggered this run
    kind: { type: String, default: 'build' }, // build | change
    // Per-message attachments for this run.
    images: { type: [{ media_type: String, data: String, name: String }], default: [] },
    documents: { type: [{ name: String, text: String }], default: [] },
    status: { type: String, default: 'created' },
    // created | finding_problem | creating_repo | creating_issues |
    // coding_issue_N | waiting_for_reply | completed | failed
    problemTitle: { type: String, default: '' },
    problemDescription: { type: String, default: '' },
    repoName: { type: String, default: '' },
    repoUrl: { type: String, default: '' },
    startedAt: { type: Date, default: Date.now },
    completedAt: { type: Date, default: null },
    error: { type: String, default: '' },
  },
  { _id: false, timestamps: true }
);

export default mongoose.model('Run', runSchema);
