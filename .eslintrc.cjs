/** @type {import('eslint').Linter.BaseConfig} */
const config = {
  extends: ['@verkstedt/verkstedt/vanilla'],
  ignorePatterns: ['node_modules', 'dist'],
  parserOptions: {
    ecmaVersion: 2024,
  },
  rules: {
    // TODO Disabled rules to get original code to pass. Enable them back and fix the code.
    'no-console': 'off',
    'consistent-return': 'off',
    'no-return-await': 'off',
    'no-use-before-define': 'off',
    'complexity': 'off',
    'no-useless-escape': 'off',
    'no-restricted-syntax': 'off',
    'no-nested-ternary': 'off',
  },
}

module.exports = config
