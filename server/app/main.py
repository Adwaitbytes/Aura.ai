# server/app/main.py (fixed Gemini payload)

import os
import re
import json
import logging
from typing import Any, Dict, List, Optional

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv

# ---------------------------
# Config & Logging
# ---------------------------
load_dotenv()
GEMINI_KEY = os.getenv("GEMINI_API_KEY")
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
GEMINI_ENDPOINT = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent"

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("cranq-plus")

# ---------------------------
# FastAPI
# ---------------------------
app = FastAPI(title="CRANQ-Plus Gemini Backend")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
    allow_credentials=True,
)

# ---------------------------
# Models
# ---------------------------
class GenerateReq(BaseModel):
    context: Dict[str, Any]

# ---------------------------
# Gemini Call
# ---------------------------
async def call_gemini_raw(prompt: str, timeout: int = 30) -> Dict[str, Any]:
    if not GEMINI_KEY:
        raise HTTPException(status_code=500, detail="GEMINI_API_KEY not set")

    payload = {
        "contents": [
            {"parts": [{"text": prompt}]}
        ]
    }
    headers = {
        "Content-Type": "application/json",
        "X-goog-api-key": GEMINI_KEY,
    }

    async with httpx.AsyncClient(timeout=timeout) as client:
        try:
            resp = await client.post(GEMINI_ENDPOINT, json=payload, headers=headers)
            resp.raise_for_status()
            return resp.json()
        except httpx.HTTPStatusError as e:
            logger.error("Gemini HTTP error: %s %s", e, e.response.text)
            raise HTTPException(status_code=502, detail=f"Gemini HTTP error: {e.response.text}")
        except Exception as e:
            logger.exception("Error calling Gemini: %s", e)
            raise HTTPException(status_code=502, detail=f"Error calling Gemini: {e}")

# ---------------------------
# Extract + Fallback Logic
# ---------------------------
def extract_text_from_gemini_response(resp: Any) -> str:
    parts: List[str] = []
    def walk(node: Any):
        if node is None:
            return
        if isinstance(node, str):
            parts.append(node)
        elif isinstance(node, dict):
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for item in node:
                walk(item)
    walk(resp)
    combined = " ".join(p.strip() for p in parts if p and p.strip())
    return re.sub(r"\s+", " ", combined).strip()

def try_parse_json_array(text: str) -> Optional[List[Dict[str, str]]]:
    try:
        parsed = json.loads(text)
        if isinstance(parsed, list):
            return parsed
    except Exception:
        pass
    m = re.search(r"(\[\s*\{[\s\S]*?\}\s*\])", text)
    if m:
        try:
            return json.loads(m.group(1))
        except Exception:
            pass
    return None

def split_into_candidates_from_plain(text: str) -> List[Dict[str, str]]:
    sentences = re.split(r'(?<=[.!?])\s+', text)
    short = (sentences[0] if sentences else text)[:220]
    balanced = (" ".join(sentences[:2]) if len(sentences) >= 2 else text)[:220]
    detailed = text[:240]
    return [
        {"label": "Short — To-the-point", "text": short.strip()},
        {"label": "Balanced — Humanish", "text": balanced.strip()},
        {"label": "Detailed — Structured", "text": detailed.strip()},
    ]

async def generate_replies_from_text(tweet_text: str, author: str = "", images: Optional[List[str]] = None) -> List[Dict[str, str]]:
    prompt = (
        "You are an assistant that writes short, structured, human-like replies suitable for replying to a tweet. "
        "Return ONLY a JSON array of exactly three objects (no commentary) with fields: 'label' and 'text'. "
        "Use labels: 'Short — To-the-point', 'Balanced — Humanish', 'Detailed — Structured'. "
        "Replies must be <=240 chars and use ≤2 emojis.\n\n"
        f"Tweet: {tweet_text}\nAuthor: {author}\nImages: {len(images or [])}"
    )
    raw_resp = await call_gemini_raw(prompt)
    extracted = extract_text_from_gemini_response(raw_resp)

    parsed = try_parse_json_array(extracted)
    if parsed:
        return parsed[:3]
    return split_into_candidates_from_plain(extracted or tweet_text)

# ---------------------------
# Endpoints
# ---------------------------
@app.get("/")
async def root():
    return {"message": "🚀 Cranq-Plus Gemini backend running"}

@app.get("/ask")
async def ask(question: str):
    suggestions = await generate_replies_from_text(question)
    return {"question": question, "suggestions": suggestions}

@app.post("/api/generate")
async def generate(req: GenerateReq):
    ctx = req.context or {}
    text = (ctx.get("text") or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="context.text is required")
    suggestions = await generate_replies_from_text(text, ctx.get("author"), ctx.get("images"))
    return {"suggestions": suggestions}
