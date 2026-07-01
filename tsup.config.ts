import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/daemon/startup.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  target: 'node18',
});
