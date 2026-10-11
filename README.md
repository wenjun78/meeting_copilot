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

1. **Settings**: choose the service (OpenAI by default, with `gpt-5.6-sol`
   for answers and `gpt-4o-transcribe` for speech; Groq is one click away,
   and any OpenAI-compatible service works) and paste its API key.
   Fill in "Names and terms to get right".
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

## Which model service

| | Groq, free plan | Groq, pay as you go | OpenAI |
|---|---|---|---|
| Cost for a one-hour meeting | Free | About US$0.30 | About US$1.50 to 2 |
| Card needed | No | Yes | Yes |
| Good for | Trying the app | Real meetings: fast and cheap | Real meetings: strongest answers |
| Catch | About 8,000 tokens a minute and 200,000 a day for answers, so roughly one answer a minute and about 25 to 60 a day | | Slower to answer; no free plan |

Figures are estimates from the providers' published prices and limits in
October 2026 (third-party summaries for Groq) and assume about 30 answers.
On the free plan choose "Lean" under Settings > Answers; the app also falls
back to it when a request is refused as too large.

## Window

The pin button in the title bar turns "stay on top of other windows" on or
off. The square button maximises and, pressed again, restores down.

Windows shows a "Windows protected your PC" warning the first time, because
the installer is not signed with a paid code-signing certificate; it is not a
virus detection. Choose "More info", then "Run anyway".

## Hearing the other side

| System | How "Them" is captured |
|---|---|
| Windows | Built in. System audio is captured directly, nothing to install. |
| macOS | Install a loopback device such as BlackHole, route meeting output to it (a Multi-Output Device keeps your speakers working), then choose it under Settings > Their audio. |
| Linux | Choose the "Monitor of ..." PulseAudio/PipeWire device under Settings > Their audio. |

Use headphones. With speakers, your microphone also hears the other side;
duplicates are filtered, but headphones give a cleaner transcript.

## What the answers draw on

Everything lives in the **Knowledge** tab, organised by what it is:

| Section | What goes in it | How it is used |
|---|---|---|
| About me | Who you are, strengths, goals, how you like to sound | Sent with every answer |
| CV | Your CV: paste it or add the PDF/Word file | Sent with every answer |
| JD | The job description, agenda or brief for this meeting | Sent with every answer |
| Instructions | Tone, length, what to stress or avoid | Sent with every answer |
| Portfolio | Repositories, your portfolio site, folders, long documents | Searched; matching passages are used |
| Equipped | Nothing to fill in: it shows what the above adds up to | |

Each section takes typed or pasted text, files chosen with a click, and
files dropped onto it. Switching sections saves what you typed. Files are
copied into the app's own folder, so they keep working if the originals move.

**Sent with every answer** has a budget: the first 8,000 characters of each
note or file, 20,000 in total, in the order About me, CV, JD, Instructions.
Anything longer is still searched. **Equipped** shows exactly how much of
each note goes out, lists every searchable file with its passages, opens any
of them to show the text as the app read it, and lets you try a question.

**Portfolio** accepts:

- **GitHub**: `owner/repo`, a username (every repo that user owns), or a
  GitHub Pages address such as `https://you.github.io/portfolio/`, which is
  read as the repository behind it. Markdown, notebooks (outputs stripped),
  code, config, PDF, Word and exported HTML reports are split into passages.
  Add a token in Settings for private repos.
- **Files and folders**: dropped or chosen. A dropped folder stays in step
  with the folder on disk.
- **A web address**: a page, a PDF, or JSON (`[...]` or
  `{results|data|items: [...]}`, one passage per record).
- **Your search API**: set a URL such as `https://host/search?q={query}` in
  Settings and it is asked live for every answer (2.5 s limit).
- **LinkedIn** cannot be read by apps. On your profile choose More > Save to
  PDF and add that file to CV or Portfolio.

A job description is treated as what the other side wants, never as your
experience. Markdown gives the cleanest results (`##` headings become
passages); PDF and Word are read too, though multi-column layouts can come
out jumbled, and scanned PDFs have no text to read.

Retrieval is keyword-based and works offline once synced. Set an embedding
model under Settings > More to add meaning-based matching.

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

## License

MIT. Copyright © 2026 wjun78.
