module.exports = {
  extends: ['react-app'],
  rules: {
    // Disable problematic rules that might cause issues
    '@typescript-eslint/no-unused-vars': 'off',
    '@typescript-eslint/no-explicit-any': 'off',
  },
  env: {
    browser: true,
    es6: true,
    node: true,
  },
};
