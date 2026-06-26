import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', 'public');

const router = express.Router();

router.get('/', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));
router.get('/settings', (req, res) => res.sendFile(path.join(publicDir, 'settings.html')));
router.get('/login', (req, res) => res.sendFile(path.join(publicDir, 'login.html')));
router.get('/register', (req, res) => res.sendFile(path.join(publicDir, 'login.html')));
router.get('/run', (req, res) => res.sendFile(path.join(publicDir, 'run.html')));

export default router;
