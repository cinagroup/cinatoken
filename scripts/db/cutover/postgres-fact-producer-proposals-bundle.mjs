import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const intentUrl = new URL('../../../packages/core/migrations-proposals/postgres/dispatch-intent-producer-definer.sql', import.meta.url);
const outboxUrl = new URL('../../../packages/core/migrations-proposals/postgres/settlement-outbox-producer-definer.sql', import.meta.url);

// Inspect only top-level commands. The proposals contain PL/pgSQL BEGIN/END
// inside dollar-quoted function bodies, which must not count as transaction SQL.
function topLevelStatements(body) {
  const statements = [];
  let current = '';
  let index = 0;
  while (index < body.length) {
    const character = body[index];
    const next = body[index + 1];
    if (character === '-' && next === '-') {
      const end = body.indexOf('\n', index + 2);
      index = end < 0 ? body.length : end;
      current += ' ';
      continue;
    }
    if (character === '/' && next === '*') {
      let depth = 1;
      index += 2;
      while (index < body.length && depth > 0) {
        if (body[index] === '/' && body[index + 1] === '*') {
          depth += 1;
          index += 2;
        } else if (body[index] === '*' && body[index + 1] === '/') {
          depth -= 1;
          index += 2;
        } else {
          index += 1;
        }
      }
      if (depth !== 0) throw new TypeError('An unterminated SQL block comment is unsafe');
      current += ' ';
      continue;
    }
    if (character === "'" || character === '"') {
      const delimiter = character;
      const escapeString = delimiter === "'" && /(?:^|[^\w])E$/iu.test(current);
      index += 1;
      let closed = false;
      while (index < body.length) {
        if (escapeString && body[index] === '\\') {
          index += 2;
        } else if (body[index] === delimiter && body[index + 1] === delimiter) {
          index += 2;
        } else if (body[index] === delimiter) {
          index += 1;
          closed = true;
          break;
        } else {
          index += 1;
        }
      }
      if (!closed) throw new TypeError('An unterminated SQL quote is unsafe');
      current += ' ';
      continue;
    }
    if (character === '$') {
      const match = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/u.exec(body.slice(index));
      if (match) {
        const delimiter = match[0];
        const end = body.indexOf(delimiter, index + delimiter.length);
        if (end < 0) throw new TypeError('An unterminated SQL dollar quote is unsafe');
        index = end + delimiter.length;
        current += ' ';
        continue;
      }
    }
    if (character === ';') {
      if (!current.trim()) throw new TypeError('An empty SQL statement is unsafe');
      statements.push(current.trim());
      current = '';
    } else {
      current += character;
    }
    index += 1;
  }
  if (current.trim()) throw new TypeError('Each proposal body must end with a SQL statement delimiter');
  return statements;
}

function assertSafeBody(body, name) {
  if (typeof body !== 'string' || body.trim().length === 0) {
    throw new TypeError(`A nonempty ${name} proposal body is required`);
  }
  const statements = topLevelStatements(body);
  if (statements.length === 0) {
    throw new TypeError(`A nonempty ${name} proposal body is required`);
  }
  if (statements.some(statement => /^(?:BEGIN|START\s+TRANSACTION|COMMIT|ROLLBACK|ABORT|END|SAVEPOINT|RELEASE|PREPARE\s+TRANSACTION)\b/iu.test(statement))) {
    throw new TypeError(`${name} proposal body must not contain transaction delimiters`);
  }
}

/** Render only. This module never opens a database connection or executes SQL. */
export function buildFactProducerProposalsBundle(
  intentBody = readFileSync(intentUrl, 'utf8'),
  outboxBody = readFileSync(outboxUrl, 'utf8'),
) {
  assertSafeBody(intentBody, 'dispatch intent');
  assertSafeBody(outboxBody, 'settlement outbox');
  return `BEGIN;\nSET LOCAL cinatoken.dispatch_intent_definer_activation = 'reviewed-v1';\nSET LOCAL cinatoken.settlement_outbox_definer_activation = 'reviewed-v1';\n${intentBody.trimEnd()}\n${outboxBody.trimEnd()}\nCOMMIT;\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 2) {
    throw new TypeError('This command only prints a SQL bundle and accepts no options');
  }
  process.stdout.write(buildFactProducerProposalsBundle());
}
