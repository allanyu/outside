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
        # (chat, text) -> when it was sent. Hermes warns about this itself
        # ("possible duplicate send"): the final send is not always suppressed
        # when a stream consumer delivered nothing, and both reach us.
        self._recent_sends: Dict[str, float] = {}
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

    @property
    def _looks_like_pair_code(self) -> bool:
        """The short code the app shows, not a relay token.

        Relay tokens are ``aic_``-prefixed and long; a pair code is six
        characters. Anything short and alphanumeric is the code the user was
        told to paste into Hermes' Messaging settings.
        """
        return (
            bool(self.token)
            and not self.token.startswith("aic_")
            and len(self.token) <= 12
            and self.token.isalnum()
        )

    def _redeem_pair_code(self) -> bool:
        """Trade the app's pair code for this machine's relay token.

        Setup tells the user to paste the six-character code from the app, so
        that code is what lands in ``AGENTINBOX_TOKEN`` — but the relay only
        accepts a token on the socket, and answers a pasted code with a 401
        that says nothing about what went wrong. Redeeming here is what makes
        the documented flow work at all.

        Pair codes are single-use and short-lived, so the exchanged token is
        written back to the profile's ``.env``: without that, the next
        reconnect would present a spent code.
        """
        import urllib.error
        import urllib.request

        body = json.dumps({"code": self.token}).encode()
        req = urllib.request.Request(
            f"{self.relay_url}/api/pair",
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                payload = json.loads(resp.read().decode())
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                self._set_fatal_error(
                    "pair_code_invalid",
                    "That pairing code is expired or already used. Open Agent "
                    "Inbox, tap + then Connect Hermes for a fresh one, and "
                    "paste it here again.",
                    retryable=False,
                )
            else:
                self._set_fatal_error(
                    "pair_failed", f"pairing failed: HTTP {exc.code}", retryable=True
                )
            return False
        except Exception as exc:
            self._set_fatal_error("pair_failed", f"pairing failed: {exc}", retryable=True)
            return False

        token = str(payload.get("token") or "").strip()
        if not token:
            self._set_fatal_error(
                "pair_failed", "relay returned no token", retryable=True
            )
            return False

        self.token = token
        try:
            from hermes_cli.config import save_env_value

            save_env_value("AGENTINBOX_TOKEN", token)
        except Exception:
            # Pairing still succeeded; only persistence failed, so this run
            # works and the next restart asks for a fresh code.
            logger.warning(
                "[AgentInbox] paired, but could not save the token to .env",
                exc_info=True,
            )
        logger.info("[AgentInbox] paired with the relay and saved this machine's token")
        return True

    async def connect(self, *, is_reconnect: bool = False) -> bool:
        self._closing = False
        # The relay replays everything since last_seen on register, so a
        # reconnect never loses messages and the flag needs no special case.
        if not self.token:
            self._set_fatal_error(
                "missing_token", "AGENTINBOX_TOKEN is not set", retryable=False
            )
            return False
        if self._looks_like_pair_code:
            if not await asyncio.to_thread(self._redeem_pair_code):
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

    def _display_name(self, profile: str) -> str:
        """What Hermes calls this bot.

        ``display_name`` in the profile's own profile.yaml when it is set --
        that is where Hermes records a renamed bot. The default profile is
        Hermes itself and has no folder of its own.
        """
        if profile == "default":
            return "Hermes"
        home = self._hermes_home / "profiles" / profile
        meta = home / "profile.yaml"
        if meta.is_file():
            try:
                import yaml

                name = (yaml.safe_load(meta.read_text()) or {}).get("display_name")
                if isinstance(name, str) and name.strip():
                    return name.strip()
            except Exception:
                pass

        # A bot's SOUL.md usually opens with its own name -- "# D Bot" for the
        # profile d-bot. Take it only when it is the same name written
        # differently, so a heading that says something else cannot rename the
        # chat to something the user would not recognise.
        soul = home / "SOUL.md"
        if soul.is_file():
            try:
                first = soul.read_text(errors="replace").lstrip().splitlines()[0]
            except Exception:
                first = ""
            if first.startswith("#"):
                heading = first.lstrip("#").strip()
                squash = lambda t: "".join(c for c in t.lower() if c.isalnum())
                if heading and squash(heading) == squash(profile):
                    return heading
        return profile

    def _profile_list(self) -> List[Dict[str, str]]:
        return [{"name": p, "display": self._display_name(p)} for p in self._profile_names()]

    def _register_frame(self) -> Dict[str, Any]:
        # With a connect token the relay knows who we are, and claiming a
        # different agent_id is rejected. Only name ourselves when connecting
        # with the shared relay token.
        self._reported_profiles = self._profile_list()
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
                current = self._profile_list()
            except Exception:
                continue
            if current == self._reported_profiles:
                continue
            self._reported_profiles = current
            _ensure_allowlist()
            logger.info(
                "[AgentInbox] profiles changed: %s",
                ", ".join(p["display"] for p in current),
            )
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

        now = asyncio.get_event_loop().time()
        fingerprint = f"{chat_id}\n{content}"
        last = self._recent_sends.get(fingerprint)
        if last is not None and now - last < 8.0:
            logger.info("[AgentInbox] dropped a repeat of the same reply")
            return SendResult(success=True)
        self._recent_sends[fingerprint] = now
        # Keep the table small; anything older cannot be a duplicate.
        for key, when in list(self._recent_sends.items()):
            if now - when > 30.0:
                self._recent_sends.pop(key, None)

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


ALLOWED_USERS_ENV = "AGENTINBOX_ALLOWED_USERS"


def _profile_homes():
    """Every Hermes home on this machine: the default root and each profile."""
    from hermes_constants import get_default_hermes_root

    root = get_default_hermes_root()
    homes = [root]
    profiles = root / "profiles"
    if profiles.is_dir():
        homes += [
            d for d in sorted(profiles.iterdir()) if (d / "config.yaml").is_file()
        ]
    return homes


def _ensure_allowlist() -> None:
    """Allow the app's sender in every profile, so no bot demands pairing.

    A profile's secrets are built from that profile's own ``.env`` with no
    fallback to the default root, so an allowlist set once in one place leaves
    every other bot unauthorized. Hermes then answers the first message with a
    pairing code and a ``hermes -p <bot> pairing approve`` command to run in a
    terminal — for each bot, forever, on a product whose whole point is that
    you never open one.

    There is nothing to decide here: the relay hands each account its own
    token, and every message that arrives over it is from that account's owner
    under the single id ``user``. Writing the constant is what makes the app's
    own messages recognized as theirs.

    Absence-only, so a user who narrows the list keeps their edit.
    """
    try:
        from hermes_constants import reset_hermes_home_override, set_hermes_home_override
        from hermes_cli.config import save_env_value
    except Exception:
        logger.debug("[AgentInbox] no Hermes config API for the allowlist", exc_info=True)
        return

    for home in _profile_homes():
        try:
            env_path = home / ".env"
            if env_path.is_file():
                already = any(
                    line.strip().startswith(f"{ALLOWED_USERS_ENV}=")
                    for line in env_path.read_text(errors="replace").splitlines()
                )
                if already:
                    continue
            token = set_hermes_home_override(str(home))
            try:
                save_env_value(ALLOWED_USERS_ENV, "user")
            finally:
                reset_hermes_home_override(token)
            logger.info("[AgentInbox] allowed the app to talk to '%s'", home.name)
        except Exception:
            logger.debug(
                "[AgentInbox] could not set the allowlist for %s", home, exc_info=True
            )


def _ensure_gateway_config() -> None:
    """Write the two config keys Agent Inbox needs but nobody can click.

    ``gateway.multiplex_profiles`` — every Hermes profile is a bot, and the app
    shows one chat per profile. Without multiplexing the gateway serves only the
    default profile, ``source.profile`` is ignored, and every bot answers as the
    default one. Hermes exposes this flag nowhere in its UI, so leaving it to
    the user means hand-editing config.yaml.

    ``platforms.agentinbox.enabled`` — the Messaging settings pane sends this
    only when its toggle is touched, and saving credentials alone posts
    ``enabled=None``. The gateway then boots with no platform and the app sits
    empty with no error anywhere the user can see.

    Neither is something a beta tester can be asked to get right, so the plugin
    writes both when it loads. Idempotent, fail-open, and deliberately
    absence-only for the platform toggle: once the key exists the user owns it,
    so an explicit ``enabled: false`` is never overwritten.
    """
    try:
        from hermes_constants import get_default_hermes_root
        from hermes_cli.config import atomic_config_write, read_user_config_raw

        cfg_path = get_default_hermes_root() / "config.yaml"
        if not cfg_path.exists():
            return

        cfg = read_user_config_raw(cfg_path)
        changed = []

        # Hermes accepts the flag either top-level or nested under `gateway`.
        if not (
            cfg.get("multiplex_profiles")
            or (cfg.get("gateway") or {}).get("multiplex_profiles")
        ):
            gateway_cfg = cfg.get("gateway")
            if not isinstance(gateway_cfg, dict):
                gateway_cfg = {}
            gateway_cfg["multiplex_profiles"] = True
            cfg["gateway"] = gateway_cfg
            changed.append("gateway.multiplex_profiles")

        platforms = cfg.get("platforms")
        if not isinstance(platforms, dict):
            platforms = {}
        entry = platforms.get(PLATFORM_NAME)
        if not isinstance(entry, dict):
            entry = {}
        if "enabled" not in entry:
            entry["enabled"] = True
            platforms[PLATFORM_NAME] = entry
            cfg["platforms"] = platforms
            changed.append(f"platforms.{PLATFORM_NAME}.enabled")

        if not changed:
            return

        atomic_config_write(cfg_path, cfg, sort_keys=False)
        logger.info(
            "[AgentInbox] set %s; takes effect on the next gateway start",
            ", ".join(changed),
        )
    except Exception:
        logger.debug("[AgentInbox] could not write gateway config", exc_info=True)


def register(ctx) -> None:
    """Plugin entry point — called by the Hermes plugin system."""
    _ensure_gateway_config()
    _ensure_allowlist()
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
