# Architecture Compiler

`architecture-sync` is a build-time compiler, not a runtime Task Bus. The
authoritative input is the metadata-bearing v4 drawio source. It produces a
normalized Architecture IR, a semantic hash, configuration candidates and
OpenCode architecture contract blocks.

```text
node --experimental-strip-types tools/architecture-sync/cli.ts check
node --experimental-strip-types tools/architecture-sync/cli.ts diff --format=json
node --experimental-strip-types tools/architecture-sync/cli.ts apply --target=config --yes
```

`check` and `diff` are read-only. `apply` requires `--yes`, stages all outputs
under `runtime/architecture-sync-staging/<run-id>`, keeps backups under
`.backups/architecture-sync/<run-id>`, and preserves manual Agent behavior
bodies. Runtime model IDs come only from `framework-config/runtime-model-map.yaml`;
missing mappings fail with `MODEL_MAPPING_MISSING`.

The compiler deliberately does not hot-reload OpenCode sessions, modify
`AGENTS.md`, touch business repositories, or infer architecture from display
text when required metadata is absent.
