// Clone synthesis. Takes the per-answer reads from a short conversation and asks
// Claude to compose a single coherent "clone" of the speaker.
// POST JSON: { turns: [{ question, story, personality, profileLine, emotions:[label] }] }
// -> { configured:true, clone:{ cloneStory, personality, profileLine, traits:[{name,phrase}], emotions:[{label,score}] } }
// -> { configured:false }                         (no Anthropic key set)
// -> { configured:true, error:"..." }             (synthesis failed -> frontend aggregates client-side)

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    res.status(200).json({ configured: false });
    return;
  }
  try {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    const turns = (body && body.turns) || [];
    if (!turns.length) { res.status(400).json({ error: 'no_turns' }); return; }
    const clone = await synth(turns, key);
    res.status(200).json({ configured: true, clone });
  } catch (e) {
    // configured:true with no clone -> the frontend will aggregate client-side
    res.status(200).json({ configured: true, error: String((e && e.message) || e) });
  }
}

async function synth(turns, key) {
  const system =
    "You are the clone-builder for First Dates, a thoughtful dating app by The School of Life. " +
    "You are given several per-answer reads from a short spoken conversation: each has the question asked, a short read of how the person sounded, and detected emotions. " +
    "Compose a single coherent 'clone' of this person: who they seem to be beneath the surface, drawn only from the evidence across answers. " +
    "Warm, specific, perceptive. Never generic, never a horoscope, never flattering for its own sake. Output STRICT JSON only.";

  const shape =
    '{"cloneStory":"3 to 4 sentences describing this person as a whole, grounded in the answers",' +
    '"personality":"a vivid 6 to 10 word descriptor",' +
    '"profileLine":"one evocative third-person line for their profile",' +
    '"traits":[{"name":"short trait name","phrase":"a short, specific phrase about how it shows"}],' +
    '"emotions":[{"label":"plain human emotion word","score":0.0_to_1.0}]}';

  const user =
    'Conversation reads (JSON):\n' + JSON.stringify(turns).slice(0, 12000) +
    '\n\nReturn ONLY JSON in exactly this shape, with 3 traits and up to 4 emotions:\n' + shape;

  const models = [...new Set([MODEL,
    'claude-sonnet-4-6',
    'claude-haiku-4-5-20251001',
    'claude-3-5-sonnet-20241022',
    'claude-3-5-haiku-20241022'].filter(Boolean))];

  let lastErr = 'synth_failed';
  for (const model of models) {
    try {
      const r = await fetch(ANTHROPIC_URL, {
        method: 'POST',
        headers: {
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ model, max_tokens: 900, system, messages: [{ role: 'user', content: user }] }),
      });
      if (!r.ok) { const t = await r.text(); lastErr = 'llm_' + r.status + ' (' + model + '): ' + t.slice(0, 160); continue; }
      const data = await r.json();
      const out = (data.content && data.content[0] && data.content[0].text) || '';
      const parsed = extractJson(out);
      if (parsed && parsed.cloneStory) return parsed;
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
