/**
 * Module boundary rules.
 *
 * These are what let `src/core`, `src/db`, and `src/config` be extracted into a
 * separate package later without a rewrite. Violations are build failures, not warnings.
 */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Circular imports make module extraction impossible.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-orphans',
      severity: 'warn',
      from: { orphan: true, pathNot: ['\\.d\\.ts$', '(^|/)index\\.ts$'] },
      to: {},
    },
    {
      name: 'core-is-automation-agnostic',
      severity: 'error',
      comment:
        'src/core is the framework. It must never know about a specific automation, ' +
        'exporter, importer, or the CLI. Breaking this is what turns a platform back into a script.',
      from: { path: '^src/core' },
      to: { path: '^src/(automations|enrichment|exporters|importers|cli|views)' },
    },
    {
      name: 'db-knows-nothing-upstream',
      severity: 'error',
      comment: 'src/db is persistence only. It must not import automations, exporters, or the CLI.',
      from: { path: '^src/db' },
      to: { path: '^src/(automations|enrichment|exporters|importers|cli|views)' },
    },
    {
      name: 'config-is-a-leaf',
      severity: 'error',
      comment:
        'src/config may use only core utilities and the error taxonomy, so that every ' +
        'other layer can import config without creating a cycle.',
      from: { path: '^src/config' },
      to: {
        path: '^src/(core/(?!util|errors)|db|automations|enrichment|exporters|importers|cli|views)',
      },
    },
    {
      name: 'automations-never-touch-the-db',
      severity: 'error',
      comment:
        'Automations yield Emissions; the engine persists them. An automation that imports ' +
        'src/db can no longer be run against a different storage backend.',
      from: { path: '^src/(automations|enrichment)' },
      to: { path: '^src/(db|exporters)' },
    },
    {
      name: 'not-to-dev-dep',
      severity: 'error',
      from: { path: '^src', pathNot: '\\.test\\.ts$' },
      to: { dependencyTypes: ['npm-dev'] },
    },
    {
      name: 'no-deprecated-core',
      severity: 'error',
      from: {},
      to: { dependencyTypes: ['core'], path: '^(punycode|sys|domain|constants)$' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '\\.test\\.ts$' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.js', '.ts'],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
