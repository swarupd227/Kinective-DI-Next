// FE-DS-001: components use semantic tokens only. Raw colours, font sizes and spacing are rejected.
export default {
  extends: ['stylelint-config-standard'],
  ignoreFiles: ['**/generated/**', '**/dist/**', '**/node_modules/**'],
  rules: {
    'color-no-hex': true,
    'color-named': 'never',
    'function-disallowed-list': ['rgb', 'rgba', 'hsl', 'hsla'],
    'declaration-property-unit-allowed-list': {
      'font-size': [],
      'line-height': [],
      '/^(padding|margin|gap|row-gap|column-gap)/': [],
    },
    'selector-class-pattern': null,
    'custom-property-pattern': null,
    'keyframes-name-pattern': null,
    // State selectors (:hover, :disabled) read best grouped by component, not by specificity.
    'no-descending-specificity': null,
    'selector-pseudo-class-no-unknown': [true, { ignorePseudoClasses: ['global'] }],
    'import-notation': 'string',
  },
};
