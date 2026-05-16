// main.js — Claude Heartbeat  (Electron menu bar app)
//
// Double-click to launch:
//   • Opens Terminal.app running supervisor.js (the Claude Code agent loop)
//   • Shows a mic icon in the macOS menu bar for push-to-talk
//
// On first launch (packaged app) a dialog asks you to locate the
// claude-heartbeat workspace directory.  The path is stored in:
//   ~/Library/Application Support/claude-heartbeat/settings.json
//
// env vars:
//   PTT_MODE              toggle (default) or hold
//   PTT_RELEASE_MS        hold: ms silence before stop; toggle: debounce window (default 700)
//   PTT_TRIGGER           trigger file path (default /tmp/ptt-held)
//   WHISPER_BIN           whisper-cli binary path (default: whisper-cli)
//   WHISPER_MODEL         ggml model path (default: ~/.cache/whisper/ggml-base.en.bin)
//   KOKORO_URL            TTS endpoint (default: http://127.0.0.1:8880/v1/audio/speech)
//   KOKORO_VOICE          voice name (default: af_heart)
//   PTT_IDLE_INTERVAL     seconds between idle Tink pings (default: 15, 0 = off)
//   PTT_IDLE_SOUND        idle ping audio file
//   PTT_THINKING_INTERVAL seconds between thinking Pop pings (default: 4, 0 = off)
//   PTT_THINKING_SOUND    thinking ping audio file

// GUI apps launched via Finder don't inherit the shell PATH — add Homebrew manually
process.env.PATH = [
  '/opt/homebrew/bin',   // Apple Silicon
  '/usr/local/bin',      // Intel
  '/usr/bin',
  '/bin',
  process.env.PATH || '',
].filter(Boolean).join(':');

const { app, Tray, Menu, dialog, nativeImage, Notification, shell } = require('electron');
const { spawn, spawnSync } = require('child_process');
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const http = require('http');

// ── config ────────────────────────────────────────────────────────────────────

const WHISPER_BIN   = process.env.WHISPER_BIN   || 'whisper-cli';
const WHISPER_MODEL = process.env.WHISPER_MODEL  || path.join(os.homedir(), '.cache', 'whisper', 'ggml-base.en.bin');
const KOKORO_URL    = process.env.KOKORO_URL     || 'http://127.0.0.1:8880/v1/audio/speech';
const KOKORO_VOICE  = process.env.KOKORO_VOICE   || 'af_heart';
const PTT_MODE      = (process.env.PTT_MODE || 'toggle').toLowerCase();
const RELEASE_MS    = parseInt(process.env.PTT_RELEASE_MS    || '700');
const IDLE_INT      = parseInt(process.env.PTT_IDLE_INTERVAL     ?? '15');
const IDLE_SND      = process.env.PTT_IDLE_SOUND      || '/System/Library/Sounds/Tink.aiff';
const THINK_INT     = parseInt(process.env.PTT_THINKING_INTERVAL ?? '4');
const THINK_SND     = process.env.PTT_THINKING_SOUND  || '/System/Library/Sounds/Pop.aiff';
const START_SND     = process.env.PTT_START_SOUND     || '/System/Library/Sounds/Ping.aiff';
const STOP_SND      = process.env.PTT_STOP_SOUND      || '/System/Library/Sounds/Bottle.aiff';
const TRIGGER       = process.env.PTT_TRIGGER    || '/tmp/ptt-held';
const SAMPLE_RATE   = 16000;

// ── workspace (resolved after app.whenReady) ──────────────────────────────────

let ROOT, INBOX, OUTBOX, OFFSET_FILE, RESTART_FLAG, SUPERVISOR_PID;

function initPaths(workspacePath) {
  ROOT          = workspacePath;
  INBOX         = path.join(ROOT, 'io', 'inbox.jsonl');
  OUTBOX        = path.join(ROOT, 'io', 'outbox.jsonl');
  OFFSET_FILE   = path.join(ROOT, 'io', '.ptt-offset');
  RESTART_FLAG  = path.join(ROOT, 'io', '.restart');
  SUPERVISOR_PID = path.join(ROOT, 'io', '.supervisor.pid');
}

const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch { return {}; }
}

function saveSettings(obj) {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(obj, null, 2));
}

function resolveWorkspace() {
  if (!app.isPackaged) return path.resolve(__dirname, '..');

  const { workspacePath } = loadSettings();
  if (workspacePath && fs.existsSync(path.join(workspacePath, 'supervisor.js'))) {
    return workspacePath;
  }

  // Auto-detect common locations
  for (const candidate of [
    path.join(os.homedir(), 'git', 'claude-heartbeat'),
    path.join(os.homedir(), 'claude-heartbeat'),
    path.join(os.homedir(), 'Documents', 'claude-heartbeat'),
  ]) {
    if (fs.existsSync(path.join(candidate, 'supervisor.js'))) {
      saveSettings({ workspacePath: candidate });
      return candidate;
    }
  }

  // Ask the user
  const result = dialog.showOpenDialogSync({
    title: 'Locate claude-heartbeat folder',
    message: 'Select the claude-heartbeat directory (contains supervisor.js)',
    properties: ['openDirectory'],
  });
  if (!result || !result[0]) { app.quit(); return null; }
  const chosen = result[0];
  if (!fs.existsSync(path.join(chosen, 'supervisor.js'))) {
    dialog.showErrorBox('Wrong folder', 'That folder does not contain supervisor.js. Please try again.');
    app.quit();
    return null;
  }
  saveSettings({ workspacePath: chosen });
  return chosen;
}

// ── terminal / supervisor ─────────────────────────────────────────────────────

const TERM_TITLE = 'Claude Heartbeat — Supervisor';

function isSupervisorRunning() {
  try {
    const pid = parseInt(fs.readFileSync(SUPERVISOR_PID, 'utf8').trim());
    if (!pid) return false;
    process.kill(pid, 0); // throws ESRCH if not running
    return true;
  } catch { return false; }
}

function launchSupervisor() {
  if (isSupervisorRunning()) return;
  const escaped = ROOT.replace(/'/g, "'\\''");
  // Open Terminal, run supervisor, set a recognisable window title so we can close it on quit
  const script = `
    tell application "Terminal"
      set w to do script "cd '${escaped}' && node supervisor.js"
      set custom title of (window 1) to "${TERM_TITLE}"
      activate
    end tell`;
  spawn('osascript', ['-e', script], { stdio: 'ignore' });
}

function killSupervisor() {
  try {
    const pid = parseInt(fs.readFileSync(SUPERVISOR_PID, 'utf8').trim());
    if (pid) process.kill(pid, 'SIGTERM');
  } catch {}
}

function closeSupervisorTerminal() {
  // 1. Send 'exit' to the shell so Terminal sees no running process (no confirm dialog)
  const exitScript = `
    tell application "Terminal"
      repeat with w in windows
        try
          if custom title of w is "${TERM_TITLE}" then
            do script "exit" in w
          end if
        end try
      end repeat
    end tell`;
  spawnSync('osascript', ['-e', exitScript]);

  // 2. Brief pause so the shell exits, then close the window
  spawnSync('sleep', ['0.4']);

  const closeScript = `
    tell application "Terminal"
      repeat with w in windows
        try
          if custom title of w is "${TERM_TITLE}" then
            close w
          end if
        end try
      end repeat
    end tell`;
  spawnSync('osascript', ['-e', closeScript]);
}

// ── state ─────────────────────────────────────────────────────────────────────

let tray         = null;
let recording    = false;
let recProc      = null;
let holdTimer      = null;
let toggleCooldown = false;
let lastTouchMs    = 0;
let outboxOffset   = 0;
let busy         = false;
let lastTranscript = '';

// ── tray icon ─────────────────────────────────────────────────────────────────

// 1×1 transparent PNG — emoji in setTitle() is the visible indicator
const EMPTY_ICON = nativeImage.createFromDataURL(
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
);

const LABEL = { idle: '🎙', recording: '🔴', transcribing: '⏳', waiting: '💭', speaking: '🔊' };

function setStatus(state) {
  if (!tray) return;
  tray.setTitle(' ' + LABEL[state]);
  const modeHint = PTT_MODE === 'toggle'
    ? 'Press Ctrl+Shift+Space to start/stop'
    : 'Hold Ctrl+Shift+Space to record';
  const items = [
    { label: 'Claude Heartbeat', enabled: false },
    { label: `${LABEL[state]}  ${state.charAt(0).toUpperCase() + state.slice(1)}`, enabled: false },
    lastTranscript ? { label: `📝 ${lastTranscript.slice(0, 55)}`, enabled: false } : null,
    { type: 'separator' },
    { label: modeHint, enabled: false },
    { type: 'separator' },
    {
      label: 'Open Terminal (supervisor)',
      click: () => launchSupervisor(),
    },
    {
      label: 'Change Workspace…',
      click: () => {
        saveSettings({});
        dialog.showMessageBoxSync({ message: 'Workspace cleared. Restart the app to re-select.' });
      },
    },
    { type: 'separator' },
    { label: 'Quit', click: () => {
      killSupervisor();
      spawnSync('sleep', ['0.3']); // let supervisor process die before sending exit to shell
      closeSupervisorTerminal();
      app.quit();
    } },
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

const TMP_WAV  = path.join(os.tmpdir(), 'ptt-in.wav');
const TMP_RESP = path.join(os.tmpdir(), 'ptt-out.wav');

function startRec() {
  if (recording || busy) return;
  recording = true;
  spawn('afplay', ['-v', '0.6', START_SND], { stdio: 'ignore' });
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
      recording = false; busy = false; setStatus('idle');
      notify('Mic error', 'Could not start recording. Is sox installed?');
    });
  });
}

function stopRec() {
  if (!recording || !recProc) return;
  recording = false;
  busy = true;
  spawn('afplay', ['-v', '0.6', STOP_SND], { stdio: 'ignore' });
  const proc = recProc;
  recProc = null;
  proc.kill('SIGTERM');
  setStatus('transcribing');
  setTimeout(transcribe, 200);
}

// ── trigger-file polling ──────────────────────────────────────────────────────

function pollTrigger() {
  try {
    const { mtimeMs } = fs.statSync(TRIGGER);
    if (mtimeMs <= lastTouchMs) return;
    lastTouchMs = mtimeMs;

    if (PTT_MODE === 'toggle') {
      if (toggleCooldown) return;
      toggleCooldown = true;
      setTimeout(() => { toggleCooldown = false; }, RELEASE_MS);
      if (recording) {
        stopRec();
      } else {
        if (busy) { busy = false; try { fs.writeFileSync(RESTART_FLAG, ''); } catch {} }
        startRec();
      }
    } else {
      if (busy) { busy = false; try { fs.writeFileSync(RESTART_FLAG, ''); } catch {} }
      if (!recording) startRec();
      if (holdTimer) clearTimeout(holdTimer);
      holdTimer = setTimeout(() => { if (recording) stopRec(); }, RELEASE_MS);
    }
  } catch {}
}

// ── transcription ─────────────────────────────────────────────────────────────

function transcribe() {
  if (!fs.existsSync(TMP_WAV) || fs.statSync(TMP_WAV).size < 4096) {
    busy = false; setStatus('idle'); return;
  }

  const result = spawnSync(WHISPER_BIN, [
    '-m', WHISPER_MODEL, '-f', TMP_WAV, '--no-timestamps',
  ], { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'ignore'] });

  if (result.error) {
    notify('Whisper error', result.error.message);
    busy = false; setStatus('idle'); return;
  }

  const text = (result.stdout || '')
    .split('\n').map(l => l.trim())
    .filter(l => l && !l.match(/^(whisper_|main:|system_info:|ggml_|llama_|\[)/))
    .join(' ').replace(/\s+/g, ' ').trim();

  if (!text || text.length < 2) { busy = false; setStatus('idle'); return; }

  lastTranscript = text;
  setStatus('waiting');

  fs.appendFileSync(INBOX, JSON.stringify({
    ts: new Date().toISOString(), channel: 'ptt', author: 'user', content: text,
  }) + '\n');
}

// ── TTS ───────────────────────────────────────────────────────────────────────

async function speak(text) {
  setStatus('speaking');
  if (!(await kokoroSpeak(text))) spawnSync('say', [text], { timeout: 60000 });
  setStatus('idle');
}

function kokoroSpeak(text) {
  return new Promise((resolve) => {
    const body = Buffer.from(JSON.stringify({ model: 'kokoro', voice: KOKORO_VOICE, input: text, response_format: 'wav' }));
    const url = new URL(KOKORO_URL);
    const req = http.request({
      hostname: url.hostname, port: Number(url.port) || 8880, path: url.pathname,
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
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
    req.write(body); req.end();
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

// ── heartbeat pings ───────────────────────────────────────────────────────────

function startHeartbeat() {
  if (IDLE_INT && fs.existsSync(IDLE_SND)) {
    setInterval(() => {
      if (!recording && !busy) spawn('afplay', ['-v', '0.3', IDLE_SND], { stdio: 'ignore' });
    }, IDLE_INT * 1000);
  }
  if (THINK_INT && fs.existsSync(THINK_SND)) {
    setInterval(() => {
      if (!recording && busy) spawn('afplay', ['-v', '0.3', THINK_SND], { stdio: 'ignore' });
    }, THINK_INT * 1000);
  }
}

// ── notifications ─────────────────────────────────────────────────────────────

function notify(title, body) {
  if (Notification.isSupported()) new Notification({ title, body }).show();
}

// ── app lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  app.dock.hide();

  const workspace = resolveWorkspace();
  if (!workspace) return; // user cancelled

  initPaths(workspace);

  tray = new Tray(EMPTY_ICON);
  tray.setToolTip('Claude Heartbeat');
  tray.on('right-click', () => tray.popUpContextMenu());
  setStatus('idle');

  // Ensure io/ directory exists (workspace might be freshly cloned)
  fs.mkdirSync(path.join(workspace, 'io'), { recursive: true });

  initOffset();

  // Announce startup immediately, then launch supervisor and say ready
  spawn('say', ['Claude Heartbeat starting'], { stdio: 'ignore' });
  launchSupervisor();

  setInterval(pollTrigger, 50);
  setInterval(pollOutbox, 300); // fallback poll
  // Fast outbox notification via native FSEvents (sub-10ms detection)
  try {
    fs.watch(path.join(workspace, 'io'), (event, filename) => {
      if (filename === path.basename(OUTBOX)) setTimeout(pollOutbox, 10);
    });
  } catch { /* io/ may not exist yet — fallback poll covers it */ }
  startHeartbeat();

  // Announce ready after a short delay so supervisor has time to launch
  setTimeout(() => {
    const modeHint = PTT_MODE === 'toggle'
      ? 'Press Control Shift Space to speak'
      : 'Hold Control Shift Space to speak';
    spawn('say', [`Ready. ${modeHint}.`], { stdio: 'ignore' });
  }, 3000);

  if (!fs.existsSync(WHISPER_MODEL)) {
    notify('Setup needed', `Whisper model not found — see README for download command`);
    spawn('say', ['Warning: Whisper model not found. See README for setup instructions.'], { stdio: 'ignore' });
  }
  const skhdrc = path.join(os.homedir(), '.skhdrc');
  if (!fs.existsSync(skhdrc) || !fs.readFileSync(skhdrc, 'utf8').includes('ptt-held')) {
    notify('Setup needed', 'Add  ctrl + shift - space : touch /tmp/ptt-held  to ~/.skhdrc, then restart skhd');
  }
});

app.on('window-all-closed', e => e.preventDefault());

process.on('exit', () => {
  if (recProc) try { recProc.kill(); } catch {}
  try { fs.unlinkSync(TRIGGER); } catch {}
});
