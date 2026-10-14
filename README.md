# Cue

Your cue, during the call. A small always-on-top window that sits beside
Teams, Zoom, Meet or any other call. It transcribes both sides, reads the
shared screen, and when the other side asks something it drafts what you
could say, grounded in your own notes, CV, documents, GitHub repositories and
search API. When the call ends it writes the whole thing up.

(Called Meeting Copilot up to version 0.3. Settings and notes carry over.)

It does not join the meeting as a bot and needs no Teams or Zoom admin
approval: it listens to your computer's audio and looks at your screen.

## Install it (Windows)

Download **Cue-Setup** from the
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

1. **Settings**: choose the service (OpenAI by default, with `gpt-6.1-sol`
   for answers and `gpt-live-transcribe` for speech (the other side's words
   appear while they speak; your microphone is transcribed after each pause
   with `gpt-4o-transcribe`); Groq is one click away,
   and any OpenAI-compatible service works) and paste its API key.
   Fill in "Names and terms to get right".
2. **Knowledge**: add `owner/repo`, a GitHub username (pulls every repo that
   user owns), a GitHub URL, a folder, or a URL that returns a document or JSON.
3. **Start listening** when the call begins and pick the meeting window or the
   screen it is on.

## What you get

| | |
|---|---|
| Transcript | "Them" (system audio) and "You" (microphone), cut at natural pauses; with a live speech model their line fills in while they speak, with each answer where it was given. "Save transcript" writes what was said to a text file; "Save with answers" adds every answer the app wrote where it was suggested, how long answers took, and the summary |
| Summary | When you stop listening, the call is written up from its transcript: an overview, every question they raised and what you answered, what they told you, the questions you asked, how you did (what went well, what was weak and what to say next time, for an interview or other call where you were assessed), follow-ups, and questions worth adding to your prepared answers. One extra request to the chat model per call; "Write it again", "Copy" and "Save summary" are in the Summary tab. Calls of only a few lines are not summarised. Turn it off under Settings > Answers |
| Earlier answers | In the wide or maximised window, under the current answer: every earlier answer of the meeting, to open again |
| Recording | The record button in the title bar (or Settings > Audio and screen): the call's audio, both sides, kept as a .webm file in Documents/Cue Recordings. Tell the other side where the law or the meeting's rules require it |
| Screen | Text read from the shared screen every few seconds, only when it changes |
| Answers | Written automatically when they ask a question (the "Auto" tick beside the answer buttons turns this off, so answers come only on the button or its shortcut); one or two sentences to say, then supporting points, with numbered sources you can click. When one of your prepared answers fits, it is shown the moment it is found, to read while the reply is written from it |
| Ask | Type your own question, or "Answer from the screen" for what is being shown, including SQL and code tasks |
| Window | Light or dark theme. Drag by the title bar, resize from any edge, minimise, maximise, compact (answer only), adjustable opacity |

## Shortcuts

They work while Teams or Zoom is the window in front, so you never have to
click on this app during a call.

| Keys | Action |
|---|---|
| `Alt+X` | Answer what they said |
| `Alt+B` | Answer from the screen |
| `Ctrl+Alt+/` | Show or hide the window |

The two used during a call are two keys each, both under the left hand, so
they can be pressed without looking. The defaults were checked against the
published Windows shortcut lists for Teams, Zoom, Google Meet, Webex, Chrome,
Edge and Firefox (October 2026): none of them use these. Each is printed on
its button, and the button the current answer came from is filled. Change
them under Settings > Shortcuts; the field tells you if a combination is
already used by one of those apps, and the app warns at start-up if another
program has taken the keys. (`Cmd` replaces `Ctrl` on macOS.)

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

## What an answer remembers

The model itself keeps nothing between questions, so the app sends the
context each time: your always-sent notes, the conversation so far (about
the last ten minutes, both sides), the earlier questions with the answers
it suggested (every earlier question of the meeting, the latest four in most
detail), the shared-screen text, and the best-matching passages. That
is why "make it shorter" or "can you elaborate?" works. "Clear for a new
meeting" forgets the conversation and the earlier suggestions; your notes
stay.

Each request opens with the parts that do not change between questions (the
always-sent notes, then your prepared answers in their own order) and only
then the parts that do. Services that keep a prefix they have already seen
(OpenAI does, for requests over about a thousand tokens) then skip re-reading
the unchanged part, so the reply starts sooner and costs less.

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
what it picks up while they are talking is left out, but headphones give a
cleaner transcript and keep your own words when you both speak at once.

Speech is found by a trained model (Silero VAD, run on your computer), not by
loudness, so a quiet voice is recorded and hiss, fans and typing are not.

A saved transcript ends with how much speech was recorded from each side. If
that is far less than was said, the audio is not reaching the app: check the
system volume and the devices under Settings.

## What the answers draw on

Everything lives in the **Knowledge** tab, organised by what it is:

| Section | What goes in it | How it is used |
|---|---|---|
| About me | Who you are, strengths, goals, how you like to sound | Sent with every answer |
| CV | Your CV: paste it or add the PDF/Word file | Sent with every answer |
| JD | The job description, agenda or brief for this meeting | Sent with every answer |
| Instructions | Tone, length, what to stress or avoid | Sent with every answer |
| Prepared answers | Questions you expect, each with the answer you want to give: typed one at a time, pasted as `Q:` / `A:` pairs, or dropped as a file (Word, PDF, Markdown or text with numbered questions, questions as headings or in bold, or `Q:` / `A:`; or a CSV with question and answer columns) | Offered with every question, closest first (about 16,000 characters fit, roughly 30 answers); when the question asked is the same or similar, the reply is built on your answer |
| Questions to ask | The questions you want to ask them, one per line | Sent with every answer; when they invite your questions, the whole list is shown less any the conversation already answered, with one or two more that follow from what they said |
| Publications | Your papers: add the PDF or Word file; type how you sum each one up | Searched section by section (methods, results, limitations); each paper's title and abstract, and what you typed, sent with every answer |
| Portfolio | Repositories, your portfolio site, folders, long documents | Searched; matching passages are used |
| Equipped | Nothing to fill in: it shows what the above adds up to | |

Each section takes typed or pasted text, files chosen with a click, and
files dropped onto it. Switching sections saves what you typed. Files are
copied into the app's own folder, so they keep working if the originals move.

**Sent with every answer** has a budget: the first 8,000 characters of each
note or file, 20,000 in total, in the order About me, CV, JD, Instructions,
Questions to ask, Publications.
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

Search is by keywords and, with OpenAI, also by meaning: passages and prepared
answers are embedded once with `text-embedding-3-small` (same key, a few
cents for thousands of passages) and each question is embedded when asked, so
a question worded differently still finds its passage or prepared answer. A
long question is embedded whole, from the start of their turn, alongside its
end. The lookup starts the moment the question is heard, during the short wait
to see whether they carry on, so it adds little or nothing to the answer.
Other services keep to keywords unless an embedding model is named under
Settings > More; type `off` there to use keywords only.

### Staying up to date

With "Keep repositories and web pages up to date automatically" on (the default), the app checks
every source a few seconds after it opens, every 30 minutes after that, and
once more at the moment you press Start listening.
A repo that has not been pushed to is not downloaded again, so the check is
one small request per repo. Apart from that one check, it pauses while you are listening to a meeting.
URLs you added are fetched again on the same schedule, and your search API is
asked live for every answer, so it is always current.
"Sync" beside a repository or web address forces a full re-read of it at any
time. Files you added are copies, read once when added.

## Privacy

- Audio clips, screen text and retrieved passages are sent to the model
  service you configure; with the summary on, so is the whole transcript when
  listening stops. Nothing else leaves your machine. Check that this is
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
  right". Speech is only written down as English or Mandarin: with "English
  and Mandarin" a sentence that comes back in any other language is
  transcribed once more in one of the two. If the whole meeting is in one
  language, choose "English only" or "Mandarin only", which is the most
  accurate.
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
renderer/          the window: capture.js (audio, screen), vad.js (finding speech), app.js (UI)
```

## License

MIT. Copyright © 2026 wjun78.
