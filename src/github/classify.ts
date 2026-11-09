/**
 * Maps a changed file path to a language, using the names GitHub Linguist uses
 * so churn lines up with repository language stats.
 */

export const DOCS_DATA = 'Docs & data';
export const SKIPPED = 'Skipped';

const EXTENSIONS: Record<string, string> = {
  ts: 'TypeScript', tsx: 'TypeScript', mts: 'TypeScript', cts: 'TypeScript',
  js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript',
  py: 'Python', pyi: 'Python', pyx: 'Cython', ipynb: 'Jupyter Notebook',
  go: 'Go', rs: 'Rust', c: 'C', h: 'C',
  cc: 'C++', cpp: 'C++', cxx: 'C++', hpp: 'C++', hh: 'C++', hxx: 'C++',
  cs: 'C#', java: 'Java', kt: 'Kotlin', kts: 'Kotlin', scala: 'Scala', groovy: 'Groovy', gradle: 'Gradle',
  swift: 'Swift', m: 'Objective-C', mm: 'Objective-C++', dart: 'Dart',
  rb: 'Ruby', php: 'PHP', lua: 'Lua', pl: 'Perl', pm: 'Perl', r: 'R', jl: 'Julia',
  ex: 'Elixir', exs: 'Elixir', erl: 'Erlang', hrl: 'Erlang', clj: 'Clojure', cljs: 'Clojure',
  hs: 'Haskell', ml: 'OCaml', mli: 'OCaml', fs: 'F#', fsx: 'F#', elm: 'Elm',
  zig: 'Zig', nim: 'Nim', v: 'Verilog', sv: 'SystemVerilog', vhd: 'VHDL', vhdl: 'VHDL',
  sol: 'Solidity', move: 'Move', cairo: 'Cairo', wgsl: 'WGSL', glsl: 'GLSL', hlsl: 'HLSL', metal: 'Metal',
  sh: 'Shell', bash: 'Shell', zsh: 'Shell', fish: 'Fish', ps1: 'PowerShell', bat: 'Batchfile', cmd: 'Batchfile',
  html: 'HTML', htm: 'HTML', css: 'CSS', scss: 'SCSS', sass: 'Sass', less: 'Less', styl: 'Stylus',
  vue: 'Vue', svelte: 'Svelte', astro: 'Astro', ejs: 'EJS', hbs: 'Handlebars', pug: 'Pug', jinja: 'Jinja', j2: 'Jinja',
  sql: 'SQL', graphql: 'GraphQL', gql: 'GraphQL', proto: 'Protocol Buffer', prisma: 'Prisma',
  tf: 'HCL', hcl: 'HCL', nix: 'Nix', cmake: 'CMake', mk: 'Makefile', vim: 'Vim Script',
  tex: 'TeX', asm: 'Assembly', s: 'Assembly', mdc: 'Markdown',
};

const FILENAMES: Record<string, string> = {
  dockerfile: 'Dockerfile',
  containerfile: 'Dockerfile',
  makefile: 'Makefile',
  justfile: 'Just',
  'cmakelists.txt': 'CMake',
  rakefile: 'Ruby',
  gemfile: 'Ruby',
  vagrantfile: 'Ruby',
  brewfile: 'Ruby',
};

const DOCS_AND_DATA = new Set([
  'md', 'mdx', 'markdown', 'rst', 'adoc', 'txt', 'json', 'jsonc', 'json5', 'jsonl', 'ndjson', 'yaml', 'yml',
  'toml', 'ini', 'cfg', 'conf', 'env', 'csv', 'tsv', 'xml', 'svg', 'plist', 'properties', 'lock', 'log',
]);

/** Directories whose contents are not hand-written. Matched as whole path segments. */
const VENDORED = new Set([
  'node_modules', 'vendor', 'vendors', 'third_party', 'thirdparty', 'bower_components', 'site-packages',
  '.venv', 'venv', 'pods', 'carthage', '.yarn', '.pnp', 'jspm_packages',
  'dist', 'build', 'out', 'target', '.next', '.nuxt', '.svelte-kit', '.turbo', '.output', '.cache', '__pycache__',
  'coverage', 'generated', '__generated__', '__snapshots__', 'storybook-static',
]);

const GENERATED_FILES = new Set([
  'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb', 'npm-shrinkwrap.json',
  'cargo.lock', 'poetry.lock', 'uv.lock', 'pipfile.lock', 'gemfile.lock', 'composer.lock',
  'go.sum', 'flake.lock', 'podfile.lock', 'pubspec.lock', 'mix.lock',
]);

const GENERATED_PATTERN =
  /(\.min\.(js|css)|\.bundle\.js|\.map|\.snap|\.pb\.go|_pb2\.py|_pb2_grpc\.py|\.g\.dart|\.freezed\.dart|\.generated\.\w+|\.gen\.\w+|\.d\.ts)$/i;

/**
 * Returns the language a file counts toward, DOCS_DATA for prose and config,
 * SKIPPED for vendored or generated output and binary or unknown types.
 */
export function classifyPath(path: string): string {
  const segments = path.split('/');
  const name = (segments.pop() ?? '').toLowerCase();

  if (segments.some((segment) => VENDORED.has(segment.toLowerCase()))) return SKIPPED;
  if (GENERATED_FILES.has(name) || GENERATED_PATTERN.test(name)) return SKIPPED;

  const byName = FILENAMES[name];
  if (byName) return byName;
  if (name.startsWith('dockerfile.')) return 'Dockerfile';

  const dot = name.lastIndexOf('.');
  if (dot <= 0) return name.startsWith('.') ? DOCS_DATA : SKIPPED;
  const extension = name.slice(dot + 1);

  if (DOCS_AND_DATA.has(extension)) return DOCS_DATA;
  return EXTENSIONS[extension] ?? SKIPPED;
}

/** Languages GitHub may report on gist files that are not really code. */
const NON_CODE_LANGUAGES = new Set([
  'text', 'markdown', 'json', 'json with comments', 'json5', 'yaml', 'toml', 'csv', 'tsv', 'xml', 'svg', 'ini',
  'restructuredtext', 'asciidoc', 'diff', 'ignore list', 'git config', 'git attributes', 'public key',
  'unknown', 'plain text', 'robots.txt', 'editorconfig', 'dotenv',
]);

export function isCodeLanguage(name: string): boolean {
  return !NON_CODE_LANGUAGES.has(name.toLowerCase());
}

const COMMIT_KINDS = new Set(['feat', 'fix', 'chore', 'refactor', 'docs', 'test', 'perf', 'style', 'build', 'ci', 'revert']);

export function commitKind(headline: string): string | null {
  const match = /^([a-z]+)(\([^)]*\))?!?:/i.exec(headline);
  if (!match) return null;
  const kind = match[1].toLowerCase();
  return COMMIT_KINDS.has(kind) ? kind : null;
}

/**
 * Identifies an AI assistant from a co-author identity. Claude and Devin are also
 * people's names, so a name alone only counts with a product word beside it;
 * otherwise the email domain or account has to match.
 */
export function aiCoauthor(name: string, email: string, login: string | null = null): string | null {
  const mail = email.toLowerCase();
  const account = (login ?? '').toLowerCase();
  const person = name.trim();

  if (mail.endsWith('@anthropic.com') || account === 'claude') return 'Claude';
  if (/^claude (code|opus|sonnet|haiku|fable)\b/i.test(person)) return 'Claude';
  if (mail.endsWith('@openai.com') || /^(chatgpt|codex|openai codex)\b/i.test(person) || account === 'codex') return 'Codex';
  if (/copilot/.test(mail) || account === 'copilot' || /^(github )?copilot\b/i.test(person)) return 'Copilot';
  if (/@cursor\.(com|sh)$/.test(mail) || /^cursor( ?agent)?$/i.test(person)) return 'Cursor';
  if (/^gemini\b/i.test(person) || /gemini-code-assist|google-labs-jules/.test(`${mail} ${account}`)) return 'Gemini';
  if (/^aider\b/i.test(person) || mail.startsWith('aider@')) return 'Aider';
  if (/devin-ai-integration/.test(`${mail} ${account} ${person.toLowerCase()}`)) return 'Devin';
  if (/^(windsurf|cascade)\b/i.test(person) || /@(codeium|windsurf)\.com$/.test(mail)) return 'Windsurf';
  return null;
}

const GENERATED_BY: [RegExp, string][] = [
  [/claude/i, 'Claude'],
  [/codex|chatgpt|openai/i, 'Codex'],
  [/copilot/i, 'Copilot'],
  [/cursor/i, 'Cursor'],
  [/gemini/i, 'Gemini'],
  [/aider/i, 'Aider'],
  [/devin/i, 'Devin'],
  [/windsurf|codeium/i, 'Windsurf'],
];

/** Reads AI credit from `Co-authored-by` trailers and "Generated with" footers only, not prose. */
export function aiAgent(message: string): string | null {
  for (const line of message.split('\n')) {
    const trailer = /^\s*co-authored-by:\s*(.*?)\s*<([^>]*)>/i.exec(line);
    if (trailer) {
      const agent = aiCoauthor(trailer[1], trailer[2]);
      if (agent) return agent;
      continue;
    }
    if (!/generated (with|by)\b/i.test(line)) continue;
    for (const [pattern, agent] of GENERATED_BY) {
      if (pattern.test(line)) return agent;
    }
  }
  return null;
}
