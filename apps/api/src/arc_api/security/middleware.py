"""ASGI middleware: security headers and request guards.

RequestGuard blocks the classic browser attack paths before any route runs:
- cross-site requests (Origin / Sec-Fetch-Site) on state-changing methods (CSRF),
- non-JSON bodies on writes (HTML forms cannot send application/json),
- oversized bodies (bounded memory and parsing cost).
"""

from __future__ import annotations

import json
from collections.abc import Iterable

from starlette.types import ASGIApp, Message, Receive, Scope, Send

SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})


async def _reject(send: Send, status: int, code: str, message: str) -> None:
    body = json.dumps({"error": {"code": code, "message": message}}).encode()
    await send(
        {
            "type": "http.response.start",
            "status": status,
            "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(body)).encode()),
                (b"cache-control", b"no-store"),
            ],
        }
    )
    await send({"type": "http.response.body", "body": body})


class SecurityHeadersMiddleware:
    def __init__(self, app: ASGIApp, *, hsts: bool) -> None:
        self.app = app
        self.headers: list[tuple[bytes, bytes]] = [
            (b"x-content-type-options", b"nosniff"),
            (b"x-frame-options", b"DENY"),
            (b"referrer-policy", b"no-referrer"),
            (b"cross-origin-opener-policy", b"same-origin"),
            (b"cross-origin-resource-policy", b"same-origin"),
            (b"content-security-policy", b"default-src 'none'; frame-ancestors 'none'"),
            (b"permissions-policy", b"camera=(), microphone=(), geolocation=()"),
            (b"cache-control", b"no-store"),
        ]
        if hsts:
            self.headers.append(
                (b"strict-transport-security", b"max-age=63072000; includeSubDomains; preload")
            )

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def send_with_headers(message: Message) -> None:
            if message["type"] == "http.response.start":
                existing = {k.lower() for k, _ in message.get("headers", [])}
                extra = [(k, v) for k, v in self.headers if k not in existing]
                message["headers"] = [*message.get("headers", []), *extra]
            await send(message)

        await self.app(scope, receive, send_with_headers)


class RequestGuardMiddleware:
    def __init__(self, app: ASGIApp, *, allowed_origins: Iterable[str], max_body: int) -> None:
        self.app = app
        self.allowed_origins = frozenset(o.rstrip("/") for o in allowed_origins)
        self.max_body = max_body

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope["method"] in SAFE_METHODS:
            await self.app(scope, receive, send)
            return

        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope["headers"]}
        origin = headers.get("origin")
        if origin is not None and origin.rstrip("/") not in self.allowed_origins:
            await _reject(send, 403, "forbidden_origin", "Cross-site request blocked.")
            return
        if origin is None and headers.get("sec-fetch-site") == "cross-site":
            await _reject(send, 403, "forbidden_origin", "Cross-site request blocked.")
            return

        content_length = headers.get("content-length")
        has_body = content_length not in (None, "0") or "transfer-encoding" in headers
        if has_body:
            ctype = headers.get("content-type", "").split(";")[0].strip().lower()
            if ctype != "application/json":
                await _reject(send, 415, "unsupported_media_type", "Send JSON.")
                return
        if content_length is not None:
            try:
                too_big = int(content_length) > self.max_body
            except ValueError:
                too_big = True
            if too_big:
                await _reject(send, 413, "payload_too_large", "Request body too large.")
                return

        received = 0
        max_body = self.max_body

        async def limited_receive() -> Message:
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > max_body:
                    raise PayloadTooLargeError
            return message

        try:
            await self.app(scope, limited_receive, send)
        except PayloadTooLargeError:
            await _reject(send, 413, "payload_too_large", "Request body too large.")


class PayloadTooLargeError(Exception):
    pass
