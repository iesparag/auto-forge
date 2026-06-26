import mongoose from 'mongoose';

// A project/chat: its own prompt (brief), mode, and target. Each project has
// many runs. Credentials & model defaults stay global (Settings).
const projectSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true }, // uuid
    ownerId: { type: String, required: true, index: true },
    name: { type: String, required: true },
    brief: { type: String, default: '' }, // the prompt
    work_mode: { type: String, default: 'new_idea' }, // new_idea | fix_repo | open_source
    target_repo: { type: String, default: '' },
    domain: { type: String, default: 'CLI tools' },
    max_issues: { type: Number, default: 8 },
    // Optional vision context: [{ media_type, data(base64), name }]
    images: { type: [{ media_type: String, data: String, name: String }], default: [] },
    // Extracted text from uploaded PDFs/Excel/Docs: [{ name, text }]
    documents: { type: [{ name: String, text: String }], default: [] },
    // Conversation thread (Claude-style): each turn is a message.
    messages: {
      type: [
        {
          role: String, // 'user' | 'assistant'
          text: String,
          runId: String,
          files: { type: [String], default: [] }, // files changed this turn (assistant)
          prs: { type: [{ number: Number, url: String }], default: [] },
          createdAt: { type: Date, default: Date.now },
        },
      ],
      default: [],
    },
    // The repo this project maintains (set after the first build; for
    // fix/open-source it's the target). Follow-up prompts change THIS repo.
    builtRepo: { type: { owner: String, name: String, url: String }, default: null },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

export default mongoose.model('Project', projectSchema);
