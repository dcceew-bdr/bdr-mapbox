<script setup>
import { onMounted, onBeforeUnmount, watch, ref } from 'vue'
import mapboxgl from 'mapbox-gl'
import {
  MVG_PROPERTY,
  MVG_SOURCE_LAYER,
  buildMvgColorExpression,
  mvgName,
  MVG_BY_VALUE
} from '../data/nvisMvgExpressions.js'

/**
 * NvisVectorMap renders the NVIS MVG *vector* tileset (built locally with the
 * GDAL MVT pipeline and uploaded via the Uploads API) as a data-driven `fill`
 * layer. Unlike the raster version, this supports:
 *   - client-side recolouring (no re-tile needed)
 *   - a viewport-aware legend (only classes currently on screen)
 *   - click-to-identify popups
 *
 * The tiles carry only the integer `mvg` code; names/colours are resolved
 * locally from nvisMvgLegend.js via nvisMvgExpressions.js.
 */
const props = defineProps({
  token: { type: String, required: true },
  // e.g. "kevinthiele.nvis_mvg_vector_90m"
  tilesetId: { type: String, default: '' },
  // Raster overview shown below vectorMinZoom, e.g. "kevinthiele.nvis_mvg"
  rasterTilesetId: { type: String, default: '' },
  // Zoom crossover: raster below, vector at/above. Match the tileset's min zoom.
  vectorMinZoom: { type: Number, default: 9 },
  basemapUrl: { type: String, required: true },
  opacity: { type: Number, default: 0.85 },
  layerVisible: { type: Boolean, default: true }
})

const emit = defineEmits(['ready', 'tile-error', 'legend-change'])

const SOURCE_ID = 'nvis-mvg-vec'
const FILL_ID = 'nvis-mvg-fill'
const LINE_ID = 'nvis-mvg-outline'
const RASTER_SOURCE_ID = 'nvis-mvg-raster'
const RASTER_LAYER_ID = 'nvis-mvg-raster-layer'
const AUSTRALIA = { center: [134, -26], zoom: 3.2 }

let map = null
let popup = null
/** Classes currently visible in the viewport (for the dynamic legend). */
const visibleClasses = ref([])

function isTilesetId(id) {
  return Boolean(id) && id.includes('.') && !id.includes('your_')
}
function hasTileset() {
  return isTilesetId(props.tilesetId)
}
function hasRaster() {
  return isTilesetId(props.rasterTilesetId)
}

/** (Re)adds the NVIS raster (low zoom) + vector (high zoom) layers. Idempotent. */
function addNvisVectorLayer() {
  if (!map) return

  for (const id of [LINE_ID, FILL_ID, RASTER_LAYER_ID]) {
    if (map.getLayer(id)) map.removeLayer(id)
  }
  for (const id of [SOURCE_ID, RASTER_SOURCE_ID]) {
    if (map.getSource(id)) map.removeSource(id)
  }

  // Raster overview beneath the vector, drawn only below vectorMinZoom.
  if (hasRaster()) {
    map.addSource(RASTER_SOURCE_ID, {
      type: 'raster',
      url: `mapbox://${props.rasterTilesetId}`,
      tileSize: 256
    })
    map.addLayer({
      id: RASTER_LAYER_ID,
      type: 'raster',
      source: RASTER_SOURCE_ID,
      maxzoom: props.vectorMinZoom,
      layout: { visibility: props.layerVisible ? 'visible' : 'none' },
      paint: { 'raster-opacity': props.opacity, 'raster-resampling': 'nearest' }
    })
  }

  if (!hasTileset()) {
    updateViewportLegend()
    return
  }

  map.addSource(SOURCE_ID, {
    type: 'vector',
    url: `mapbox://${props.tilesetId}`,
    // NVIS is DCCEEW material under CC BY 4.0; the state/territory custodians and
    // the fuller citation belong on an About/Credits page (see LICENSING.md).
    // Mapbox merges this into the attribution control next to © Mapbox / © OSM.
    attribution:
      '© DCCEEW — NVIS v7.0 (CC BY 4.0); incl. data © Australian State/Territory Governments'
  })

  map.addLayer({
    id: FILL_ID,
    type: 'fill',
    source: SOURCE_ID,
    'source-layer': MVG_SOURCE_LAYER,
    minzoom: props.vectorMinZoom,
    layout: { visibility: props.layerVisible ? 'visible' : 'none' },
    paint: {
      'fill-color': buildMvgColorExpression(),
      'fill-opacity': props.opacity
    }
  })

  // Optional hairline outline improves class-boundary legibility at high zoom.
  map.addLayer({
    id: LINE_ID,
    type: 'line',
    source: SOURCE_ID,
    'source-layer': MVG_SOURCE_LAYER,
    minzoom: props.vectorMinZoom,
    layout: { visibility: props.layerVisible ? 'visible' : 'none' },
    paint: {
      'line-color': 'rgba(0,0,0,0.15)',
      'line-width': ['interpolate', ['linear'], ['zoom'], 6, 0, 10, 0.4]
    }
  })

  updateViewportLegend()
}

/**
 * Viewport-aware legend: query the rendered fill features, collect the distinct
 * `mvg` codes actually on screen, and emit them (sorted, with name + colour).
 */
function updateViewportLegend() {
  if (!map || !map.getLayer(FILL_ID)) return
  const feats = map.queryRenderedFeatures({ layers: [FILL_ID] })
  const codes = new Set()
  for (const f of feats) {
    const v = f.properties?.[MVG_PROPERTY]
    if (v !== undefined && v !== null) codes.add(Number(v))
  }
  const list = [...codes]
    .sort((a, b) => a - b)
    .map((value) => {
      const meta = MVG_BY_VALUE.get(value)
      return { value, name: mvgName(value), css: meta?.css ?? 'transparent' }
    })
  visibleClasses.value = list
  emit('legend-change', list)
}

function wireInteractions() {
  // Recompute the legend whenever the view settles.
  map.on('moveend', updateViewportLegend)
  map.on('sourcedata', (e) => {
    if (e.sourceId === SOURCE_ID && e.isSourceLoaded) updateViewportLegend()
  })

  // Click-to-identify popup.
  map.on('click', FILL_ID, (e) => {
    const f = e.features?.[0]
    if (!f) return
    const value = Number(f.properties?.[MVG_PROPERTY])
    const meta = MVG_BY_VALUE.get(value)
    const name = mvgName(value)
    const swatch = meta?.css ?? 'transparent'

    popup?.remove()
    popup = new mapboxgl.Popup({ closeButton: true, maxWidth: '260px' })
      .setLngLat(e.lngLat)
      .setHTML(
        `<div style="font:13px/1.4 system-ui,sans-serif">
           <div style="display:flex;align-items:center;gap:8px;margin-bottom:2px">
             <span style="width:14px;height:14px;border:1px solid #0003;background:${swatch}"></span>
             <strong>MVG ${value}</strong>
           </div>
           <div>${name}</div>
         </div>`
      )
      .addTo(map)
  })

  map.on('mouseenter', FILL_ID, () => (map.getCanvas().style.cursor = 'pointer'))
  map.on('mouseleave', FILL_ID, () => (map.getCanvas().style.cursor = ''))
}

function flyToAustralia() {
  map?.flyTo({ ...AUSTRALIA, duration: 1200, essential: true })
}

onMounted(() => {
  mapboxgl.accessToken = props.token

  map = new mapboxgl.Map({
    container: 'map-root-vec',
    style: props.basemapUrl,
    center: AUSTRALIA.center,
    zoom: AUSTRALIA.zoom,
    attributionControl: true,
    projection: 'mercator'
  })

  map.addControl(new mapboxgl.NavigationControl({ visualizePitch: false }), 'top-left')
  map.addControl(new mapboxgl.ScaleControl({ unit: 'metric' }), 'bottom-right')

  map.on('style.load', addNvisVectorLayer)
  map.on('load', () => {
    wireInteractions()
    emit('ready')
  })

  map.on('error', (e) => {
    const msg = e?.error?.message || 'Unknown map error'
    if (/tileset|source|40\d|not found|access/i.test(msg)) emit('tile-error', msg)
    // eslint-disable-next-line no-console
    console.warn('[mapbox]', msg)
  })
})

onBeforeUnmount(() => {
  popup?.remove()
  map?.remove()
  map = null
})

watch(
  () => props.basemapUrl,
  (url) => map?.setStyle(url) // style.load re-adds the vector layer
)

watch(
  () => props.opacity,
  (value) => {
    if (map?.getLayer(FILL_ID)) map.setPaintProperty(FILL_ID, 'fill-opacity', value)
    if (map?.getLayer(RASTER_LAYER_ID)) map.setPaintProperty(RASTER_LAYER_ID, 'raster-opacity', value)
  }
)

watch(
  () => props.layerVisible,
  (visible) => {
    const v = visible ? 'visible' : 'none'
    if (map?.getLayer(FILL_ID)) map.setLayoutProperty(FILL_ID, 'visibility', v)
    if (map?.getLayer(LINE_ID)) map.setLayoutProperty(LINE_ID, 'visibility', v)
    if (map?.getLayer(RASTER_LAYER_ID)) map.setLayoutProperty(RASTER_LAYER_ID, 'visibility', v)
  }
)

watch(
  () => [props.tilesetId, props.rasterTilesetId, props.vectorMinZoom],
  () => addNvisVectorLayer()
)

defineExpose({ flyToAustralia, visibleClasses })
</script>

<template>
  <div id="map-root-vec" class="map-root"></div>
</template>

<style scoped>
.map-root {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}
</style>
