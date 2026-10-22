import { describe, expect, it } from 'vitest';
import { synapseGraph, synapseKindForCategory, type SynapseStep } from './turn-synapse-geometry';

const count = (paths: string): number => (paths.match(/M/g) ?? []).length;

describe('synapseGraph', () => {
  it('is repeatable: the same steps always draw the same graph', () => {
    const steps: SynapseStep[] = [{ kind: 'read', batch: 's1' }, { kind: 'read', batch: 's1' }, { kind: 'edit' }, { kind: 'run' }];
    expect(synapseGraph(steps)).toEqual(synapseGraph(steps.map((s) => ({ ...s }))));
  });

  it('draws one column per step and stacks calls that ran in parallel', () => {
    const graph = synapseGraph([{ kind: 'read', batch: 's1' }, { kind: 'read', batch: 's1' }, { kind: 'edit' }]);
    expect(graph.columns).toBe(2);
    expect(count(graph.paths.lookups)).toBe(2);
    // The start node fans out to both reads, which both fan in to the edit.
    expect(count(graph.paths.links)).toBe(4);
    expect(count(synapseGraph([{ kind: 'read' }, { kind: 'read' }]).paths.lookups)).toBe(2);
    expect(synapseGraph([{ kind: 'read' }, { kind: 'read' }]).columns).toBe(2);
  });

  it('gives each kind its node: dendrites for search, a ring for edit, satellites for web', () => {
    expect(count(synapseGraph([{ kind: 'search' }]).paths.dendrites)).toBe(3);
    expect(count(synapseGraph([{ kind: 'edit' }]).paths.rings)).toBe(1);
    expect(count(synapseGraph([{ kind: 'web' }]).paths.stalks)).toBe(2);
    expect(synapseGraph([{ kind: 'run' }]).paths.nodes).toContain('z');
  });

  it('a thought adds no node: the next link arcs, and a thought still going shows as pending', () => {
    const graph = synapseGraph([{ kind: 'think' }, { kind: 'read' }]);
    expect(graph.columns).toBe(1);
    expect(count(graph.paths.arcs)).toBe(1);
    expect(graph.paths.links).toBe('');
    expect(synapseGraph([{ kind: 'read' }, { kind: 'think' }]).paths.pending).not.toBe('');
  });

  it('packs long stretches to stay within a bounded width, and points the live pulse at the newest column', () => {
    const long = synapseGraph(Array.from({ length: 30 }, () => ({ kind: 'read' as const })));
    expect(long.width).toBeLessThanOrEqual(180);
    const graph = synapseGraph([{ kind: 'read' }, { kind: 'edit' }]);
    expect(graph.head.x).toBeGreaterThan(graph.from.x);
  });
});

describe('synapseKindForCategory', () => {
  it('maps tool categories onto node kinds', () => {
    expect(synapseKindForCategory('read')).toBe('read');
    expect(synapseKindForCategory('list')).toBe('read');
    expect(synapseKindForCategory('lsp')).toBe('read');
    expect(synapseKindForCategory('search')).toBe('search');
    expect(synapseKindForCategory('edit')).toBe('edit');
    expect(synapseKindForCategory('web')).toBe('web');
    expect(synapseKindForCategory('other')).toBe('run');
  });
});
