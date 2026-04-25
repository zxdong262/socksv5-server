import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm'],
    dts: true,
    clean: true,
    outDir: 'dist/esm',
    splitting: false,
    sourcemap: true,
    treeshake: true,
    outExtension({ format }) {
      return {
        js: '.js',
      };
    },
  },
  {
    entry: ['src/index.ts'],
    format: ['cjs'],
    dts: false,
    clean: false,
    outDir: 'dist/cjs',
    splitting: false,
    sourcemap: true,
    treeshake: true,
    outExtension({ format }) {
      return {
        js: '.cjs',
      };
    },
  },
]);
