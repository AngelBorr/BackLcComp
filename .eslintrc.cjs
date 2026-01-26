module.exports = {
  env: {
    node: true,
    es2022: true
  },
  extends: ['eslint:recommended'],
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module'
  },
  overrides: [
    {
      files: ['test/**/*.js', '**/*.test.js'],
      env: {
        mocha: true
      }
    }
  ]
}
