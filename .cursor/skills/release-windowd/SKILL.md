---
name: release-windowd
description: Creates a new windowd npm release - bumps version, commits, tags, and pushes to trigger CI publish. Use when the user asks to release, tag, publish, or bump the version of windowd.
---

# Release windowd

## Versioning

- **Patch** (`0.x.Y`): bug fixes only
- **Minor** (`0.X.0`): new features or meaningful UX improvements

The project is pre-1.0, so minor bumps are fine for anything non-trivial.

## Steps

1. **Check what has changed** since the last release tag:

```powershell
git log --oneline $(git describe --tags --abbrev=0)..HEAD
git diff $(git describe --tags --abbrev=0)..HEAD --stat
```

2. **Decide the version bump** (patch vs minor) based on the changes above.

3. **Bump `version` in `package.json`** - edit the field directly.

4. **Commit and tag** (PowerShell - no heredoc, no `&&`):

```powershell
git add package.json; git commit -m "Release vX.Y.Z."
git tag vX.Y.Z
git push origin main --tags
```

5. **Confirm** the tag appears in the push output. CI publishes to npm automatically via OIDC trusted publisher - do NOT run `npm publish` manually.

6. **Watch the CI run to completion** - open the Actions tab and wait for the publish workflow triggered by the tag to finish. Check it succeeded and the new version appears on npm. Alert the user if it fails.

## Rules

- Never use `&&` to chain git commands in PowerShell - use `;` instead
- Never skip hooks (`--no-verify`)
- Never force-push main
- The commit message must be exactly `Release vX.Y.Z.` (trailing period)
- If the working tree is dirty, commit or stash changes first before bumping
