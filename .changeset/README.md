# Changesets

This folder is managed by [changesets](https://github.com/changesets/changesets).

Every user-visible change lands with a changeset:

```sh
bunx changeset          # pick packages + bump type, write a summary
bunx changeset version  # (release) apply bumps and update CHANGELOGs
```

Use Conventional Commit wording in summaries. Internal refactors with no user impact do not need a changeset.
