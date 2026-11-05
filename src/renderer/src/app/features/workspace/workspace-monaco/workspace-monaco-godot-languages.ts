import type * as Monaco from 'monaco-editor';

/**
 * Monaco ships no grammar for any Godot format, and it silently opens a model whose language id
 * was never registered as ``plaintext``. So these must be registered before any model is created,
 * or LSP providers for ``gdscript`` never match a ``.gd`` file.
 */

export const GDSCRIPT_LANGUAGE_ID = 'gdscript';
export const GODOT_RESOURCE_LANGUAGE_ID = 'godot-resource';
export const GDSHADER_LANGUAGE_ID = 'gdshader';

/** File extension (no dot, lowercase) to Monaco language id. */
export const GODOT_EXTENSION_TO_LANGUAGE: Readonly<Record<string, string>> = {
  gd: GDSCRIPT_LANGUAGE_ID,
  tscn: GODOT_RESOURCE_LANGUAGE_ID,
  tres: GODOT_RESOURCE_LANGUAGE_ID,
  godot: GODOT_RESOURCE_LANGUAGE_ID,
  gdextension: GODOT_RESOURCE_LANGUAGE_ID,
  import: GODOT_RESOURCE_LANGUAGE_ID,
  gdshader: GDSHADER_LANGUAGE_ID,
  gdshaderinc: GDSHADER_LANGUAGE_ID,
};

const COMMON_BRACKETS: Monaco.languages.CharacterPair[] = [
  ['{', '}'],
  ['[', ']'],
  ['(', ')'],
];

const COMMON_AUTO_CLOSING: Monaco.languages.IAutoClosingPair[] = [
  { open: '{', close: '}' },
  { open: '[', close: ']' },
  { open: '(', close: ')' },
  { open: '"', close: '"' },
  { open: "'", close: "'" },
];

export const GDSCRIPT_MONARCH: Monaco.languages.IMonarchLanguage = {
  defaultToken: '',
  tokenPostfix: '.gd',
  keywords: [
    'if', 'elif', 'else', 'for', 'while', 'match', 'when', 'break', 'continue', 'pass', 'return',
    'class', 'class_name', 'extends', 'is', 'in', 'as', 'not', 'and', 'or', 'self', 'super',
    'signal', 'func', 'static', 'const', 'enum', 'var', 'await', 'breakpoint', 'preload', 'assert',
    'true', 'false', 'null', 'PI', 'TAU', 'INF', 'NAN',
  ],
  typeKeywords: [
    'void', 'bool', 'int', 'float', 'String', 'StringName', 'NodePath', 'Vector2', 'Vector2i',
    'Rect2', 'Rect2i', 'Vector3', 'Vector3i', 'Transform2D', 'Vector4', 'Vector4i', 'Plane',
    'Quaternion', 'AABB', 'Basis', 'Transform3D', 'Projection', 'Color', 'RID', 'Callable',
    'Signal', 'Dictionary', 'Array', 'PackedByteArray', 'PackedInt32Array', 'PackedInt64Array',
    'PackedFloat32Array', 'PackedFloat64Array', 'PackedStringArray', 'PackedVector2Array',
    'PackedVector3Array', 'PackedVector4Array', 'PackedColorArray', 'Variant',
  ],
  tokenizer: {
    root: [
      [/#.*$/, 'comment'],
      [/@[a-zA-Z_]\w*/, 'tag'],
      // Node paths: $Hud/Label, $"Odd name", %Unique.
      [/[$%]"[^"]*"/, 'variable.predefined'],
      [/\$[a-zA-Z_][\w/]*/, 'variable.predefined'],
      [/%[a-zA-Z_]\w*/, 'variable.predefined'],
      // Prefixes: r"" raw, &"" StringName, ^"" NodePath. Before identifiers, or `r` would match as one.
      [/[rR&^]?"""/, { token: 'string', next: '@tripleDouble' }],
      [/[rR&^]?'''/, { token: 'string', next: '@tripleSingle' }],
      [/[rR&^]?"/, { token: 'string', next: '@double' }],
      [/[rR&^]?'/, { token: 'string', next: '@single' }],
      [/[a-zA-Z_]\w*/, { cases: { '@keywords': 'keyword', '@typeKeywords': 'type', '@default': 'identifier' } }],
      [/0[xX][0-9a-fA-F_]+/, 'number.hex'],
      [/0[bB][01_]+/, 'number'],
      [/\d[\d_]*(\.[\d_]*)?([eE][+-]?\d+)?/, 'number'],
      [/[{}()[\]]/, '@brackets'],
      [/->|:=|[=<>!+\-*/%&|^~]+/, 'operator'],
      [/[,.:;]/, 'delimiter'],
    ],
    tripleDouble: [
      [/\\./, 'string.escape'],
      [/"""/, { token: 'string', next: '@pop' }],
      [/./, 'string'],
    ],
    tripleSingle: [
      [/\\./, 'string.escape'],
      [/'''/, { token: 'string', next: '@pop' }],
      [/./, 'string'],
    ],
    double: [
      [/\\./, 'string.escape'],
      [/"/, { token: 'string', next: '@pop' }],
      [/$/, { token: 'string', next: '@pop' }],
      [/[^\\"]+/, 'string'],
    ],
    single: [
      [/\\./, 'string.escape'],
      [/'/, { token: 'string', next: '@pop' }],
      [/$/, { token: 'string', next: '@pop' }],
      [/[^\\']+/, 'string'],
    ],
  },
};

const GDSCRIPT_CONFIGURATION: Monaco.languages.LanguageConfiguration = {
  comments: { lineComment: '#' },
  brackets: COMMON_BRACKETS,
  autoClosingPairs: COMMON_AUTO_CLOSING,
  surroundingPairs: COMMON_AUTO_CLOSING,
  // Blocks are indentation-based, so folding follows indentation until the server sends ranges.
  folding: { offSide: true, markers: { start: /^\s*#region\b/, end: /^\s*#endregion\b/ } },
  wordPattern: /[a-zA-Z_]\w*|-?\d+(\.\d+)?/,
  onEnterRules: [
    {
      beforeText: /:\s*(#.*)?$/,
      // ``IndentAction.Indent``; the enum is a runtime value this type-only import can't reach.
      action: { indentAction: 1 as Monaco.languages.IndentAction },
    },
  ],
};

export const GODOT_RESOURCE_MONARCH: Monaco.languages.IMonarchLanguage = {
  defaultToken: '',
  tokenPostfix: '.godot-resource',
  constants: ['true', 'false', 'null', 'nan', 'inf'],
  tokenizer: {
    root: [
      [/;.*$/, 'comment'],
      // ``^`` is Monarch's "only at line start": a ``[`` elsewhere is an array value.
      [/^\[/, { token: 'delimiter.bracket', next: '@headerName' }],
      // Property names can hold slashes: shader_parameter/speed.
      [/^\s*[a-zA-Z_][\w/.:-]*(?=\s*=)/, 'attribute.name'],
      { include: '@value' },
    ],
    headerName: [
      [/[a-zA-Z_][\w.-]*/, { token: 'tag', switchTo: '@header' }],
      [/\]/, { token: 'delimiter.bracket', next: '@pop' }],
      [/$/, { token: '', next: '@pop' }],
    ],
    header: [
      [/\]/, { token: 'delimiter.bracket', next: '@pop' }],
      [/[a-zA-Z_][\w/.-]*(?=\s*=)/, 'attribute.name'],
      { include: '@value' },
    ],
    value: [
      [/[a-zA-Z_]\w*(?=\()/, 'type'],
      [/[a-zA-Z_]\w*/, { cases: { '@constants': 'keyword', '@default': 'identifier' } }],
      [/-?\d+(\.\d+)?([eE][+-]?\d+)?/, 'number'],
      [/&?"/, { token: 'string', next: '@string' }],
      [/[{}()[\]]/, '@brackets'],
      [/[=,:]/, 'delimiter'],
    ],
    string: [
      [/\\./, 'string.escape'],
      [/"/, { token: 'string', next: '@pop' }],
      [/[^\\"]+/, 'string'],
    ],
  },
};

const GODOT_RESOURCE_CONFIGURATION: Monaco.languages.LanguageConfiguration = {
  comments: { lineComment: ';' },
  brackets: COMMON_BRACKETS,
  autoClosingPairs: COMMON_AUTO_CLOSING,
  surroundingPairs: COMMON_AUTO_CLOSING,
};

export const GDSHADER_MONARCH: Monaco.languages.IMonarchLanguage = {
  defaultToken: '',
  tokenPostfix: '.gdshader',
  keywords: [
    'shader_type', 'render_mode', 'uniform', 'varying', 'const', 'struct', 'if', 'else', 'for',
    'while', 'do', 'switch', 'case', 'default', 'break', 'continue', 'return', 'discard', 'in',
    'out', 'inout', 'global', 'instance', 'group_uniforms', 'true', 'false', 'lowp', 'mediump',
    'highp', 'flat', 'smooth',
  ],
  typeKeywords: [
    'void', 'bool', 'bvec2', 'bvec3', 'bvec4', 'int', 'ivec2', 'ivec3', 'ivec4', 'uint', 'uvec2',
    'uvec3', 'uvec4', 'float', 'vec2', 'vec3', 'vec4', 'mat2', 'mat3', 'mat4', 'sampler2D',
    'isampler2D', 'usampler2D', 'sampler2DArray', 'isampler2DArray', 'usampler2DArray',
    'sampler3D', 'isampler3D', 'usampler3D', 'samplerCube', 'samplerCubeArray',
  ],
  tokenizer: {
    root: [
      [/\/\/.*$/, 'comment'],
      [/\/\*/, { token: 'comment', next: '@comment' }],
      [/#\s*[a-zA-Z_]\w*/, 'tag'],
      // Built-ins are upper case: COLOR, TIME, UV.
      [/\b[A-Z][A-Z0-9_]*\b/, 'variable.predefined'],
      [/hint_\w+|source_color|repeat_\w+|filter_\w+/, 'tag'],
      [/[a-zA-Z_]\w*/, { cases: { '@keywords': 'keyword', '@typeKeywords': 'type', '@default': 'identifier' } }],
      [/\d+\.\d*([eE][+-]?\d+)?f?|\.\d+([eE][+-]?\d+)?f?|\d+[uU]?/, 'number'],
      [/"/, { token: 'string', next: '@string' }],
      [/[{}()[\]]/, '@brackets'],
      [/[,.:;]/, 'delimiter'],
      [/[=<>!+\-*/%&|^~?]+/, 'operator'],
    ],
    comment: [
      [/\*\//, { token: 'comment', next: '@pop' }],
      [/./, 'comment'],
    ],
    string: [
      [/"/, { token: 'string', next: '@pop' }],
      [/[^"]+/, 'string'],
    ],
  },
};

const GDSHADER_CONFIGURATION: Monaco.languages.LanguageConfiguration = {
  comments: { lineComment: '//', blockComment: ['/*', '*/'] },
  brackets: COMMON_BRACKETS,
  autoClosingPairs: COMMON_AUTO_CLOSING,
  surroundingPairs: COMMON_AUTO_CLOSING,
};

function extensionsFor(languageId: string): string[] {
  return Object.entries(GODOT_EXTENSION_TO_LANGUAGE)
    .filter(([, id]) => id === languageId)
    .map(([ext]) => `.${ext}`);
}

/** Registers the Godot languages; safe to call from every editor instance. */
export function registerGodotLanguages(api: typeof Monaco): void {
  if (api.languages.getLanguages().some((l) => l.id === GDSCRIPT_LANGUAGE_ID)) {
    return;
  }
  const languages: ReadonlyArray<{
    id: string;
    aliases: string[];
    monarch: Monaco.languages.IMonarchLanguage;
    configuration: Monaco.languages.LanguageConfiguration;
  }> = [
    {
      id: GDSCRIPT_LANGUAGE_ID,
      aliases: ['GDScript'],
      monarch: GDSCRIPT_MONARCH,
      configuration: GDSCRIPT_CONFIGURATION,
    },
    {
      id: GODOT_RESOURCE_LANGUAGE_ID,
      aliases: ['Godot Resource'],
      monarch: GODOT_RESOURCE_MONARCH,
      configuration: GODOT_RESOURCE_CONFIGURATION,
    },
    {
      id: GDSHADER_LANGUAGE_ID,
      aliases: ['Godot Shader'],
      monarch: GDSHADER_MONARCH,
      configuration: GDSHADER_CONFIGURATION,
    },
  ];
  for (const { id, aliases, monarch, configuration } of languages) {
    api.languages.register({ id, aliases, extensions: extensionsFor(id) });
    api.languages.setMonarchTokensProvider(id, monarch);
    api.languages.setLanguageConfiguration(id, configuration);
  }
}
