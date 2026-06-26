import mongoose from 'mongoose';

// Key/value store. `value` holds encrypted ciphertext for secret keys,
// plaintext for non-secret keys. Encryption is handled in repo.js, not here.
const settingSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    value: { type: String, default: '' },
  },
  { timestamps: true }
);

export default mongoose.model('Setting', settingSchema);
