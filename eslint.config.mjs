import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: ['lib/engine/**/*.ts'],
    rules: {
      // NFR-11: no `any` in the engine.
      '@typescript-eslint/no-explicit-any': 'error',
      // NFR-13: the engine must stay free of React / Supabase / browser APIs.
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['react', 'react-dom', 'react/*'], message: 'Engine must not import React (NFR-13).' },
            { group: ['@supabase/*'], message: 'Engine must not import Supabase (NFR-13).' },
            { group: ['@/lib/realtime/*', '@/lib/client/*', '@/components/*'], message: 'Engine must stay pure.' },
          ],
        },
      ],
    },
  },
  globalIgnores([
    '.next/**',
    'out/**',
    'build/**',
    'next-env.d.ts',
    'test-results/**',
    'playwright-report/**',
    'lib/words/answers.ts',
    'lib/words/valid.ts',
  ]),
]);

export default eslintConfig;
