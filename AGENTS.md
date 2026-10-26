# Extension release workflow

For each completed edit batch that changes this extension, automatically increment the patch version. Keep manifest.json, package.json, README.md, and version assertions synchronized. Do not increment separately for intermediate edits within the same batch.

When asked for a Chrome Web Store ZIP, package the updated version with manifest.json at the archive root and verify archive integrity and all manifest resource paths. Commit and push only when the user authorizes it.
