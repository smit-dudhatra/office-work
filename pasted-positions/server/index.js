import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import multer from 'multer';
import { AngelError, login } from './angel.js';
import { refreshGreeks, streamGreeks } from './greeks.js';
import { ParseError, parseFile, parseText } from './parse.js';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST_DIR = path.join(APP_DIR, 'dist');

// Angel One credentials: this app's .env, else the one in the folder above (shared with the Python scripts).
// Variables already set in the environment win.
for (const file of [path.join(APP_DIR, '.env'), path.join(APP_DIR, '../.env')]) {
  if (fs.existsSync(file)) process.loadEnvFile(file);
}

const PORT = Number(process.env.PORT) || 5050;
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  defParamCharset: 'utf8',
});

app.post('/api/parse/text', express.json({ limit: '10mb' }), (req, res) => {
  const { text, html } = req.body ?? {};
  if (typeof text !== 'string' || !text.trim()) {
    throw new ParseError('Nothing to parse: the pasted text is empty.');
  }
  res.json(parseText(text, typeof html === 'string' ? html : undefined));
});

app.post('/api/parse/file', upload.single('file'), (req, res) => {
  if (!req.file) throw new ParseError('No file received.');
  res.json(parseFile(req.file.buffer, req.file.originalname));
});

app.get('/api/greeks/stream', streamGreeks);

app.post('/api/angel/login', express.json(), async (req, res) => {
  // Failed logins count against the Angel account, so only accept them from this computer
  if (!LOOPBACK.has(req.socket.remoteAddress)) {
    return res.status(403).json({ error: 'Log in from the computer running the server.' });
  }
  await login(String(req.body?.totp ?? '').trim());
  refreshGreeks();
  res.json({ ok: true });
});

app.use('/api', (req, res) => {
  res.status(404).json({ error: `No such endpoint: ${req.method} ${req.originalUrl}` });
});

// After `npm run build`, serve the React app from the same port
if (fs.existsSync(DIST_DIR)) {
  app.use(express.static(DIST_DIR));
  app.use((req, res, next) => {
    if (req.method !== 'GET') return next();
    res.sendFile(path.join(DIST_DIR, 'index.html'));
  });
}

app.use((err, req, res, _next) => {
  if (err instanceof ParseError) return res.status(400).json({ error: err.message });
  if (err instanceof AngelError) return res.status(err.code === 'NETWORK' ? 502 : 400).json({ error: err.message });
  if (err instanceof multer.MulterError) {
    const message = err.code === 'LIMIT_FILE_SIZE' ? 'File is larger than 10 MB.' : err.message;
    return res.status(400).json({ error: message });
  }
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Pasted data is larger than 10 MB.' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Request body is not valid JSON.' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong while parsing the data.' });
});

app.listen(PORT, () => {
  console.log(`pasted-positions API listening on http://localhost:${PORT}`);
});
