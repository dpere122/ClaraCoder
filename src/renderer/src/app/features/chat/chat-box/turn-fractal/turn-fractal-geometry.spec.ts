import { describe, expect, it } from 'vitest';
import { fractalKindForCategory, turnFractal, type FractalKind } from './turn-fractal-geometry';

const segments = (paths: string): number => (paths.match(/M/g) ?? []).length;

describe('turnFractal', () => {
  it('is repeatable: the same tool sequence always draws the same shape', () => {
    const seq: FractalKind[] = ['read', 'read', 'edit', 'run', 'edit', 'run'];
    expect(turnFractal(seq)).toEqual(turnFractal([...seq]));
    expect(turnFractal(seq)).not.toEqual(turnFractal(['read', 'edit', 'read', 'run', 'edit', 'run']));
  });

  it('grows one generation per tool call, by its rule', () => {
    const reads = turnFractal(['read', 'read']);
    // Trunk, then 2 then 4 lookup branches; the newest generation is split out.
    expect(segments(reads.base.line)).toBe(1);
    expect(segments(reads.base.third)).toBe(2);
    expect(segments(reads.newest.third)).toBe(4);
    expect(segments(turnFractal(['edit']).newest.hi)).toBe(1);
    expect(segments(turnFractal(['search']).newest.third)).toBe(3);
    expect(segments(turnFractal(['web']).newest.dots)).toBe(3);
  });

  it('keeps at most eight tips so long stretches stay legible', () => {
    const many = turnFractal(['read', 'read', 'read', 'read', 'read']);
    expect(segments(many.newest.third)).toBe(16);
  });

  it('a thought adds no branches; thinking alone is a trunk with a node', () => {
    const thought = turnFractal(['think']);
    expect(thought.newest).toEqual({ line: '', third: '', hi: '', dots: '' });
    expect(segments(thought.base.dots)).toBe(1);
    expect(turnFractal(['think', 'read']).newest).not.toEqual(turnFractal(['read']).newest);
  });

  it('fits a square viewBox around the shape', () => {
    const [, , w, h] = turnFractal(['read', 'edit', 'run']).viewBox.split(' ').map(Number);
    expect(w).toBe(h);
    expect(w).toBeGreaterThan(0);
  });
});

describe('fractalKindForCategory', () => {
  it('maps tool categories onto growth rules', () => {
    expect(fractalKindForCategory('read')).toBe('read');
    expect(fractalKindForCategory('list')).toBe('read');
    expect(fractalKindForCategory('lsp')).toBe('read');
    expect(fractalKindForCategory('search')).toBe('search');
    expect(fractalKindForCategory('edit')).toBe('edit');
    expect(fractalKindForCategory('run')).toBe('run');
    expect(fractalKindForCategory('web')).toBe('web');
    expect(fractalKindForCategory('other')).toBe('run');
  });
});
