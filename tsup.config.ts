import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/cli.ts', 'src/demo.ts'],
  format: ['esm'],
  target: 'node20',
  sourcemap: true,
  clean: true,
  dts: false,
  splitting: false,
  shims: false,
});

