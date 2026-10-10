# Meeting Copilot

A small always-on-top window that sits beside Teams, Zoom, Meet or any other
call. It transcribes both sides, reads the shared screen, and when the other
side asks something it drafts what you could say, grounded in your own GitHub
repositories, documents and search API.

It does not join the meeting as a bot and needs no Teams or Zoom admin
approval: it listens to your computer's audio and looks at your screen.

## Run it

Needs Node.js 20 or newer.

```
npm install
npm start
```

1. **Settings**: paste an API key. The defaults point at Groq
   (`whisper-large-v3` for speech, `openai/gpt-oss-120b` for answers); any
   OpenAI-compatible service works by changing the base URL and model names.
   Fill in "About you" and "Names and terms to get right".
2. **Knowledge**: add `owner/repo`, a GitHub username (pulls every repo that
   user owns), a GitHub URL, a folder, or a URL that returns a document or JSON.
3. **Start listening** when the call begins and pick the meeting window or the
   screen it is on.

## What you get

| | |
|---|---|
| Transcript | "Them" (system audio) and "You" (microphone), cut at natural pauses |
| Screen | Text read from the shared screen every few seconds, only when it changes |
| Answers | Written automatically when they ask a question; one or two sentences to say, then supporting points, with numbered sources you can click |
| Ask | Type your own question, or "Answer from the screen" for what is being shown, including SQL and code tasks |
| Window | Drag by the title bar, resize from any edge, minimise, maximise, compact (answer only), adjustable opacity |

## Shortcuts

They work while Teams or Zoom is the window in front, so you never have to
click on this app during a call.

| Keys | Action |
|---|---|
| `Ctrl+Alt+,` | Answer what they said |
| `Ctrl+Alt+.` | Answer from the screen |
| `Ctrl+Alt+/` | Show or hide the window |

The defaults were checked against the published Windows shortcut lists for
Teams, Zoom, Google Meet and Webex (October 2026): none of them use
Ctrl+Alt with a punctuation key. Change them under Settings > Shortcuts;
the field tells you if a combination is already used by one of those apps,
and the app warns at start-up if another program has taken the keys. (`Cmd`
replaces `Ctrl` on macOS.)

## How "Answer from the screen" works

1. While you are listening, the screen or window you picked is sampled every
   few seconds and its text is read with OCR (on your machine) whenever the
   picture changes. The Screen tab shows exactly what was read.
2. When you press the shortcut or the button, the screen is read again at
   that moment, so the answer is about what is showing now.
3. That text is used to search your sources, then sent to the model with the
   recent conversation and the instruction to work out what the screen is
   asking for: a question, a task, a query to write, an error to explain.
4. If the task calls for SQL or code, the answer leads with the complete
   query in a code block, followed by a short explanation and edge cases.

Typing in the question box first narrows it, for example "rewrite with a
window function" and then the shortcut.

Limits: it reads text only, so diagrams and handwriting are missed; very
small or low-contrast text can come out garbled (check the Screen tab); and
this app's own window is blanked out of the capture so it never reads its
own answers.

## Hearing the other side

| System | How "Them" is captured |
|---|---|
| Windows | Built in. System audio is captured directly, nothing to install. |
| macOS | Install a loopback device such as BlackHole, route meeting output to it (a Multi-Output Device keeps your speakers working), then choose it under Settings > Their audio. |
| Linux | Choose the "Monitor of ..." PulseAudio/PipeWire device under Settings > Their audio. |

Use headphones. With speakers, your microphone also hears the other side;
duplicates are filtered, but headphones give a cleaner transcript.

## Knowledge sources

- **GitHub**: one request downloads the repository; Markdown, notebooks
  (outputs stripped), code and config files are split into passages. Add a
  token in Settings for private repos. GitHub Enterprise: set the API URL.
- **URL**: a JSON array or `{results|data|items: [...]}` becomes one passage
  per record; HTML and Markdown are split by heading.
- **Your search API**: set a URL such as `https://host/search?q={query}` in
  Settings and it is called for every answer (2.5 s limit), with its results
  ranked first. Records are read from `text`, `content`, `body`, `answer`,
  `snippet` or `description`.
- Retrieval is keyword-based (BM25) and works offline once synced. Set an
  embedding model under Advanced to add meaning-based matching.

The index lives in the app's data folder; "Sync" refreshes a source.

## Privacy

- Audio clips, screen text and retrieved passages are sent to the model
  service you configure. Nothing else leaves your machine. Check that this is
  allowed for the meetings you use it in.
- Tell the people you are meeting that the call is being transcribed where
  that is required.
- API keys are encrypted with your OS account when the OS supports it.
- The window is an ordinary window: if you share your whole screen, others
  see it. Share a single window instead.

## Troubleshooting

- **"Them" stays empty**: the Them level bar should move when they talk. On
  Windows check Settings > Their audio is "System audio". If the meeting app
  plays through a different output device than the Windows default, set them
  to the same device.
- **No screens listed (macOS)**: allow Screen Recording for the app in System
  Settings > Privacy & Security, then restart it.
- **Words are wrong**: add names and acronyms under "Names and terms to get
  right", and set the spoken language instead of auto-detect.
- **Rate limit messages**: free API tiers cap requests per minute; each
  utterance is one request.
- **Screen text in another language**: set e.g. `eng+chi_sim`; the language
  data is downloaded once.

## Tests

```
npm test       # retrieval, ingestion, streaming, question detection, orchestration (mock API)
npm run e2e    # drives the real window with a fake microphone and a mock API
```

## Layout

```
main.js            window, permissions, IPC, source syncing
preload.js         the narrow bridge exposed to the window
src/copilot.js     meeting state, question trigger, prompt, answers
src/llm.js         speech-to-text, streaming chat, embeddings
src/ocr.js         Tesseract screen reading
src/question.js    is this a question?
src/shortcuts.js   shortcut defaults and the meeting-app conflict table
src/rag/           chunking, BM25, GitHub / URL / folder ingestion, index
renderer/          the window: capture.js (audio, screen), app.js (UI)
```
