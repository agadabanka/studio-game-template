/* Minimal Express host implementing the hub convention contracts
 * (/health, /api/meta, /api/diary, /api/config, /api/notes) + static game. */
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const DATA = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA, { recursive: true });
app.use(express.json());

const read = (f, d) => { try { return fs.readFileSync(path.join(__dirname, f), 'utf8'); } catch { return d; } };
const notesFile = path.join(DATA, 'notes.json');
const notes = () => { try { return JSON.parse(fs.readFileSync(notesFile, 'utf8')); } catch { return []; } };

app.get('/health', (_, res) => res.json({ ok: true, ts: Date.now() }));
app.get('/api/meta', (_, res) => res.type('application/json').send(read('GAME_META.json', '{}')));
app.get('/api/diary', (_, res) => res.type('text/markdown').send(read('DIARY.md', '# Diary')));
app.get('/api/config', (_, res) => res.json({ engine: 'studio-phaser4', phaser: '4.1.0', renderer: 'webgl-canvas' }));
app.get('/api/notes', (_, res) => res.json(notes()));
app.post('/api/notes', (req, res) => { const n = notes(); n.push({ id: Date.now(), ...req.body }); fs.writeFileSync(notesFile, JSON.stringify(n, null, 2)); res.json({ ok: true }); });

app.use(express.static(path.join(__dirname, 'src')));
app.listen(PORT, () => console.log('studio game-template on :' + PORT));
