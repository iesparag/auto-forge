import mongoose from 'mongoose';

// Importing the models here registers them with Mongoose on startup.
import './models/Setting.js';
import './models/User.js';
import './models/Project.js';
import './models/Run.js';
import './models/RunLog.js';
import './models/Issue.js';
import './models/EmailQuery.js';

export async function connectDB() {
  const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/autoforge';
  mongoose.connection.on('error', (err) => {
    console.error('❌ MongoDB connection error:', err.message);
  });
  await mongoose.connect(uri);
  console.log(`✅ Connected to MongoDB (${uri.replace(/\/\/[^@]*@/, '//***@')})`);
  return mongoose.connection;
}
