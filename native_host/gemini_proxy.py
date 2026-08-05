#!/usr/bin/env python3
"""
Gemini Canvas Proxy — Native Messaging Host
============================================

A local HTTP server that exposes an OpenAI-compatible API endpoint,
backed by free unlimited Gemini inference via Gemini Canvas.

How it works:
    1. HTTP server listens on localhost:8765
    2. Incoming OpenAI-format requests are translated to Gemini format
    3. Translated requests are sent to the Chrome extension via stdio
       (Chrome native messaging protocol: 4-byte length + JSON)
    4. The extension forwards them to the Canvas page via postMessage
    5. The Canvas page calls the Gemini API with its auto-injected key
    6. Responses flow back: Canvas → extension → native host → HTTP

The Canvas internal API key is:
    - Unlimited (no rate limit, no daily cap)
    - Model-scoped (only works with the currently promoted model)
    - Session-bound (dies when the Canvas tab closes)
    - Auto-injected by Canvas when code contains `apiKey = ""`

Limitations:
    - The Canvas key rejects native function/functionResponse roles in
      conversation history. We work around this by converting tool calls
      and results to plain text messages (model still understands them).
    - 1MB max response size (Chrome native messaging limit)
    - Streaming is faked (single chunk + [DONE])

Credits:
    The postMessage bridge concept was inspired by coxcelot's "I am canceled"
    autobrowsing agent harness:
    https://github.com/coxcelot/iamcanceledpresentsagenericautobrowsingagentharness
"""

import struct
import sys
import json
import threading
import uuid
import os
import datetime
import time
from http.server import HTTPServer, BaseHTTPRequestHandler
from socketserver import ThreadingMixIn
from queue import Queue, Empty

request_lock = threading.Lock()
last_request_time = 0.0
LOG_FILE_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "proxy_requests.log")

def write_request_log(req_id, model, body, gemini_body, status, resp_data, error_msg):
    """Write request & response details to proxy_requests.log so AI assistant and user can inspect errors."""
    try:
        timestamp = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        entry = {
            "timestamp": timestamp,
            "id": req_id,
            "model": model,
            "status": status,
            "error": error_msg,
            "messages_count": len(body.get('messages', [])) if isinstance(body, dict) else 0,
            "gemini_contents_count": len(gemini_body.get('contents', [])) if isinstance(gemini_body, dict) else 0,
            "response_summary": str(resp_data)[:500] if resp_data else None
        }
        with open(LOG_FILE_PATH, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry) + "\n")
    except Exception as e:
        sys.stderr.write(f"[Proxy] Log write error: {e}\n")

# Ensure binary stdio mode on Windows to prevent CRLF line translation from corrupting Chrome Native Messaging framing
if sys.platform == "win32":
    import msvcrt
    try:
        msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
        msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)
    except Exception:
        pass


# ═══════════════════════════════════════════════════════════════════════════
# THREADED HTTP SERVER
# ═══════════════════════════════════════════════════════════════════════════
# CRITICAL: Must be threaded. When a chat request blocks waiting for the
# extension response (up to 60s), a single-threaded server would block
# ALL other requests including health checks.

import socket

class ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
    """HTTPServer that handles each request in its own thread with dual-stack IPv4/IPv6 support."""
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, server_address, RequestHandlerClass, bind_and_activate=True):
        host, port = server_address
        # Enable IPv6 dual-stack if available so both localhost (::1) and 127.0.0.1 work across Windows and Linux
        if socket.has_ipv6 and host in ('', '0.0.0.0', '::', 'localhost', '127.0.0.1'):
            try:
                self.address_family = socket.AF_INET6
                addr = '::' if host in ('', '0.0.0.0', '::') else ( '::1' if host in ('localhost', '127.0.0.1') else host )
                super().__init__((addr, port), RequestHandlerClass, bind_and_activate=False)
                if hasattr(socket, 'IPPROTO_IPV6') and hasattr(socket, 'IPV6_V6ONLY'):
                    try:
                        self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
                    except Exception:
                        pass
                if bind_and_activate:
                    self.server_bind()
                    self.server_activate()
                return
            except Exception:
                # Fallback to standard IPv4 if IPv6 dual-stack fails
                try:
                    self.socket.close()
                except Exception:
                    pass

        self.address_family = socket.AF_INET
        super().__init__((host if host != '::' else '0.0.0.0', port), RequestHandlerClass, bind_and_activate=bind_and_activate)


# ═══════════════════════════════════════════════════════════════════════════
# NATIVE MESSAGING PROTOCOL
# ═══════════════════════════════════════════════════════════════════════════
# Chrome communicates with native hosts via stdin/stdout. Each message is:
#   [4-byte length (native endian)] [UTF-8 JSON payload]
# Limits: host→extension = 1MB, extension→host = 64MB

def read_message():
    """Read a single framed JSON message from Chrome's stdin."""
    raw = sys.stdin.buffer.read(4)
    if not raw or len(raw) < 4:
        return None
    length = struct.unpack('=I', raw)[0]
    if length == 0:
        return None
    return json.loads(sys.stdin.buffer.read(length).decode('utf-8'))


class NativeMessagingDisconnectedError(Exception):
    """Raised when writing to Chrome's native messaging stdio pipe fails."""
    pass


def send_message(msg):
    """Send a framed JSON message to Chrome's stdout."""
    try:
        encoded = json.dumps(msg, separators=(',', ':')).encode('utf-8')
        sys.stdout.buffer.write(struct.pack('=I', len(encoded)))
        sys.stdout.buffer.write(encoded)
        sys.stdout.buffer.flush()
    except (OSError, IOError, BrokenPipeError) as e:
        sys.stderr.write(f"[Proxy] Native messaging stdout write error: {e}\n")
        sys.stderr.flush()
        raise NativeMessagingDisconnectedError(f"Extension disconnected: {e}")


# ═══════════════════════════════════════════════════════════════════════════
# REQUEST TRACKING
# ═══════════════════════════════════════════════════════════════════════════

pending_requests = {}  # request_id → Queue (for matching responses to requests)
payload_store = {}     # request_id → gemini_body (for large payloads that exceed 1MB native messaging limit)
HOST_PORT = 8765       # Set in main(), used by request handlers for payload fetch URLs


# ═══════════════════════════════════════════════════════════════════════════
# FORMAT TRANSLATION: OpenAI Chat Completions → Gemini generateContent
# ═══════════════════════════════════════════════════════════════════════════

def openai_to_gemini(body):
    """
    Convert an OpenAI chat completions request to Gemini generateContent format.

    Key conversions:
        - messages[] → contents[] with role mapping (user→user, assistant→model)
        - system message → systemInstruction
        - temperature, max_tokens → generationConfig
        - tools[] → single tools[{functionDeclarations: [...]}] with UPPERCASE types
        - tool_calls in assistant history → text description (Canvas key rejects functionCall parts)
        - tool results → user message with [Tool result] prefix (Canvas key rejects function role)
    """
    contents = []
    system_instruction = None
    pending_tool_parts = []  # Buffer for consecutive tool messages (flush as single user msg)

    for msg in body.get('messages', []):
        role = msg.get('role', 'user')
        content = msg.get('content', '')

        # Flush pending tool parts before any non-tool message
        if role != 'tool' and pending_tool_parts:
            contents.append({"role": "user", "parts": pending_tool_parts})
            pending_tool_parts = []

        # ── Assistant messages with tool_calls ────────────────────────────
        # Native functionCall parts in history (prevents text mimicry of tool calls)
        if role == 'assistant' and msg.get('tool_calls'):
            parts = []
            if content:
                parts.append({"text": str(content)})
            signature_added = False
            for tc in msg.get('tool_calls', []):
                func = tc.get('function', {})
                args_str = func.get('arguments', '{}')
                try:
                    args_parsed = json.loads(args_str)
                except Exception:
                    args_parsed = {}
                fc_part = {"functionCall": {"name": func.get('name', ''), "args": args_parsed}}
                if not signature_added:
                    fc_part["thoughtSignature"] = "context_engineering_is_the_way_to_go"
                    signature_added = True
                parts.append(fc_part)
            contents.append({"role": "model", "parts": parts})
            continue

        # ── Tool results ──────────────────────────────────────────────────
        # Native functionResponse parts with role "user" (Gemini spec)
        if role == 'tool':
            func_name = msg.get('name', '')
            if not func_name:
                tool_call_id = msg.get('tool_call_id', '')
                for prev_msg in body.get('messages', []):
                    if prev_msg.get('role') == 'assistant' and prev_msg.get('tool_calls'):
                        for tc in prev_msg['tool_calls']:
                            if tc.get('id') == tool_call_id:
                                func_name = tc.get('function', {}).get('name', '')
                                break
            result_text = str(content)
            if len(result_text) > 8000:
                result_text = result_text[:8000] + "\n... (truncated)"
            try:
                result_obj = json.loads(result_text)
            except Exception:
                result_obj = {"output": result_text}
            
            pending_tool_parts.append({
                "functionResponse": {"name": func_name, "response": result_obj}
            })
            continue

        # ── Multimodal content (images, mixed text+image) ────────────────
        # OpenAI sends images as content arrays:
        #   [{"type": "text", "text": "..."}, {"type": "image_url", "image_url": {"url": "data:..."}}]
        # Gemini expects separate parts:
        #   [{"text": "..."}, {"inlineData": {"mimeType": "image/png", "data": "base64..."}}]
        #
        # Handles both data URIs and HTTP URLs (fetched server-side).
        # WARNING: Chrome native messaging limits host→extension to 1MB.
        # Large images (>750KB base64) may cause truncation. We log a warning
        # but still attempt delivery — Canvas may accept partial data.
        if isinstance(content, list):
            parts = []
            for part in content:
                if part.get('type') == 'text':
                    parts.append({"text": part['text']})
                elif part.get('type') == 'image_url':
                    url = part.get('image_url', {}).get('url', '')
                    if url.startswith('data:'):
                        # Data URI: extract mime type and base64 data
                        meta, b64 = url.split(',', 1)
                        mime = meta.split(';')[0].split(':')[1] if ':' in meta else 'image/jpeg'
                        parts.append({"inlineData": {"mimeType": mime, "data": b64}})
                    elif url.startswith('http'):
                        # HTTP URL: fetch the image server-side, convert to inlineData
                        # This is necessary because Canvas can't fetch arbitrary URLs,
                        # and Gemini's fileData requires a separate upload step that
                        # the Canvas key may not support.
                        try:
                            import urllib.request
                            req = urllib.request.Request(url, headers={'User-Agent': 'GeminiCanvasProxy/1.0'})
                            with urllib.request.urlopen(req, timeout=15) as resp:
                                img_data = resp.read()
                                content_type = resp.headers.get('Content-Type', 'image/jpeg')
                                # Only process if it's actually an image
                                if content_type.startswith('image/'):
                                    import base64
                                    b64 = base64.b64encode(img_data).decode('utf-8')
                                    parts.append({"inlineData": {"mimeType": content_type, "data": b64}})
                        except Exception:
                            # Silently skip failed fetches — don't break the entire request
                            pass
            if parts:
                # Check total payload size for the 1MB native messaging limit
                try:
                    payload_size = len(json.dumps(parts).encode('utf-8'))
                    if payload_size > 900_000:  # 900KB safety margin
                        sys.stderr.write(f"WARNING: Multimodal payload {payload_size}B exceeds 1MB native messaging limit\n")
                except Exception:
                    pass

                if role == 'system':
                    system_instruction = {"parts": parts}
                elif role == 'assistant':
                    contents.append({"role": "model", "parts": parts})
                else:
                    contents.append({"role": "user", "parts": parts})
            continue

        # ── Plain text messages ───────────────────────────────────────────
        if role == 'system':
            system_instruction = {"parts": [{"text": content}]}
        elif role == 'assistant':
            contents.append({"role": "model", "parts": [{"text": content}]})
        else:
            contents.append({"role": "user", "parts": [{"text": content}]})

    # Flush any remaining tool parts after the loop
    if pending_tool_parts:
        contents.append({"role": "user", "parts": pending_tool_parts})

    result = {
        "contents": contents,
        "generationConfig": {}
    }

    if system_instruction:
        result["systemInstruction"] = system_instruction

    # ── Generation parameters ─────────────────────────────────────────────
    gc = result["generationConfig"]
    if 'temperature' in body:
        gc["temperature"] = body["temperature"]
    if 'max_tokens' in body:
        gc["maxOutputTokens"] = body["max_tokens"]
    if 'top_p' in body:
        gc["topP"] = body["top_p"]
    if 'max_completion_tokens' in body:
        gc["maxOutputTokens"] = body["max_completion_tokens"]
    if 'response_format' in body:
        rf = body['response_format']
        if isinstance(rf, dict) and rf.get('type') in ('json_object', 'json_schema'):
            gc["responseMimeType"] = "application/json"

    # ── Tool definitions ──────────────────────────────────────────────────
    # Canvas requires: single tools object, all functions in one array,
    # UPPERCASE type values (OBJECT, STRING, INTEGER, etc.)
    tools = body.get('tools', [])
    if tools:
        func_decls = []
        for tool in tools:
            if tool.get('type') == 'function':
                func = tool.get('function', {})
                params = func.get('parameters', {"type": "object", "properties": {}})
                params = _sanitize_schema_for_gemini(params)
                params = _uppercase_types(params)
                func_decls.append({
                    "name": func.get('name', ''),
                    "description": func.get('description', ''),
                    "parameters": params
                })
        if func_decls:
            result["tools"] = [{"functionDeclarations": func_decls}]

    return result


def _uppercase_types(obj):
    """Recursively uppercase all 'type' field values in a JSON schema."""
    if isinstance(obj, dict):
        if 'type' in obj and isinstance(obj['type'], str):
            obj['type'] = obj['type'].upper()
        for v in obj.values():
            _uppercase_types(v)
    elif isinstance(obj, list):
        for item in obj:
            _uppercase_types(item)
    return obj


_ALLOWED_SCHEMA_KEYS = frozenset({
    'type', 'format', 'description', 'nullable', 'enum',
    'maxItems', 'minItems', 'properties', 'required',
    'propertyOrdering', 'items'
})


def _sanitize_schema_for_gemini(obj, is_properties_dict=False):
    """Remove JSON Schema fields that Gemini's function calling API rejects.

    Gemini's functionDeclarations use a strict subset of JSON Schema.
    Unknown/unsupported fields cause Protobuf parsing errors (e.g. 'Unknown name "store"').
    """
    if isinstance(obj, dict):
        if is_properties_dict:
            # Under 'properties', keys are user parameter names (e.g. "store", "query")
            return {k: _sanitize_schema_for_gemini(v, is_properties_dict=False) for k, v in obj.items()}
        cleaned = {}
        for k, v in obj.items():
            if k in _ALLOWED_SCHEMA_KEYS:
                if k == 'properties' and isinstance(v, dict):
                    cleaned[k] = _sanitize_schema_for_gemini(v, is_properties_dict=True)
                elif k == 'items' and isinstance(v, bool):
                    if v:
                        cleaned[k] = {}
                else:
                    cleaned[k] = _sanitize_schema_for_gemini(v, is_properties_dict=False)
        return cleaned
    elif isinstance(obj, list):
        return [_sanitize_schema_for_gemini(item, is_properties_dict=False) for item in obj]
    return obj


# ═══════════════════════════════════════════════════════════════════════════
# FORMAT TRANSLATION: Gemini generateContent → OpenAI Chat Completions
# ═══════════════════════════════════════════════════════════════════════════

def gemini_to_openai(gemini_response, model):
    """
    Convert a Gemini API response to OpenAI chat completion format.

    Handles:
        - Text parts → message.content
        - Image parts (inlineData) → message.content as markdown image data URLs
        - Function calls → tool_calls array
    """
    candidates = gemini_response.get('candidates', [])
    text_parts = []
    image_parts = []
    finish_reason = "stop"

    if candidates:
        candidate = candidates[0]
        parts = candidate.get('content', {}).get('parts', [])

        # Extract text, images, and function calls from parts
        tool_calls = []
        for p in parts:
            if 'text' in p:
                text_parts.append(p['text'])
            elif 'inlineData' in p:
                # Image generation models return images as inlineData
                img_data = p['inlineData'].get('data', '')
                mime = p['inlineData'].get('mimeType', 'image/png')
                image_parts.append(f"![generated_image](data:{mime};base64,{img_data})")

        # Check for function calls
        for p in parts:
            if 'functionCall' in p:
                fc = p['functionCall']
                tool_calls.append({
                    "id": f"call_{uuid.uuid4().hex[:8]}",
                    "type": "function",
                    "function": {
                        "name": fc.get('name', ''),
                        "arguments": json.dumps(fc.get('args', {}))
                    }
                })

        finish_reason = candidate.get('finishReason', 'stop').lower()
        if finish_reason == 'max_tokens':
            finish_reason = 'length'

        # Combine text and image parts into content
        content = '\n'.join(text_parts + image_parts) or None

        if tool_calls:
            return {
                "id": f"chatcmpl-{uuid.uuid4().hex[:8]}",
                "object": "chat.completion",
                "model": model,
                "choices": [{
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": content,
                        "tool_calls": tool_calls
                    },
                    "finish_reason": "tool_calls"
                }],
                "usage": _extract_usage(gemini_response)
            }

    content = '\n'.join(text_parts + image_parts) or ""

    return {
        "id": f"chatcmpl-{uuid.uuid4().hex[:8]}",
        "object": "chat.completion",
        "model": model,
        "choices": [{
            "index": 0,
            "message": {"role": "assistant", "content": content},
            "finish_reason": finish_reason
        }],
        "usage": _extract_usage(gemini_response)
    }


def _extract_usage(gemini_response):
    """Extract token usage from Gemini response."""
    meta = gemini_response.get('usageMetadata', {})
    return {
        "prompt_tokens": meta.get('promptTokenCount', 0),
        "completion_tokens": meta.get('candidatesTokenCount', 0),
        "total_tokens": meta.get('totalTokenCount', 0)
    }


VALID_CANVAS_MODELS = {
    "gemini-3-flash-preview",
    "gemini-2.5-flash",
    "gemini-2.5-flash-preview-05-20",
    "gemini-2.0-flash",
    "gemini-1.5-flash",
    "gemini-3.1-flash-image-preview",
    "gemini-2.5-flash-image"
}

def resolve_model_name(requested_model):
    """Fallback unlisted or OpenAI model names (e.g. gpt-4o-mini, gpt-3.5-turbo) to gemini-3-flash-preview."""
    if not requested_model or not isinstance(requested_model, str):
        return "gemini-3-flash-preview"
    req_lower = requested_model.lower()
    if req_lower in VALID_CANVAS_MODELS:
        # Avoid 403 endpoints; promoted model is gemini-3-flash-preview
        if req_lower in ("gemini-3-flash-preview", "gemini-3.1-flash-image-preview", "gemini-2.5-flash-image"):
            return req_lower
    return "gemini-3-flash-preview"


# ═══════════════════════════════════════════════════════════════════════════
# HTTP SERVER
# ═══════════════════════════════════════════════════════════════════════════

class APIHandler(BaseHTTPRequestHandler):
    """HTTP handler exposing OpenAI-compatible endpoints."""

    def do_POST(self):
        if self.path in ('/v1/chat/completions', '/chat/completions', '/v1/completions'):
            self._handle_chat_completions()
        else:
            self.send_error(404)

    def do_GET(self):
        if self.path in ('/v1/models', '/models'):
            models = [
                # Gemini Primary Models
                {"id": "gemini-3-flash-preview", "object": "model", "owned_by": "google", "context_window": 1048576, "description": "Gemini 3 Flash — 1,048,576 Token Context Window"},
                {"id": "gemini-2.5-flash", "object": "model", "owned_by": "google", "context_window": 1048576, "description": "Gemini 2.5 Flash — 1,048,576 Token Context Window"},
                {"id": "gemini-2.5-flash-preview-05-20", "object": "model", "owned_by": "google", "context_window": 1048576, "description": "Gemini 2.5 Flash Preview"},
                {"id": "gemini-3.1-flash-image-preview", "object": "model", "owned_by": "google", "context_window": 1048576, "description": "Nano Banana 2 — AI Image Generation & Retouching"},
                {"id": "gemini-2.5-flash-image", "object": "model", "owned_by": "google", "context_window": 1048576, "description": "Nano Banana — AI Image Generation & Retouching"},
                
                # OpenAI Aliases
                {"id": "gpt-4o", "object": "model", "owned_by": "openai-alias", "context_window": 1048576, "description": "OpenAI gpt-4o alias (1M Context Window)"},
                {"id": "gpt-4o-mini", "object": "model", "owned_by": "openai-alias", "context_window": 1048576, "description": "OpenAI gpt-4o-mini alias (1M Context Window)"},
                {"id": "gpt-4-turbo", "object": "model", "owned_by": "openai-alias", "context_window": 1048576, "description": "OpenAI gpt-4-turbo alias (1M Context Window)"},
                {"id": "gpt-3.5-turbo", "object": "model", "owned_by": "openai-alias", "context_window": 1048576, "description": "OpenAI gpt-3.5-turbo alias (1M Context Window)"},
                
                # Llama / Ollama / Open-Source Aliases
                {"id": "llama3", "object": "model", "owned_by": "ollama-alias", "context_window": 1048576, "description": "Llama 3 alias (1M Context Window)"},
                {"id": "llama3:8b", "object": "model", "owned_by": "ollama-alias", "context_window": 1048576, "description": "Llama 3 8B alias (1M Context Window)"},
                {"id": "llama3:70b", "object": "model", "owned_by": "ollama-alias", "context_window": 1048576, "description": "Llama 3 70B alias (1M Context Window)"},
                {"id": "mistral", "object": "model", "owned_by": "ollama-alias", "context_window": 1048576, "description": "Mistral alias (1M Context Window)"},
                {"id": "qwen2.5", "object": "model", "owned_by": "ollama-alias", "context_window": 1048576, "description": "Qwen 2.5 alias (1M Context Window)"},
                
                # Anthropic Aliases
                {"id": "claude-3-5-sonnet", "object": "model", "owned_by": "anthropic-alias", "context_window": 1048576, "description": "Claude 3.5 Sonnet alias (1M Context Window)"},
                {"id": "claude-3-haiku", "object": "model", "owned_by": "anthropic-alias", "context_window": 1048576, "description": "Claude 3 Haiku alias (1M Context Window)"}
            ]
            self._json_response(200, {"object": "list", "data": models})
        elif self.path == '/health':
            self._json_response(200, {"status": "ok"})
        elif self.path.startswith('/internal/payload/'):
            req_id = self.path.split('/internal/payload/')[1]
            body = payload_store.pop(req_id, None)
            if body is not None:
                self._json_response(200, body)
            else:
                self._json_error(404, "Payload not found or already consumed")
        else:
            self.send_error(404)

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
        self.end_headers()

    def _handle_chat_completions(self):
        """Translate OpenAI request → Gemini → forward to extension → translate back."""
        try:
            content_length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(content_length))
        except Exception as e:
            self._json_error(400, f"Invalid JSON: {e}")
            return

        raw_model = body.get('model', 'gemini-3-flash-preview')
        model = resolve_model_name(raw_model)
        gemini_body = openai_to_gemini(body)
        stream = body.get('stream', False)

        # Create a tracked request
        req_id = str(uuid.uuid4())
        response_queue = Queue()
        pending_requests[req_id] = response_queue

        # Check if the payload exceeds the 1MB native messaging limit.
        # Chrome's kMaximumNativeMessageSize = 1024*1024 bytes for host→extension.
        # If it does, store the payload and tell the extension to fetch it via HTTP
        # (extension service workers can fetch localhost without LNA restrictions).
        message_payload = {
            "type": "api_request",
            "id": req_id,
            "method": "POST",
            "path": f"/v1beta/models/{model}:generateContent",
            "body": gemini_body,
            "headers": {}
        }
        serialized = json.dumps(message_payload, separators=(',', ':')).encode('utf-8')

        global last_request_time
        with request_lock:
            try:
                if len(serialized) > 900_000:
                    chunk_size = 800_000
                    payload_str = serialized.decode('utf-8')
                    total_chunks = (len(payload_str) + chunk_size - 1) // chunk_size
                    sys.stderr.write(f"[Proxy] Large payload ({len(serialized)}B), sending in {total_chunks} chunks\n")
                    sys.stderr.flush()

                    for i in range(total_chunks):
                        chunk = payload_str[i * chunk_size : (i + 1) * chunk_size]
                        send_message({
                            "type": "api_request_chunk",
                            "id": req_id,
                            "chunk_index": i,
                            "total_chunks": total_chunks,
                            "chunk_data": chunk
                        })
                else:
                    send_message(message_payload)
            except NativeMessagingDisconnectedError as e:
                pending_requests.pop(req_id, None)
                self._json_error(502, "Chrome Extension channel disconnected. Please reload the extension and Gemini page in Chrome.")
                return

            # Wait for the response (up to 60s)
            try:
                resp = response_queue.get(timeout=60)
            except Empty:
                pending_requests.pop(req_id, None)
                write_request_log(req_id, model, body, gemini_body, 504, None, "Gateway Timeout")
                self._json_error(504, "Gateway Timeout — Canvas tab may be closed or unresponsive")
                return
            finally:
                last_request_time = time.time()

        pending_requests.pop(req_id, None)

        if resp.get('error'):
            write_request_log(req_id, model, body, gemini_body, resp.get('status', 502), resp.get('data'), resp.get('error'))
            self._json_error(502, resp['error'])
            return

        openai_response = gemini_to_openai(resp.get('data', {}), raw_model)
        write_request_log(req_id, raw_model, body, gemini_body, 200, "OK", None)

        if stream:
            self._send_streaming(openai_response, raw_model)
        else:
            self._json_response(200, openai_response)

    def _send_streaming(self, openai_response, model):
        """Fake streaming — send as single chunk + [DONE].

        Handles both text content and tool_calls in streaming format.
        For tool_calls, we emit each call as a separate delta chunk
        (matching OpenAI's streaming protocol for tool calls), followed
        by a final chunk with finish_reason="tool_calls".
        """
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('Connection', 'close')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()

        choice = openai_response["choices"][0]
        message = choice["message"]
        finish_reason = choice.get("finish_reason", "stop")
        tool_calls = message.get("tool_calls")

        if tool_calls:
            # ── Stream tool_calls (OpenAI streaming format) ───────────────
            # Each tool call is sent as a delta with an index. The first
            # chunk includes the role. Arguments may be split across chunks
            # in real OpenAI streaming, but we send them all at once since
            # our proxy fakes streaming (single Gemini response).

            # First chunk: role + first tool call name
            first_tc = tool_calls[0]
            delta = {
                "role": "assistant",
                "tool_calls": [{
                    "index": 0,
                    "id": first_tc["id"],
                    "type": "function",
                    "function": {
                        "name": first_tc["function"]["name"],
                        "arguments": first_tc["function"]["arguments"]
                    }
                }]
            }
            chunk = {
                "id": openai_response["id"],
                "object": "chat.completion.chunk",
                "model": model,
                "choices": [{"index": 0, "delta": delta, "finish_reason": None}]
            }
            self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())

            # Additional tool calls (if multiple)
            for i, tc in enumerate(tool_calls[1:], 1):
                delta = {
                    "tool_calls": [{
                        "index": i,
                        "id": tc["id"],
                        "type": "function",
                        "function": {
                            "name": tc["function"]["name"],
                            "arguments": tc["function"]["arguments"]
                        }
                    }]
                }
                chunk = {
                    "id": openai_response["id"],
                    "object": "chat.completion.chunk",
                    "model": model,
                    "choices": [{"index": 0, "delta": delta, "finish_reason": None}]
                }
                self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())

            # Final chunk: finish_reason = "tool_calls"
            done_chunk = {
                "id": openai_response["id"],
                "object": "chat.completion.chunk",
                "model": model,
                "choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls"}]
            }
            self.wfile.write(f"data: {json.dumps(done_chunk)}\n\n".encode())
        else:
            # ── Stream text content ───────────────────────────────────────
            content = message.get("content") or ""
            chunk = {
                "id": openai_response["id"],
                "object": "chat.completion.chunk",
                "model": model,
                "choices": [{"index": 0, "delta": {"content": content}, "finish_reason": None}]
            }
            self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())

            done_chunk = {
                "id": openai_response["id"],
                "object": "chat.completion.chunk",
                "model": model,
                "choices": [{"index": 0, "delta": {}, "finish_reason": finish_reason}]
            }
            self.wfile.write(f"data: {json.dumps(done_chunk)}\n\n".encode())

        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()

    def _json_response(self, code, data):
        body = json.dumps(data).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _json_error(self, code, message):
        body = json.dumps({"error": {"message": message, "type": "proxy_error"}}).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        """Suppress HTTP logs — writing to stdout corrupts native messaging."""
        pass


# ═══════════════════════════════════════════════════════════════════════════
# MAIN LOOP
# ═══════════════════════════════════════════════════════════════════════════

def main():
    global HOST_PORT
    port = int(os.environ.get('PROXY_PORT', '8765'))
    HOST_PORT = port

    # --standalone mode: run HTTP server without native messaging
    # Useful for debugging or when the extension bridge isn't needed.
    # The extension can still connect if it discovers the port.
    standalone = '--standalone' in sys.argv

    # Start HTTP server in a proper thread (not daemon — we want clean shutdown)
    # 0.0.0.0 allows Tailscale/VPS access. 127.0.0.1 for local only.
    # Default to 0.0.0.0 for easier VPS/Tailscale deployment.
    bind_address = os.environ.get('PROXY_BIND', '0.0.0.0')
    server = ThreadedHTTPServer((bind_address, port), APIHandler)
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()

    if standalone:
        sys.stderr.write(f"[Proxy] Standalone mode — HTTP server on http://{bind_address}:{port}\n")
        if bind_address == '0.0.0.0':
            sys.stderr.write(f"[Proxy] WARNING: Listening on 0.0.0.0 (all interfaces). No authentication is enabled.\n")
        sys.stderr.write(f"[Proxy] No native messaging — use curl or point any tool at the URL above\n")
        sys.stderr.flush()
        return

    if bind_address == '0.0.0.0':
        sys.stderr.write(f"[Proxy] Warning: HTTP server listening on 0.0.0.0 (all interfaces).\n")
        sys.stderr.flush()

    # Main loop: read messages from the extension
    while True:
        try:
            msg = read_message()
        except Exception:
            break
        if msg is None:
            break

        msg_type = msg.get('type')

        if msg_type == 'init':
            try:
                send_message({
                    "type": "host_ready",
                    "port": port,
                    "config": {
                        "target_chat_id": os.environ.get("TARGET_CHAT_ID", ""),
                        "canvas_card_name": os.environ.get("CANVAS_CARD_NAME", "")
                    }
                })
            except Exception as e:
                sys.stderr.write(f"[Proxy] Failed to send host_ready: {e}\n")
                sys.stderr.flush()

        elif msg_type == 'api_response':
            req_id = msg.get('id')
            if req_id in pending_requests:
                pending_requests[req_id].put({
                    "status": msg.get('status'),
                    "data": msg.get('data'),
                    "error": msg.get('error')
                })

    # Stdin closed — extension disconnected or reconnecting.
    sys.stderr.write("[Proxy] Extension channel closed — shutting down HTTP server\n")
    sys.stderr.flush()
    try:
        server.shutdown()
        server.server_close()
    except Exception:
        pass



if __name__ == '__main__':
    main()
