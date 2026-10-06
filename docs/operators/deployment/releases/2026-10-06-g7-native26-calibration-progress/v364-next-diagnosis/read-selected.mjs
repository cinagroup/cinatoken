import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
const args = process.argv.slice(2);
const digest = data => createHash('sha256').update(data).digest('hex');
if (args[0] === '--files') {
  const files = [];
  for (const dir of args.slice(1)) for (const item of fs.readdirSync(dir, { withFileTypes: true })) if (item.isFile() && (/v364/u.test(dir) || /v364/u.test(item.name))) files.push(path.join(dir, item.name));
  process.stdout.write(files.sort().join('\n') + '\n');
} else {
  for (const arg of args) {
    const [file, fromText, toText] = arg.split('::');
    const stat = fs.lstatSync(file); assert.ok(stat.isFile() && !stat.isSymbolicLink());
    const bytes = fs.readFileSync(file), text = bytes.toString('utf8'), lines = text.split(/\r?\n/u);
    assert.deepEqual(fs.readFileSync(file), bytes);
    process.stdout.write(JSON.stringify({ file, bytes: bytes.length, sha256: digest(bytes) }) + '\n');
    const from = fromText ? Number(fromText) : 1, to = toText ? Number(toText) : lines.length;
    for (let i = from; i <= Math.min(to, lines.length); i++) process.stdout.write(`${i}: ${lines[i - 1]}\n`);
  }
}
