import fs from 'fs';

const src = fs.readFileSync(process.argv[2], 'utf8');

let i = 0;
let line = 1;
const stack = [];
let state = 'code'; // code | line | block | sq | dq | tpl

function report(ch, depth) {
  if ('{}()[]'.includes(ch)) {
    if ('{(['.includes(ch)) {
      stack.push({ ch, line });
    } else {
      const open = stack.pop();
      const match = { '}': '{', ')': '(', ']': '[' }[ch];
      if (!open || open.ch !== match) {
        console.log(`UNBALANCED at line ${line}: saw '${ch}', expected close for '${open ? open.ch : 'nothing'}' (opened line ${open ? open.line : '-'})`);
      }
    }
  }
}

for (i = 0; i < src.length; i++) {
  const c = src[i];
  const n = src[i + 1];
  if (c === '\n') line++;
  if (state === 'code') {
    if (c === '/' && n === '/') { state = 'line'; i++; continue; }
    if (c === '/' && n === '*') { state = 'block'; i++; continue; }
    if (c === '"') { state = 'dq'; continue; }
    if (c === "'") { state = 'sq'; continue; }
    if (c === '`') { state = 'tpl'; continue; }
    report(c);
  } else if (state === 'line') {
    if (c === '\n') state = 'code';
  } else if (state === 'block') {
    if (c === '*' && n === '/') { state = 'code'; i++; }
  } else if (state === 'dq') {
    if (c === '\\') { i++; } else if (c === '"') state = 'code';
  } else if (state === 'sq') {
    if (c === '\\') { i++; } else if (c === "'") state = 'code';
  } else if (state === 'tpl') {
    if (c === '\\') { i++; } else if (c === '`') state = 'code';
  }
}

console.log(`Remaining open at EOF: ${stack.map((s) => `${s.ch}@${s.line}`).join(', ') || 'none'}`);
