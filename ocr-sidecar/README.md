# OCR sidecar

Two processes:

1. **vLLM model server** (WSL2 or Docker — vLLM needs Linux + CUDA):
   ```
   pip install vllm && vllm serve baidu/Unlimited-OCR --port 8000
   ```
   Model id: `baidu/Unlimited-OCR`. Fallback if VRAM-constrained: `PaddlePaddle/PaddleOCR-VL`.

2. **This wrapper** (any OS):
   ```
   pip install -r requirements.txt
   uvicorn server:app --port 8100
   ```

Backend env: `OCR_SIDECAR_URL=http://localhost:8100`

## Contract

`POST /ocr` with body `{"file_b64": string, "mime_type": string}` → `200 {"pages": [{"page_number": int, "markdown": string}], "model": string}`

`GET /health` → `{"status": "ok"}`

## Before first run

1. **Verify the model exists and fits your hardware:**
   - Visit https://huggingface.co/baidu/Unlimited-OCR and confirm the repo exists.
   - Check the model card for minimum VRAM requirements.
   - If the model card's minimum VRAM exceeds your local GPU capacity, use `PaddlePaddle/PaddleOCR-VL` instead.
   - Update the `vllm serve` command above with your chosen model id.

2. **Smoke test** (after vLLM and uvicorn are both running):
   ```python
   python - <<'EOF'
   import base64, json, urllib.request
   pdf = open("any-scanned-test.pdf", "rb").read()
   body = json.dumps({"file_b64": base64.b64encode(pdf).decode(), "mime_type": "application/pdf"}).encode()
   req = urllib.request.Request("http://localhost:8100/ocr", body, {"Content-Type": "application/json"})
   out = json.load(urllib.request.urlopen(req, timeout=600))
   print(out["model"], len(out["pages"]), out["pages"][0]["markdown"][:200])
   EOF
   ```
   Expected output: model id, page count, readable Markdown of page 1.
   
   If the vLLM chat template rejects image content, consult the model card's serving instructions (some OCR models need `--chat-template` flags). Update the `vllm serve` command in the README with the flag.
