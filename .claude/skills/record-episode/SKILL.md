---
name: record-episode
description: Write down a lesson, incident or decision a person learned, as an immutable episode in docs/knowledge/episodes. Use when something went wrong, or was decided, in a way the next person should find by asking the memory.
---

# Record an episode

A person writes and commits an episode; no command or agent does. A decision that changes structure is an ADR first (`record-decision`); an episode records what was learned around it.

1. Create `docs/knowledge/episodes/YYYY-MM-DD-short-slug.md`, dated the day it is written.
2. Start it with frontmatter:
   - `id`: the file name without `.md`
   - `kind`: `lesson`, `incident` or `decision`
   - `title`: one line
   - `validFrom`: the date, `YYYY-MM-DD`
   - `reviewBy`: a date after which someone must reread it and confirm or supersede it
   - `refs`: comma-separated ids of the nodes it is about (`adr:0017, script:scripts/verify.mjs`), at least one, each an existing node
   - `supersedes`: optional id of an earlier episode this one replaces
3. Write what happened, why, and what to do next time. Facts, no secrets, no absolute paths.
4. Run `node scripts/knowledge.mjs sync`, then `check`, and commit the episode with the regenerated files.
5. A committed episode is never edited or deleted; `check` fails when it is. To correct one, write a new episode that `supersedes` it.
