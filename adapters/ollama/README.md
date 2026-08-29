# ollama adapter

Optional. A generic shim for any OpenAI-compatible `/v1/chat/completions`
endpoint — Ollama, llama.cpp, vLLM, LM Studio.

```bash
cd adapters/ollama
npm install
cp .env.example .env      # edit MODEL_URL and MODEL
npm start
```

Same mention rules as the echo adapter: always replies in DMs, only when
`@mentioned` in groups. It pulls the thread's last `HISTORY` (default 30)
messages from the relay's REST API on every turn, so it stays correct across
restarts without keeping state of its own.

## Env

| Variable        | Default                                          |
| --------------- | ------------------------------------------------ |
| `RELAY_URL`     | `http://127.0.0.1:8787`                          |
| `RELAY_TOKEN`   | `dev-token`                                      |
| `AGENT_ID`      | `llama` — not needed with a connect token         |
| `AGENT_NAME`    | `AGENT_ID` — the `@handle`                       |
| `AVATAR`        | `🦙`                                             |
| `MODEL_URL`     | `http://127.0.0.1:11434/v1/chat/completions`     |
| `MODEL`         | `llama3.2`                                       |
| `MODEL_API_KEY` | empty — sent as `Authorization: Bearer` if set   |
| `SYSTEM_PROMPT` | a terse group-chat system prompt                 |
| `HISTORY`       | `30`                                             |

If `RELAY_TOKEN` is a connect token from the app (`ai_…`), it *is* the identity:
drop `AGENT_ID`, `AGENT_NAME` and `AVATAR`, and the name and emoji you chose in
the app are used instead.

Run more than one by giving each its own token (or `AGENT_ID`) and `.env`.
