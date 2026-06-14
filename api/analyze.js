// Velma proxy — holds the Modulate key server-side and calls Velma-2 batch.
// The browser sends the raw audio bytes to this endpoint. The key is read from
// the MODULATE_API_KEY environment variable and is never exposed to the browser.
//
// Responses:
//   { configured:false }                  -> no key set on the server, frontend simulates
//   { configured:true, velma:{...} }       -> Velma's analysis JSON
//   { error:"...", detail:"..." }          -> something went wrong (frontend simulates + shows note)

export const config = { api: { bodyParser: false } }; // we read the raw audio stream ourselves

const VELMA_BATCH = 'https://modulate-developer-apis.com/api/velma-2-batch';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed', detail: 'Use POST.' });
    return;
  }

  const key = process.env.MODULATE_API_KEY;
  if (!key) {
    // No key configured yet. Tell the frontend so it falls back to a simulated read.
    res.status(200).json({ configured: false });
    return;
  }

  try {
    // Collect the raw audio bytes from the request stream.
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const audio = Buffer.concat(chunks);
    if (!audio.length) {
      res.status(400).json({ error: 'no_audio', detail: 'Empty request body.' });
      return;
    }

    const contentType = req.headers['content-type'] || 'audio/webm';

    // Build the multipart form Velma expects.
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

    let json;
    try { json = JSON.parse(text); } catch (e) { json = { raw: text }; }

    res.status(200).json({ configured: true, velma: json });
  } catch (e) {
    res.status(500).json({ error: 'proxy_failure', detail: String((e && e.message) || e) });
  }
}
