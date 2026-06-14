// Velma proxy + Claude interpreter.
// - Holds the Modulate (Velma) key server-side and calls Velma-2 batch.
// - If an Anthropic key is present, it turns Velma's raw signals into a rich,
//   human emotional + personality read instead of flat template text.
// Keys are read from environment variables and never exposed to the browser.
//
// GET  /api/analyze            -> { ok:true, velmaKey:bool, llmKey:bool }   (health check, no secrets)
// POST /api/analyze (audio)    -> { configured:true, velma:{...}, interpreted:{...}|null }
//                              -> { configured:false }   (no Velma key set -> frontend simulates)
//                              -> { error, detail }      (something failed -> frontend simulates + note)

export const config = { api: { bodyParser: false } }; // we read the raw audio stream ourselves

const VELMA_BATCH = 'https://modulate-developer-apis.com/api/velma-2-batch';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';

export default async function handler(req, res) {
  // Health check: lets the page show whether the server can see each key, without revealing them.
  if (req.method === 'GET') {
    res.status(200).json({
      ok: true,
      velmaKey: !!process.env.MODULATE_API_KEY,
      llmKey: !!process.env.ANTHROPIC_API_KEY,
      model: MODEL,
    });
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed', detail: 'Use POST.' });
    return;
  }

  const key = process.env.MODULATE_API_KEY;
  if (!key) {
    res.status(200).json({ configured: false });
    return;
  }

  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const audio = Buffer.concat(chunks);
    if (!audio.length) {
      res.status(400).json({ error: 'no_audio', detail: 'Empty request body.' });
      return;
    }

    const contentType = req.headers['content-type'] || 'audio/webm';
    const form = new FormData();
    form.append('upload_file', new Blob([audio], { type: contentType }), 'reply.webm');
    form.append('config', 'default');

    const velmaRes = await fetch(VELMA_BATCH, {
      method: 'POST',
      headers: { 'X-API-Key': key },
      body: form,
    });

    const text = await velmaRes.text();
    if (!velmaRes.ok) {
      res.status(502).json({ error: 'velma_' + velmaRes.status, detail: text.slice(0, 600) });
      return;
    }

    let velma;
    try { velma = JSON.parse(text); } catch (e) { velma = { raw: text }; }

    // Turn Velma's raw signals into a richer read, if an Anthropic key is set.
    let interpreted = null, interpErr;
    const llmKey = process.env.ANTHROPIC_API_KEY;
    if (llmKey) {
      try { interpreted = await interpret(velma, llmKey); }
      catch (e) { interpErr = String((e && e.message) || e); }
    }

    res.status(200).json({ configured: true, velma, interpreted, interpErr });
  } catch (e) {
    res.status(500).json({ error: 'proxy_failure', detail: String((e && e.message) || e) });
  }
}

// --- Claude interpretation -------------------------------------------------
async function interpret(velma, llmKey) {
  const system =
    "You are the voice-analysis interpreter for First Dates, a thoughtful dating app by The School of Life. " +
    "You receive JSON from Velma, a model that analyses HOW someone sounds: emotions, sentiment, behaviours, and a transcript. " +
    "Write a warm, precise, specific read of the speaker as a person. " +
    "Rules: ground every claim in the data and the transcript. Prefer concrete, human emotional language over vague clinical words like 'measured', 'guarded' or 'self-possessed' unless the data clearly demands them. " +
    "Be insightful and a little generous, but never flattering for its own sake, never a horoscope, never wishy-washy. " +
    "If a transcript topic is present, refer to it naturally. Output STRICT JSON only, no prose or code fences around it.";

  const shape =
    '{"emotions":[{"label":"plain human emotion word","score":0.0_to_1.0}],' +
    '"story":"2 to 3 sentences on how they sounded and what it gently suggests about them, specific and grounded",' +
    '"personality":"a vivid 6 to 10 word personality descriptor",' +
    '"profileLine":"one short third-person line for their profile, e.g. Lights up talking about the people they love"}';

  const user =
    'Velma output (JSON):\n' + JSON.stringify(velma).slice(0, 12000) +
    '\n\nReturn ONLY JSON in exactly this shape:\n' + shape;

  const r = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'x-api-key': llmKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 700,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });

  if (!r.ok) {
    const t = await r.text();
    throw new Error('llm_' + r.status + ': ' + t.slice(0, 200));
  }
  const data = await r.json();
  let out = (data.content && data.content[0] && data.content[0].text) || '';
  out = out.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  const parsed = JSON.parse(out);
  if (!parsed || !parsed.story) throw new Error('llm_bad_shape');
  return parsed;
}
