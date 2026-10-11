"""Lets the Java server read bills with a Gemini API key instead of an Anthropic one.

The server forwards each extraction request (Anthropic Messages format) to $ANTHROPIC_URL.
run-gemini.sh points that here; this script turns the request into a Gemini
generateContent call and turns the answer back. Python 3.8+ standard library only.

    GEMINI_API_KEY=... python3 server/gemini_bridge.py     # listens on 127.0.0.1:8788

Env: GEMINI_API_KEY (required), GEMINI_MODEL (default gemini-3.5-flash-lite),
BRIDGE_PORT (default 8788). The key stays in this process; it is never written to disk.
"""
import json
import os
import sys
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

KEY = os.environ.get("GEMINI_API_KEY", "").strip()
MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.5-flash-lite")
PORT = int(os.environ.get("BRIDGE_PORT", "8788"))
URL = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent"

# JSON Schema keywords the Gemini API rejects.
UNSUPPORTED = {"additionalProperties", "minItems", "maxItems", "$schema", "strict"}


def to_gemini_schema(o):
    """Drop unsupported keywords; anyOf [{type: t}, {type: null}] -> {type: t, nullable: true}."""
    if isinstance(o, list):
        return [to_gemini_schema(x) for x in o]
    if not isinstance(o, dict):
        return o
    any_of = o.get("anyOf")
    if any_of and any(x.get("type") == "null" for x in any_of):
        rest = [x for x in any_of if x.get("type") != "null"]
        if len(rest) == 1:
            out = {k: v for k, v in o.items() if k != "anyOf"}
            out.update(to_gemini_schema(rest[0]))
            out["nullable"] = True
            return to_gemini_schema(out)
    return {k: to_gemini_schema(v) for k, v in o.items() if k not in UNSUPPORTED}


def to_gemini(req):
    parts = []
    for msg in req.get("messages", []):
        content = msg.get("content")
        if isinstance(content, str):
            parts.append({"text": content})
            continue
        for block in content:
            if block.get("type") in ("image", "document"):
                src = block["source"]
                parts.append({"inline_data": {"mime_type": src["media_type"], "data": src["data"]}})
            elif block.get("type") == "text":
                parts.append({"text": block["text"]})
    body = {"contents": [{"role": "user", "parts": parts}]}

    system = req.get("system")
    if isinstance(system, list):
        system = "\n\n".join(b.get("text", "") for b in system)
    if system:
        body["system_instruction"] = {"parts": [{"text": system}]}

    cfg = {"temperature": 0, "maxOutputTokens": int(req.get("max_tokens") or 8192),
           "thinkingConfig": {"thinkingBudget": 512}}
    schema = ((req.get("output_config") or {}).get("format") or {}).get("schema")
    if schema:
        cfg["responseMimeType"] = "application/json"
        cfg["responseSchema"] = to_gemini_schema(schema)
    body["generationConfig"] = cfg
    return body


def from_gemini(res):
    cands = res.get("candidates") or []
    if not cands:
        reason = (res.get("promptFeedback") or {}).get("blockReason", "no answer")
        return {"type": "message", "role": "assistant", "model": MODEL, "content": [], "stop_reason": "refusal",
                "stop_detail": reason}
    c = cands[0]
    text = "".join(p.get("text", "") for p in (c.get("content") or {}).get("parts", []) if not p.get("thought"))
    finish = c.get("finishReason", "STOP")
    stop = {"STOP": "end_turn", "MAX_TOKENS": "max_tokens"}.get(finish, "refusal")
    return {"id": "msg_gemini", "type": "message", "role": "assistant", "model": MODEL,
            "content": [{"type": "text", "text": text}], "stop_reason": stop}


def call(req):
    data = json.dumps(to_gemini(req)).encode()
    r = urllib.request.Request(URL, data=data, headers={"content-type": "application/json", "x-goog-api-key": KEY})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(r, timeout=180) as resp:
                return 200, from_gemini(json.loads(resp.read()))
        except urllib.error.HTTPError as e:
            detail = e.read().decode(errors="replace")
            if e.code >= 500 and attempt < 2:
                continue
            try:
                detail = json.loads(detail)["error"]["message"]
            except Exception:
                detail = detail[:300]
            return e.code, {"type": "error", "error": {"type": f"gemini_{e.code}", "message": f"Gemini {e.code}: {detail}"}}


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get("content-length") or 0)
        try:
            code, out = call(json.loads(self.rfile.read(n)))
        except Exception as e:  # shown in the chat as a failed live read
            code, out = 502, {"type": "error", "error": {"type": type(e).__name__, "message": str(e)}}
        if code != 200:
            print(f"[gemini bridge] {out['error']['message']}", file=sys.stderr)
        body = json.dumps(out).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    if not KEY:
        sys.exit("Set GEMINI_API_KEY first (get one at https://aistudio.google.com/apikey).")
    print(f"Gemini bridge on http://127.0.0.1:{PORT} -> {MODEL}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
