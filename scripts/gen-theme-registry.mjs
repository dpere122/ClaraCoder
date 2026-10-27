#!/usr/bin/env node
/**
 * Theme group registry codegen.
 *
 * Scans renderer templates for `data-theme-group="<category>.<name>"` (HTML attributes and
 * `@Component({ host: { 'data-theme-group': '…' } })` bindings), infers everything about
 * each group, merges optional `*.theme.json` manifests, and writes:
 *
 *   src/shared/theme/theme-registry.generated.ts   (typed registry for main + renderer)
 *   python/clara_coder_backend/theme/registry.json (groups + token catalog for the agent tool)
 *
 * Inference per group:
 *   id                  the attribute value
 *   category            first id segment; label from a manifest `categories` map, else humanized
 *   label               manifest `groups[id].label`, else humanized last segment
 *   selector            `[data-theme-group="<id>"]`
 *   component           renderer-relative folder of the file that declares the attribute
 *   tokens              `var(--t-…)` names found in that folder's *.css and inline `styles`
 *                       (+ manifest `styleSources` folders/files, + manifest `tokens`)
 *   supportsBackground  manifest `groups[id].supportsBackground === true`
 *   classes             (registry.json only) class names in the group's markup and the
 *                       templates of child components it renders, for agent-authored CSS
 *
 * Attribute forms recognised:
 *   data-theme-group="chat.transcript"                         (template attribute)
 *   [attr.data-theme-group]="cond ? 'chat.a' : 'chat.b'"       (binding; every quoted id counts)
 *   host: { 'data-theme-group': 'chat.transcript' }            (component host binding)
 *
 * Manifest (`<anything>.theme.json`, any scanned folder):
 *   {
 *     "categories": { "chat": "Chat" },
 *     "groups": {
 *       "chat.transcript": {
 *         "label": "Transcript",
 *         "description": "…",
 *         "supportsBackground": true,
 *         "backgroundClear": [".chat-box"],
 *         "tokens": ["--t-chat-bg"],
 *         "styleSources": ["features/chat/chat-box", "features/chat/hitl-btn-shared.css"]
 *       }
 *     }
 *   }
 *
 * Usage: node scripts/gen-theme-registry.mjs [--check]
 *   --check  exit 1 (without writing) when committed outputs are stale.
 */
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');
const rendererAppRoot = path.join(projectRoot, 'src', 'renderer', 'src', 'app');
const tokensSource = path.join(projectRoot, 'src', 'shared', 'theme', 'theme-tokens.ts');
const tsOutput = path.join(projectRoot, 'src', 'shared', 'theme', 'theme-registry.generated.ts');
const jsonOutput = path.join(projectRoot, 'python', 'clara_coder_backend', 'theme', 'registry.json');

const SCAN_ROOTS = ['features', 'shared'];
const GROUP_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const ATTR_PATTERNS = [
  /(?<![\[.\w])data-theme-group\s*=\s*"([^"]+)"/g,
  /(?<![\[.\w])data-theme-group\s*=\s*'([^']+)'/g,
  /['"]data-theme-group['"]\s*:\s*['"]([^'"]+)['"]/g,
];
/** `[attr.data-theme-group]="…"` — every `'<cat>.<name>'` literal inside the expression counts. */
const ATTR_BINDING_PATTERNS = [
  /\[attr\.data-theme-group\]\s*=\s*"([^"]*)"/g,
  /\[attr\.data-theme-group\]\s*=\s*'([^']*)'/g,
];
const BOUND_ID_LITERAL = /['"]([a-z][a-z0-9-]*\.[a-z][a-z0-9-]*)['"]/g;
const TOKEN_USE = /var\(\s*(--t-[a-z0-9-]+)/g;
/** Index of the host-binding form in ATTR_PATTERNS (the group root is the whole component). */
const HOST_ATTR_PATTERN = 2;
/** Agent catalog: at most this many class names per group (own subtree first). */
const MAX_GROUP_CLASSES = 200;
const TEMPLATE_TAG = /<(\/?)([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const CLASS_NAME = /^-?[A-Za-z_][\w-]*$/;
const CLASS_ATTR = /(?:^|\s)class\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const CLASS_BINDING = /\[class\.(-?[A-Za-z_][\w-]*)\]/g;
const CLASS_EXPRESSION = /\[(?:ngClass|class)\]\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const QUOTED_LITERAL = /['"]([^'"]+)['"]/g;
/** Set inline from user font preferences, not by themes (see THEME_RUNTIME_ONLY_PROPERTIES). */
const RUNTIME_ONLY_TOKENS = new Set(['--t-font-ui-override', '--t-font-code-override']);

function humanize(segment) {
  const words = segment.split('-').filter(Boolean);
  if (words.length === 0) return segment;
  return words.map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(' ');
}

async function walk(dir, out = []) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, out);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function toPosix(p) {
  return p.split(path.sep).join('/');
}

function isTemplateSource(file) {
  if (file.endsWith('.spec.ts')) return false;
  return file.endsWith('.html') || file.endsWith('.ts');
}

function collectMatches(text, regex) {
  const out = [];
  regex.lastIndex = 0;
  let m;
  while ((m = regex.exec(text)) !== null) {
    out.push(m[1]);
  }
  return out;
}

function collectMatchesWithIndex(text, regex) {
  const out = [];
  regex.lastIndex = 0;
  let m;
  while ((m = regex.exec(text)) !== null) {
    out.push({ value: m[1], index: m.index });
  }
  return out;
}

/** Tags of an Angular template (`{ name, attrs, close, selfClosing }`), comments removed. */
function templateTags(text, from = 0) {
  const tags = [];
  const src = text.replace(/<!--[\s\S]*?-->/g, (c) => ' '.repeat(c.length));
  TEMPLATE_TAG.lastIndex = from;
  let m;
  while ((m = TEMPLATE_TAG.exec(src)) !== null) {
    tags.push({ name: m[2].toLowerCase(), attrs: m[3], close: m[1] === '/', selfClosing: m[4] === '/' });
  }
  return tags;
}

/** Tags of the element whose opening tag contains `attrIndex`, through its closing tag. */
function elementSubtree(text, attrIndex) {
  const start = text.lastIndexOf('<', attrIndex);
  if (start < 0) return [];
  const out = [];
  let depth = 0;
  for (const tag of templateTags(text, start)) {
    out.push(tag);
    const opens = !tag.close && !tag.selfClosing && !VOID_TAGS.has(tag.name);
    if (opens) depth++;
    else if (tag.close) depth--;
    if (depth <= 0) break;
  }
  return out;
}

/** Class names an element can carry: `class="…"`, `[class.x]`, literals in `[ngClass]` / `[class]`. */
function classesOfTag(attrs) {
  const out = [];
  for (const m of attrs.matchAll(CLASS_ATTR)) {
    out.push(...(m[1] ?? m[2]).split(/\s+/));
  }
  for (const m of attrs.matchAll(CLASS_BINDING)) out.push(m[1]);
  for (const m of attrs.matchAll(CLASS_EXPRESSION)) {
    for (const lit of (m[1] ?? m[2]).matchAll(QUOTED_LITERAL)) out.push(...lit[1].split(/\s+/));
  }
  // `'plan--' + state` leaves a `plan--` fragment; it is not a class anything carries.
  return out.filter((c) => CLASS_NAME.test(c) && !c.endsWith('-'));
}

/**
 * Class names inside a group, breadth first: the group's own markup, then the templates of
 * child components it renders (by element selector), until `MAX_GROUP_CLASSES`.
 */
function groupClasses(roots, componentTemplates) {
  const classes = [];
  const queue = [...roots];
  const visited = new Set();
  while (queue.length > 0 && classes.length < MAX_GROUP_CLASSES) {
    const tags = queue.shift();
    for (const tag of tags) {
      if (tag.close) continue;
      for (const cls of classesOfTag(tag.attrs)) {
        if (!classes.includes(cls)) classes.push(cls);
      }
      const child = componentTemplates.get(tag.name);
      if (child !== undefined && !visited.has(tag.name)) {
        visited.add(tag.name);
        queue.push(templateTags(child));
      }
    }
  }
  return classes.slice(0, MAX_GROUP_CLASSES);
}

/** Template of the component defined in `tsFile` (`templateUrl` or inline `template`), or null. */
async function componentTemplate(tsFile, text) {
  const url = /\btemplateUrl:\s*['"]([^'"]+)['"]/.exec(text);
  if (url) {
    try {
      return await fs.readFile(path.join(path.dirname(tsFile), url[1]), 'utf8');
    } catch {
      return null;
    }
  }
  const inline = /\btemplate:\s*`([\s\S]*?)`/.exec(text);
  return inline ? inline[1] : null;
}

/** Extract the token catalog from `theme-tokens.ts` (`T('--t-x', 'Label', 'category'[, 'kind'])`). */
async function readTokenCatalog() {
  const src = await fs.readFile(tokensSource, 'utf8');
  const re = /T\(\s*'(--t-[a-z0-9-]+)',\s*'([^']*)',\s*'([a-z]+)'(?:,\s*'([a-z]+)')?(?:,\s*\{([^}]*)\})?/g;
  const tokens = [];
  let m;
  while ((m = re.exec(src)) !== null) {
    const token = { name: m[1], label: m[2], category: m[3], kind: m[4] ?? 'color' };
    if (m[5] && /alias:\s*true/.test(m[5])) token.alias = true;
    tokens.push(token);
  }
  if (tokens.length === 0) {
    throw new Error(`No tokens parsed from ${toPosix(path.relative(projectRoot, tokensSource))}`);
  }
  return tokens;
}

async function buildRegistry() {
  const files = [];
  for (const root of SCAN_ROOTS) {
    const dir = path.join(rendererAppRoot, root);
    try {
      await walk(dir, files);
    } catch (err) {
      if (err && err.code === 'ENOENT') continue;
      throw err;
    }
  }

  /** folder → { css: string[] (file contents), inlineTs: string[] } */
  const folderStyles = new Map();
  const manifests = [];
  const declarations = []; // { id, file, folder, index, host }
  /** file → text of every scanned template source (group subtrees are cut from it). */
  const declaringText = new Map();
  /** element selector → template text (agent catalog class names). */
  const componentTemplates = new Map();
  /** file → template text of the component it defines (for host-bound groups). */
  const templateOfFile = new Map();

  for (const file of files) {
    const folder = path.dirname(file);
    if (!folderStyles.has(folder)) {
      folderStyles.set(folder, []);
    }
    if (file.endsWith('.theme.json')) {
      const raw = JSON.parse(await fs.readFile(file, 'utf8'));
      manifests.push({ file, data: raw });
      continue;
    }
    if (file.endsWith('.css')) {
      folderStyles.get(folder).push(await fs.readFile(file, 'utf8'));
      continue;
    }
    if (!isTemplateSource(file)) continue;
    const text = await fs.readFile(file, 'utf8');
    if (file.endsWith('.ts')) {
      // Inline `styles:` blocks consume tokens too.
      folderStyles.get(folder).push(text);
      const template = await componentTemplate(file, text);
      if (template !== null) {
        templateOfFile.set(file, template);
        const selector = /\bselector:\s*['"]([a-z][\w-]*)['"]/.exec(text);
        if (selector) componentTemplates.set(selector[1], template);
      }
    }
    declaringText.set(file, text);
    for (const [p, pattern] of ATTR_PATTERNS.entries()) {
      for (const { value: id, index } of collectMatchesWithIndex(text, pattern)) {
        // Skip code that builds selectors dynamically (`[data-theme-group="${id}"]`).
        if (id.includes('$') || id.includes('{')) continue;
        declarations.push({ id, file, folder, index, host: p === HOST_ATTR_PATTERN });
      }
    }
    for (const pattern of ATTR_BINDING_PATTERNS) {
      for (const { value: expression, index } of collectMatchesWithIndex(text, pattern)) {
        for (const id of collectMatches(expression, BOUND_ID_LITERAL)) {
          declarations.push({ id, file, folder, index, host: false });
        }
      }
    }
  }

  /** Token names used anywhere under a renderer-app-relative file or folder. */
  const styleSourceCache = new Map();
  async function tokensFromStyleSource(relPath) {
    if (styleSourceCache.has(relPath)) return styleSourceCache.get(relPath);
    const abs = path.join(rendererAppRoot, relPath);
    const found = new Set();
    let stat;
    try {
      stat = await fs.stat(abs);
    } catch {
      throw new Error(`styleSources entry "${relPath}" does not exist under src/renderer/src/app`);
    }
    const targets = stat.isDirectory() ? await walk(abs) : [abs];
    for (const file of targets) {
      if (!(file.endsWith('.css') || (file.endsWith('.ts') && !file.endsWith('.spec.ts')))) continue;
      const text = await fs.readFile(file, 'utf8');
      for (const token of collectMatches(text, TOKEN_USE)) found.add(token);
    }
    styleSourceCache.set(relPath, found);
    return found;
  }

  const errors = [];
  const categoryLabels = new Map();
  const groupManifest = new Map();
  for (const { file, data } of manifests) {
    const rel = toPosix(path.relative(projectRoot, file));
    if (data && typeof data.categories === 'object' && data.categories) {
      for (const [cat, label] of Object.entries(data.categories)) {
        if (typeof label === 'string' && label.trim()) categoryLabels.set(cat, label.trim());
      }
    }
    if (data && typeof data.groups === 'object' && data.groups) {
      for (const [id, entry] of Object.entries(data.groups)) {
        if (!GROUP_ID_PATTERN.test(id)) {
          errors.push(`${rel}: manifest group id "${id}" is not <category>.<name>`);
          continue;
        }
        if (groupManifest.has(id)) {
          errors.push(`${rel}: manifest group "${id}" is declared twice`);
          continue;
        }
        groupManifest.set(id, { entry: entry ?? {}, file: rel });
      }
    }
  }

  /** id → { folders:Set, files:Set, roots: tag lists of the group's own markup } */
  const byId = new Map();
  for (const { id, file, folder, index, host } of declarations) {
    const rel = toPosix(path.relative(projectRoot, file));
    if (!GROUP_ID_PATTERN.test(id)) {
      errors.push(`${rel}: data-theme-group "${id}" is not <category>.<name> (lowercase, hyphens)`);
      continue;
    }
    if (!byId.has(id)) {
      byId.set(id, { folders: new Set(), files: new Set(), roots: [] });
    }
    byId.get(id).folders.add(folder);
    byId.get(id).files.add(rel);
    byId.get(id).roots.push(host ? templateTags(templateOfFile.get(file) ?? '') : elementSubtree(declaringText.get(file), index));
  }

  for (const [id, { file }] of groupManifest) {
    if (!byId.has(id)) {
      errors.push(`${file}: manifest declares "${id}" but no template carries data-theme-group="${id}"`);
    }
  }

  const groups = [];
  for (const [id, info] of byId) {
    const [category, name] = id.split('.');
    const manifest = groupManifest.get(id)?.entry ?? {};
    const tokens = new Set();
    for (const folder of info.folders) {
      for (const text of folderStyles.get(folder) ?? []) {
        for (const token of collectMatches(text, TOKEN_USE)) tokens.add(token);
      }
    }
    if (Array.isArray(manifest.styleSources)) {
      for (const source of manifest.styleSources) {
        if (typeof source !== 'string' || !source.trim()) continue;
        for (const token of await tokensFromStyleSource(source.trim())) tokens.add(token);
      }
    }
    if (Array.isArray(manifest.tokens)) {
      for (const token of manifest.tokens) {
        if (typeof token === 'string' && /^--t-[a-z0-9-]+$/.test(token)) tokens.add(token);
      }
    }
    // Component folder: the shallowest declaring folder (host bindings live with the component).
    const folders = [...info.folders].sort((a, b) => a.length - b.length);
    const component = toPosix(path.relative(path.join(projectRoot, 'src', 'renderer', 'src'), folders[0]));
    const group = {
      id,
      label: typeof manifest.label === 'string' && manifest.label.trim() ? manifest.label.trim() : humanize(name),
      category,
      categoryLabel: categoryLabels.get(category) ?? humanize(category),
      selector: `[data-theme-group="${id}"]`,
      component,
      tokens: [...tokens].filter((t) => !RUNTIME_ONLY_TOKENS.has(t)).sort(),
      supportsBackground: manifest.supportsBackground === true,
    };
    if (typeof manifest.description === 'string' && manifest.description.trim()) {
      group.description = manifest.description.trim();
    }
    if (group.supportsBackground && Array.isArray(manifest.backgroundClear)) {
      const clear = manifest.backgroundClear.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim());
      if (clear.length > 0) group.backgroundClear = clear;
    }
    // Agent catalog only (registry.json; renderTs lists fields explicitly): real class names
    // advanced CSS can target, so models do not invent selectors that match nothing.
    const classes = groupClasses(info.roots, componentTemplates);
    if (classes.length > 0) group.classes = classes;
    groups.push(group);
  }

  groups.sort((a, b) => (a.category === b.category ? a.id.localeCompare(b.id) : a.category.localeCompare(b.category)));

  const categories = [];
  const seenCategories = new Set();
  for (const g of groups) {
    if (seenCategories.has(g.category)) continue;
    seenCategories.add(g.category);
    categories.push({ id: g.category, label: g.categoryLabel });
  }

  if (errors.length > 0) {
    throw new Error(`Theme registry generation failed:\n  - ${errors.join('\n  - ')}`);
  }
  return { groups, categories };
}

function renderTs({ groups, categories }) {
  const lines = [];
  lines.push('/* eslint-disable */');
  lines.push('// AUTO-GENERATED by scripts/gen-theme-registry.mjs - do not edit by hand.');
  lines.push('// Re-run `node scripts/gen-theme-registry.mjs` after adding a data-theme-group attribute');
  lines.push('// or a *.theme.json manifest under src/renderer/src/app.');
  lines.push("import type { ThemeGroupCategoryDef, ThemeGroupDef } from './theme-registry-types';");
  lines.push('');
  lines.push('export const THEME_GROUPS: readonly ThemeGroupDef[] = [');
  for (const g of groups) {
    lines.push('  {');
    lines.push(`    id: ${JSON.stringify(g.id)},`);
    lines.push(`    label: ${JSON.stringify(g.label)},`);
    lines.push(`    category: ${JSON.stringify(g.category)},`);
    lines.push(`    categoryLabel: ${JSON.stringify(g.categoryLabel)},`);
    if (g.description) lines.push(`    description: ${JSON.stringify(g.description)},`);
    lines.push(`    selector: ${JSON.stringify(g.selector)},`);
    lines.push(`    component: ${JSON.stringify(g.component)},`);
    lines.push(`    tokens: [${g.tokens.map((t) => JSON.stringify(t)).join(', ')}],`);
    lines.push(`    supportsBackground: ${g.supportsBackground ? 'true' : 'false'},`);
    if (g.backgroundClear) {
      lines.push(`    backgroundClear: [${g.backgroundClear.map((s) => JSON.stringify(s)).join(', ')}],`);
    }
    lines.push('  },');
  }
  lines.push('];');
  lines.push('');
  lines.push('export const THEME_GROUP_CATEGORIES: readonly ThemeGroupCategoryDef[] = [');
  for (const c of categories) {
    lines.push(`  { id: ${JSON.stringify(c.id)}, label: ${JSON.stringify(c.label)} },`);
  }
  lines.push('];');
  lines.push('');
  const idUnion = groups.length > 0 ? groups.map((g) => `  | ${JSON.stringify(g.id)}`).join('\n') : '  | never';
  lines.push('export type ThemeGroupId =');
  lines.push(`${idUnion};`);
  lines.push('');
  lines.push('export const THEME_GROUP_IDS: readonly string[] = THEME_GROUPS.map((g) => g.id);');
  lines.push('');
  lines.push('const GROUP_BY_ID = new Map<string, ThemeGroupDef>();');
  lines.push('for (const g of THEME_GROUPS) {');
  lines.push('  GROUP_BY_ID.set(g.id, g);');
  lines.push('}');
  lines.push('');
  lines.push('export function themeGroupDef(id: string): ThemeGroupDef | undefined {');
  lines.push('  return GROUP_BY_ID.get(id);');
  lines.push('}');
  lines.push('');
  lines.push('export function isThemeGroupId(id: unknown): id is ThemeGroupId {');
  lines.push("  return typeof id === 'string' && GROUP_BY_ID.has(id);");
  lines.push('}');
  lines.push('');
  lines.push('export function themeGroupsInCategory(category: string): ThemeGroupDef[] {');
  lines.push('  return THEME_GROUPS.filter((g) => g.category === category);');
  lines.push('}');
  lines.push('');
  return lines.join('\n');
}

function renderJson({ groups, categories }, tokens) {
  return `${JSON.stringify({ version: 1, categories, groups, tokens }, null, 2)}\n`;
}

async function readIfExists(file) {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
}

async function main() {
  const check = process.argv.includes('--check');
  const registry = await buildRegistry();
  const tokens = await readTokenCatalog();
  const ts = renderTs(registry);
  const json = renderJson(registry, tokens);

  const outputs = [
    { file: tsOutput, content: ts },
    { file: jsonOutput, content: json },
  ];

  if (check) {
    const stale = [];
    for (const { file, content } of outputs) {
      const current = await readIfExists(file);
      if (current === null || current.replace(/\r\n/g, '\n') !== content) {
        stale.push(toPosix(path.relative(projectRoot, file)));
      }
    }
    if (stale.length > 0) {
      console.error(`[gen-theme-registry] stale outputs (run "node scripts/gen-theme-registry.mjs"):\n  - ${stale.join('\n  - ')}`);
      process.exit(1);
    }
    console.log(`[gen-theme-registry] up to date (${registry.groups.length} groups, ${tokens.length} tokens)`);
    return;
  }

  for (const { file, content } of outputs) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const current = await readIfExists(file);
    if (current !== null && current.replace(/\r\n/g, '\n') === content) continue;
    await fs.writeFile(file, content, 'utf8');
    console.log(`[gen-theme-registry] wrote ${toPosix(path.relative(projectRoot, file))}`);
  }
  console.log(`[gen-theme-registry] ${registry.groups.length} groups, ${registry.categories.length} categories, ${tokens.length} tokens`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
