const esbuild = require('esbuild');

const watch = process.argv.includes('--watch');

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

async function main() {
  if (watch) {
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
