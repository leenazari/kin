// Text to speech via ElevenLabs, so Kin has a natural voice instead of the
// robotic browser one. The key stays on the server.
// POST JSON { text } -> audio/mpeg bytes
//                    -> { configured:false }   (no ElevenLabs key -> frontend uses browser voice)
//                    -> { error, detail }      (failed -> frontend uses browser voice)
//
// Optional env vars:
//   ELEVENLABS_API_KEY   (required for a real voice)
//   ELEVENLABS_VOICE_ID  (defaults to a warm voice; pick any from your ElevenLabs voice library)
//   ELEVENLABS_MODEL     (defaults to eleven_turbo_v2_5 for low latency)

const VOICE_ID = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM'; // "Rachel" — warm, calm
const TTS_MODEL = process.env.ELEVENLABS_MODEL || 'eleven_turbo_v2_5';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) {
    res.status(200).json({ configured: false });
    return;
  }
  try {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    const text = ((body && body.text) || '').toString().slice(0, 800);
    if (!text.trim()) { res.status(400).json({ error: 'no_text' }); return; }

    const r = await fetch('https://api.elevenlabs.io/v1/text-to-speech/' + VOICE_ID, {
      method: 'POST',
      headers: {
        'xi-api-key': key,
        'content-type': 'application/json',
        'accept': 'audio/mpeg',
      },
      body: JSON.stringify({
        text,
        model_id: TTS_MODEL,
        voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.3, use_speaker_boost: true },
      }),
    });

    if (!r.ok) {
      const t = await r.text();
      res.status(502).json({ error: 'tts_' + r.status, detail: t.slice(0, 200) });
      return;
    }

    const audio = Buffer.from(await r.arrayBuffer());
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).send(audio);
  } catch (e) {
    res.status(500).json({ error: 'tts_failure', detail: String((e && e.message) || e) });
  }
}
