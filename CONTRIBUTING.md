# Contributing to web-craft-skills

Thanks for improving these skills. This repo is the **canonical upstream** for a set of Claude Code
plugins that are meant to be installed and vendored elsewhere. The most common contribution is an
enhancement you made to a skill while using it in another project, brought back here so everyone gets it.

> Working as Claude / Claude Code? [`CLAUDE.md`](./CLAUDE.md) is the condensed version of this file and is
> loaded automatically when you work in this repo.

## Repository shape

```
.claude-plugin/marketplace.json     # lists the plugins
shared/web-probe/                    # the canonical headless-chromium probe (the shared harness)
  web-probe.mjs                      # THE source of the harness (single vendor unit; has VERSION)
  scripts/sync-vendored.sh           # copies + stamps the harness into each skill
plugins/<plugin>/
  .claude-plugin/plugin.json
  skills/<skill>/
    SKILL.md
    tools/<skill>.mjs                # the skill's logic
    tools/web-probe.mjs              # a GENERATED vendored copy (do not hand-edit)
    fixtures/                        # positive + negative test pages
    test/run.mjs                     # self-validation; exits non-zero on failure
docs/combos/                         # how skills pair with each other / external skills
REFERENCES.md                        # third-party skills we point at but do NOT host
```

## The golden rule: edit the canonical source, not a vendored copy

- **Harness change** → edit `shared/web-probe/web-probe.mjs`, bump its `VERSION`, then re-sync:
  ```bash
  bash shared/web-probe/scripts/sync-vendored.sh plugins/*/skills/*
  ```
  Every `plugins/<skill>/skills/<skill>/tools/web-probe.mjs` carries a `// VENDORED from shared/web-probe …`
  stamp — that is a generated file. Edits there are overwritten on the next sync and will be rejected in
  review.
- **Skill change** → edit `plugins/<skill>/skills/<skill>/tools/<skill>.mjs` and its `SKILL.md`.

## Every change ships with a test

Add or update a fixture and an assertion in the skill's `test/run.mjs` that **fails without your change
and passes with it**. These skills are verification tools; an untested change to one is not acceptable.

```bash
cd plugins/<skill>/skills/<skill>
npm install                       # pnpm shim may be unset in some shells; npm is fine
npx playwright install chromium   # one-time, if not already present
node test/run.mjs                 # must print its passes and exit 0
```

## Branching, PRs, and CI

`main` is protected: no direct pushes, and the `ci-pass` check must be green to merge.

```bash
git switch -c my-change
# … edit, re-sync if needed, test …
git commit -am "…"
git push -u origin my-change
gh pr create --fill
```

CI (`.github/workflows/ci.yml`) validates the manifests and runs **every** skill's test suite (each in a
headless chromium matched to its pinned `playwright-core`). The `ci-pass` job is green only if the
manifests job and all skill legs pass — that single check is what branch protection requires.

In the PR description, state **what the enhancement does** and **which fixture/assertion proves it**.

## Do / don't

- **Do** keep each plugin independently installable: its own vendored harness copy, its own pinned deps.
- **Do** port a fix you made to a vendored copy in another repo back to the canonical source here.
- **Don't** commit `node_modules/` (gitignored) or unrelated lockfile churn.
- **Don't** edit a `tools/web-probe.mjs` copy as if it were the source.
- **Don't** add third-party skills to this repo. They live in [`REFERENCES.md`](./REFERENCES.md); propose
  changes to them in their own upstreams.

## License

Contributions are accepted under this repo's [MIT license](./LICENSE).
