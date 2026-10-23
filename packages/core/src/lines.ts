/**
 * Lines of a text by offset, the way an editor counts them: `\r\n`, `\r` and `\n` each end one.
 * For working out edits (where a line starts, how it's indented) without an editor's document.
 */

import type { OffsetRange } from './sourceMap';

export class Lines {
  private readonly starts: number[] = [0];

  constructor(readonly text: string) {
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c === 13 && text.charCodeAt(i + 1) === 10) i++;
      if (c === 10 || c === 13) this.starts.push(i + 1);
    }
  }

  get count(): number {
    return this.starts.length;
  }

  /** The line `offset` is on, from 0. */
  lineOf(offset: number): number {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /** Where line `n` starts; past the last line, the end of the text. */
  start(n: number): number {
    return n < this.starts.length ? this.starts[n] : this.text.length;
  }

  /** Line `n`'s text, without its line break. */
  line(n: number): string {
    return this.text.slice(this.start(n), n + 1 < this.starts.length ? this.starts[n + 1] : this.text.length).replace(/\r?\n$|\r$/, '');
  }

  /** The spaces and tabs line `n` starts with. */
  indent(n: number): string {
    return /^[ \t]*/.exec(this.line(n))![0];
  }

  /** The indentation of the line `offset` is on. */
  indentAt(offset: number): string {
    return this.indent(this.lineOf(offset));
  }

  /** The identifier-like word (`[A-Za-z_]\w*`) touching `offset`, as an editor picks one. */
  wordAt(offset: number): (OffsetRange & { text: string }) | undefined {
    const n = this.lineOf(offset);
    const start = this.start(n);
    for (const m of this.line(n).matchAll(/[A-Za-z_]\w*/g)) {
      const s = start + m.index;
      const e = s + m[0].length;
      if (s <= offset && offset <= e) return { start: s, end: e, text: m[0] };
    }
    return undefined;
  }
}
