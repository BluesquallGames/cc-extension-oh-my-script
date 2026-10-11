# Releasing @oms/plugin

Only `@oms/plugin` is published to npm. All other workspace packages are private.

For a plugin API change, run `node --run changeset` and select `@oms/plugin`.
Commit the generated changeset with the implementation. Changesets is currently
in alpha prerelease mode; the initial patch produces `0.0.1-alpha.0` with the
`alpha` npm dist-tag.

After changes reach `main`, `release.yml` opens or updates a version PR. That PR
updates the version, changelog, prerelease state and lockfile. Merging the version
PR publishes any unpublished plugin version and creates its GitHub Release.
The workflow can also be rerun manually on `main`.
For version PRs created by `GITHUB_TOKEN`, a maintainer may need to select
**Approve workflows to run** in the PR before its checks start.

## Initial npm setup

The package must exist on npm before a trusted publisher can be configured.
A maintainer with permission to publish in the `@oms` scope must bootstrap the
first release interactively after the initial version PR is ready:

```sh
pnpm install --frozen-lockfile
node --run build
node --run lint
node --run test
cd packages/plugin
npm publish --access public --tag alpha
```

Use the version PR's `0.0.1-alpha.0` package, not the initial `0.0.0` manifest.
Configure npm trusted publishing for `@oms/plugin` with:

- GitHub organization: `BluesquallGames`
- Repository: `cc-extension-oh-my-script`
- Workflow filename: `release.yml`
- Allowed action: direct `npm publish`
- Environment: leave unset; this workflow does not use a GitHub environment.

Enable GitHub Actions' ability to create pull requests in the repository settings.
The workflow uses `GITHUB_TOKEN` for version PRs and GitHub Releases, and OIDC for
npm publishing. No `NPM_TOKEN` secret is required. Node 24 supplies an npm CLI
that supports trusted publishing; npm requires CLI 11.5.1 or newer.

The bootstrapped version is already published, so Changesets will skip it when
the first version PR is merged. Create the initial GitHub Release manually from
that version PR's changelog, using the tag `@oms/plugin@0.0.1-alpha.0` on its merge
commit. Subsequent releases are published and tagged by the workflow.

See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)
for setup requirements and [Changesets prereleases](https://github.com/changesets/changesets/blob/main/docs/prereleases.md)
for leaving alpha mode when a stable release is ready.
See [GitHub workflow triggers](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow)
for approving checks on PRs created by automation.
