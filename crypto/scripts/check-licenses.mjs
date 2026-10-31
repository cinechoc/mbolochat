#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const crateDir = resolve(here, '..');

// Règle du projet : MIT/Apache/ISC pour les dépendances directes ;
// BSD-3-Clause et Zlib tolérées en transitif ; GPL/LGPL/AGPL toujours refusées.
const DIRECT = new Set(['MIT', 'Apache-2.0', 'ISC']);
const TRANSITIVE = new Set([...DIRECT, 'BSD-3-Clause', 'Zlib']);
const FORBIDDEN = /(A?GPL|LGPL)/i;

// Exceptions documentées, uniquement pour des dépendances de build (non
// embarquées dans l'APK) sous licence permissive hors liste stricte.
const EXCEPTIONS = new Map([
  ['unicode-ident', 'Unicode-3.0 (build-only, proc-macro2, permissive)'],
  ['walkdir', 'Unlicense/MIT (build-only, script de build de jni)'],
  ['same-file', 'Unlicense/MIT (build-only, dépendance de walkdir)'],
]);

function tokenize(expression) {
  const normalized = expression.replace(/\//g, ' OR ');
  const tokens = normalized.replace(/\(/g, ' ( ').replace(/\)/g, ' ) ').split(/\s+/).filter(Boolean);
  return tokens;
}

function evaluate(tokens, allowed) {
  let index = 0;
  function parseOr() {
    let value = parseAnd();
    while (tokens[index] === 'OR') {
      index += 1;
      const right = parseAnd();
      value = value || right;
    }
    return value;
  }
  function parseAnd() {
    let value = parseAtom();
    while (tokens[index] === 'AND') {
      index += 1;
      const right = parseAtom();
      value = value && right;
    }
    return value;
  }
  function parseAtom() {
    const token = tokens[index];
    if (token === '(') {
      index += 1;
      const value = parseOr();
      if (tokens[index] !== ')') throw new Error('parenthèse non fermée');
      index += 1;
      return value;
    }
    index += 1;
    if (!token || token === ')' || token === 'AND' || token === 'OR') {
      throw new Error('expression SPDX invalide');
    }
    return allowed.has(token);
  }
  if (tokens.length === 0) return false;
  const value = parseOr();
  if (index !== tokens.length) throw new Error('expression SPDX invalide');
  return value;
}

const metadata = JSON.parse(
  execFileSync('cargo', ['metadata', '--format-version', '1', '--all-features'], {
    cwd: crateDir,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  }),
);

const root = metadata.packages.find((pkg) => pkg.name === 'mbolo-crypto');
if (!root) {
  console.error('LICENSE FAIL: crate racine introuvable dans cargo metadata');
  process.exit(1);
}
const directNames = new Set(
  root.dependencies.filter((dep) => dep.kind === null || dep.kind === undefined).map((dep) => dep.name),
);

const nodeById = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
const packageById = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]));

const reachable = new Set();
const queue = [root.id];
while (queue.length > 0) {
  const id = queue.pop();
  if (reachable.has(id)) continue;
  reachable.add(id);
  const node = nodeById.get(id);
  for (const dep of node?.deps ?? []) queue.push(dep.pkg);
}

// Graphe réellement compilé pour Android (runtime + build), afin d'ignorer
// les dépendances propres à d'autres cibles (UEFI, Windows, WASI...).
const tree = execFileSync(
  'cargo',
  ['tree', '--target', 'x86_64-linux-android', '--features', 'jni', '-e', 'normal,build', '--prefix', 'none'],
  { cwd: crateDir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
);
const shipped = new Map();
for (const line of tree.split('\n')) {
  const match = line.trim().match(/^([A-Za-z0-9_.-]+) v([^\s]+)/);
  if (match) shipped.set(`${match[1]}@${match[2]}`, match[1]);
}

const rows = [];
const violations = [];
for (const [key, name] of shipped) {
  const [version] = key.slice(name.length + 1).split('@');
  const pkg = metadata.packages.find((item) => item.name === name && item.version === version);
  if (!pkg || pkg.name === 'mbolo-crypto') continue;
  const direct = directNames.has(pkg.name);
  const expression = pkg.license ?? '';
  const forbidden = FORBIDDEN.test(expression);
  let allowed = false;
  let reason = '';
  const exception = EXCEPTIONS.get(pkg.name);
  let appliedException = null;
  try {
    allowed = evaluate(tokenize(expression), direct ? DIRECT : TRANSITIVE);
  } catch (error) {
    reason = `expression illisible (${error.message})`;
  }
  if (!expression) reason = 'licence absente';
  if (forbidden) {
    allowed = false;
    reason = 'licence copyleft (GPL/LGPL/AGPL)';
  }
  if (!allowed && exception) {
    allowed = true;
    appliedException = exception;
    reason = exception;
  }
  if (!allowed) {
    violations.push(`${pkg.name}@${pkg.version} — ${expression || 'aucune'} — ${direct ? 'directe' : 'transitive'}${reason ? ` — ${reason}` : ''}`);
  }
  rows.push({
    name: pkg.name,
    version: pkg.version,
    license: expression || 'UNKNOWN',
    scope: direct ? 'direct' : 'transitive',
    allowed,
    exception: appliedException,
  });
}

rows.sort((a, b) => a.name.localeCompare(b.name));
const markdown = [
  '# Licences des dépendances Rust',
  '',
  'Généré par `crypto/scripts/check-licenses.mjs` à partir de `cargo metadata`.',
  '',
  'Règle : MIT/Apache-2.0/ISC pour les dépendances directes, BSD-3-Clause/Zlib tolérées en transitif, GPL/LGPL/AGPL interdites.',
  '',
  '| Paquet | Version | Portée | Licence | Conforme | Exception |',
  '|---|---|---|---|---|---|',
  ...rows.map(
    (row) =>
      `| ${row.name} | ${row.version} | ${row.scope} | ${row.license.replace(/\|/g, '\\|')} | ${row.allowed ? 'oui' : 'NON'} | ${row.exception ?? ''} |`,
  ),
  '',
  '## Exceptions approuvées',
  '',
  '- `unicode-ident` — `Unicode-3.0` combinée à MIT/Apache-2.0, dépendance de compilation (proc-macro2), approuvée le 2026-10-31. Non embarquée dans l’APK.',
  '',
].join('\n');

writeFileSync(resolve(crateDir, 'THIRD_PARTY_LICENSES.md'), markdown);
writeFileSync(resolve(crateDir, 'licenses-report.json'), JSON.stringify(rows, null, 2) + '\n');

if (violations.length > 0) {
  console.error(`LICENSE FAIL (${violations.length})`);
  for (const violation of violations) console.error(` - ${violation}`);
  process.exit(1);
}
console.log(`LICENSE OK: ${rows.length} dépendances, aucune licence interdite.`);
console.log('Rapports: crypto/THIRD_PARTY_LICENSES.md, crypto/licenses-report.json');
