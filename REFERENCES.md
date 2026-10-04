# External skills — referenced, not redistributed

These skills were **trialed** in the source project but are other people's work (some commercial), so
they are not bundled into this marketplace. This file catalogues them so you can install them from their
own sources. [`scripts/install-external.sh`](./scripts/install-external.sh) automates the ones with a
known install path.

Provenance below is what was recorded in the skills' own frontmatter/metadata at the time of writing;
**verify the current source and license yourself before installing or redistributing** — these can change.

## SVG / graphics generators

| Skill | What it does | Origin (as recorded) | License (as recorded) | Install |
|---|---|---|---|---|
| `svg-infographic` | Technical/structured SVG infographics → PNG; strong CJK; sketch preset | kyungseo | ships its own `LICENSE.txt` | source TODO — ships its own license file; find upstream |
| `svg-design` | SVG logos/icons/path art, optimization, animation | unclear (no license header) | unknown | source TODO — confirm provenance before reuse |
| `svg-skill` (dir `svg-linyaosky`) | Production-ready SVG markup; "rebuilt less-detectable" | Reddit creator | unknown | see https://www.reddit.com/r/claudeskills/comments/1vra4yr/ (pending feedback to creator) |
| `moai-tool-svg` | SVG creation/optimization (SVGO), icon systems, animation | MoAI / mcpmarket | Apache-2.0 | via mcpmarket (`mcpmarket-version: 1.0.0`) |

## Design systems / generators

| Skill | What it does | Origin | License | Install |
|---|---|---|---|---|
| `hallmark` | Anti-AI-slop design skill; insists on structural variety | Together AI ("Powered by Together AI") | unknown | via Together AI |
| `impeccable` | Out-of-distribution design craft; audit/animate/polish verbs | (external product) | Apache-2.0 | `npx impeccable` (confirm current invocation upstream) |
| `superdesign` | Design/redesign UI on an infinite canvas; multi-model; extract a site's design DNA | Superdesign | unknown | via Superdesign |
| `frontend-design` | Distinctive, intentional visual design guidance | Anthropic | see its `LICENSE.txt` | Anthropic skill (installed at `~/.agents/skills/frontend-design`) |

## Infographics / dataviz

| Skill | What it does | Origin | License | Install |
|---|---|---|---|---|
| `epic-infographics` | Polished infographic images from data; HTML/CSS+SVG → PNG, can animate to MP4/GIF | marketplace plugin | unknown | via plugin marketplace (`/plugin marketplace add …`) |
| `dataviz` | Chart/visualization design-system guidance | Anthropic (harness) | — | built into the harness |

> `model-render` (in this repo) pairs well with an infographic skill: render the real object as a PNG,
> then let the infographic place leader-lines against it. That combo was the original high-value idea.

## Narrative / ideation (relevant to scrollytelling)

| Skill | What it does | Origin | License |
|---|---|---|---|
| `storytelling` | Four canonical narrative patterns for design work — **companion to the `storytelling-coach` agent** | Anthropic | — |
| `storyboard` | Six-frame journey storyboard | Anthropic | — |
| `story-sense`, `story-collaborator`, `story-coach`, `story-zoom`, `story-idea-generator` | Story diagnosis / drafting / coaching / multi-level sync | jwynia | MIT |
| `outline-coach`, `outline-collaborator`, `reverse-outliner` | Outline development and reverse-engineering | jwynia | MIT |
| `brainstorming` | Escape convergent ideation; expand seeds | jwynia | MIT |
| `problem-framing-canvas` | MITRE Problem Framing Canvas | (external) | — |

## 3D / WebGL

| Skill | What it does | Origin | License |
|---|---|---|---|
| `threejs-skills` (10 skills: fundamentals, geometry, materials, lighting, loaders, shaders, postprocessing, animation, interaction, textures) | Foundational three.js API knowledge — the basis for `model-render` | github.com/CloudAI-X/threejs-skills | see repo |

## Web performance / deployment (web-dev-adjacent, out of this repo's UI/UX theme)

Installed under `~/.claude/skills` and useful for web work, but outside this marketplace's focus:
`web-perf` (Core Web Vitals auditing, Anthropic) and the **Cloudflare cluster** — `cloudflare`,
`wrangler`, `workers-best-practices`, `durable-objects`, `agents-sdk`, `cloudflare-email-service`,
`cloudflare-one*`, `sandbox-*`, `turnstile-spin` (all Cloudflare).
