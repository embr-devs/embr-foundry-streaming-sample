# embr-foundry-streaming-sample

A Node + Express sample that streams chat completions from Foundry to the
browser via **Server-Sent Events**. The whole point of this sample is to
exercise Embr's ingress (AFD → Envoy → YARP) on long-lived response streams.

## Why this sample exists

Every other Foundry chat sample in this org uses single-shot, non-streaming
`/chat/completions`. That hides whether the proxy chain buffers, coalesces
chunks, or drops idle connections mid-generation. This sample explicitly
opens a real `text/event-stream` channel and reports two timings to the
browser:

| Timing | Meaning |
|---|---|
| `server first token` | Foundry → this app: time to first delta |
| `server total` | Foundry → this app: full generation duration |
| `first chunk → client` (browser side) | Embr ingress + this app → browser: time from POST to first byte received in the browser |

If those numbers diverge in non-obvious ways, the proxy chain is buffering.

## Endpoints

| Path | Method | Notes |
|---|---|---|
| `/` | GET | Static chat UI |
| `/health` | GET | `{status:"ok"}` (Embr health probe) |
| `/api/config` | GET | Reports model + Foundry host so you can confirm wiring |
| `/api/chat/stream` | POST | `text/event-stream` — events: `token`, `done`, `error`, plus heartbeat comment lines every 15s |

## Local development

```bash
cd embr-foundry-streaming-sample
npm install
cp .env.example .env  # fill in FOUNDRY_BASE_URL and FOUNDRY_API_KEY
npm start
# → http://localhost:8000
```

## Foundry portal setup

Same as the chat sample — you need a model deployment in a Foundry project
and the OpenAI-compat v1 API endpoint + key. See
[`embr-foundry-chat-sample-python` README](https://github.com/embr-devs/embr-foundry-chat-sample-python)
for screenshots.

## Deploy on Embr

```bash
embr quickstart deploy embr-devs/embr-foundry-streaming-sample
embr variables set FOUNDRY_BASE_URL          "<your endpoint>"          -p <project> -e <env>
embr variables set FOUNDRY_API_KEY           "<your key>" --secret      -p <project> -e <env>
embr variables set FOUNDRY_MODEL_DEPLOYMENT  "<your deployment name>"   -p <project> -e <env>
embr deployments trigger -c HEAD -p <project> -e <env>
```

## Validate streaming through ingress

Use `curl --no-buffer` to confirm chunks arrive incrementally:

```bash
curl --no-buffer -N -X POST \
  https://<your-deployment-url>/api/chat/stream \
  -H 'content-type: application/json' \
  -d '{"message":"Write a 4-paragraph story about a panda who debugs servers."}'
```

If you see tokens trickle in, ingress is streaming correctly. If you see one
big block at the end, ingress (or the platform handler) is buffering — that's
a finding.

## Findings (specific to this sample)

Appended to the master `samples/FINDINGS.md`. Highlights:

- Whether `text/event-stream` survives intact through AFD + Envoy + YARP
- Whether the heartbeat comment lines (`: hb …\n\n`) are forwarded
- How long the proxy chain will hold an idle SSE connection without traffic
- Where the time-to-first-byte budget actually goes (Foundry vs proxy chain
  vs this app)
