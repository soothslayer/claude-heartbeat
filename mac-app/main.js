// main.js — Claude Heartbeat menu bar push-to-talk (Electron)
//
// Displays a mic icon in the macOS menu bar.
// Hold Ctrl+Shift+Space (via skhd) to record; release to transcribe and reply.
// No dock icon, no window — lives entirely in the menu bar.
//
// Prerequisites:
//   skhd running with:  ctrl + shift - space : touch /tmp/ptt-held
//   whisper-cli + ggml-base.en.bin model
//   Kokoro-FastAPI at localhost:8880 (optional; falls back to macOS say)
//
// env vars: same as push_to_talk.js — WHISPER_BIN, WHISPER_MODEL, KOKORO_URL,
//           KOKORO_VOICE, PTT_RELEASE_MS, PTT_TRIGGER
//   PTT_IDLE_INTERVAL       seconds between idle pings (default: 15, 0 = off)
//   PTT_IDLE_SOUND          audio file when idle (default: /System/Library/Sounds/Tink.aiff)
//   PTT_THINKING_INTERVAL   seconds between thinking pings (default: 4, 0 = off)
//   PTT_THINKING_SOUND      audio file when Claude is working (default: /System/Library/Sounds/Pop.aiff)

const { app, Tray, Menu, nativeImage, Notification } = require('electron');
const { spawn, spawnSync } = require('child_process');
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const http = require('http');

// ── paths ─────────────────────────────────────────────────────────────────────

const ROOT        = path.resolve(__dirname, '..');
const INBOX       = path.join(ROOT, 'io', 'inbox.jsonl');
const OUTBOX      = path.join(ROOT, 'io', 'outbox.jsonl');
const OFFSET_FILE   = path.join(ROOT, 'io', '.ptt-offset');
const RESTART_FLAG  = path.join(ROOT, 'io', '.restart');
const TMP_WAV     = path.join(os.tmpdir(), 'ptt-in.wav');
const TMP_RESP    = path.join(os.tmpdir(), 'ptt-out.wav');
const TRIGGER     = process.env.PTT_TRIGGER    || '/tmp/ptt-held';

const WHISPER_BIN   = process.env.WHISPER_BIN   || 'whisper-cli';
const WHISPER_MODEL = process.env.WHISPER_MODEL  || path.join(os.homedir(), '.cache', 'whisper', 'ggml-base.en.bin');
const KOKORO_URL    = process.env.KOKORO_URL     || 'http://127.0.0.1:8880/v1/audio/speech';
const KOKORO_VOICE  = process.env.KOKORO_VOICE   || 'af_heart';
const RELEASE_MS         = parseInt(process.env.PTT_RELEASE_MS || '700');
const IDLE_INTERVAL     = parseInt(process.env.PTT_IDLE_INTERVAL     ?? '15');
const IDLE_SOUND        = process.env.PTT_IDLE_SOUND        || '/System/Library/Sounds/Tink.aiff';
const THINKING_INTERVAL = parseInt(process.env.PTT_THINKING_INTERVAL ?? '4');
const THINKING_SOUND    = process.env.PTT_THINKING_SOUND    || '/System/Library/Sounds/Pop.aiff';
const SAMPLE_RATE        = 16000;

// ── state ─────────────────────────────────────────────────────────────────────

let tray         = null;
let recording    = false;
let recProc      = null;
let holdTimer    = null;
let lastTouchMs  = 0;
let outboxOffset = 0;
let busy         = false;

// ── tray icon helpers ─────────────────────────────────────────────────────────

// 1×1 transparent PNG — we rely on setTitle() for the visible emoji
const EMPTY_ICON = nativeImage.createFromDataURL(
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
);

const LABEL = { idle: '🎙', recording: '🔴', transcribing: '⏳', waiting: '💭', speaking: '🔊' };

function setStatus(state, lastText) {
  if (!tray) return;
  tray.setTitle(' ' + LABEL[state]);
  const items = [
    { label: LABEL[state] + '  ' + state.charAt(0).toUpperCase() + state.slice(1), enabled: false },
    lastText ? { label: `📝 ${lastText.slice(0, 60)}`, enabled: false } : null,
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ].filter(Boolean);
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

// ── outbox offset ─────────────────────────────────────────────────────────────

function initOffset() {
  try {
    outboxOffset = parseInt(fs.readFileSync(OFFSET_FILE, 'utf8')) || 0;
  } catch {
    outboxOffset = fs.existsSync(OUTBOX) ? fs.statSync(OUTBOX).size : 0;
    fs.writeFileSync(OFFSET_FILE, String(outboxOffset));
  }
}

function saveOffset() {
  fs.writeFileSync(OFFSET_FILE, String(outboxOffset));
}

// ── recording ─────────────────────────────────────────────────────────────────

function startRec() {
  if (recording || busy) return;
  recording = true;
  setStatus('recording');

  recProc = spawn('rec', ['-q', '-r', String(SAMPLE_RATE), '-c', '1', '-b', '16', TMP_WAV], {
    stdio: 'ignore',
  });

  recProc.on('error', () => {
    recProc = spawn('ffmpeg', [
      '-y', '-f', 'avfoundation', '-i', ':0',
      '-ar', String(SAMPLE_RATE), '-ac', '1', TMP_WAV,
    ], { stdio: 'ignore' });
    recProc.on('error', () => {
      recording = false;
      busy = false;
      setStatus('idle');
      notify('Mic error', 'Could not start recording. Is sox installed?');
    });
  });
}

function stopRec() {
  if (!recording || !recProc) return;
  recording = false;
  busy = true;
  const proc = recProc;
  recProc = null;
  proc.kill('SIGTERM');
  setStatus('transcribing');
  setTimeout(transcribe, 400);
}

// ── trigger-file polling ──────────────────────────────────────────────────────

function pollTrigger() {
  try {
    const { mtimeMs } = fs.statSync(TRIGGER);
    if (mtimeMs <= lastTouchMs) return;
    lastTouchMs = mtimeMs;
    if (!recording && !busy) startRec();
    if (holdTimer) clearTimeout(holdTimer);
    holdTimer = setTimeout(() => { if (recording) stopRec(); }, RELEASE_MS);
  } catch {}
}

// ── transcription ─────────────────────────────────────────────────────────────

let lastTranscript = '';

function transcribe() {
  if (!fs.existsSync(TMP_WAV) || fs.statSync(TMP_WAV).size < 4096) {
    busy = false;
    setStatus('idle');
    return;
  }

  const result = spawnSync(WHISPER_BIN, [
    '-m', WHISPER_MODEL, '-f', TMP_WAV, '--no-timestamps',
  ], { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'ignore'] });

  if (result.error) {
    notify('Whisper error', result.error.message);
    busy = false;
    setStatus('idle');
    return;
  }

  const text = (result.stdout || '')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.match(/^(whisper_|main:|system_info:|ggml_|llama_|\[)/))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!text || text.length < 2) {
    busy = false;
    setStatus('idle');
    return;
  }

  lastTranscript = text;
  setStatus('waiting', text);

  const msg = JSON.stringify({
    ts: new Date().toISOString(),
    channel: 'ptt',
    author: 'user',
    content: text,
  });
  fs.appendFileSync(INBOX, msg + '\n');
  try { fs.writeFileSync(RESTART_FLAG, ''); } catch {}
}

// ── TTS ───────────────────────────────────────────────────────────────────────

async function speak(text) {
  setStatus('speaking', lastTranscript);
  if (!(await kokoroSpeak(text))) {
    spawnSync('say', [text], { timeout: 60000 });
  }
  setStatus('idle');
}

function kokoroSpeak(text) {
  return new Promise((resolve) => {
    const body = Buffer.from(JSON.stringify({
      model: 'kokoro', voice: KOKORO_VOICE, input: text, response_format: 'wav',
    }));
    const url = new URL(KOKORO_URL);
    const req = http.request({
      hostname: url.hostname,
      port: Number(url.port) || 8880,
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return resolve(false); }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        fs.writeFileSync(TMP_RESP, Buffer.concat(chunks));
        const play = spawnSync('afplay', [TMP_RESP]);
        if (play.error) spawnSync('aplay', [TMP_RESP]);
        resolve(true);
      });
    });
    req.on('error', () => resolve(false));
    req.write(body);
    req.end();
  });
}

// ── outbox polling ────────────────────────────────────────────────────────────

function pollOutbox() {
  if (!busy || !fs.existsSync(OUTBOX)) return;
  const size = fs.statSync(OUTBOX).size;
  if (size <= outboxOffset) return;

  const buf = Buffer.alloc(size - outboxOffset);
  const fd  = fs.openSync(OUTBOX, 'r');
  fs.readSync(fd, buf, 0, buf.length, outboxOffset);
  fs.closeSync(fd);
  outboxOffset = size;
  saveOffset();

  for (const line of buf.toString('utf8').split('\n').filter(Boolean)) {
    try {
      const msg = JSON.parse(line);
      if (msg.action === 'send' && msg.content) {
        busy = false;
        speak(msg.content);
        return;
      }
    } catch {}
  }
}

// ── heartbeat ping ────────────────────────────────────────────────────────────

function startHeartbeat() {
  if (IDLE_INTERVAL && fs.existsSync(IDLE_SOUND)) {
    setInterval(() => {
      if (!recording && !busy) {
        spawn('afplay', ['-v', '0.3', IDLE_SOUND], { stdio: 'ignore' });
      }
    }, IDLE_INTERVAL * 1000);
  }
  if (THINKING_INTERVAL && fs.existsSync(THINKING_SOUND)) {
    setInterval(() => {
      if (!recording && busy) {
        spawn('afplay', ['-v', '0.3', THINKING_SOUND], { stdio: 'ignore' });
      }
    }, THINKING_INTERVAL * 1000);
  }
}

// ── notifications ─────────────────────────────────────────────────────────────

function notify(title, body) {
  if (Notification.isSupported()) {
    new Notification({ title, body }).show();
  }
}

// ── app lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  app.dock.hide(); // menu bar only — no dock icon

  tray = new Tray(EMPTY_ICON);
  tray.setToolTip('Claude Heartbeat PTT');
  setStatus('idle');

  // Right-click / click menu
  tray.on('right-click', () => tray.popUpContextMenu());

  initOffset();

  setInterval(pollTrigger, 50);
  setInterval(pollOutbox, 300);
  startHeartbeat();

  // Validate setup on launch
  if (!fs.existsSync(WHISPER_MODEL)) {
    notify('Setup needed', `Whisper model not found at ${WHISPER_MODEL}`);
  }
  const skhdrc = path.join(os.homedir(), '.skhdrc');
  if (!fs.existsSync(skhdrc) || !fs.readFileSync(skhdrc, 'utf8').includes('ptt-held')) {
    notify('Setup needed', 'Add  ctrl + shift - space : touch /tmp/ptt-held  to ~/.skhdrc');
  }
});

app.on('window-all-closed', (e) => e.preventDefault()); // keep alive with no windows

process.on('exit', () => {
  if (recProc) try { recProc.kill(); } catch {}
  try { fs.unlinkSync(TRIGGER); } catch {}
});
