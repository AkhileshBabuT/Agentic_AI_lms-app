"""OCR sidecar: rasterizes documents and OCRs pages via a local vLLM server.

Env:
  VLLM_URL      OpenAI-compatible base URL of the vLLM server (default http://localhost:8000/v1)
  OCR_MODEL_ID  model id served by vLLM (must match `vllm serve <id>`)
"""
import base64
import os

import fitz  # PyMuPDF
from fastapi import FastAPI, HTTPException
from openai import OpenAI
from pydantic import BaseModel

app = FastAPI()
client = OpenAI(base_url=os.environ.get("VLLM_URL", "http://localhost:8000/v1"), api_key="unused")
MODEL_ID = os.environ.get("OCR_MODEL_ID", "baidu/Unlimited-OCR")  # verified in Task 1 Step 1

PAGE_PROMPT = (
    "Convert this document page to clean Markdown. Preserve all text, headings, "
    "reading order, tables (as Markdown tables), and formulas (as LaTeX). "
    "Output ONLY the Markdown, no commentary."
)


class OcrRequest(BaseModel):
    file_b64: str
    mime_type: str


def _rasterize(data: bytes, mime_type: str) -> list[bytes]:
    """Return one PNG per page."""
    if mime_type == "application/pdf":
        doc = fitz.open(stream=data, filetype="pdf")
        # 2x zoom ~ 144 dpi: enough for print text without exploding VRAM
        return [page.get_pixmap(matrix=fitz.Matrix(2, 2)).tobytes("png") for page in doc]
    return [data]  # already an image


def _ocr_page(png: bytes) -> str:
    result = client.chat.completions.create(
        model=MODEL_ID,
        messages=[{
            "role": "user",
            "content": [
                {"type": "text", "text": PAGE_PROMPT},
                {"type": "image_url", "image_url": {
                    "url": f"data:image/png;base64,{base64.b64encode(png).decode()}"}},
            ],
        }],
        temperature=0.0,
        max_tokens=8192,
    )
    return (result.choices[0].message.content or "").strip()


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/ocr")
def ocr(req: OcrRequest):
    try:
        data = base64.b64decode(req.file_b64)
        pngs = _rasterize(data, req.mime_type)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not read document: {e}")
    if not pngs:
        raise HTTPException(status_code=400, detail="Document has no pages")
    # ponytail: sequential per-page calls; batch pages per request if throughput matters
    pages = [{"page_number": i + 1, "markdown": _ocr_page(png)} for i, png in enumerate(pngs)]
    return {"pages": pages, "model": MODEL_ID}
