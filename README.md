# First Dates — live Velma emotional read

A small web app that records a spoken reply, sends it to Velma (Modulate) for an
emotional read, uses Claude to turn Velma's raw signals into a rich, human read,
and writes the result onto the user's profile. All keys are held on the server
and are never exposed to the browser.

## What is in here

- `index.html` — the front end. Records the microphone, sends the audio to
  `/api/analyze`, and renders the read. Shows a server status line up top so you
  can see whether the keys are detected. Falls back to a clearly labelled
  simulated read if there is no key.
- `api/analyze.js` — the back end. Reads `MODULATE_API_KEY` and (optionally)
  `ANTHROPIC_API_KEY`, calls Velma, then Claude, and returns the result.
- `vercel.json`, `package.json` — project config. No dependencies to install.
- `demos/`, `docs/` — the clickable platform walkthrough, earlier prototypes, and
  the CTO briefing. Not needed to run the app.

## Environment variables (set in Vercel → Settings → Environment Variables)

- `MODULATE_API_KEY` (required for a live read) — your Velma / Modulate key.
- `ANTHROPIC_API_KEY` (optional, recommended) — turns Velma's signals into the
  richer, more human read. Without it, the app uses a plainer template.
- `ANTHROPIC_MODEL` (optional) — defaults to `claude-haiku-4-5-20251001`.

**Critical:** environment variables only apply to deployments built AFTER they
are added. After adding or changing a key you MUST redeploy (Deployments → the
latest one → Redeploy), or the running site will still behave as if the key is
missing. Make sure the variable is applied to the Production environment.

## Verify the server can see the keys

Open `https://YOUR-URL/api/analyze` in a browser. It returns, for example:

```json
{ "ok": true, "velmaKey": true, "llmKey": true, "model": "claude-haiku-4-5-20251001" }
```

If `velmaKey` is false, the key is not set for this deployment (add it, then
redeploy). The app shows the same status in the line under the header.

## Deploy on Vercel

1. Import this repo into Vercel. Framework Preset is **Other** (set in
   `vercel.json`); there is no build step.
2. Add the environment variables above.
3. Deploy, then open the URL, allow the microphone, and record. The badge should
   read **Live Velma**.

## Run locally (optional, for a developer)

```bash
npm i -g vercel
vercel dev   # serves the site and the /api function locally
```
Provide keys with `MODULATE_API_KEY=... ANTHROPIC_API_KEY=... vercel dev`.

## Notes and limits

- Safe to deploy with no keys: it runs in simulated mode and says so.
- A simulated read describes delivery and tone only. It never invents topics,
  because with no live call it does not know what was said.
- Velma's JSON shape may differ from assumptions. Claude reads the raw Velma JSON
  directly, so the interpreted read is robust to shape differences; the template
  fallback in `normalize()` is defensive too.
- Before pointing real users at this, add a consent screen before recording, a
  rate limit on `/api/analyze`, and keep the URL unlisted. Inferred emotion from
  intimate recordings is sensitive personal data.
