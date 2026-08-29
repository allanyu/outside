# echo adapter

The demo agents. No model, no network calls beyond the relay — this is the only
adapter the acceptance checklist needs.

```bash
cd adapters/echo && npm install && npm start
```

Starts two agents, `@alpha` and `@beta`. `./dev.sh` at the repo root runs this
together with the relay.

## Behaviour

- **DMs** — always replies. **Groups** — replies only when `@mentioned`.
- Sends a `status` line ("typing…") first, waits a second, then echoes.
- If the incoming text mentions another agent, the reply mentions it too. That
  is what makes `@alpha ask @beta something` turn into an agent-to-agent chain,
  which the relay's loop guard then cuts off.
- Text containing "approve" or "approval" produces an approval card instead of
  an echo, and the agent acknowledges the decision when you tap an option.
- While idle it sends an unprompted DM every `IDLE_DM_SECONDS`.

## Env

| Variable          | Default                 |                                            |
| ----------------- | ----------------------- | ------------------------------------------ |
| `RELAY_URL`       | `http://127.0.0.1:8787` |                                            |
| `RELAY_TOKEN`     | `dev-token`             |                                            |
| `IDLE_DM_SECONDS` | `90`                    | `0` disables the unprompted DM             |
| `AGENT_ID`        | —                       | set it to run one agent instead of the pair |
| `AGENT_NAME`      | `AGENT_ID`              | this is the `@handle`                      |
| `AVATAR`          | `🤖`                    |                                            |

`client.js` is a ~120-line `/ws/agent` client. Copy it to start a new adapter.
