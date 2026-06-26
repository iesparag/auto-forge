import mongoose from 'mongoose';

const emailQuerySchema = new mongoose.Schema({
  runId: { type: String, required: true, index: true },
  taskKey: { type: String, default: '' },
  issueNumber: { type: Number, default: null },
  question: { type: String, default: '' },
  answer: { type: String, default: '' },
  status: { type: String, default: 'pending' }, // pending | answered
  sentAt: { type: Date, default: Date.now },
  answeredAt: { type: Date, default: null },
});

export default mongoose.model('EmailQuery', emailQuerySchema);
