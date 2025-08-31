# server/app/api.py
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Dict, Any
from app.llm_client import generate_replies

router = APIRouter()

class GenerateReq(BaseModel):
    context: Dict[str, Any]

@router.post("/generate")
async def generate(req: GenerateReq):
    ctx = req.context
    if not ctx.get("text"):
        raise HTTPException(status_code=400, detail="empty text")
    suggestions = await generate_replies(ctx)
    return {"suggestions": suggestions}
