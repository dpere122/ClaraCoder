import type * as Monaco from 'monaco-editor';
import { describe, expect, it, vi } from 'vitest';
import {
  GDSCRIPT_MONARCH,
  GDSHADER_MONARCH,
  GODOT_EXTENSION_TO_LANGUAGE,
  GODOT_RESOURCE_MONARCH,
  registerGodotLanguages,
} from './workspace-monaco-godot-languages';
import { monacoLanguageIdForPath } from './workspace-monaco-model-store';

function fakeApi(): { api: typeof Monaco; registered: Array<{ id: string; extensions?: string[] }> } {
  const registered: Array<{ id: string; extensions?: string[] }> = [];
  const api = {
    languages: {
      getLanguages: () => registered,
      register: (language: { id: string; extensions?: string[] }) => registered.push(language),
      setMonarchTokensProvider: vi.fn(),
      setLanguageConfiguration: vi.fn(),
    },
  } as unknown as typeof Monaco;
  return { api, registered };
}

describe('registerGodotLanguages', () => {
  it('registers a grammar and configuration for each language', () => {
    const { api, registered } = fakeApi();
    registerGodotLanguages(api);
    expect(registered.map((l) => l.id)).toEqual(['gdscript', 'godot-resource', 'gdshader']);
    expect(registered[0]!.extensions).toEqual(['.gd']);
    expect(registered[1]!.extensions).toEqual(['.tscn', '.tres', '.godot', '.gdextension', '.import']);
    expect(registered[2]!.extensions).toEqual(['.gdshader', '.gdshaderinc']);
    expect(api.languages.setMonarchTokensProvider).toHaveBeenCalledTimes(3);
    expect(api.languages.setLanguageConfiguration).toHaveBeenCalledTimes(3);
  });

  it('runs once however many editor instances call it', () => {
    const { api, registered } = fakeApi();
    registerGodotLanguages(api);
    registerGodotLanguages(api);
    expect(registered).toHaveLength(3);
  });
});

describe('monacoLanguageIdForPath', () => {
  const api = { languages: { getLanguages: () => [] } } as unknown as typeof Monaco;

  it.each([
    ['scripts/dog.gd', 'gdscript'],
    ['scenes/dog.tscn', 'godot-resource'],
    ['materials/glow.tres', 'godot-resource'],
    ['project.godot', 'godot-resource'],
    ['addons/x/x.gdextension', 'godot-resource'],
    ['icon.png.import', 'godot-resource'],
    ['materials/glow.gdshader', 'gdshader'],
    ['materials/common.gdshaderinc', 'gdshader'],
  ])('%s opens as %s', (path, language) => {
    expect(monacoLanguageIdForPath(api, path)).toBe(language);
  });

  it('covers every Godot extension', () => {
    for (const [ext, language] of Object.entries(GODOT_EXTENSION_TO_LANGUAGE)) {
      expect(monacoLanguageIdForPath(api, `file.${ext}`)).toBe(language);
    }
  });
});

describe('grammars', () => {
  /** Monarch compiles each rule to a RegExp; a bad one only shows up when a Godot file opens. */
  function regexes(language: Monaco.languages.IMonarchLanguage): RegExp[] {
    const out: RegExp[] = [];
    for (const rules of Object.values(language.tokenizer)) {
      for (const rule of rules) {
        if (Array.isArray(rule) && rule[0] instanceof RegExp) {
          out.push(rule[0]);
        }
      }
    }
    return out;
  }

  it.each([
    ['gdscript', GDSCRIPT_MONARCH],
    ['godot-resource', GODOT_RESOURCE_MONARCH],
    ['gdshader', GDSHADER_MONARCH],
  ])('%s rules never match empty text, which would hang the tokenizer', (_name, language) => {
    for (const regex of regexes(language)) {
      // ``$`` rules pop a state, so they may match at end of line.
      if (regex.source !== '$') {
        expect(new RegExp(`^(?:${regex.source})`).test(''), regex.source).toBe(false);
      }
    }
  });

  it('every state a rule moves to exists', () => {
    for (const language of [GDSCRIPT_MONARCH, GODOT_RESOURCE_MONARCH, GDSHADER_MONARCH]) {
      const states = new Set(Object.keys(language.tokenizer));
      for (const rules of Object.values(language.tokenizer)) {
        for (const rule of rules) {
          const action = (Array.isArray(rule) ? rule[1] : undefined) as
            | { next?: string; switchTo?: string }
            | undefined;
          const target = action?.next ?? action?.switchTo;
          if (typeof target === 'string' && target !== '@pop') {
            expect(states.has(target.replace(/^@/, '')), target).toBe(true);
          }
        }
      }
    }
  });
});
