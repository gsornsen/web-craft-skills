# web-craft-skills — guide for Claude / Claude Code

This repo is a Claude Code **plugin marketplace**. Its skills are meant to be installed and **vendored**
into other projects. If you (an AI agent or a human) improved a copy of one of these skills while using
it somewhere else, and the improvement is general, **contribute it back here** — that is the whole point
of keeping a canonical upstream. See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the full version; the
essentials:

## Raising a local enhancement upstream

1. **Edit the canonical source, never a vendored copy.**
   - Harness logic lives in `shared/web-probe/web-probe.mjs` — the single vendor unit. A
     `plugins/<skill>/skills/<skill>/tools/web-probe.mjs` is a **generated copy** (it carries a
     `// VENDORED …` stamp). Never treat a copy as the source. Edit the canonical file, bump its
     `VERSION`, then re-sync every copy:
     `bash shared/web-probe/scripts/sync-vendored.sh plugins/*/skills/*` (or pass explicit skill dirs).
   - Skill logic lives in `plugins/<skill>/skills/<skill>/tools/<skill>.mjs`.
2. **Cover it with a test.** Add or update a fixture + an assertion in that skill's `test/run.mjs` that
   fails without your change and passes with it. A change with no test that exercises it is not done.
3. **Validate locally** before opening anything:
   `cd plugins/<skill>/skills/<skill> && npm install && node test/run.mjs` → must exit 0. The headless
   chromium downloads once via `npx playwright install chromium`.
4. **`main` is protected — you cannot push to it.** Make a branch, push, open a PR:
   `git switch -c <topic>` → commit → `git push -u origin <topic>` → `gh pr create`.
5. **CI (`ci-pass`) must be green before merge.** In the PR body, say what the enhancement is and name
   the fixture/assertion that proves it.

## Rules

- Never commit `node_modules/` (gitignored). Keep each plugin independently installable: its own vendored
  harness copy + its own pinned deps.
- If you changed a vendored copy inside **another** repo (where a skill was installed), port the change
  back to the canonical source here — don't just leave it downstream.
- Third-party skills are catalogued in [`REFERENCES.md`](./REFERENCES.md) and are **not** part of this
  repo. Propose changes to them in *their* upstreams, never here.
- Don't fabricate review approvals or claim CI passed without seeing it. End commits/PRs with the
  attribution trailer your harness provides.
