## Kapa CLI

A lightweight Node.js command-line client for the [kapa.ai](https://www.kapa.ai/) HTTP API.

### Features

- Reads prompts from arguments or stdin (`echo foo | kapa --stdin`)
- Per-profile configuration saved under `~/.config/kapa-cli/config.json`
- Metadata injection, temperature control, resume threads, optional streaming
- Local history tracked in `~/.local/share/kapa-cli/history.jsonl`
- Save responses to files or copy to clipboard
- Basic management commands: `config`, `history`, and `cache clear`

### Quick Start

```bash
# Protect secrets at rest before storing them locally
export KAPA_VAULT_KEY="your-long-random-passphrase"
export KAPA_HISTORY_KEY="$KAPA_VAULT_KEY"   # optional but recommended

# Link the CLI locally
npm link

# Configure credentials (or set env vars: KAPA_API_KEY, KAPA_PROJECT_ID, KAPA_INTEGRATION_ID)
kapa config set apiKey sk-...
kapa config set projectId proj_123
kapa config set integrationId integ_456

# Ask something
kapa "How do I refresh sources?"
```

### Useful Flags

| Flag | Description |
| --- | --- |
| `--project <id>` | Override project id for this call |
| `--integration <id>` | Override integration id |
| `--thread <id>` / `--resume last` | Continue an existing conversation |
| `--metadata key=value` | Attach metadata (repeat multiple times) |
| `--stream / --no-stream` | Force-enable or disable streaming |
| `--json` | Print raw JSON from the API |
| `--save <path>` | Save the answer text to a file |
| `--copy` | Copy the answer text to the clipboard |

### Config Profiles

```
kapa config list                    # show stored profiles
kapa config profile create prod     # add a profile
kapa config profile use prod        # switch default profile
kapa --profile prod "Status?"
```

### History

```
kapa history            # show the last 10 prompts
kapa history 25 --json  # show 25 entries as JSON
kapa history clear      # wipe local history
```

History is stored locally only; delete `~/.local/share/kapa-cli/history.jsonl` if you prefer not to track it. Use `--no-history` on individual calls to skip logging.

### Security & Storage

- `KAPA_VAULT_KEY` (or `KAPA_CONFIG_SECRET`) is required to encrypt `kapa config` secrets before they land on disk. Without it, the CLI refuses to persist API keys unless you opt in to plaintext with `KAPA_ALLOW_PLAINTEXT_CONFIG=1`.
- Set `KAPA_HISTORY_KEY` (or reuse `KAPA_VAULT_KEY`) to encrypt prompt/response history. To deliberately write plaintext history, set `KAPA_ALLOW_PLAINTEXT_HISTORY=1`; otherwise history logging is skipped.
- Environment variables (`KAPA_API_KEY`, `KAPA_PROJECT_ID`, etc.) remain the safest option for automation pipelines when writing to disk is undesirable.

### Development

```
npm install
npm run test   # runs node --test with the ts-node loader
npm run build  # compiles dist/*.js
```

### License

This project is released under the MIT License (see `LICENSE`). Third-party runtime dependencies (`chalk`, `clipboardy`, `commander`, `ora`, and `undici`) are also MIT-licensed.
