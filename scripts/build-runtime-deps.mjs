import { build } from 'esbuild';
import fs from 'node:fs';
await build({ stdin: { contents: 'export { default as Ajv } from "ajv"; export { default as Ajv2020 } from "ajv/dist/2020.js";', resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', target: 'node18', minify: true, legalComments: 'eof', outfile: 'plugins/droid/scripts/vendor/runtime-deps.mjs' });
fs.writeFileSync('plugins/droid/scripts/vendor/LICENSES.txt', ['ajv/LICENSE', 'fast-deep-equal/LICENSE', 'fast-uri/LICENSE', 'json-schema-traverse/LICENSE', 'require-from-string/license'].map(file => `${file}\n${fs.readFileSync(`node_modules/${file}`, 'utf8')}`).join('\n\n'));
