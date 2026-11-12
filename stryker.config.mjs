// @ts-check
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const config = {
  testRunner: 'vitest',
  vitest: { configFile: 'vitest.config.ts' },
  mutate: [
    'src/**/*.ts',
    '!src/**/*.test.ts',
    '!src/**/index.ts',
    '!src/cache/types.ts'
  ],
  // Logging statements are not behavior; mutating their strings/objects only adds noise
  ignorers: [],
  reporters: ['clear-text', 'progress', 'html', 'json'],
  htmlReporter: { fileName: 'reports/mutation/index.html' },
  jsonReporter: { fileName: 'reports/mutation/mutation.json' },
  coverageAnalysis: 'perTest',
  concurrency: 6,
  timeoutMS: 15000,
  thresholds: { high: 85, low: 70, break: null },
  tempDirName: '.stryker-tmp'
}

export default config
