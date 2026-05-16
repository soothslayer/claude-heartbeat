# claude-heartbeat

Stateless autonomous agent for Claude Code — no `-p`, no SDK credits.

The heartbeat hook turns an interactive Claude Code session into a stateless task processor. Each message from the inbox gets its own fresh session, just like `-p` — but using your regular subscription.

## Why

Anthropic is separating `-p` and SDK usage into a dedicated credit bucket. If you've been using `claude -p` for automation, your costs just went up.

The heartbeat hook gives you `-p` behavior in **interactive mode**, which uses your regular subscription — not SDK credits.

## How it works

```
supervisor.js → claude (interactive) → hooks/heartbeat.js (stop hook)
                                             ↓
                                        io/inbox.jsonl ← external events
                                        io/outbox.jsonl → relay → discord/slack/webhook
```

1. The supervisor launches Claude Code in interactive mode
2. After each response, the **stop hook** fires
3. The hook reads the next line from `io/inbox.jsonl`
4. If a message exists, it's injected — one message per session
5. The agent processes it, writes a response to `io/outbox.jsonl`
6. The hook signals the supervisor to kill and restart with fresh context
7. Next message gets a clean session — true stateless operation

**One message = one session = fresh context every time.**

When the inbox is empty, the hook polls internally and blocks with minimal idle ticks (~20 tokens each) to keep the session alive until work arrives.

## Setup

### 1. Clone

```bash
git clone https://github.com/Siigari/claude-heartbeat.git
cd claude-heartbeat
```

### 2. Start

```bash
node supervisor.js
```

That's it. The hook is already configured in `.claude/settings.json`. The supervisor launches Claude, and the heartbeat hook handles the rest.

Options:

```bash
node supervisor.js sonnet "Read CLAUDE.md"   # default
node supervisor.js opus "Read CLAUDE.md"     # use opus
```

### 3. Send messages

From another terminal:

```bash
# Plain text works
echo "what is 2+2" >> io/inbox.jsonl

# JSON format also works
echo '{"ts":"2025-01-01","channel":"test","author":"you","content":"hello agent"}' >> io/inbox.jsonl
```

Messages are processed one at a time. If 5 messages pile up, each gets its own fresh session.

### 4. (Optional) Start the relay

```bash
cd relay
npm install discord.js
BOT_TOKEN=your_token node relay.js
```

### 5. (Optional) Inject events

```bash
# From a cron job
node examples/cron-trigger.js

# From an HTTP webhook
node examples/webhook-receiver.js
```

## Mac App (double-click launcher)

The `mac-app/` directory contains an Electron menu bar app that bundles everything into a single double-click experience:

- Opens **Terminal.app** running `supervisor.js` (the Claude Code agent loop) automatically on launch
- Shows a **🎙 mic icon in the menu bar** for push-to-talk status
- Remembers your `claude-heartbeat` workspace path after the first launch

### Prerequisites

Before installing the app, complete the [Push-to-talk setup](#push-to-talk) below (sox, whisper, skhd). The Mac app wraps those tools — it does not replace them.

### Install

```bash
cd mac-app
npm install
npm run build         # produces dist/Claude Heartbeat-1.0.0-arm64.dmg
open "dist/Claude Heartbeat-1.0.0-arm64.dmg"
```

Drag **Claude Heartbeat.app** to Applications and double-click to launch.

**First launch:** a folder picker appears — select the `claude-heartbeat` directory (the one containing `supervisor.js`). The path is saved; subsequent launches are instant.

### Tray menu

Right-click the 🎙 icon for options:

- **Open Terminal (supervisor)** — opens a Terminal.app window with the agent running
- **Change Workspace…** — re-select the claude-heartbeat directory
- **Quit** — stop the app and remove the hotkey trigger file

### Build from source

```bash
cd mac-app
npm install
npm run build        # arm64 DMG
npm start            # run without building (dev mode, reads workspace from ../
```

## Push-to-talk

Speak to Claude from any screen. Press **Ctrl+Shift+Space** to start recording, press again to send. Claude speaks the response aloud. The system is entirely audio — no need to look at a terminal.

### Accessibility note

Because all interaction is voice in / voice out, push-to-talk works well for blind and low-vision users. Two audio tones confirm system state without needing to check the screen:

- **Tink** (soft click, every 15 s) — idle, ready to record
- **Pop** (every 4 s while waiting) — Claude is thinking

**Toggle mode** (the default) is designed for one-handed use: press the hotkey once to start recording, press it again to stop. You do not need to hold the key combination while speaking.

The hotkey **Ctrl+Shift+Space** does not conflict with macOS VoiceOver defaults.

### Prerequisites

- macOS (uses `afplay` for audio playback)
- [Homebrew](https://brew.sh) — run the one-liner installer from their site if not installed
- A Claude Code subscription at [claude.ai/code](https://claude.ai/code)

### Step-by-step setup

**1. Clone and enter the repo**

```bash
git clone https://github.com/Siigari/claude-heartbeat.git
cd claude-heartbeat
```

**2. Install audio and transcription tools**

```bash
brew install sox
brew install whisper-cpp
```

**3. Download the Whisper speech-to-text model (~142 MB)**

```bash
mkdir -p ~/.cache/whisper
curl -L -o ~/.cache/whisper/ggml-base.en.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin
```

**4. Install and configure the global hotkey daemon**

```bash
brew install koekeishiya/formulae/skhd
echo 'ctrl + shift - space : touch /tmp/ptt-held' >> ~/.skhdrc
```

**5. Grant Accessibility permission to skhd**

Open System Settings, go to Privacy & Security → Accessibility, and enable skhd. This allows skhd to receive keypresses from any app.

```bash
skhd --start-service
```

If skhd was already running before you granted access, restart it:

```bash
skhd --restart-service
```

**6. Start the Claude agent (keep this running in the background)**

```bash
node supervisor.js
```

Use `tmux` or `screen` to keep it running after you close the terminal:

```bash
tmux new -s claude
node supervisor.js
# press Ctrl+B then D to detach; reconnect with: tmux attach -t claude
```

**7. Start push-to-talk**

```bash
npm run ptt
```

You will hear a soft **Tink** tone every 15 seconds confirming the system is alive. Press **Ctrl+Shift+Space** from any app to start recording. You will hear the tone stop. Press **Ctrl+Shift+Space** again to send. You will hear **Pop** tones while Claude thinks, then Claude speaks the answer aloud.

Press **Ctrl+C** in the terminal to stop push-to-talk.

### Text-to-speech options

By default, responses are spoken using the built-in macOS `say` command. For a higher-quality voice, install [Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI) and start it before running push-to-talk — it is detected automatically.

### Tuning

| Variable | Default | Description |
|----------|---------|-------------|
| `PTT_MODE` | `toggle` | `toggle` — press once to start, again to stop. `hold` — hold while speaking, release to send. |
| `PTT_RELEASE_MS` | `700` | Hold mode: ms of silence before stopping. Toggle mode: debounce window to ignore key-repeat. |
| `PTT_IDLE_INTERVAL` | `15` | Seconds between idle Tink pings. Set to `0` to disable. |
| `PTT_THINKING_INTERVAL` | `4` | Seconds between thinking Pop pings. Set to `0` to disable. |
| `PTT_IDLE_SOUND` | `Tink.aiff` | Full path to idle ping audio file. |
| `PTT_THINKING_SOUND` | `Pop.aiff` | Full path to thinking ping audio file. |
| `WHISPER_MODEL` | `~/.cache/whisper/ggml-base.en.bin` | Path to a different Whisper model. |

Example — slower pings, snappier release:

```bash
PTT_IDLE_INTERVAL=30 PTT_THINKING_INTERVAL=6 PTT_RELEASE_MS=500 npm run ptt
```

### How it works

```
skhd (global hotkey)
  └─ touches /tmp/ptt-held while key is held
       └─ push_to_talk.js detects hold → starts recording (sox)
            └─ on release → whisper-cli transcribes → writes to io/inbox.jsonl
                 └─ signals supervisor to interrupt current Claude turn
                      └─ Claude responds → push_to_talk.js reads outbox → speaks reply
```

## What you get

- **No SDK credits** — interactive mode uses your subscription
- **Stateless** — each message gets fresh context, like `-p`
- **Autonomous** — watches inbox, processes messages, writes responses
- **Cheap idle** — minimal ticks (~20 tokens) while waiting for work
- **One message per session** — no context inflation from batching
- **Auto-restart** — supervisor handles crashes and session recycling
- **Watchdog** — detects stuck sessions and force-restarts them
- **Orphan reaper** — cleans up stale child processes on startup
- **fsync'd state** — offset and flag writes are flushed to disk

## What you trade

- **Startup cost** — each message pays the CLAUDE.md read (~500 tokens)
- **One session** — no parallelism per terminal (but run multiple terminals)
- **Needs a terminal** — even if backgrounded (use `screen` or `tmux`)

## The inbox

Each line in `io/inbox.jsonl` is either plain text or a JSON object:

```
fix the bug in auth.js
```

```json
{"ts":"2025-05-13T10:00:00Z","channel":"discord","author":"username","content":"message text"}
```

Lines are consumed one at a time. The hook tracks its position via a byte offset in `io/.inbox-offset`.

## The outbox

The agent writes responses as JSON lines to `io/outbox.jsonl`:

```json
{"action":"send","channelId":"123456789","content":"response text"}
```

## Architecture

```
                    ┌─────────────┐
                    │ supervisor   │  (restarts on exit)
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │ claude code  │  (interactive session)
                    └──────┬──────┘
                           │ stop hook fires after each response
                    ┌──────▼──────┐
                    │ heartbeat.js │
                    └──────┬──────┘
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
         inbox.jsonl   .responded   .restart
         (read 1 line)  (flag)      (signal supervisor)
```

**Idle flow:** hook polls inbox → nothing → blocks with minimal tick → agent responds `.` → repeat

**Message flow:** hook reads one line → blocks with message → agent processes → hook sets `.restart` → supervisor kills session → restarts fresh

## Parallelism

Run multiple terminals, each with their own working directory and inbox/outbox:

```bash
# Terminal 1: coding agent
cd ~/agents/coder && node supervisor.js

# Terminal 2: monitoring agent
cd ~/agents/monitor && node supervisor.js

# Terminal 3: research agent
cd ~/agents/research && node supervisor.js
```

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `HEARTBEAT_INTERVAL` | `60` | Seconds between idle ticks |
| `WATCHDOG_TIMEOUT` | `300` | Seconds before supervisor kills a stuck session |

## Examples

- `examples/cron-trigger.js` — inject tick messages on a schedule
- `examples/webhook-receiver.js` — HTTP endpoint that writes to inbox
- `relay/relay.js` — Discord relay that sends outbox messages

## Built by

[Convergence](https://discord.gg/hkcK5s3zUB) — companion AI with memory, personality, and physical connection.
