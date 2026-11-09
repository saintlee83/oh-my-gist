# oh-my-gist

The ultimate gist profile for hackers. It traces your real activity across personal repos, gists and every organization you belong to, then publishes it as cards you can pin to your GitHub profile.

![Example dashboard](https://gist.githubusercontent.com/saintlee83/8cda62a6053728866393e4e1c6b3f869/raw/dashboard.svg)

*A live example, from [@saintlee83's profile gist](https://gist.github.com/saintlee83/8cda62a6053728866393e4e1c6b3f869).*

| Card | What it traces |
|---|---|
| ⚡ **Contributions** | Commits, PRs, code reviews and issues: all-time, this year, 12-month trend, by year and by where |
| 🕒 **Coding rhythm** | Morning, daytime, evening and night, plus a weekday-by-hour punchcard |
| 🧬 **Top languages** | Every language you wrote, split across personal repos, orgs and gists |
| ± **Language churn** | Lines added and removed per language, as a diverging chart |
| 🪙 **AI token trace** | Claude Code and Codex tokens by model and day, with API-equivalent cost |
| 🤝 **Top coauthored with** | Who you co-author with, by AI model and by teammate |
| 🔥 **Pulse** | Streaks, peak day, AI-assisted share, merge and review speed |

Each card leads with a five-line summary, which is all a pinned gist shows. The rest of the file holds the full tables. A separate hub gist collects everything, plus an SVG dashboard you can embed in your profile README.

## Choose how to run it

| | On your machine | From a fork, with GitHub Actions |
|---|---|---|
| **Cards** | All seven | Six, without the AI token trace, because your AI logs are local |
| **Needs** | Node 22.18+ and the [GitHub CLI](https://cli.github.com) | A GitHub account and a personal access token |
| **Updates** | While your machine is on | Every 6 hours, on GitHub's servers |

You can use both: the fork keeps the GitHub cards fresh, and your machine updates the token card.

## Run it on your machine

There are no runtime dependencies and no build step.

```sh
git clone https://github.com/saintlee83/oh-my-gist && cd oh-my-gist
gh auth refresh -s repo,read:org,gist

node src/cli.ts doctor            # check token, org access and AI logs
node src/cli.ts collect           # gather the data (read-only)
node src/cli.ts render            # write out/, including out/preview.html
node src/cli.ts publish --dry-run # see what would change
node src/cli.ts publish --yes     # create the public gists
```

Then open your profile, choose **Customize your pins**, and pick your cards. GitHub allows six pins and has no API for them, so this step is manual.

The first `collect` makes one API call per commit to get language-level line counts. The results are cached, so later runs only fetch new commits. If you have more commits than one run's budget allows, the next run picks up where this one stopped.

To keep it fresh, install a schedule. It uses launchd on macOS and prints a crontab line elsewhere.

```sh
node src/cli.ts schedule --install   # refresh every 6 hours; --uninstall removes it
```

## Run it from a fork

1. **Fork this repository**, then open the fork's **Actions** tab and enable workflows.
2. **Create a [classic personal access token](https://github.com/settings/tokens)** with the `repo`, `read:org` and `gist` scopes. If an organization uses SAML SSO, authorize the token for it too. Add the token as a secret:
   ```sh
   gh secret set OH_MY_GIST_TOKEN -R <you>/oh-my-gist
   ```
3. **Set your timezone**, because Actions runners use UTC:
   ```sh
   gh variable set OMG_TIMEZONE --body Asia/Seoul -R <you>/oh-my-gist
   ```
4. **Create the gists.** In the **Actions** tab, open **Update gist profile**, choose **Run workflow**, and tick **Create the gists**. You can also run:
   ```sh
   gh workflow run oh-my-gist.yml -f create_gists=true -R <you>/oh-my-gist
   ```
5. **Turn on the schedule:**
   ```sh
   gh variable set OH_MY_GIST_ENABLED --body true -R <you>/oh-my-gist
   ```
6. **Pin your cards** from your profile.

The `repo` scope is broad because reading private repositories requires it. GitHub doesn't expose secrets to pull requests from other forks, and the workflow only runs on a schedule or by hand.

## Why the numbers differ from other stats tools

GitHub's contribution API hides private work behind `restrictedContributionsCount`, even from your own token. One real account shows 519 commits and 3 PRs there, against 3,228 commits and 371 PRs in reality. So oh-my-gist asks a different way:

- **Commits** are walked repo by repo, using each repo's default branch.
- **PRs and issues** come from your own lists, and **reviews** from search.
- **Totals and streaks** come from the contribution calendar, which does include private work.

It also corrects for some other common distortions:

- **Languages** are ranked by lines you added, not repo bytes. Bytes can't tell an imported SDK or notebook outputs from code you wrote: the same account ranks C first at 47% by bytes, because of a few large imports, and TypeScript first by lines.
- **Churn** leaves out lockfiles, vendored and generated code, merge commits and bulk imports (a single commit over 20,000 lines). Docs and config are reported separately, and everything excluded is listed on the card.
- **Tokens** are counted once per model response. Claude Code logs about half of its rows more than once, and naive totals double-count them.
- **Token history** survives log cleanup. Claude Code deletes old logs, so daily totals are kept in a ledger that only ever grows.

## What gets published

The cards are public, because only public gists can be pinned. They contain aggregates:

| Published | Never published |
|---|---|
| Totals per language, month, hour and model | Private repository and organization names |
| Daily token totals per model | Prompts, code, commit messages, file paths |
| AI assistants and bots you co-author with | Email addresses |
| `@login` of people co-authoring in **public** repos, with those public commits only | People who co-author only in private repos, who become an anonymous count unless you list them in `namedCoauthors` or `agentCoauthors` |

Repository, organization and person names are dropped during collection, before anything is rendered. A test plants fake private names and checks that none reach any output.

The totals themselves do reveal how much private work you do. If you'd rather not show that, don't pin that card.

Publishing is cautious by default: creating new gists requires `--yes`, scheduled runs only update existing ones, and a gist is only written when its content changed. With seven cards and six pins, you can delete any card you don't want, and it stays deleted.

## Commands

```
node src/cli.ts doctor      Check token, org access and AI log sources
node src/cli.ts collect     Fetch GitHub data and scan AI logs
node src/cli.ts render      Write cards, dashboard and preview to out/
node src/cli.ts publish     Create or update the gists
node src/cli.ts run         collect + render + publish
node src/cli.ts schedule    Run automatically (--install, --uninstall)

--github-only   Skip local AI logs and reuse the published ledger (for CI)
--tokens-only   Only the token card, with no GitHub collection
--dry-run       Show what publish would do without writing
--yes           Allow creating new public gists
--update-only   Only update gists that exist (what scheduled runs use)
```

## Configuration

Settings come from the first of these that exists, so personal values can stay out of your public repository:

1. The `OMG_CONFIG_JSON` environment variable. In a fork, set it as an Actions variable.
2. The file named by `OMG_CONFIG`.
3. `~/.oh-my-gist/config.json`.
4. [`oh-my-gist.config.json`](oh-my-gist.config.json) in this repository, which holds the defaults.

For example, to name your own agent account when running from a fork:

```sh
gh variable set OMG_CONFIG_JSON --body '{"agentCoauthors":["my-agent"]}' -R <you>/oh-my-gist
```

| Key | Default | Meaning |
|---|---|---|
| `timezone` | `"auto"` | IANA zone for the rhythm card. GitHub stores times in UTC. |
| `public` | `true` | Only public gists can be pinned. |
| `excludeLanguages` | `[]` | For example `["Jupyter Notebook"]`. |
| `namedCoauthors` | `[]` | GitHub logins to name on the co-author card, including their commits in private repos. Use this for people who've agreed. |
| `agentCoauthors` | `[]` | Logins of your own AI agent accounts. They are named and counted as AI, not people. |
| `churn.maxRequestsPerRun` | `4000` | REST budget per run. |
| `churn.maxFileLines` | `5000` | A bigger single-file diff is treated as generated. |
| `churn.maxCommitLines` | `20000` | A commit changing more lines is treated as a bulk import. Raise it if you land huge commits by hand. |
| `churn.concurrency` | `8` | Parallel requests. |

Other environment variables:

| Variable | Meaning |
|---|---|
| `OH_MY_GIST_TOKEN` | GitHub token. Falls back to `GH_TOKEN`, `GITHUB_TOKEN`, then `gh auth token`. |
| `OMG_TIMEZONE` | Overrides `timezone`. |
| `OMG_HOME` | Where state is kept. Default: `~/.oh-my-gist`. |
| `OMG_OUT` | Where `render` writes. Default: `./out`. |
| `OMG_API_URL` | GitHub Enterprise API URL. |

## Known limits

- **Default branches only.** Commits still on other branches aren't walked, which matches how GitHub counts contributions. The contributions card shows the gap against your graph total.
- **Co-authored commits you didn't author** aren't walked. The co-author card covers trailers on your own commits.
- **Churn reads the first 300 files of a commit**, which is what one API page returns.
- **AI tools:** only Claude Code and Codex logs are read today.
- **Multiple machines:** the token ledger keeps the higher figure per day and model rather than adding machines together, so a day used on two machines is under-counted.
- **Costs** use [LiteLLM's public price list](https://github.com/BerriAI/litellm). A model it doesn't list is left out of the cost and named on the card, and subscription plans pay differently.
- **Dark mode** in the SVG follows the viewer's OS setting, not GitHub's theme toggle.
- **Platforms:** CI covers Linux, and development happens on macOS. Windows is untested, and `schedule` doesn't support it.

## Contributing

Issues and pull requests are welcome.

```sh
pnpm install     # TypeScript and Node types, for type checking only
pnpm test
pnpm typecheck
```

- **Adding an AI tool:** write a parser in `src/tokens/parsers.ts` that returns `UsageEvent`s, and register its log folder in `src/tokens/ledger.ts`.
- **The one rule that matters:** repository, organization and file names must never enter the `Snapshot` type in `src/types.ts`. Everything rendered comes from it, so that is what keeps private names out of public gists.

## License

[MIT](LICENSE)
