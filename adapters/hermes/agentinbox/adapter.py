"""Agent Inbox platform adapter for the Hermes Agent gateway.

Mirrors the shape of ``plugins/platforms/telegram``: a ``plugin.yaml``, an
``__init__.py`` that exports ``register``, and a ``BasePlatformAdapter``
subclass implementing ``connect`` / ``disconnect`` / ``send``.

Threads on the relay map to Hermes chats: ``chat_id`` is the relay thread id,
``chat_type`` is "dm" or "group". Sessions and memory therefore live in Hermes,
one per thread, exactly as they do for Telegram.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from typing import Any, Dict, Optional
from urllib.parse import urlsplit, urlunsplit, urlencode

import websockets

from gateway.config import Platform, PlatformConfig
from gateway.platforms.base import (
    BasePlatformAdapter,
    MessageEvent,
    MessageType,
    SendResult,
)
from gateway.session import SessionSource

logger = logging.getLogger(__name__)

PLATFORM_NAME = "agentinbox"


def _env(name: str, default: str = "") -> str:
    return (os.environ.get(name) or default).strip()


def agentinbox_deps_present() -> bool:
    """The adapter only needs ``websockets``, already a Hermes dependency."""
    return websockets is not None


class AgentInboxAdapter(BasePlatformAdapter):
    """Speaks the Agent Inbox ``/ws/agent`` protocol."""

    def __init__(self, config: PlatformConfig):
        super().__init__(config, Platform(PLATFORM_NAME))
        self.relay_url = _env("AGENTINBOX_RELAY_URL", "http://127.0.0.1:8787").rstrip("/")
        self.token = _env("AGENTINBOX_TOKEN", config.token or "")
        self.agent_id = _env("AGENTINBOX_AGENT_ID", "hermes")
        self.agent_name = _env("AGENTINBOX_AGENT_NAME", self.agent_id)
        self.avatar = _env("AGENTINBOX_AVATAR", "🧠")

        self._ws: Optional[Any] = None
        self._reader: Optional[asyncio.Task] = None
        self._threads: Dict[str, Dict[str, Any]] = {}

    # ------------------------------------------------------------------ #
    # connection
    # ------------------------------------------------------------------ #

    @property
    def _socket_url(self) -> str:
        parts = urlsplit(self.relay_url)
        scheme = "wss" if parts.scheme == "https" else "ws"
        query = urlencode({"token": self.token})
        return urlunsplit((scheme, parts.netloc, "/ws/agent", query, ""))

    async def connect(self, *, is_reconnect: bool = False) -> bool:
        # The relay replays everything since last_seen on register, so a
        # reconnect never loses messages and the flag needs no special case.
        if not self.token:
            self._set_fatal_error(
                "missing_token", "AGENTINBOX_TOKEN is not set", retryable=False
            )
            return False
        try:
            self._ws = await websockets.connect(self._socket_url)
        except Exception as exc:
            logger.error("[AgentInbox] connect failed: %s", exc)
            self._set_fatal_error("connect_failed", str(exc), retryable=True)
            return False

        await self._send_json(
            {
                "type": "register",
                "agent_id": self.agent_id,
                "name": self.agent_name,
                "avatar_emoji": self.avatar,
            }
        )
        self._reader = asyncio.create_task(self._read_loop())
        self._mark_connected()
        logger.info("[AgentInbox] connected to %s as @%s", self.relay_url, self.agent_name)
        return True

    async def disconnect(self) -> None:
        if self._reader:
            self._reader.cancel()
            self._reader = None
        if self._ws:
            await self._ws.close()
            self._ws = None
        self._mark_disconnected()

    async def _send_json(self, payload: Dict[str, Any]) -> None:
        if self._ws is None:
            raise RuntimeError("not connected")
        await self._ws.send(json.dumps(payload))

    # ------------------------------------------------------------------ #
    # inbound
    # ------------------------------------------------------------------ #

    async def _read_loop(self) -> None:
        try:
            async for raw in self._ws:
                try:
                    payload = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                await self._dispatch(payload)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning("[AgentInbox] read loop ended: %s", exc)
            self._mark_disconnected()

    async def _dispatch(self, payload: Dict[str, Any]) -> None:
        kind = payload.get("type")
        if kind == "registered":
            for thread in payload.get("threads", []):
                self._threads[thread["id"]] = thread
            return
        if kind == "thread":
            thread = payload["thread"]
            self._threads[thread["id"]] = thread
            return
        if kind != "inbound":
            return

        thread = payload.get("thread") or {}
        message = payload.get("message") or {}
        self._threads[thread.get("id", "")] = thread

        if message.get("sender_id") == self.agent_id:
            return
        # DMs are always for us; in groups the relay tells us when we were @-ed.
        if thread.get("kind") != "dm" and not payload.get("mentioned"):
            return

        sender = message.get("sender_id", "user")
        source = SessionSource(
            platform=self.platform,
            chat_id=thread.get("id", ""),
            chat_name=thread.get("name") or thread.get("kind", "thread"),
            chat_type="dm" if thread.get("kind") == "dm" else "group",
            user_id=sender,
            user_name=sender,
            message_id=message.get("id"),
        )
        event = MessageEvent(
            text=message.get("text", ""),
            message_type=MessageType.TEXT,
            user_id=sender,
            user_name=sender,
            source=source,
            raw_message=message,
            message_id=message.get("id"),
            reply_to_message_id=message.get("reply_to"),
        )
        await self.handle_message(event)

    # ------------------------------------------------------------------ #
    # outbound
    # ------------------------------------------------------------------ #

    async def get_chat_info(self, chat_id: str) -> Dict[str, Any]:
        thread = self._threads.get(chat_id, {})
        kind = thread.get("kind", "dm")
        return {
            "name": thread.get("name") or kind,
            "type": "dm" if kind == "dm" else "group",
            "participants": thread.get("participant_ids", []),
        }

    async def send(
        self,
        chat_id: str,
        content: str,
        reply_to: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> SendResult:
        try:
            await self._send_json(
                {
                    "type": "send",
                    "thread_id": chat_id,
                    "text": content,
                    "reply_to": reply_to,
                }
            )
        except Exception as exc:
            return SendResult(success=False, error=str(exc), retryable=True)
        # The relay assigns the message id; nothing to echo back.
        return SendResult(success=True)


# ---------------------------------------------------------------------- #
# plugin entry point
# ---------------------------------------------------------------------- #

_active: Optional[AgentInboxAdapter] = None


def _build_adapter(config: PlatformConfig) -> AgentInboxAdapter:
    global _active
    _active = AgentInboxAdapter(config)
    return _active


def _is_connected() -> bool:
    return bool(_active and _active.is_connected)


def register(ctx) -> None:
    """Plugin entry point — called by the Hermes plugin system."""
    ctx.register_platform(
        name=PLATFORM_NAME,
        label="Agent Inbox",
        adapter_factory=_build_adapter,
        check_fn=agentinbox_deps_present,
        is_connected=_is_connected,
        required_env=["AGENTINBOX_RELAY_URL", "AGENTINBOX_TOKEN"],
        install_hint="Set AGENTINBOX_RELAY_URL and AGENTINBOX_TOKEN, then restart the gateway.",
        cron_deliver_env_var="AGENTINBOX_HOME_THREAD",
        max_message_length=8000,
        emoji="📥",
    )
