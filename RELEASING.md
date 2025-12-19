# Releasing

This repo is a single npm package.

## Checklist

1) Update version

- Bump `version` in `package.json`
- Add a section to `CHANGELOG.md`

2) Verify

```bash
cd mcp-router
npm ci
npm test
```

3) Tag

```bash
git tag vX.Y.Z
git push origin vX.Y.Z
```

4) Publish to npm

```bash
npm publish --access public
```

Notes:

- `prepack` runs `npm run build`, so the published package includes `dist/`.

