# server/app/llm_client.py
import os
import json
import re
from typing import List, Dict, Any, Optional

import httpx

GEMINI_KEY = os.getenv("GEMINI_API_KEY")
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"

if not GEMINI_KEY:
    # don't raise here — we'll raise in call function with clearer message
    pass


async def call_gemini_raw(prompt: str, timeout: int = 30) -> Dict[str, Any]:
    """
    Call Gemini generative language endpoint and return the parsed JSON response.
    Uses X-goog-api-key header (matches the curl you provided).
    """
    if not GEMINI_KEY:
        raise RuntimeError("GEMINI_API_KEY not set in environment")

    url = GEMINI_ENDPOINT.format(model=GEMINI_MODEL)
    headers = {
        "Content-Type": "application/json",
        "X-goog-api-key": GEMINI_KEY
    }

    payload = {
        "contents": [
            {"parts": [{"text": prompt}]}
        ],
        # optional tuning params — adjust as needed
        "temperature": 0.35,
        "maxOutputTokens": 512
    }

    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.post(url, json=payload, headers=headers)
        resp.raise_for_status()
        return resp.json()


def extract_text_from_gemini_response(resp: Any) -> str:
    """
    Best-effort extraction of textual content from Gemini JSON response.
    It walks the response and concatenates string 'text' occurrences and common fields like 'candidates' or 'outputs'.
    """
    parts: List[str] = []

    def walk(node: Any):
        if node is None:
            return
        if isinstance(node, str):
            parts.append(node)
        elif isinstance(node, dict):
            # prioritize likely containers
            for k in ("candidates", "outputs", "output", "content", "response", "result", "message", "text"):
                if k in node:
                    walk(node[k])
                    return
            # otherwise walk values
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for item in node:
                walk(item)

    walk(resp)

    combined = " ".join(p.strip() for p in parts if p and p.strip())
    # normalize whitespace
    combined = re.sub(r"\s+", " ", combined).strip()
    return combined


def try_parse_json_array(text: str) -> Optional[List[Dict[str, str]]]:
    """
    Try to parse a JSON array present in `text`.
    Returns list of objects if parse successful, otherwise None.
    """
    # first try direct parse
    try:
        parsed = json.loads(text)
        if isinstance(parsed, list):
            # ensure each item is a dict with label/text
            out = []
            for it in parsed:
                if isinstance(it, dict):
                    lbl = it.get("label", "") if isinstance(it.get("label", ""), str) else ""
                    txt = it.get("text", "") if isinstance(it.get("text", ""), str) else ""
                    out.append({"label": lbl or "Option", "text": txt or ""})
                else:
                    out.append({"label": "Option", "text": str(it)})
            return out
    except Exception:
        pass

    # find JSON substring with regex
    m = re.search(r"(\[\s*\{[\s\S]*?\}\s*\])", text)
    if m:
        try:
            parsed = json.loads(m.group(1))
            if isinstance(parsed, list):
                out = []
                for it in parsed:
                    if isinstance(it, dict):
                        out.append({"label": it.get("label", "Option"), "text": it.get("text", "")})
                    else:
                        out.append({"label": "Option", "text": str(it)})
                return out
        except Exception:
            pass
    return None


def split_into_candidates_from_plain(text: str, want: int = 3) -> List[Dict[str, str]]:
    """
    Heuristic to split plain text into `want` candidate replies.
    Looks for numbered list, separators, or falls back to sentence windows.
    """
    text = text.strip()
    # Try split by numbered lines (1. 2. 3. or 1) 2) ...)
    numbered = re.split(r"\n\s*(?:\d+[\.\)]\s*)", text)
    numbered = [s.strip() for s in numbered if s.strip()]
    if len(numbered) >= want:
        out = []
        labels = ["Short — To-the-point", "Balanced — Humanish", "Detailed — Structured"]
        for i in range(want):
            snippet = numbered[i] if i < len(numbered) else ""
            out.append({"label": labels[i] if i < len(labels) else f"Option {i+1}", "text": snippet})
        return out

    # Try split by common separators
    parts = re.split(r"\n\-+\n|\n\s*\*\s+|\n----\n", text)
    parts = [p.strip() for p in parts if p.strip()]
    if len(parts) >= want:
        out = []
        labels = ["Short — To-the-point", "Balanced — Humanish", "Detailed — Structured"]
        for i in range(want):
            out.append({"label": labels[i] if i < len(labels) else f"Option {i+1}", "text": parts[i]})
        return out

    # fallback — split by sentences
    sentences = re.split(r'(?<=[.!?])\s+', text)
    # create three progressive variants
    short = (sentences[0] if sentences else text)[:220]
    balanced = (" ".join(sentences[:2]) if len(sentences) >= 2 else text)[:220]
    detailed = text[:240]
    return [
        {"label": "Short — To-the-point", "text": short.strip()},
        {"label": "Balanced — Humanish", "text": balanced.strip()},
        {"label": "Detailed — Structured", "text": detailed.strip()},
    ]


async def generate_replies_from_text(tweet_text: str, author: str = "", images: List[str] = None) -> List[Dict[str, str]]:
    """
    Generate 3 reply options for the provided tweet_text (and optional author/images)
    Returns list of 3 dicts: {label, text}
    """
    images = images or []
    # Instruct Gemini to return ONLY a JSON array of 3 objects (this improves parsing)
    prompt = (
        "You are an assistant that writes short, structured, human-like replies suitable for replying to a tweet. "
        "Return ONLY a JSON array of exactly three objects (no commentary) where each object has fields: "
        "\"label\" and \"text\". Use these labels: "
        "\"Short — To-the-point\", \"Balanced — Humanish\", \"Detailed — Structured\". "
        "Each reply should be ≤240 characters and use at most 2 emojis. Avoid political persuasion and harassment.\n\n"
        f"Context/Tweet: {tweet_text}\nAuthor: {author}\nImageCount: {len(images)}\n\nReturn valid JSON array only."
    )

    try:
        raw_resp = await call_gemini_raw(prompt)
    except Exception as e:
        # bubble up a readable error for caller to handle
        raise RuntimeError(f"Error calling Gemini: {e}") from e

    # Extract any concatenated text from the structured response
    extracted = extract_text_from_gemini_response(raw_resp)

    # 1) Try parse JSON array if Gemini returned JSON text
    parsed = try_parse_json_array(extracted)
    if parsed and len(parsed) >= 1:
        # ensure exactly 3 items and normalized fields
        out = []
        for it in parsed[:3]:
            if isinstance(it, dict):
                label = it.get("label", "") or ""
                text = it.get("text", "") or ""
                out.append({"label": label or "Option", "text": text})
            else:
                out.append({"label": "Option", "text": str(it)})
        while len(out) < 3:
            out.append({"label": f"Option {len(out)+1}", "text": ""})
        return out

    # 2) If no JSON, try to split the plain text heuristically
    if extracted:
        candidates = split_into_candidates_from_plain(extracted, want=3)
        return candidates

    # 3) Fallback minimal options
    fallback_text = tweet_text.strip()[:240] if tweet_text else "Unable to generate reply."
    return [
        {"label": "Short — To-the-point", "text": fallback_text},
        {"label": "Balanced — Humanish", "text": fallback_text},
        {"label": "Detailed — Structured", "text": fallback_text},
    ]
