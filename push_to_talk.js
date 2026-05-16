#!/usr/bin/env node
// push_to_talk.js — voice relay for claude-heartbeat (skhd edition)
//
// Hold the hotkey defined in ~/.skhdrc to record; release to transcribe and reply.
// skhd fires on keydown + key-repeat — we touch /tmp/ptt-held each time and stop
// recording when touches cease for PTT_RELEASE_MS (default 700 ms).
//
// Setup:
//   brew install koekeishiya/formulae/skhd
//   echo 'ctrl + shift - space : touch /tmp/ptt-held' >> ~/.skhdrc
//   skhd --start-service   # grant Accessibility access when prompted
//
// Deps: sox (brew install sox), whisper-cli (brew install whisper-cpp)
// Optional TTS: Kokoro-FastAPI at localhost:8880; falls back to macOS `say`
//
// env vars:
//   WHISPER_BIN              path/name of whisper-cli binary  (default: whisper-cli)
//   WHISPER_MODEL            path to ggml model file           (default: ~/.cache/whisper/ggml-base.en.bin)
//   KOKORO_URL               TTS endpoint                      (default: http://127.0.0.1:8880/v1/audio/speech)
//   KOKORO_VOICE             voice name                        (default: af_heart)
//   PTT_MODE                 toggle (default) or hold
//                              toggle: press once to start, press again to stop
//                              hold:   hold key while speaking, release to send
//   PTT_RELEASE_MS           hold mode only — ms after last key-repeat before stopping (default: 700)
//   PTT_TRIGGER              trigger file path                 (default: /tmp/ptt-held)
//   PTT_IDLE_INTERVAL        seconds between idle pings         (default: 15, 0 = off)
//   PTT_IDLE_SOUND           audio file when idle               (default: /System/Library/Sounds/Tink.aiff)
//   PTT_THINKING_INTERVAL    seconds between thinking pings     (default: 4, 0 = off)
//   PTT_THINKING_SOUND       audio file when Claude is working  (default: /System/Library/Sounds/Pop.aiff)
//   PTT_START_SOUND          audio file played when recording starts (default: /System/Library/Sounds/Ping.aiff)
//   PTT_STOP_SOUND           audio file played when recording stops  (default: /System/Library/Sounds/Bottle.aiff)

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync, spawn } = require('child_process');
const http = require('http');

const CWD = path.resolve(__dirname, '.');
const INBOX = path.join(CWD, 'io', 'inbox.jsonl');
const OUTBOX = path.join(CWD, 'io', 'outbox.jsonl');
const OFFSET_FILE = path.join(CWD, 'io', '.ptt-offset');
const RESTART_FLAG = path.join(CWD, 'io', '.restart');
const TMP_WAV = path.join(os.tmpdir(), 'ptt-in.wav');
const TMP_RESP_WAV = path.join(os.tmpdir(), 'ptt-out.wav');
const TRIGGER = process.env.PTT_TRIGGER || '/tmp/ptt-held';

const WHISPER_BIN = process.env.WHISPER_BIN || 'whisper-cli';
const WHISPER_MODEL = process.env.WHISPER_MODEL
  || path.join(os.homedir(), '.cache', 'whisper', 'ggml-base.en.bin');
const KOKORO_URL = process.env.KOKORO_URL || 'http://127.0.0.1:8880/v1/audio/speech';
const KOKORO_VOICE = process.env.KOKORO_VOICE || 'af_heart';
const PTT_MODE           = (process.env.PTT_MODE || 'toggle').toLowerCase();
const RELEASE_MS         = parseInt(process.env.PTT_RELEASE_MS || '700');
const IDLE_INTERVAL     = parseInt(process.env.PTT_IDLE_INTERVAL     ?? '15');
const IDLE_SOUND        = process.env.PTT_IDLE_SOUND        || '/System/Library/Sounds/Tink.aiff';
const THINKING_INTERVAL = parseInt(process.env.PTT_THINKING_INTERVAL ?? '4');
const THINKING_SOUND    = process.env.PTT_THINKING_SOUND    || '/System/Library/Sounds/Pop.aiff';
const START_SOUND       = process.env.PTT_START_SOUND       || '/System/Library/Sounds/Ping.aiff';
const STOP_SOUND        = process.env.PTT_STOP_SOUND        || '/System/Library/Sounds/Bottle.aiff';
const SAMPLE_RATE        = 16000;

let recording = false;
let recProc = null;
let holdTimer = null;
let lastTouchMs = 0;
let toggleCooldown = false; // debounce key-repeat in toggle mode
let outboxOffset = 0;
let busy = false;

// ── outbox offset ────────────────────────────────────────────────────────────

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

// ── recording ────────────────────────────────────────────────────────────────

function startRec() {
  if (recording || busy) return;
  recording = true;
  spawn('afplay', ['-v', '0.6', START_SOUND], { stdio: 'ignore' });
  printStatus('🎤  Recording…  (release key to send)');
  recProc = spawn('rec', ['-q', '-r', String(SAMPLE_RATE), '-c', '1', '-b', '16', TMP_WAV], {
    stdio: 'ignore',
  });
  recProc.on('error', () => {
    recProc = spawn('ffmpeg', [
      '-y', '-f', 'avfoundation', '-i', ':0',
      '-ar', String(SAMPLE_RATE), '-ac', '1', TMP_WAV,
    ], { stdio: 'ignore' });
    recProc.on('error', (e) => {
      printStatus(`❌  mic error: ${e.message}`);
      recording = false;
      busy = false;
      showPrompt();
    });
  });
}

function stopRec() {
  if (!recording || !recProc) return;
  recording = false;
  busy = true;
  spawn('afplay', ['-v', '0.6', STOP_SOUND], { stdio: 'ignore' });
  const proc = recProc;
  recProc = null;
  proc.kill('SIGTERM');
  printStatus('⏳  Transcribing…');
  setTimeout(transcribe, 400);
}

// ── trigger-file polling ──────────────────────────────────────────────────────

function pollTrigger() {
  try {
    const { mtimeMs } = fs.statSync(TRIGGER);
    if (mtimeMs <= lastTouchMs) return;
    lastTouchMs = mtimeMs;

    if (PTT_MODE === 'toggle') {
      // Debounce key-repeat: only act on the first event of each keypress
      if (toggleCooldown) return;
      toggleCooldown = true;
      setTimeout(() => { toggleCooldown = false; }, RELEASE_MS);

      if (recording) {
        stopRec();
      } else if (!busy) {
        startRec();
      }
    } else {
      // hold mode: each touch resets the release timer
      if (!recording && !busy) startRec();
      if (holdTimer) clearTimeout(holdTimer);
      holdTimer = setTimeout(() => {
        if (recording) stopRec();
      }, RELEASE_MS);
    }
  } catch {
    // trigger file doesn't exist yet — fine
  }
}

// ── transcription ─────────────────────────────────────────────────────────────

function transcribe() {
  if (!fs.existsSync(TMP_WAV) || fs.statSync(TMP_WAV).size < 4096) {
    printStatus('💤  Nothing captured');
    setTimeout(() => { busy = false; showPrompt(); }, 800);
    return;
  }

  const result = spawnSync(WHISPER_BIN, [
    '-m', WHISPER_MODEL,
    '-f', TMP_WAV,
    '--no-timestamps',
  ], { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'ignore'] });

  if (result.error) {
    process.stderr.write(`\n❌  whisper error: ${result.error.message}\n`);
    busy = false;
    showPrompt();
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
    printStatus('💤  Nothing heard');
    setTimeout(() => { busy = false; showPrompt(); }, 800);
    return;
  }

  process.stdout.write(`\n📝  You: ${text}\n`);
  const msg = JSON.stringify({
    ts: new Date().toISOString(),
    channel: 'ptt',
    author: 'user',
    content: text,
  });
  fs.appendFileSync(INBOX, msg + '\n');
  try { fs.writeFileSync(RESTART_FLAG, ''); } catch {}
  printStatus('⏳  Waiting for Claude…');
}

// ── TTS ───────────────────────────────────────────────────────────────────────

async function speak(text) {
  if (!(await kokoroSpeak(text))) {
    try { spawnSync('say', [text], { timeout: 60000 }); } catch {}
  }
}

function kokoroSpeak(text) {
  return new Promise((resolve) => {
    const body = Buffer.from(JSON.stringify({
      model: 'kokoro',
      voice: KOKORO_VOICE,
      input: text,
      response_format: 'wav',
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
        fs.writeFileSync(TMP_RESP_WAV, Buffer.concat(chunks));
        const play = spawnSync('afplay', [TMP_RESP_WAV]);
        if (play.error) spawnSync('aplay', [TMP_RESP_WAV]);
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
  const fd = fs.openSync(OUTBOX, 'r');
  fs.readSync(fd, buf, 0, buf.length, outboxOffset);
  fs.closeSync(fd);
  outboxOffset = size;
  saveOffset();

  for (const line of buf.toString('utf8').split('\n').filter(Boolean)) {
    try {
      const msg = JSON.parse(line);
      if (msg.action === 'send' && msg.content) {
        busy = false;
        process.stdout.write(`\n🤖  Claude: ${msg.content}\n`);
        speak(msg.content).then(() => showPrompt());
        return;
      }
    } catch {}
  }
}

// ── UI ────────────────────────────────────────────────────────────────────────

function printStatus(s) { process.stdout.write('\r\x1b[K' + s); }
function showPrompt() {
  const hint = PTT_MODE === 'toggle'
    ? 'Press  Ctrl+Shift+Space  to start · press again to send'
    : 'Hold   Ctrl+Shift+Space  to speak · release to send';
  process.stdout.write(`\n🎙️   ${hint}  |  Ctrl+C to quit\n`);
}

// ── main ──────────────────────────────────────────────────────────────────────

console.log('claude-heartbeat · push-to-talk  (skhd global hotkey)');
console.log('──────────────────────────────────────────────────────');
console.log(`hotkey:  Ctrl+Shift+Space  (trigger: ${TRIGGER})`);
console.log(`mode:    ${PTT_MODE === 'toggle' ? 'toggle (press once to start, again to stop)' : `hold (stop after ${RELEASE_MS} ms silence)`}`);
console.log(`whisper: ${WHISPER_BIN}  model: ${path.basename(WHISPER_MODEL)}`);
console.log(`kokoro:  ${KOKORO_URL}  voice: ${KOKORO_VOICE}`);

// Validate whisper model exists
if (!fs.existsSync(WHISPER_MODEL)) {
  console.error(`\n❌  Whisper model not found: ${WHISPER_MODEL}`);
  console.error('   Run: mkdir -p ~/.cache/whisper && curl -L -o ~/.cache/whisper/ggml-base.en.bin \\');
  console.error('        https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin');
  process.exit(1);
}

// Validate skhd is configured
const skhdrc = path.join(os.homedir(), '.skhdrc');
if (!fs.existsSync(skhdrc) || !fs.readFileSync(skhdrc, 'utf8').includes('ptt-held')) {
  console.warn('\n⚠️   skhd not configured for PTT. Add to ~/.skhdrc:');
  console.warn(`    ctrl + shift - space : touch ${TRIGGER}`);
  console.warn('   Then: skhd --restart-service  (or  skhd --start-service  if not running)\n');
}

initOffset();
showPrompt();

// Announce startup and readiness
spawn('say', ['Claude Heartbeat ready.'], { stdio: 'ignore' });

setInterval(pollTrigger, 50);
setInterval(pollOutbox, 300);

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

function cleanup() {
  if (recProc) try { recProc.kill(); } catch {}
  try { fs.unlinkSync(TRIGGER); } catch {}
}

process.on('SIGINT', () => { cleanup(); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });
process.on('exit', cleanup);
