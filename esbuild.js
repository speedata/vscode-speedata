const esbuild = require('esbuild');

const watch = process.argv.includes('--watch');
const tests = process.argv.includes('--tests');

/** @type {import('esbuild').BuildOptions} */
const clientOptions = {
  entryPoints: ['./src/client/extension.ts'],
  bundle: true,
  outfile: './dist/client/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: true,
};

/** @type {import('esbuild').BuildOptions} */
const serverOptions = {
  entryPoints: ['./src/server/server.ts'],
  bundle: true,
  outfile: './dist/server/server.js',
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: true,
};

// Tests: every test/*.test.ts becomes its own bundle in out/test/, run with
// `node --test` (see the "test" script in package.json).
/** @type {import('esbuild').BuildOptions} */
const testOptions = {
  entryPoints: ['./test/*.test.ts'],
  bundle: true,
  outdir: './out/test',
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: true,
};

async function main() {
  if (tests) {
    await esbuild.build(testOptions);
  } else if (watch) {
    const clientCtx = await esbuild.context(clientOptions);
    const serverCtx = await esbuild.context(serverOptions);
    await clientCtx.watch();
    await serverCtx.watch();
    console.log('Watching for changes...');
  } else {
    await esbuild.build(clientOptions);
    await esbuild.build(serverOptions);
    console.log('Build complete.');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
