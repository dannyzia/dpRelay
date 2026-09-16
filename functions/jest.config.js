module.exports = {
  testEnvironment: 'node',
  testTimeout: 20000,
  setupFilesAfterEnv: ['./test/setup.js'],
  // index.js requires the real service-account JSON at module load; it is a
  // gitignored production credential, so clean checkouts (CI) would fail to
  // even load the module. Map it to a dummy fixture — the suites mock
  // firebase-admin entirely, so the content is never read.
  moduleNameMapper: {
    '^\\./authenticator-15fb7-36cfda9edf3b\\.json$':
      '<rootDir>/test/fixtures/dummy-service-account.json',
  },
  testPathIgnorePatterns: ['/node_modules/', '/coverage/'],
  coverageDirectory: 'coverage',
  collectCoverageFrom: [
    '**/*.js',
    '!node_modules/**',
    '!coverage/**',
    '!jest.config.js',
    '!test/**'
  ],
  coverageThreshold: {
    global: {
      branches: 80,
      functions: 80,
      lines: 80,
      statements: 80
    }
  }
};
