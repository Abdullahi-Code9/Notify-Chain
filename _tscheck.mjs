import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const ts = require(path.resolve('listener/node_modules/typescript/lib/typescript.js'));

const file = process.argv[2];
const src = fs.readFileSync(file, 'utf8');
const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

const lineOf = (pos) => sf.getLineAndCharacterOfPosition(pos).line + 1;
const colOf = (pos) => sf.getLineAndCharacterOfPosition(pos).character + 1;

const target = Number(process.argv[3]); // line number of interest
let found = null;

function walk(node) {
  const s = lineOf(node.getStart(sf));
  const e = lineOf(node.getEnd());
  if (s <= target && e >= target) {
    found = node;
  }
  node.forEachChild(walk);
}

walk(sf);
console.log(`Innermost node containing line ${target}: ${ts.SyntaxKind[found.kind]} ${lineOf(found.getStart(sf))}:${colOf(found.getStart(sf))} - ${lineOf(found.getEnd())}:${colOf(found.getEnd())}`);
console.log('text:');
console.log(found.getText(sf).slice(0, 400));

let parent = found.parent;
let depth = 0;
while (parent && depth < 8) {
  console.log(`  ^ parent ${depth}: ${ts.SyntaxKind[parent.kind]} ${lineOf(parent.getStart(sf))}:${colOf(parent.getStart(sf))} - ${lineOf(parent.getEnd())}:${colOf(parent.getEnd())}`);
  parent = parent.parent;
  depth++;
}
