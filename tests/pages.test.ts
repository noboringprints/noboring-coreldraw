import { describe, expect, it } from 'vitest'
import { buildItems, formatPageRange, pageSelectionPatch, parsePageRange, type Design } from '../src/lib/job'
import { readSource } from '../src/lib/sources'
import { makeTestPoster } from '../src/lib/testDesign'

describe('page range', () => {
  it('reads ranges, lists and open ends', () => {
    expect(parsePageRange('2-4', 6)).toEqual([1, 2, 3])
    expect(parsePageRange('2 - 4', 6)).toEqual([1, 2, 3])
    expect(parsePageRange('1, 3,5-6', 6)).toEqual([0, 2, 4, 5])
    expect(parsePageRange('4-', 6)).toEqual([3, 4, 5])
    expect(parsePageRange('-2', 6)).toEqual([0, 1])
    expect(parsePageRange('3, 2-3', 6)).toEqual([1, 2])
    expect(parsePageRange('', 3)).toEqual([0, 1, 2])
    expect(parsePageRange('All', 3)).toEqual([0, 1, 2])
  })

  it('explains bad input', () => {
    expect(parsePageRange('2-9', 6)).toBe('This file has only 6 pages')
    expect(parsePageRange('0', 6)).toBe('Pages start at 1')
    expect(parsePageRange('4-2', 6)).toMatch(/backwards/)
    expect(parsePageRange('abc', 6)).toMatch(/not a page/)
    expect(parsePageRange('-', 6)).toMatch(/not a page/)
  })

  it('writes ranges back compactly', () => {
    expect(formatPageRange([1, 2, 3, 5], 6)).toBe('2-4, 6')
    expect(formatPageRange([0, 1, 2], 3)).toBe('All')
    expect(formatPageRange(undefined, 3)).toBe('All')
    expect(formatPageRange([2], 3)).toBe('3')
  })

  it('one page prints on its own, several are each printed', () => {
    expect(pageSelectionPatch([2], 5)).toEqual({ split: false, pageIndex: 2, pages: undefined })
    expect(pageSelectionPatch([1, 2, 3], 5)).toEqual({ split: true, pageIndex: 1, pages: [1, 2, 3] })
    expect(pageSelectionPatch([0, 1, 2, 3, 4], 5)).toEqual({ split: true, pageIndex: 0, pages: undefined })
  })

  it('only the selected pages are imposed', async () => {
    const bytes = await makeTestPoster({ trimW: 148, trimH: 210, bleed: 3, title: 'Pages', pages: 5 })
    const src = await readSource('pages.pdf', bytes, 'pg')
    const design: Design = {
      id: 'd', sourceId: 'pg', name: 'Pages', trimName: 'A5', trimW: 148, trimH: 210, copies: 2,
      bleedMode: 'included', fit: 'fit', bleedAuto: true, pageIndex: 0, split: false,
      ...pageSelectionPatch([1, 2, 3], 5),
    }
    const items = buildItems([design], { pg: src })
    expect(items.map((i) => i.art?.pageIndex)).toEqual([1, 2, 3, 1, 2, 3])
    expect(items[0].panel).toEqual({ index: 2, total: 5 })
  })
})
