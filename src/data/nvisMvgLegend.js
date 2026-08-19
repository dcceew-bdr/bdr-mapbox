// -----------------------------------------------------------------------------
//  NVIS Major Vegetation Groups (MVG) legend
//
//  Colours come straight from the supplied palette file:
//    NVIS_V7_30m/NVIS_V7_30m_Revised/NVIS7_0_AUST_EX_MVG.clr
//  (each .clr line is:  <pixel value>  <R>  <G>  <B>)
//
//  The class names follow the standard National Vegetation Information System
//  (NVIS) Major Vegetation Groups classification. Value 99 is the no-data /
//  "unknown" class. Value 30 (Unclassified Forest) is not present in this raster.
//
//  This is the same palette that gets "baked" into the RGB GeoTIFF during the
//  GDAL color-relief step (see the project README), so the swatches below match
//  what you see on the map.
// -----------------------------------------------------------------------------

/** @typedef {{ value: number, name: string, rgb: [number, number, number] }} MvgClass */

/** @type {MvgClass[]} */
export const NVIS_MVG_CLASSES = [
  { value: 1, name: 'Rainforests and Vine Thickets', rgb: [255, 0, 0] },
  { value: 2, name: 'Eucalypt Tall Open Forests', rgb: [3, 77, 0] },
  { value: 3, name: 'Eucalypt Open Forests', rgb: [0, 130, 0] },
  { value: 4, name: 'Eucalypt Low Open Forests', rgb: [76, 230, 0] },
  { value: 5, name: 'Eucalypt Woodlands', rgb: [193, 214, 200] },
  { value: 6, name: 'Acacia Forests and Woodlands', rgb: [146, 173, 47] },
  { value: 7, name: 'Callitris Forests and Woodlands', rgb: [144, 186, 141] },
  { value: 8, name: 'Casuarina Forests and Woodlands', rgb: [0, 214, 168] },
  { value: 9, name: 'Melaleuca Forests and Woodlands', rgb: [178, 235, 178] },
  { value: 10, name: 'Other Forests and Woodlands', rgb: [115, 255, 222] },
  { value: 11, name: 'Eucalypt Open Woodlands', rgb: [224, 255, 235] },
  { value: 12, name: 'Tropical Eucalypt Woodlands / Grasslands', rgb: [200, 194, 255] },
  { value: 13, name: 'Acacia Open Woodlands', rgb: [240, 228, 141] },
  { value: 14, name: 'Mallee Woodlands and Shrublands', rgb: [189, 182, 106] },
  { value: 15, name: 'Low Closed Forests and Tall Closed Shrublands', rgb: [138, 114, 19] },
  { value: 16, name: 'Acacia Shrublands', rgb: [250, 190, 190] },
  { value: 17, name: 'Other Shrublands', rgb: [138, 114, 101] },
  { value: 18, name: 'Heathlands', rgb: [255, 160, 122] },
  { value: 19, name: 'Tussock Grasslands', rgb: [184, 171, 141] },
  { value: 20, name: 'Hummock Grasslands', rgb: [255, 248, 219] },
  { value: 21, name: 'Other Grasslands, Herblands, Sedgelands and Rushlands', rgb: [252, 228, 167] },
  { value: 22, name: 'Chenopod Shrublands, Samphire Shrublands and Forblands', rgb: [252, 228, 220] },
  { value: 23, name: 'Mangroves', rgb: [21, 163, 171] },
  { value: 24, name: 'Inland Aquatic — freshwater, salt lakes, lagoons', rgb: [0, 111, 255] },
  { value: 25, name: 'Cleared, non-native vegetation, buildings', rgb: [255, 255, 255] },
  { value: 26, name: 'Unclassified native vegetation', rgb: [79, 79, 79] },
  { value: 27, name: 'Naturally bare — sand, rock, claypan, mudflat', rgb: [204, 204, 204] },
  { value: 28, name: 'Sea and estuaries', rgb: [150, 219, 242] },
  { value: 29, name: 'Regrowth, modified native vegetation', rgb: [156, 156, 156] },
  { value: 31, name: 'Other Open Woodlands', rgb: [214, 157, 188] },
  { value: 32, name: 'Mallee Open Woodlands and Sparse Mallee Shrublands', rgb: [224, 217, 136] },
  { value: 99, name: 'Unknown / No data', rgb: [235, 235, 235] }
]

/** Convert an [r,g,b] triple to a CSS rgb() string. */
export function rgbToCss([r, g, b]) {
  return `rgb(${r}, ${g}, ${b})`
}
