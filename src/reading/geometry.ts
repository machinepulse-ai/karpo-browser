/** Boxes in the page's viewport, in CSS pixels, and how they lie against each other. */

/** A box: its top-left corner and its size. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const NO_RECT: Rect = { x: 0, y: 0, w: 0, h: 0 };

/** What two boxes share; undefined when they do not overlap. */
export function overlap(a: Rect, b: Rect): Rect | undefined {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.w, b.x + b.w);
  const bottom = Math.min(a.y + a.h, b.y + b.h);
  return right > x && bottom > y ? { x, y, w: right - x, h: bottom - y } : undefined;
}

/** The most pieces a union keeps: past it, it takes no more boxes, so it hides no more than it did. */
const MAX_PIECES = 5_000;
/** The cells each side of a union's grid is cut into: a box is weighed only against the pieces in its cells. */
const GRID_CELLS = 64;
/** How far short of a box's area the pieces' shares may add up, in floating point, and still be checked by cutting. */
const AREA_SLACK = 1e-9;

/** A box by its edges. */
interface Edges {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function edgesOf(rect: Rect): Edges {
  return { left: rect.x, top: rect.y, right: rect.x + rect.w, bottom: rect.y + rect.h };
}

function area(edges: Edges): number {
  return Math.max(edges.right - edges.left, 0) * Math.max(edges.bottom - edges.top, 0);
}

function edgesHold(outer: Edges, inner: Edges): boolean {
  return (
    outer.left <= inner.left && outer.top <= inner.top && outer.right >= inner.right && outer.bottom >= inner.bottom
  );
}

/** Whether two boxes overlap with some area. */
function meet(a: Edges, b: Edges): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

/** The area two boxes share. */
function shared(a: Edges, b: Edges): number {
  const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return Math.max(w, 0) * Math.max(h, 0);
}

function around(a: Edges, b: Edges): Edges {
  return {
    left: Math.min(a.left, b.left),
    top: Math.min(a.top, b.top),
    right: Math.max(a.right, b.right),
    bottom: Math.max(a.bottom, b.bottom),
  };
}

/**
 * What of a box lies outside `other`, which it overlaps: up to four pieces (above and below `other`, then left and
 * right of it within their shared rows).
 */
function less(box: Edges, other: Edges): Edges[] {
  const pieces: Edges[] = [];
  if (box.top < other.top) pieces.push({ ...box, bottom: other.top });
  if (other.bottom < box.bottom) pieces.push({ ...box, top: other.bottom });
  const top = Math.max(box.top, other.top);
  const bottom = Math.min(box.bottom, other.bottom);
  if (box.left < other.left) pieces.push({ ...box, top, bottom, right: other.left });
  if (other.right < box.right) pieces.push({ ...box, top, bottom, left: other.right });
  return pieces;
}

/**
 * Boxes put together: whether a box lies wholly inside them. Kept as pieces that do not overlap; a box put in stays
 * whole, the pieces it overlaps cut back around it; a grid over the area they lie in finds the pieces near a box.
 * Whether they hold a box is told by cutting it by those pieces, but first by one piece holding it whole, and by
 * their shares of it adding up short.
 */
export class BoxUnion {
  private readonly pieces: Edges[] = [];
  /** Whether each piece is still in, not cut back around a box put in after it. */
  private readonly live: boolean[] = [];
  private alive = 0;
  /** What all the pieces lie in: a box reaching out of it is not inside them. */
  private bounds: Edges | undefined;
  private readonly origin: Offset;
  private readonly cell: Offset;
  /** The pieces in each cell of the grid, row after row. */
  private readonly cells: number[][] = Array.from({ length: GRID_CELLS * GRID_CELLS }, () => []);
  /** The look a piece was last found in, so a look finds it once whatever cells it spans. */
  private readonly seen: number[] = [];
  private look = 0;

  /** An empty union of boxes that lie in `within` (a box out of it counts in the cells at its edge). */
  constructor(within: Rect) {
    const size = (side: number) => Math.max(side / GRID_CELLS, 1);
    this.origin = { x: within.x, y: within.y };
    this.cell = { x: size(within.w), y: size(within.h) };
  }

  /** Whether the boxes put together hold `rect` whole. */
  holds(rect: Rect): boolean {
    const edges = edgesOf(rect);
    if (!this.bounds || !edgesHold(this.bounds, edges)) return false;
    const near = this.near(edges);
    if (near.some((piece) => edgesHold(this.pieces[piece]!, edges))) return true;
    let covered = 0;
    for (const piece of near) covered += shared(this.pieces[piece]!, edges);
    if (area(edges) <= 0 || covered < area(edges) * (1 - AREA_SLACK)) return false;
    let left = [edges];
    for (const index of near) {
      const piece = this.pieces[index]!;
      left = left.flatMap((part) => (meet(piece, part) ? less(part, piece) : [part]));
      if (left.length === 0) return true;
    }
    return false;
  }

  /** Puts `rect` in whole, the pieces it overlaps cut back around it. */
  add(rect: Rect): void {
    if (this.alive >= MAX_PIECES || this.holds(rect)) return;
    const edges = edgesOf(rect);
    for (const piece of this.near(edges)) {
      const was = this.pieces[piece]!;
      if (meet(was, edges)) {
        this.live[piece] = false;
        this.alive -= 1;
        for (const part of less(was, edges)) this.put(part);
      }
    }
    this.put(edges);
    this.bounds = this.bounds ? around(this.bounds, edges) : edges;
  }

  private put(edges: Edges): void {
    const index = this.pieces.length;
    this.pieces.push(edges);
    this.live.push(true);
    this.seen.push(0);
    this.alive += 1;
    const { columns, rows } = this.cellsOf(edges);
    for (let row = rows[0]; row <= rows[1]; row += 1) {
      for (let column = columns[0]; column <= columns[1]; column += 1) {
        this.cells[row * GRID_CELLS + column]!.push(index);
      }
    }
  }

  /** The pieces still in, in the cells a box lies in, each once; the cells looked in drop the pieces cut back. */
  private near(edges: Edges): number[] {
    this.look += 1;
    const { columns, rows } = this.cellsOf(edges);
    const near: number[] = [];
    for (let row = rows[0]; row <= rows[1]; row += 1) {
      for (let column = columns[0]; column <= columns[1]; column += 1) {
        const at = row * GRID_CELLS + column;
        const cell = this.cells[at]!.filter((piece) => this.live[piece]);
        this.cells[at] = cell;
        for (const piece of cell) {
          if (this.seen[piece] !== this.look) {
            this.seen[piece] = this.look;
            near.push(piece);
          }
        }
      }
    }
    return near;
  }

  /** The first and last column and row of the cells a box lies in. */
  private cellsOf(edges: Edges): { columns: [number, number]; rows: [number, number] } {
    const at = (value: number, origin: number, cell: number) => {
      const index = Math.floor((value - origin) / cell);
      // A value that is no number counts in the first cell.
      return Number.isNaN(index) ? 0 : Math.min(Math.max(index, 0), GRID_CELLS - 1);
    };
    return {
      columns: [at(edges.left, this.origin.x, this.cell.x), at(edges.right, this.origin.x, this.cell.x)],
      rows: [at(edges.top, this.origin.y, this.cell.y), at(edges.bottom, this.origin.y, this.cell.y)],
    };
  }
}

interface Offset {
  x: number;
  y: number;
}
