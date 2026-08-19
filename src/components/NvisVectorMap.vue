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
  basemapUrl: { type: String, required: true },
  opacity: { type: Number, default: 0.85 },
  layerVisible: { type: Boolean, default: true }
})

const emit = defineEmits(['ready', 'tile-error', 'legend-change'])

const SOURCE_ID = 'nvis-mvg-vec'
const FILL_ID = 'nvis-mvg-fill'
const LINE_ID = 'nvis-mvg-outline'
const AUSTRALIA = { center: [134, -26], zoom: 3.2 }

let map = null
let popup = null
/** Classes currently visible in the viewport (for the dynamic legend). */
const visibleClasses = ref([])

function hasTileset() {
  return Boolean(props.tilesetId) && props.tilesetId.includes('.') && !props.tilesetId.includes('your_')
}

/** (Re)adds the NVIS vector source + fill/outline layers. Idempotent. */
function addNvisVectorLayer() {
  if (!map || !hasTileset()) return

  if (map.getLayer(LINE_ID)) map.removeLayer(LINE_ID)
  if (map.getLayer(FILL_ID)) map.removeLayer(FILL_ID)
  if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID)

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
  }
)

watch(
  () => props.layerVisible,
  (visible) => {
    const v = visible ? 'visible' : 'none'
    if (map?.getLayer(FILL_ID)) map.setLayoutProperty(FILL_ID, 'visibility', v)
    if (map?.getLayer(LINE_ID)) map.setLayoutProperty(LINE_ID, 'visibility', v)
  }
)

watch(
  () => props.tilesetId,
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
