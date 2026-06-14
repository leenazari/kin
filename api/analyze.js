// Velma proxy + Claude interpreter.
// - Holds the Modulate (Velma) key server-side.
// - Streams the audio to Velma's WebSocket endpoint for per-utterance, moment-to-moment
//   emotion. Falls back to the batch endpoint automatically if streaming fails, so the
//   demo never breaks.
// - Uses a custom "Relationship Reflection" conversation type so Velma stops guessing
//   "media narration".
// - If an Anthropic key is present, turns Velma's signals into a rich, human read.
// Keys are read from environment variables and never exposed to the browser.
//
// GET  /api/analyze            -> { ok, velmaKey, llmKey, ttsKey, model }   (health check)
// POST /api/analyze (audio)    -> { configured:true, velma:{...}, interpreted:{...}|null }
//                              -> { configured:false }   (no Velma key set -> frontend simulates)
//                              -> { error, detail }      (something failed -> frontend simulates + note)

export const config = { api: { bodyParser: false } }; // we read the raw audio stream ourselves

const VELMA_BATCH = 'https://modulate-developer-apis.com/api/velma-2-batch';
const VELMA_STREAM = 'wss://modulate-developer-apis.com/api/velma-2-streaming';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';

const CT_UUID = 'a1b2c3d4-1111-4111-8111-000000000001';
const ROLE_UUID = 'b2c3d4e5-2222-4222-8222-000000000001';

function velmaConfigObj() {
  return {
    stt: { emotion_signal: true },
    default_conversation_type: CT_UUID,
    conversation_types: [{
      conversation_type_uuid: CT_UUID,
      name: 'Relationship Reflection',
      short_description: 'A person reflecting candidly on themselves in relationships.',
      detailed_description: 'A single speaker answering questions about who they are in close relationships — how they love, connect, and handle conflict, distance and reassurance. The tone is personal and honest. This is self-reflection, not media narration, an interview, or a service call.',
    }],
    participant_roles: [{
      participant_role_uuid: ROLE_UUID,
      name: 'Reflecting Speaker',
      short_description: 'The person reflecting on their relational self.',
      detailed_description: 'The single speaker sharing honest reflections about their own feelings and patterns in relationships.',
      applies_to_conversation_type_uuids: [CT_UUID],
    }],
  };
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    res.status(200).json({
      ok: true,
      velmaKey: !!process.env.MODULATE_API_KEY,
      llmKey: !!process.env.ANTHROPIC_API_KEY,
      ttsKey: !!process.env.ELEVENLABS_API_KEY,
      model: MODEL,
    });
    return;
  }
  if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed', detail: 'Use POST.' }); return; }

  const key = process.env.MODULATE_API_KEY;
  if (!key) { res.status(200).json({ configured: false }); return; }

  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const audio = Buffer.concat(chunks);
    if (!audio.length) { res.status(400).json({ error: 'no_audio', detail: 'Empty request body.' }); return; }

    const contentType = req.headers['content-type'] || 'audio/webm';
    const cfg = velmaConfigObj();

    // Prefer streaming (per-utterance emotion). Fall back to batch on any issue.
    let velma;
    try {
      velma = await velmaStreaming(audio, key, cfg);
      if (!velma.clips || !velma.clips.length) throw new Error('stream_no_clips');
    } catch (streamErr) {
      try {
        velma = await velmaBatch(audio, contentType, key, cfg);
        velma.__stream_fallback = String((streamErr && streamErr.message) || streamErr);
      } catch (batchErr) {
        res.status(502).json({ error: 'velma_failed', detail: String((batchErr && batchErr.message) || batchErr) });
        return;
      }
    }

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

// --- Velma streaming (per-utterance emotion) -------------------------------
async function velmaStreaming(audio, key, cfg) {
  let WS;
  try { WS = (await import('ws')).default; } catch (e) { throw new Error('ws_unavailable'); }
  return await new Promise((resolve, reject) => {
    const out = { __source: 'streaming', duration_ms: 0, clips: [], behaviors: [], conversation_type_pick: null, participant_role_picks: [], topics: [], topic_sentiments: [], summary: '' };
    let settled = false, ws;
    const finish = (err) => { if (settled) return; settled = true; clearTimeout(timer); try { ws && ws.close(); } catch (e) {} err ? reject(err) : resolve(out); };
    const timer = setTimeout(() => finish(out.clips.length ? null : new Error('stream_timeout')), 30000);
    try {
      ws = new WS(VELMA_STREAM + '?api_key=' + encodeURIComponent(key));
    } catch (e) { finish(new Error('ws_connect_failed')); return; }
    ws.on('open', () => {
      try {
        ws.send(JSON.stringify(cfg));
        const CH = 32 * 1024;
        for (let i = 0; i < audio.length; i += CH) ws.send(audio.subarray(i, Math.min(audio.length, i + CH)));
        ws.send(''); // end-of-stream
      } catch (e) { finish(e); }
    });
    ws.on('message', (data) => {
      let ev; try { ev = JSON.parse(data.toString()); } catch (e) { return; }
      switch (ev.type) {
        case 'clip': if (ev.clip) out.clips.push(ev.clip); break;
        case 'conversation_type': out.conversation_type_pick = ev.pick; break;
        case 'participant_role': if (ev.pick) out.participant_role_picks.push(ev.pick); break;
        case 'behavior_detection': if (ev.detection) out.behaviors.push(ev.detection); break;
        case 'topics': out.topics = ev.topics || []; break;
        case 'topic_sentiment': if (ev.topic_sentiment) out.topic_sentiments.push(ev.topic_sentiment); break;
        case 'summary': out.summary = ev.text || ''; break;
        case 'done': out.duration_ms = ev.duration_ms || out.duration_ms; finish(null); break;
        case 'error': finish(new Error(ev.error || 'stream_error')); break;
      }
    });
    ws.on('error', (e) => finish(e instanceof Error ? e : new Error('ws_error')));
    ws.on('close', () => { if (!settled) finish(out.clips.length ? null : new Error('closed_early')); });
  });
}

// --- Velma batch (fallback) ------------------------------------------------
async function velmaBatch(audio, contentType, key, cfg) {
  const form = new FormData();
  form.append('upload_file', new Blob([audio], { type: contentType }), 'reply.webm');
  form.append('config', JSON.stringify(cfg));
  const r = await fetch(VELMA_BATCH, { method: 'POST', headers: { 'X-API-Key': key }, body: form });
  const text = await r.text();
  if (!r.ok) throw new Error('velma_' + r.status + ': ' + text.slice(0, 300));
  let velma; try { velma = JSON.parse(text); } catch (e) { velma = { raw: text }; }
  velma.__source = 'batch';
  return velma;
}

// --- Claude interpretation -------------------------------------------------
async function interpret(velma, llmKey) {
  const system =
    "You are the voice-analysis interpreter for First Dates, a thoughtful dating app by The School of Life. " +
    "Everything you write is about who this person is IN A RELATIONSHIP: what they are like to be close to, how they show love and warmth, how they handle conflict, distance and reassurance, what they bring to a partner and what they may need. " +
    "You receive JSON from Velma, a model that analyses HOW someone sounds. Each clip carries an 'emotion' field, which is Velma's acoustic read of the voice (for example Affectionate, Calm, Hopeful, Anxious, Content, Sad), produced from the sound itself and not from the words. There may be several clips, and the emotion can shift between them — pay attention to that movement. " +
    "Treat the per-clip 'emotion' fields as your PRIMARY signal. Read like a perceptive therapist in session: the richest insight is in the RELATIONSHIP between how they sounded and what they said, and in how the feeling moves across the answer. Where tone and words agree it is sincere; where they diverge (upbeat words in an anxious or sad voice, calm words carrying longing, reassurance said tensely) that gap is where the real feeling lives. Name what they feel but may not be saying directly. Never just paraphrase the words. " +
    "Write a warm, precise, specific relational read. Prefer concrete, human language over vague clinical words like 'measured' or 'guarded' unless the data clearly demands them. " +
    "Be insightful and a little generous, but never flattering for its own sake, never a horoscope, never wishy-washy. Output STRICT JSON only, no prose or code fences.";

  const shape =
    '{"emotions":[{"label":"plain human emotion word","score":0.0_to_1.0}],' +
    '"story":"2 to 3 sentences on how they sounded and what it suggests about them as a partner, specific and grounded",' +
    '"personality":"a vivid 6 to 10 word descriptor of them in relationships",' +
    '"profileLine":"one short third-person line about what they are like to love, e.g. Loves hard once they trust, and shows it in small acts",' +
    '"followUp":"a warm, specific one-sentence follow-up question about how they are in relationships, based on what they just said"}';

  const user =
    'Velma output (JSON):\n' + JSON.stringify(velma).slice(0, 12000) +
    '\n\nReturn ONLY JSON in exactly this shape:\n' + shape;

  const models = [...new Set([MODEL,
    'claude-sonnet-4-6',
    'claude-haiku-4-5-20251001',
    'claude-3-5-sonnet-20241022',
    'claude-3-5-haiku-20241022'].filter(Boolean))];

  let lastErr = 'llm_failed';
  for (const model of models) {
    try {
      const r = await fetch(ANTHROPIC_URL, {
        method: 'POST',
        headers: { 'x-api-key': llmKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model, max_tokens: 700, system, messages: [{ role: 'user', content: user }] }),
      });
      if (!r.ok) { const t = await r.text(); lastErr = 'llm_' + r.status + ' (' + model + '): ' + t.slice(0, 160); continue; }
      const data = await r.json();
      const out = (data.content && data.content[0] && data.content[0].text) || '';
      const parsed = extractJson(out);
      if (parsed && parsed.story) return parsed;
      lastErr = 'llm_bad_shape (' + model + ')';
    } catch (e) {
      lastErr = String((e && e.message) || e) + ' (' + model + ')';
    }
  }
  throw new Error(lastErr);
}

function extractJson(s) {
  if (!s) return null;
  let t = s.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  try { return JSON.parse(t); } catch (e) {}
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch (e) {} }
  return null;
}
