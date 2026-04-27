// Embr × Foundry — streaming SSE sample
//
// This sample exists specifically to stress-test Embr's ingress on long-lived
// response streams. Existing Foundry chat samples in this org use single-shot
// /chat/completions with no streaming; this one opens a real SSE channel from
// browser → Embr ingress (AFD → Envoy → YARP) → this Node app → Foundry,
// proxying tokens as they arrive.
//
// What it surfaces:
//   • Whether AFD or Envoy buffers SSE responses (the `Content-Type:
//     text/event-stream` + `X-Accel-Buffering: no` should disable buffering on
//     the proxy layer; this sample confirms whether that's honored).
//   • Whether YARP correctly streams chunked transfer-encoding through.
//   • Idle-timeout behavior on long generations.

import express from 'express';
import OpenAI from 'openai';
import 'dotenv/config';

const PORT = parseInt(process.env.PORT || '8000', 10);
const HOST = '0.0.0.0';

const app = express();
app.use(express.json());

const FOUNDRY_BASE_URL = process.env.FOUNDRY_BASE_URL;
const FOUNDRY_API_KEY = process.env.FOUNDRY_API_KEY;
const FOUNDRY_MODEL = process.env.FOUNDRY_MODEL_DEPLOYMENT || 'gpt-4o-mini';

let openai = null;
if (FOUNDRY_BASE_URL && FOUNDRY_API_KEY) {
  openai = new OpenAI({ baseURL: FOUNDRY_BASE_URL, apiKey: FOUNDRY_API_KEY });
}

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.get('/api/config', (_req, res) => {
  let host = '';
  let project = '';
  try {
    if (FOUNDRY_BASE_URL) {
      const u = new URL(FOUNDRY_BASE_URL);
      host = u.host;
      const parts = u.pathname.split('/').filter(Boolean);
      const idx = parts.indexOf('projects');
      if (idx !== -1 && idx + 1 < parts.length) project = parts[idx + 1];
    }
  } catch {}
  res.json({
    model: FOUNDRY_MODEL,
    foundry_host: host,
    foundry_project: project,
    shape: 'streaming chat completions (SSE)',
    configured: !!openai,
  });
});

// --- The actual streaming endpoint --------------------------------------------
// Returns a real text/event-stream channel. Each token arrives as one event
// of the form:  event: token \n data: {"text":"..."} \n\n
// Final marker:                event: done  \n data: {} \n\n
// On error:                    event: error \n data: {"message":"..."} \n\n

app.post('/api/chat/stream', async (req, res) => {
  if (!openai) {
    res.status(500).json({ error: 'Foundry not configured. Set FOUNDRY_BASE_URL + FOUNDRY_API_KEY.' });
    return;
  }
  const { message, history = [] } = req.body || {};
  if (!message || typeof message !== 'string') {
    res.status(400).json({ error: 'message (string) required' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  // Hint to nginx-style proxies (and to Embr's ingress) to not buffer this.
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // Heartbeat so idle-timeouts mid-generation get extended on the proxy chain.
  // (Comment lines in SSE are ignored by browsers but keep the conn alive.)
  const heartbeat = setInterval(() => {
    try { res.write(`: hb ${Date.now()}\n\n`); } catch {}
  }, 15000);

  try {
    const messages = [
      {
        role: 'system',
        content:
          'You are a friendly demo assistant inside an Embr-hosted Node app. ' +
          'When asked to write something long, write a moderately long response ' +
          '(a few paragraphs) so we can observe streaming behavior. Keep tone friendly.',
      },
      ...history.filter((m) => m.role && m.content).map((m) => ({ role: m.role, content: m.content })),
      { role: 'user', content: message },
    ];

    const stream = await openai.chat.completions.create({
      model: FOUNDRY_MODEL,
      messages,
      stream: true,
    });

    let total = 0;
    const startedAt = Date.now();
    let firstTokenAt = null;
    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) {
        if (firstTokenAt === null) firstTokenAt = Date.now() - startedAt;
        total += delta.length;
        send('token', { text: delta });
      }
    }
    send('done', {
      total_chars: total,
      first_token_ms: firstTokenAt,
      total_ms: Date.now() - startedAt,
    });
  } catch (err) {
    console.error('stream error:', err);
    send('error', { message: err?.message || String(err) });
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
});

app.use(express.static(new URL('./static', import.meta.url).pathname));

app.listen(PORT, HOST, () => {
  console.log(`embr-foundry-streaming-sample listening on http://${HOST}:${PORT}`);
  console.log(`  Foundry configured: ${!!openai}`);
  console.log(`  model: ${FOUNDRY_MODEL}`);
});
