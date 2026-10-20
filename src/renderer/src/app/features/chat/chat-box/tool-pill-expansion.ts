import { Injectable, signal } from '@angular/core';

/**
 * Which tool pills in one turn feed are open, by stream tag. When the next same-kind call lands,
 * the feed swaps a single pill for a group pill and the single pill is destroyed; keeping the
 * open state here lets the group open on the call the user was reading.
 */
@Injectable()
export class ToolPillExpansion {
  private readonly open = signal<ReadonlySet<string>>(new Set());

  isOpen(key: string): boolean {
    return this.open().has(key);
  }

  set(key: string, open: boolean): void {
    this.open.update((prev) => {
      if (prev.has(key) === open) {
        return prev;
      }
      const next = new Set(prev);
      if (open) {
        next.add(key);
      } else {
        next.delete(key);
      }
      return next;
    });
  }
}
