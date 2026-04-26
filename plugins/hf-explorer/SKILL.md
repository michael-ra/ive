---
name: HF Explorer
description: Mount and explore Hugging Face Hub repos as local filesystems via hf-mount
---

# HF Explorer

You have tools to mount Hugging Face Hub repos as local filesystems. Once mounted, files are fetched lazily — use your normal file tools (Read, ls, Glob, grep) to explore.

## When to Activate

- User mentions a HF repo (e.g. `meta-llama/Llama-3.1-8B`, `openai/whisper-large-v3`)
- User needs a model for a task — search, then mount the best candidate
- User asks about model architecture, config, tokenizer, or dataset structure
- User wants to compare models or inspect what's inside a repo

## Workflow

1. **`hf_search(query)`** — Find repos by keyword, task, or model family. Start here when you don't have a specific repo.
2. **`hf_mount(repo_id)`** — Mount the repo locally. Returns the mount path.
3. **Explore with native tools** — `ls`, `Read`, `Glob`, `grep` on the mount path. Files load on demand.
4. **`hf_unmount(repo_id)`** — Clean up when done.

## Examples

**Find and inspect a model:**
```
hf_search("code generation python") → pick best match →
hf_mount("bigcode/starcoder2-15b") → mounted at /tmp/hf-mounts/bigcode_starcoder2-15b →
ls /tmp/hf-mounts/bigcode_starcoder2-15b →
Read config.json, tokenizer_config.json
```

**Explore a dataset:**
```
hf_search("sentiment", type="dataset") →
hf_mount("stanfordnlp/imdb", type="dataset") →
ls, read sample files
```

## Key Files in Model Repos

- `config.json` — architecture, hidden size, layers, vocab
- `tokenizer_config.json` — tokenizer type, special tokens
- `generation_config.json` — default generation params
- `README.md` — model card, benchmarks, usage examples

## Tips

- Files are lazy — reading `config.json` doesn't download model weights
- Sort search by `trending` for what's hot, `downloads` for battle-tested
- Filter searches: `hf_search(query, filter="task:text-generation")`
- Private repos need `HF_TOKEN` env var
- Mount stays active until you unmount or the session ends
