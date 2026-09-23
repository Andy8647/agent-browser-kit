# agent-browser-kit

A complete browser-control setup for LLM agents: **hands + reflexes + brain**.

| layer | component | role |
|---|---|---|
| **Hands** | `chrome-debug` + [chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp) | launch and drive a dedicated Chrome instance (navigate, snapshot, click, fill, evaluate) |
| **Hands (batch)** | `abk-fetch` | background tabs + downloads through the page's login session — silent bulk work the MCP can't do |
| **Reflexes** | `jev-ask` + `extract/extract.js` | [TypeSafe Jev](https://typesafe.ai) makes fast bounded decisions (pick element, done?, risky?) in ~0.6s for ~$0.0001 |
| **Brain** | your agent (pi, Claude Code, Codex, …) | planning, text generation, recovery, anything Jev shouldn't touch |

Everything is glued together by a **skill** (`skills/browser-control/SKILL.md`) that teaches any agent the full workflow, including the state-on-disk + `rg` retrieval pattern that cuts token cost by ~3× on large pages.

Validated in a controlled benchmark: on 6 real websites × 5 runs, this division of labor (Jev as decider) beat a pure-LLM decider **30/30 vs 25/30**, at **23× lower cost** and **4× lower latency**.

## Install

```sh
git clone https://github.com/Andy8647/agent-browser-kit
cd agent-browser-kit

# 1. Hands: the Chrome launcher (macOS)
cp bin/chrome-debug ~/.local/bin/ && chmod +x ~/.local/bin/chrome-debug

# 1b. Hands: silent batch fetch/download helper (run via: uv run --with websockets abk-fetch ...)
cp bin/abk-fetch ~/.local/bin/ && chmod +x ~/.local/bin/abk-fetch

# 2. Hands: register chrome-devtools-mcp with your agent host.
#    See mcp/mcp.json for a known-good config (pi syntax; adapt for your host).

# 3. Reflexes: the decision CLI (zero dependencies, Python ≥ 3.10 stdlib)
cp bin/jev-ask bin/jev-prep ~/.local/bin/ && chmod +x ~/.local/bin/{jev-ask,jev-prep}
export TYPESAFE_API_KEY=...        # https://typesafe.ai

# 4. Brain: install the skill
#    pi:          cp -r skills/browser-control ~/.pi/agent/skills/
#    Claude Code: cp -r skills/browser-control ~/.claude/skills/
```

## The loop (what the skill teaches)

```
1. chrome-debug                     # idempotent launcher, dedicated profile, port 9222
2. MCP navigate → take_snapshot
3. Save every snapshot to .browser-state/ — never inline a large snapshot into context.
   Retrieve with rg; only read the matched region.  (3× cheaper on pages > 4–5 KB)
4. When an action is needed and candidates are enumerable:
   a. MCP evaluate_script with extract/extract.js
      → ≤120 numbered candidates with disambiguating context + current values,
        each marked in the DOM with data-bench-idx
   b. jev-prep turns that into state.txt + questions.json
   c. jev-ask --threshold 0.6 → typed answer + confidence
      exit 0 → execute; exit 3 → hand back to the LLM with the probability distribution
5. Execute with extract/act.js via evaluate_script (DOM click — synthetic mouse
   events don't trigger React onClick; benchmarked)
6. DONE is always a hypothesis: verify completion with your own JS, never trust
   the model's self-report
```

## Division of labor (hard rules)

**Jev decides** when: candidates are enumerable (≤120), no text needs generating, and confidence clears the threshold — element disambiguation, action selection, completion hypotheses, danger gates.

**The LLM decides** when: planning, generating text to type, recovering from being stuck (2+ steps with no page change), arithmetic/date/cross-page reasoning, or canvas/WebGL pages where the DOM has no candidates.

**Thresholds by reversibility**: 0.6 reversible (click/scroll/fill) · 0.8 semi-irreversible (form submit, add-to-cart) · irreversible actions (pay/delete/send/publish) never auto-execute — hard gate in code, ask the human.

## What's in the box

| path | what |
|---|---|
| `bin/chrome-debug` | idempotent launcher for a dedicated debug Chrome (separate profile from daily Chrome, blocks the 4 GB Gemini Nano download) |
| `bin/abk-fetch` | silent CDP helper: background tabs (`Target.createTarget background:true`), session-cookie fetch/download, per-attach focus emulation. `/json/new` has no background mode — never use it for silent work |
| `bin/jev-ask` | zero-dep CLI for the Jev `/v1/systemone` API; JSON in/out, exit code 3 = low confidence. Also available [standalone](https://github.com/Andy8647/jev-ask) |
| `bin/jev-prep` | glue: extract.js output + goal → `state.txt` + `questions.json` for jev-ask |
| `extract/extract.js` | in-page element-table extractor; the disambiguation context (4-layer heuristic) is the accuracy-critical piece |
| `extract/act.js` | act on a candidate by `data-bench-idx`: DOM click with occlusion check, React-safe fill, select |
| `mcp/mcp.json` | known-good chrome-devtools-mcp config |
| `skills/browser-control/SKILL.md` | the whole workflow as an installable agent skill |
| `examples/` | a runnable saucedemo example (state, questions, expected flow) |

## Silent background work (no focus stealing)

Interactive steps go through the MCP, but two common needs fall outside it: opening a tab **without** focusing it, and downloading files through the page's login session. `abk-fetch` covers both, over raw CDP on :9222:

```sh
uv run --with websockets abk-fetch bg-new <url>          # background tab, prints targetId (never activates)
uv run --with websockets abk-fetch eval  <tid> '<js>'    # JS in that tab, JSON out
uv run --with websockets abk-fetch fetch <tid> <url>     # GET via the tab's cookies (scraping)
uv run --with websockets abk-fetch download <tid> <url> <out>  # binary download via session
uv run --with websockets abk-fetch close <tid>
```

`new_page` (MCP) and `/json/new` (CDP HTTP) both open foreground tabs — benchmarked focus stealers. `Target.createTarget {background: true}` is the only measured-silent way to open a page.

## Why these design choices (short version)

- **Candidates, not snapshots**: feeding raw pages to a decision model is expensive and less accurate. A numbered candidate list with context is the cheapest and most accurate input form we tested.
- **a11y trees lose `input` elements** on real sites (observed: DuckDuckGo's search box missing); extract.js reads the DOM directly.
- **Always offer an escape hatch** (`__wait` / `__scroll` / `__back`): without one, the model picks the least-wrong option instead of saying "none".
- **Confidence is per-vendor**: thresholds above are calibrated against the official Jev API, not any local clone.

## Requirements

- macOS (chrome-debug uses `open -na`); the rest is platform-agnostic
- Google Chrome installed
- An agent host with MCP support + shell access
- `TYPESAFE_API_KEY` for the reflex layer (the kit works without it — you just lose the fast path)

## License

MIT
