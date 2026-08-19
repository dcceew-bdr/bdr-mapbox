// -----------------------------------------------------------------------------
//  Mapbox style-expression helpers for the NVIS MVG *vector* tileset.
//
//  The vector tiles carry a single integer property `mvg` (the class code).
//  Names + colours are NOT in the tiles — we look them up locally from
//  nvisMvgLegend.js and build data-driven expressions here. This keeps the
//  tiles tiny and lets us restyle without re-tiling.
// -----------------------------------------------------------------------------

import { NVIS_MVG_CLASSES } from './nvisMvgLegend.js'

/** The property name baked into the vector tiles by prepare-vector.mjs. */
export const MVG_PROPERTY = 'mvg'

/** The source-layer name inside the .mbtiles (see build-mbtiles.mjs -nln). */
export const MVG_SOURCE_LAYER = 'mvg'

const rgbCss = ([r, g, b]) => `rgb(${r}, ${g}, ${b})`

/**
 * Build a Mapbox `match` expression that maps the integer `mvg` code to its
 * fill colour. Falls back to transparent for any unmapped value.
 *
 *   ['match', ['get','mvg'], 1,'rgb(255,0,0)', 2,'rgb(3,77,0)', …, fallback]
 */
export function buildMvgColorExpression(fallback = 'rgba(0,0,0,0)') {
  const expr = ['match', ['get', MVG_PROPERTY]]
  for (const { value, rgb } of NVIS_MVG_CLASSES) {
    expr.push(value, rgbCss(rgb))
  }
  expr.push(fallback)
  return expr
}

/** value → { name, rgb, css } lookup for legend / popup rendering. */
export const MVG_BY_VALUE = new Map(
  NVIS_MVG_CLASSES.map((c) => [c.value, { ...c, css: rgbCss(c.rgb) }])
)

/** Human-readable name for a class code (or a sensible default). */
export function mvgName(value) {
  return MVG_BY_VALUE.get(value)?.name ?? `MVG ${value}`
}
