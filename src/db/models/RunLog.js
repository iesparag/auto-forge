import mongoose from 'mongoose';

const runLogSchema = new mongoose.Schema({
  runId: { type: String, required: true, index: true },
  message: { type: String, required: true },
  level: { type: String, default: 'info' }, // info | warn | error | success
  createdAt: { type: Date, default: Date.now },
});

export default mongoose.model('RunLog', runLogSchema);
