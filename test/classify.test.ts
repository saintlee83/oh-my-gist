import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aiAgent, aiCoauthor, classifyPath, commitKind, DOCS_DATA, isCodeLanguage, SKIPPED } from '../src/github/classify.ts';
import { summarizeFiles } from '../src/github/churn.ts';

test('source files map to Linguist language names', () => {
  assert.equal(classifyPath('src/app.tsx'), 'TypeScript');
  assert.equal(classifyPath('lib/util.py'), 'Python');
  assert.equal(classifyPath('native/main.rs'), 'Rust');
  assert.equal(classifyPath('notebooks/eda.ipynb'), 'Jupyter Notebook');
  assert.equal(classifyPath('Dockerfile'), 'Dockerfile');
  assert.equal(classifyPath('docker/Dockerfile.prod'), 'Dockerfile');
  assert.equal(classifyPath('Makefile'), 'Makefile');
});

test('prose and config count as docs, not code', () => {
  assert.equal(classifyPath('README.md'), DOCS_DATA);
  assert.equal(classifyPath('config/settings.yaml'), DOCS_DATA);
  assert.equal(classifyPath('package.json'), DOCS_DATA);
  assert.equal(classifyPath('.gitignore'), DOCS_DATA);
});

test('generated, vendored and binary files are skipped', () => {
  for (const path of [
    'node_modules/react/index.js',
    'vendor/lib/thing.go',
    'dist/bundle.js',
    'web/.next/server/app.js',
    'pnpm-lock.yaml',
    'Cargo.lock',
    'go.sum',
    'public/app.min.js',
    'types/index.d.ts',
    'api/service.pb.go',
    'assets/logo.png',
    'LICENSE',
  ]) {
    assert.equal(classifyPath(path), SKIPPED, path);
  }
});

test('a single huge file diff is treated as generated', () => {
  const summary = summarizeFiles(
    [
      { filename: 'src/a.ts', additions: 10, deletions: 2 },
      { filename: 'src/b.ts', additions: 3, deletions: 1 },
      { filename: 'src/huge.ts', additions: 9000, deletions: 0 },
    ],
    5000,
  );
  assert.deepEqual(summary.TypeScript, [13, 3]);
  assert.deepEqual(summary[SKIPPED], [9000, 0]);
});

test('AI co-authors match product identities', () => {
  assert.equal(aiCoauthor('Claude Opus 5.5', 'noreply@anthropic.com'), 'Claude');
  assert.equal(aiCoauthor('Claude', 'noreply@anthropic.com'), 'Claude');
  assert.equal(aiCoauthor('Claude Code', ''), 'Claude');
  assert.equal(aiCoauthor('Copilot', '175728472+Copilot@users.noreply.github.com'), 'Copilot');
  assert.equal(aiCoauthor('Cursor Agent', 'cursoragent@cursor.com'), 'Cursor');
  assert.equal(aiCoauthor('Codex', 'codex@openai.com'), 'Codex');
});

test('people who share a name with an AI product stay people', () => {
  assert.equal(aiCoauthor('Claude Dupont', 'claude@dupont.fr'), null);
  assert.equal(aiCoauthor('Claude', 'claude@example.com'), null);
  assert.equal(aiCoauthor('Devin Smith', 'devin@example.com'), null);
  assert.equal(aiCoauthor('Jules Verne', 'jules@example.com'), null);
});

test('AI credit reads trailers and footers, not ordinary prose', () => {
  assert.equal(aiAgent('fix: thing\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'), 'Claude');
  assert.equal(aiAgent('feat: x\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)'), 'Claude');
  assert.equal(aiAgent('docs: compare Claude and Copilot pricing'), null);
  assert.equal(aiAgent('fix: thing\n\nCo-authored-by: Claude Dupont <claude@dupont.fr>'), null);
});

test('conventional commit types are recognized', () => {
  assert.equal(commitKind('feat(api): add route'), 'feat');
  assert.equal(commitKind('fix!: breaking'), 'fix');
  assert.equal(commitKind('Update readme'), null);
  assert.equal(commitKind('note: not a known type'), null);
});

test('gist languages exclude prose and data', () => {
  assert.equal(isCodeLanguage('TypeScript'), true);
  assert.equal(isCodeLanguage('Markdown'), false);
  assert.equal(isCodeLanguage('Text'), false);
  assert.equal(isCodeLanguage('JSON'), false);
});
