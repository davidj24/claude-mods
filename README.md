# claude-mods

Four Claude Code mods (plugins built from function hooks). They run locally and never call the model, except for the opt-in keep-warm ping.

| Mod | What it does |
| --- | --- |
| **blast-radius** | Before `rm`, `find -delete`, `git clean -f`, `git reset --hard`, `git checkout -- …`, `git restore`, `git stash drop/clear` or `git branch -D` runs, it shows the files that would be deleted or discarded (with counts and sizes) and asks **Cancel** or **Run it**. The git commands and `find` are dry-run for an exact list. |
| **cache-thermometer** | A bar above the prompt: a countdown to when the prompt cache goes cold, what your next reply costs warm versus cold, the 5-hour and weekly usage left, and how long a break can be before keeping the cache warm stops paying off. It reads the cache lifetime (1 hour, or 5 minutes in usage overage) from the session itself. Auto-warm is off by default and stops at the break-even point. `/cache show \| hide \| warm \| auto on\|off` |
| **dictation-cleanup** | Removes um, uh, erm, hmm and ah, and stutter repeats like "the the", from a prompt before it is sent. Leaves code, inline code and real doubles ("that that") alone. `/dictation-cleanup on\|off` |
| **voice-picker** | A **Voices** pane, open in every session, for the voice-reader service on Linux (or the read-aloud plugin elsewhere): an auto-read button, a progress bar with pause, 10-second skip and sentence skip, a sample of any Kokoro voice with **Use**, and a speed slider. Each finished reply goes to the reader when auto-read is on. A small 🔊 Voices button above the prompt brings the pane back. The player needs voice-reader; without it the pane still picks voices and speed for read-aloud. `/voices` |

## Install

### Claude desktop app

Click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `davidj24/claude-mods`, then **Add plugin** for each mod you want.

### At the prompt of a terminal session

```
/plugin install blast-radius --marketplace davidj24/claude-mods
/plugin install cache-thermometer --marketplace davidj24/claude-mods
/plugin install dictation-cleanup --marketplace davidj24/claude-mods
/plugin install voice-picker --marketplace davidj24/claude-mods
```

Answer `y` to add the marketplace, then choose the user scope so the mods load in every session.

### From a shell

```
claude plugin install blast-radius --marketplace davidj24/claude-mods
claude plugin install cache-thermometer --marketplace davidj24/claude-mods
claude plugin install dictation-cleanup --marketplace davidj24/claude-mods
claude plugin install voice-picker --marketplace davidj24/claude-mods
```

## Notes

- Mods are an early-access Claude Code feature; the API may change between releases.
- Each mod's tests run with `claude plugin test <mod folder>`.
