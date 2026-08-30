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
from pathlib import Path
from typing import Any, Dict, List, Optional
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
    """Read config per-profile.

    Under ``gateway.multiplex_profiles`` every profile is started inside its
    own secret scope, and a raw ``os.environ`` read returns whichever profile
    won the race — so two profiles would come up holding the same token and
    the gateway would refuse the duplicate.
    """
    try:
        from gateway.config import _getenv

        scoped = _getenv(name, None)
        if scoped is not None and str(scoped).strip():
            return str(scoped).strip()
    except Exception:  # pragma: no cover - single-profile fallback
        pass
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
        self._watcher: Optional[asyncio.Task] = None
        self._closing = False
        self._reported_profiles: List[str] = []
        self._threads: Dict[str, Dict[str, Any]] = {}
        # Agents the app created under this one. They have no connection of
        # their own -- this socket carries them, so adding one in the app needs
        # no change here and no restart.
        self._hosted: Dict[str, Dict[str, Any]] = {}
        # thread id -> the identity that should answer in it
        self._identity_for_thread: Dict[str, str] = {}
        # agent id -> the Hermes profile that should answer as it
        self._profile_for_agent: Dict[str, str] = {}
        # relay thread id -> session tag. Hermes keys a session partly on
        # thread_id, so a new tag lands the next message in a session with no
        # link to the previous one.
        self._session_tag: Dict[str, str] = {}
        # Threads mid-rotation. The app has already asked the user, so Hermes'
        # own confirmation is answered here and never shown.
        self._rotating: set = set()

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
        self._closing = False
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

        await self._send_json(self._register_frame())
        self._reader = asyncio.create_task(self._read_loop())
        self._watcher = self._watcher or asyncio.create_task(self._watch_profiles())
        self._mark_connected()
        logger.info("[AgentInbox] connected to %s as @%s", self.relay_url, self.agent_name)
        return True

    async def disconnect(self) -> None:
        self._closing = True
        if self._watcher:
            self._watcher.cancel()
            self._watcher = None
        if self._reader:
            self._reader.cancel()
            self._reader = None
        if self._ws:
            await self._ws.close()
            self._ws = None
        self._mark_disconnected()

    @property
    def _uses_connect_token(self) -> bool:
        """A token minted in the app already names one agent."""
        return self.token.startswith("aic_")

    @property
    def _hermes_home(self) -> Path:
        return Path(os.environ.get("HERMES_HOME") or (Path.home() / ".hermes"))

    def _profile_names(self) -> List[str]:
        """Profiles on this machine, so the app can offer them."""
        names = ["default"]
        profiles_dir = self._hermes_home / "profiles"
        if profiles_dir.is_dir():
            names += sorted(
                p.name for p in profiles_dir.iterdir()
                if p.is_dir() and (p / "config.yaml").exists()
            )
        return names

    def _register_frame(self) -> Dict[str, Any]:
        # With a connect token the relay knows who we are, and claiming a
        # different agent_id is rejected. Only name ourselves when connecting
        # with the shared relay token.
        self._reported_profiles = self._profile_names()
        frame: Dict[str, Any] = {"type": "register", "profiles": self._reported_profiles}
        if self._uses_connect_token:
            return frame
        frame.update(
            {
                "agent_id": self.agent_id,
                "name": self.agent_name,
                "avatar_emoji": self.avatar,
            }
        )
        return frame

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
        # The relay restarting is routine (it is a small local process), so
        # reconnect here rather than waiting to be rebuilt.
        await self._reconnect_forever()

    async def _watch_profiles(self) -> None:
        """Tell the relay when a bot is added or removed on this machine.

        Profiles are created in the desktop app, not here, so polling is what
        keeps a new bot from waiting on a gateway restart to become a chat.
        """
        while not self._closing:
            await asyncio.sleep(15)
            if self._closing:
                return
            try:
                current = self._profile_names()
            except Exception:
                continue
            if current == self._reported_profiles:
                continue
            self._reported_profiles = current
            logger.info("[AgentInbox] profiles changed: %s", ", ".join(current))
            try:
                await self._send_json({"type": "profiles", "profiles": current})
            except Exception:
                pass  # the reconnect path will resend on register

    async def _reconnect_forever(self) -> None:
        backoff = 1.0
        while not self._closing:
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 30.0)
            if self._closing:
                return
            try:
                self._ws = await websockets.connect(self._socket_url)
            except Exception as exc:
                logger.info("[AgentInbox] reconnect failed (%s), retrying", exc)
                continue
            await self._send_json(self._register_frame())
            self._mark_connected()
            logger.info("[AgentInbox] reconnected to %s", self.relay_url)
            self._reader = asyncio.create_task(self._read_loop())
            return

    async def _dispatch(self, payload: Dict[str, Any]) -> None:
        kind = payload.get("type")
        if kind == "registered":
            me = payload.get("agent") or {}
            if me.get("id"):
                self.agent_id = me["id"]
                self.agent_name = me.get("name") or self.agent_id
                self.avatar = me.get("avatar_emoji") or self.avatar
            for thread in payload.get("threads", []):
                self._threads[thread["id"]] = thread
                self._identity_for_thread[thread["id"]] = self.agent_id
            for entry in payload.get("hosted", []) or []:
                self._adopt_hosted(entry.get("agent") or {}, entry.get("threads") or [])
            if self._hosted:
                logger.info(
                    "[AgentInbox] also serving %s", ", ".join(sorted(self._hosted))
                )
            return
        if kind == "new_session":
            await self._rotate_session(payload)
            return
        if kind == "host_agent_added":
            agent = payload.get("agent") or {}
            self._adopt_hosted(agent, payload.get("threads") or [])
            logger.info("[AgentInbox] now also serving @%s", agent.get("name"))
            return
        if kind == "thread":
            thread = payload["thread"]
            self._threads[thread["id"]] = thread
            return
        if kind == "error":
            logger.warning("[AgentInbox] relay error: %s", payload.get("error"))
            return
        if kind != "inbound":
            return

        thread = payload.get("thread") or {}
        message = payload.get("message") or {}
        self._threads[thread.get("id", "")] = thread

        # Which identity this message is addressed to -- this one, or one of
        # the agents created in the app under it.
        identity = payload.get("agent_id") or self.agent_id
        if message.get("sender_id") == identity:
            return
        thread_id = thread.get("id", "")
        if thread_id:
            self._identity_for_thread[thread_id] = identity
        tag = thread.get("session_tag")
        if thread_id and tag:
            self._session_tag[thread_id] = str(tag)
        # DMs are always for us; in groups the relay tells us when we were @-ed.
        if thread.get("kind") != "dm" and not payload.get("mentioned"):
            return

        sender = message.get("sender_id", "user")
        source = SessionSource(
            platform=self.platform,
            chat_id=thread_id,
            chat_name=thread.get("name") or thread.get("kind", "thread"),
            chat_type="dm" if thread.get("kind") == "dm" else "group",
            user_id=sender,
            user_name=sender,
            # Part of the session key: a new tag means a new conversation that
            # is not recorded as following the old one.
            thread_id=self._session_tag.get(thread_id),
            message_id=message.get("id"),
        )
        # Route the turn to the Hermes profile this identity stands for. One
        # gateway can answer as any of its profiles this way, so adding a bot
        # in the app needs no new process.
        profile = self._profile_for_agent.get(identity)
        if profile and profile != "default":
            source.profile = profile

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

    async def _rotate_session(self, payload: Dict[str, Any]) -> None:
        """Start a fresh conversation for one profile.

        Two shapes, because they mean different things on the backend:

        ``continue`` runs Hermes' own ``/new``. That records the new session as
        following the old one, which is what makes the desktop show them as a
        chain.

        ``separate`` changes the session tag instead. Hermes keys a session
        partly on thread id, so the next message simply lands in a session it
        has never seen -- unrelated to anything before it. Nothing to reset.

        Either way the profile keeps its long-term memory; only the
        conversation starts over.
        """
        mode = payload.get("mode", "continue")
        tag = payload.get("session_tag")
        thread_key = payload.get("thread_id") or ""
        if tag:
            self._session_tag[thread_key] = str(tag)
        if mode == "separate":
            logger.info(
                "[AgentInbox] separate conversation for '%s' (tag %s)",
                payload.get("profile") or payload.get("agent_id"),
                tag,
            )
            return
        thread_id = payload.get("thread_id") or ""
        identity = payload.get("agent_id") or self.agent_id
        profile = payload.get("profile") or self._profile_for_agent.get(identity)
        thread = self._threads.get(thread_id, {"id": thread_id, "kind": "dm"})

        source = SessionSource(
            platform=self.platform,
            chat_id=thread_id,
            chat_name=thread.get("name") or "chat",
            chat_type="dm",
            user_id="user",
            user_name="user",
        )
        if profile and profile != "default":
            source.profile = profile

        logger.info("[AgentInbox] starting a new session for '%s'", profile or identity)

        def command(text: str) -> MessageEvent:
            return MessageEvent(
                text=text,
                message_type=MessageType.TEXT,
                user_id="user",
                user_name="user",
                source=source,
                raw_message=payload,
            )

        self._rotating.add(thread_id)
        try:
            await self.handle_message(command("/new"))
            # /new is destructive, so Hermes asks to confirm. The user already
            # confirmed in the app; answering here keeps it to one question.
            await asyncio.sleep(1.5)
            await self.handle_message(command("/approve"))
            await asyncio.sleep(1.5)
        finally:
            self._rotating.discard(thread_id)

    def _adopt_hosted(self, agent: Dict[str, Any], threads: list) -> None:
        agent_id = agent.get("id")
        if not agent_id:
            return
        self._hosted[agent_id] = agent
        profile = (agent.get("profile") or "").strip()
        if profile:
            self._profile_for_agent[agent_id] = profile
        for thread in threads:
            self._threads[thread["id"]] = thread
            self._identity_for_thread[thread["id"]] = agent_id

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
        # Swallow the confirmation exchange: the app asked already, and these
        # would land in a transcript the user expects to be empty.
        if chat_id in self._rotating and (
            "Confirm /" in content or content.strip().startswith("♻️")
        ):
            return SendResult(success=True)

        # Hermes offers to make each new chat its cron/notification target.
        # That is a per-platform setup question, not something to ask in every
        # conversation -- /sethome still works if the user types it.
        if "No home channel is set" in content:
            logger.debug("[AgentInbox] suppressed the home-channel prompt")
            return SendResult(success=True)

        # Answer as whichever identity was addressed in this thread.
        identity = self._identity_for_thread.get(chat_id, self.agent_id)
        try:
            await self._send_json(
                {
                    "type": "send",
                    "agent_id": identity,
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
        # The relay is single-user behind a shared token, so the sender is
        # always "user". Without these the gateway has no allowlist for this
        # platform and falls back to pairing for every profile.
        allowed_users_env="AGENTINBOX_ALLOWED_USERS",
        allow_all_env="AGENTINBOX_ALLOW_ALL_USERS",
        install_hint="Set AGENTINBOX_RELAY_URL and AGENTINBOX_TOKEN, then restart the gateway.",
        cron_deliver_env_var="AGENTINBOX_HOME_THREAD",
        max_message_length=8000,
        emoji="📥",
    )
