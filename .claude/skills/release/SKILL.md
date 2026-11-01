---
name: release
description: Cut a ClaraCoder beta or stable (full) release through the GitHub Actions Release workflow — version checks, the package.json bump PR, dispatching a beta or pushing a vX.Y.Z tag, watching the build, publishing the draft, and bumping to the next version. Use when asked to release, ship, publish, cut a beta or a stable/full release, or bump the app version.
---

# Release ClaraCoder

Releases are built by `.github/workflows/release.yml` and published as GitHub Releases of
`dpere122/ClaraCoder`, which the in-app Updates window reads. Version rules live in
`scripts/release-version.mjs`; read it if anything here seems off.

**Convention:** `package.json` on `master` holds the *next* stable version.
- Beta = `<package.json version>-beta.<workflow run number>`, published as a pre-release.
- Stable = exactly the `package.json` version, from a `vX.Y.Z` tag, created as a **draft**.

So betas of 0.2.1 sort above the 0.2.0 stable release and below 0.2.1.

Every step that publishes or changes `master` is outward-facing. Confirm with the user first:
merging a PR, dispatching the workflow, pushing or moving a tag, and publishing a draft. One
"go ahead" covers the steps the user agreed to, not later ones.

## 0. Preflight (both kinds)

```bash
git fetch --tags origin
git switch master
git pull
grep '"version"' package.json
gh release list --limit 10
git tag -l 'v*' --sort=-v:refname
```

- Work from an up-to-date `master` with a clean tree.
- If a stable tag `v<package.json version>` already exists, the version was never bumped after
  that release. Betas would sort *below* it and stable can't reuse it, so do the bump in step S1
  first.
- `gh run list --workflow release.yml --limit 1` shows whether another release run is still going
  (runs are serialized per ref, but don't stack them).

## Beta release

1. Pick the ref: `master` unless the user names a branch. The workflow file must exist on the
   default branch for manual runs, and on the chosen ref.
2. Dispatch (after confirming):
   ```bash
   gh workflow run release.yml --ref master
   ```
3. Find the run and watch it in the background (`run_in_background`, no polling):
   ```bash
   gh run list --workflow release.yml --limit 1 --json databaseId,headBranch,status,createdAt
   ```
   ```bash
   gh run watch <id> --exit-status --interval 30
   ```
4. On success, a pre-release `v<next>-beta.<run>` exists, with the tag pinned to the built commit:
   ```bash
   gh release view v<version> --json tagName,isPrerelease,assets -q '.tagName, .isPrerelease, [.assets[].name]'
   ```
   Expect `Clara-Coder-<version>-Windows-x64.exe`, its `.blockmap`, and `latest.yml`. Users with
   "Show beta versions" on see it in the Updates window right away.

## Stable (full) release

**S1. Version.** Agree on the version with the user (semver: patch for fixes, minor for features).
If `package.json` already holds it and it isn't tagged yet, skip to S2. Otherwise bump on a
branch and open a PR:
```bash
git switch -c release/vX.Y.Z origin/master
```
```bash
npx -y npm@11.9.0 version X.Y.Z --no-git-tag-version
```
```bash
node scripts/release-version.mjs --channel stable --tag vX.Y.Z
```
Use npm 11.9.0 (`packageManager`) so the lockfile stays byte-identical to what CI's `npm ci`
expects. Commit `package.json` and `package-lock.json` (`chore: release X.Y.Z`), push, then
`gh pr create --base master`. Merge only when the user says so (`gh pr merge <n> --merge`).

**S2. Tag the merge commit** on the updated `master` and push it. This starts the workflow:
```bash
git switch master
git pull
git tag -a vX.Y.Z -m "Clara Coder X.Y.Z"
git push origin vX.Y.Z
```
The trigger only matches plain `v[0-9]+.[0-9]+.[0-9]+`. The `version` job fails fast if the tag
and `package.json` disagree.

**S3. Watch** the run in the background as in the beta steps. Expect the Windows build to take a
while: it installs `npm ci`, the portable Python and its packages, then NSIS.

**S4. Draft.** Success creates a **draft** release `vX.Y.Z` with generated notes. Updaters ignore
drafts. Hand it to the user to smoke-test (download the installer from the draft and install it).
Offer to edit the notes (`gh release edit vX.Y.Z --notes-file …`).

**S5. Publish**, only on the user's go-ahead:
```bash
gh release edit vX.Y.Z --draft=false --latest
```

**S6. Bump to the next version** right away (normally the next patch) with the same PR flow as S1,
so later betas sort above the release just shipped.

## When a run fails

```bash
gh run view <id> --log-failed | grep -iE "error|fail|ERR!|exit code" | head -40
```

Fix the cause on a branch and get it merged, then:
- **Beta:** just dispatch again. The new run number gives a new version.
- **Stable, nothing published:** the publish job only runs after a successful build, so a failed
  build leaves no release. With the user's OK, move the tag to the fixed `master` commit:
  ```bash
  git switch master
  git pull
  git tag -d vX.Y.Z
  git push origin :refs/tags/vX.Y.Z
  git tag -a vX.Y.Z -m "Clara Coder X.Y.Z"
  git push origin vX.Y.Z
  ```
  If a draft was created and you're replacing it, delete the draft first (`gh release delete vX.Y.Z`,
  after confirming). **Never move the tag of a published release.** Ship the next patch instead.

Known pitfalls:
- **Workflow steps run in Git Bash**, so a bare `tar` is GNU tar, which reads `D:\…` as `host:path`.
  Bundle scripts must call `%SystemRoot%\System32\tar.exe` on Windows.
- **`npm ci` fails when `package-lock.json` is out of sync** with `package.json`. Re-sync with
  `npx -y npm@11.9.0 install --package-lock-only` and commit the result.
- **A pushed tag doesn't trigger the workflow** when it was pushed with `GITHUB_TOKEN`, or doesn't
  match the plain `vX.Y.Z` pattern.

## Report

Tell the user:
- the version and tag;
- the run link;
- the release link;
- whether it is a pre-release, a draft or published;
- what is left for them to do (smoke-test, publish, the next-version PR).
