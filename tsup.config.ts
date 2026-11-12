import { defineConfig } from 'tsup'

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/sdk/index.ts',
    'src/auth/index.ts',
    'src/exceptions/index.ts'
  ],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
  target: 'node18',
  outDir: 'dist',
  external: ['undici']
})
