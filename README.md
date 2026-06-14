# First Dates — live Velma emotional read

A small web app that records a spoken reply, sends it to Velma (Modulate) for an
emotional read, builds a short story from it, and writes the result onto the
user's profile. The Velma API key is held on the server and is never exposed to
the browser.

## What is in here

- `index.html` — the front end. Records the microphone, sends the audio to
  `/api/analyze`, and renders the emotional read. If the server has no key set,
  it shows a clearly labelled simulated read instead.
- `api/analyze.js` — the back end proxy. Reads `MODULATE_API_KEY` from the
  environment, calls Velma-2 batch, and returns the result.
- `vercel.json`, `package.json` — project config. No dependencies to install.

## Deploy on Vercel (recommended)

1. Create a free account at vercel.com and a new project, pointing it at this
   `velma-live` folder (via the Vercel dashboard, the Vercel CLI, or a Git repo).
2. In the project, open **Settings → Environment Variables** and add:
   - Name: `MODULATE_API_KEY`
   - Value: your Velma / Modulate API key
   - Apply to: Production (and Preview if you want)
3. Deploy. Vercel gives you an HTTPS URL.
4. Open the URL, allow the microphone, record a reply. The badge should read
   **Live Velma**, and the read will reflect what you actually said.

Do not put the key in the code or anywhere in the front end. It belongs only in
the Vercel environment variable above.

## Run locally (optional, for a developer)

```bash
npm i -g vercel
cd velma-live
vercel dev            # serves the site and the /api function locally
```
Set the key for local runs with `MODULATE_API_KEY=... vercel dev`, or add it via
`vercel env`.

## Notes and limits

- Without a key the app runs in simulated mode, so it is safe to deploy first and
  add the key later.
- A simulated read describes delivery and tone only. It never invents topics,
  because with no live call it does not know what was said.
- Velma's exact JSON shape may differ slightly from what `api/analyze.js` returns.
  The front end parser in `index.html` (`normalize()`) is defensive and falls
  back gracefully, and can be tightened once you see a real response.
- Before pointing real users at this, add a short consent screen before recording,
  a basic rate limit on `/api/analyze`, and keep the URL unlisted. Inferred
  emotion from intimate recordings is sensitive personal data.
