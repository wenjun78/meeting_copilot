# Meeting Copilot

A small always-on-top window that sits beside Teams, Zoom, Meet or any other
call. It transcribes both sides, reads the shared screen, and when the other
side asks something it drafts what you could say, grounded in your own GitHub
repositories, documents and search API.

It does not join the meeting as a bot and needs no Teams or Zoom admin
approval: it listens to your computer's audio and looks at your screen.

## Install it (Windows)

Download **Meeting-Copilot-Setup** from the
[Releases page](https://github.com/wenjun78/meeting_copilot/releases) and run
it. It installs for your user only (no admin rights), adds Start menu and
desktop shortcuts, and opens like any other app. The **portable** file runs
without installing.

The build is not code-signed, so Windows SmartScreen asks once: choose
"More info", then "Run anyway".

### Updates

The installed app updates itself: it checks this repository's releases a
little after it opens and every few hours, downloads a new version in the
background (never while you are listening to a meeting), and installs it when
you close the app. Turn it off, or check by hand, under Settings > This app.
The portable file does not update itself.

## Run from source

Needs Node.js 20 or newer.

```
npm install
npm start
```

`npm run dist` builds the installer yourself into `dist/`.

## First run

1. **Settings**: paste an API key. The defaults point at Groq
   (`whisper-large-v3` for speech, `openai/gpt-oss-120b` for answers); any
   OpenAI-compatible service works by changing the base URL and model names.
   Fill in "About you", "This meeting" and "Names and terms to get right".
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

- **Files**: press "Add files" in the Knowledge tab, or drop files or folders
  onto the window. Files are copied into the app's own folder, so they keep
  working if the originals move; "Open" on the "My files" row shows that
  folder for editing or deleting.
- **Pasted text**: "Paste text" in the Knowledge tab saves what you paste
  (from Word, a web page, an email) as a note in the same place. Give it a
  name; pasting again under the same name replaces it.

- **GitHub**: one request downloads the repository; Markdown, notebooks
  (outputs stripped), code, config, **PDF and Word (.docx)** files are split
  into passages. Add a token in Settings for private repos. GitHub
  Enterprise: set the API URL.
- **Your CV**: commit it to a repo as PDF, Word or Markdown and add that repo.
  Scanned PDFs (pictures of pages) have no text to read; export from Word or
  Google Docs instead. In a public repo the CV is public: use a private repo
  and a token if it has your phone number or address.
- **URL**: a JSON array or `{results|data|items: [...]}` becomes one passage
  per record; HTML and Markdown are split by heading; a link to a PDF or Word
  file is read as a document.
- **A portfolio site on GitHub Pages**: add the repository behind it
  (`owner/portfolio`) rather than the web address, so every page, notebook
  and exported report is read, not only the front page. Large HTML reports
  with embedded charts are fine: only their text is kept.
- **LinkedIn**: LinkedIn does not let apps read profiles. On your profile
  choose More > Save to PDF and add that file; repeat when the profile
  changes.
- **Folder**: any folder on your computer, same file types.
- **Your search API**: set a URL such as `https://host/search?q={query}` in
  Settings and it is called for every answer (2.5 s limit), with its results
  ranked first. Records are read from `text`, `content`, `body`, `answer`,
  `snippet` or `description`.
- Retrieval is keyword-based (BM25) and works offline once synced. Set an
  embedding model under Advanced to add meaning-based matching.

### The meeting itself: job description, agenda, brief

Sources above are searched per question. Two kinds of text are instead sent
to the model with **every** answer, so replies lead with what the role or
agenda asks for:

- **Pasted**: Settings > This meeting (or "Load from a file" for a PDF or
  Word file).
- **Pinned notes in your sources**, which stay current with the source: a
  file whose name contains `jd`, `job description`, `instructions`, `agenda`
  or `brief` as a word (`jd.md`, `JD - Data Engineer.pdf`,
  `interview instructions.docx`), or any Markdown note whose first lines are

  ```
  ---
  title: About me
  pinned: true
  ---
  ```

A job description is treated as what the other side wants, not as your
experience. Swap the file's content (or the pasted text) before each
different meeting. The Knowledge tab shows which notes are pinned.

**Writing notes.** Markdown works best for a CV and a job description: each
`##` heading becomes its own searchable passage, a leading `---` block is
read as settings rather than content, and changes show up as readable diffs.
PDF and Word are read too, but multi-column layouts can come out in a jumbled
order.

### Staying up to date

With "Keep sources up to date automatically" on (the default), the app checks
every source a few seconds after it opens, every 30 minutes after that, and
once more at the moment you press Start listening.
A repo that has not been pushed to is not downloaded again, so the check is
one small request per repo. Apart from that one check, it pauses while you are listening to a meeting.
URLs you added are fetched again on the same schedule, and your search API is
asked live for every answer, so it is always current.
"Sync" forces a full re-read at any time.

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
