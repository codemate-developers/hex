# Hex vendor binaries

The fork's **Toolbox helper** GitHub Actions workflow builds Hex itself and the
TypeScript SDK from one selected commit. It does not build Toolbox. Linux and
Windows reuse `build-desktop.yml`; macOS uses native GitHub-hosted ARM64 and
Intel runners with Xcode and Metal. No signing credentials are needed.

Run it in `codemate-developers/hex` from the Actions page, or after the workflow
has landed on `dev`:

```sh
gh workflow run toolbox-helper.yml --repo codemate-developers/hex \
  --ref dev -f ref=toolbox/embedded-streams
```

`--ref` selects the workflow revision; the `ref` input selects the source branch,
tag, or full commit to compile. Leave the input empty to build the workflow's
own commit. Use a full commit for a reproducible vendor pin.

Download the `toolbox-<12-character-sha>-vendor-bundle` artifact from the run.
It is kept for seven days and contains:

```text
hex-linux-x64
hex-linux-arm64
hex-win32-x64.exe
hex-win32-arm64.exe
hex-darwin-x64
hex-darwin-arm64
hex-sdk.tar.gz
LICENSE
THIRD_PARTY_NOTICES.md
toolbox-manifest.json
SHA256SUMS
```

The manifest records the source commit, Hex and SDK versions, and each file's
SHA-256. The SDK archive contains the compiled JavaScript and declarations at
its root, plus an ESM `package.json`; it is shared across all six targets. Pass
the matching native executable explicitly to the SDK's `create({ command })`.
The binaries are test builds with self-updates disabled, so the host owns
their updates.

The workflow verifies every input artifact's checksum manifest, checks the
Linux x64 binary's runtime libraries and startup on Debian 12, and checks both
Mac binaries' architecture, ad-hoc signature, startup, authenticated SDK
handshake, and shutdown after closing the parent pipe. The SDK runs its
typecheck, tests, and build. These checks do not record audio, run inference,
or prove desktop permissions, HUD behavior, or focused-field paste. Intel Mac
inference and desktop behavior still require hardware verification.

The Mac binaries target macOS 15 or later and are ad-hoc signed, **not Developer
ID signed or notarized**. The consuming application's distribution process must
sign its embedded executables and notarize the final app. The bundle contains
the six Hex executables, not app installers or optional capture helpers and
virtual microphone drivers. Linux runtime libraries and desktop permissions
remain host prerequisites.

To publish the same bundle as a `toolbox-<sha>` GitHub prerelease, enable the
manual `publish` input. Pushing a matching `toolbox-<12-character-sha>` tag also
publishes, using the workflow stored at that tagged commit; that commit must
contain the six-target workflow. Prereleases never replace GitHub's Latest
release. Published files must not be overwritten with different bytes.
