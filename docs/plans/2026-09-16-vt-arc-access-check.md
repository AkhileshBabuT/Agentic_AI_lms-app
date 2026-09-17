# VT ARC generation integration and access check

## Implemented

Course chat uses a separate generation-only provider contract; assignment grading retains its existing provider. `RAG_GENERATION_PROVIDER` defaults explicitly to `vt_arc`. There is no mock or cross-provider fallback. Configure `VT_ARC_MODEL` explicitly after confirming an accessible chat model. The presence of `VT_ARC_API_KEY` does not establish usable model access.

The transport pins `https://llm-api.arc.vt.edu/api/v1`, denies redirects and legacy tool-calling model IDs, sends buffered chat messages without upstream files/web tools, and bounds the response size. An overall timeout covers admission, generation, and retries. Transient HTTP errors receive at most one retry by default; ARC's `error.retry_after_s` and standard `Retry-After` are respected when they fit inside that deadline. Uncertain network failures are not retried. Authentication failures, truncated responses, and tool-call responses fail clearly. Errors exposed to the app contain no upstream bodies, secrets, or prompts.

Application admission combines a bounded process queue with PostgreSQL session advisory locks. All replicas using the same database, credential, model, and concurrency setting share the same active slots. A dedicated database pool connection stays checked out during an active generation and retries; connection loss aborts that request. Keep sufficient pool connections available for ordinary application queries. A browser/manual request or another application outside this admission system still contributes to ARC's upstream limit. Test fixtures and the synthetic probe inject/use local admission without opening the application database.

## Official endpoint and credential compatibility

[ARC's shared API documentation](https://docs.arc.vt.edu/ai/011_llm_api_arc_vt_edu.html) specifies Bearer authentication at `/api/v1/chat/completions` with the personal API key generated under **User profile → Settings → Account → API keys** in [the Open WebUI interface](https://docs.arc.vt.edu/ai/010_llm_arc_vt_edu.html). Therefore a key obtained from that interface is intended for the documented inference gateway; a separate adapter targeting the browser host is unnecessary. Model inventory and capacity change over time, so the configuration must use a confirmed API model ID. This application keeps its own pgvector retrieval and GCS files; it does not upload the corpus to ARC's separate RAG service.

## Synthetic check result — September 16, 2026

- The server-side `VT_ARC_API_KEY` was present; its value was never printed or saved to this report.
- GET `https://llm-api.arc.vt.edu/api/v1/models` returned HTTP **403**, so accessible models could not be discovered.
- A minimal POST to the **documented** `/api/v1/chat/completions` endpoint with the documented `gpt-oss-120b` model ID and fabricated course evidence also failed authentication/access (the transport groups HTTP **401/403** under that category; the exact chat status was not retained in the probe output). No real course content was transmitted. The model ID was a probe argument, not a verified default or an `.env` change.
- **No successful generation or structured JSON capability has been verified.** HTTP 403 alone cannot establish whether the cause is credential/account access, gateway policy, or network restrictions. The implementation classifies it as an authentication/access failure and does not silently switch providers.

### Recheck - September 17, 2026

The current `.env` key was loaded correctly, with no inherited environment override, whitespace or accidental Bearer prefix. The normal discovery and synthetic generation probe returned HTTP **403** for both endpoints. A second minimal synthetic chat request and a discovery request without credentials both returned the same plain-text response:

> API access is restricted to the VT Campus VPN. Please connect to the VPN and retry.

This establishes a **network access restriction**, not an invalid-key diagnosis. The gateway response does not establish whether model authentication was reached; key validity and model capability remain unverified. The Open WebUI personal key is still the documented credential type. The probe now recognizes this specific response, reports `network_restricted`, and stops before unnecessary generation attempts.

Connect the machine running the backend/probe to the VT Campus VPN and rerun the commands below. The backend deployment also needs an ARC-permitted network path. If the same response persists while connected, ask ARC support about VPN routing and the permitted deployment arrangement. No key rotation is indicated by this response alone; never send the secret to support. Confirm the permitted backend arrangement before a department rollout using a personal credential; ARC explicitly forbids sharing keys with other users.

### Successful recheck - September 17, 2026

After the user changed the network connection, the same probe and current key succeeded:

- Model discovery returned HTTP **200**, including `gpt-oss-120b` and other ARC chat model IDs.
- Synthetic generation through the actual VT ARC adapter succeeded using `gpt-oss-120b`.
- The response passed the probe's JSON evidence-format check (`jsonEvidenceFormat: true`); usage was 144 input tokens and 154 output tokens.

The current credential and network path now permit this model request. This confirms the previous VPN restriction was resolved for this environment. It does not establish live course answer quality, permissions for every listed model, or department load capacity. No real course content was sent; `.env` was not changed. `gpt-oss-120b` is now a verified option for `VT_ARC_MODEL`.

## Configuration and repeatable probe

Existing secret: `VT_ARC_API_KEY` (server side only). Required deployment setting: `VT_ARC_MODEL=<confirmed chat-model ID>`. Optional settings:

| Setting | Default |
| --- | --- |
| `RAG_GENERATION_PROVIDER` | `vt_arc` |
| `VT_ARC_BASE_URL` | `https://llm-api.arc.vt.edu/api/v1` (only allowed gateway) |
| `VT_ARC_TIMEOUT_MS` | `45000` |
| `VT_ARC_CONCURRENCY` | `2` (same on all replicas) |
| `VT_ARC_MAX_QUEUE` | `20` |
| `VT_ARC_MAX_RETRIES` | `1` |
| `VT_ARC_MAX_OUTPUT_TOKENS` | `1500` |
| `VT_ARC_REASONING_EFFORT` | omitted; optional `low`, `medium`, `high` only after capability check |

From `backend/` after access is resolved:

```powershell
npx ts-node src/scripts/probeVtArc.ts --discover-only
npx ts-node src/scripts/probeVtArc.ts --model=<confirmed-model-id>
```

The probe loads `.env` quietly, prints only gateway/status/model IDs and generation capability metadata, and never opens the database or uploads files. `--model` changes only the probe process environment. A full success reports `jsonEvidenceFormat: true` for a fabricated E1 passage. Discovery may be unsupported even if chat works, so a failed discovery does not prevent the documented synthetic chat check when a model is supplied explicitly.
