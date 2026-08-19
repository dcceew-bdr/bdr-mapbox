<script setup>
import { onMounted, onBeforeUnmount, watch } from 'vue'
import mapboxgl from 'mapbox-gl'

/**
 * MapView renders a Mapbox GL JS map and overlays the NVIS raster tileset
 * (once it has been published to Mapbox Tiling Service) as a `raster` layer.
 *
 * The component is intentionally defensive: if the tileset ID has not been
 * configured yet, it still renders the base map so the POC is always demoable.
 */
const props = defineProps({
  token: { type: String, required: true },
  tilesetId: { type: String, default: '' },
  basemapUrl: { type: String, required: true },
  opacity: { type: Number, default: 0.85 },
  layerVisible: { type: Boolean, default: true }
})

const emit = defineEmits(['ready', 'tile-error'])

const SOURCE_ID = 'nvis-mvg'
const LAYER_ID = 'nvis-mvg-raster'
// Centre roughly on the Australian landmass.
const AUSTRALIA = { center: [134, -26], zoom: 3.2 }

let map = null

function hasTileset() {
  return Boolean(props.tilesetId) && props.tilesetId.includes('.') && !props.tilesetId.includes('your_')
}

/** (Re)adds the NVIS raster source + layer. Safe to call multiple times. */
function addNvisLayer() {
  if (!map || !hasTileset()) return

  if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID)
  if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID)

  // A Mapbox-hosted tileset is referenced with the mapbox:// protocol; GL JS
  // fetches its TileJSON automatically using the access token.
  map.addSource(SOURCE_ID, {
    type: 'raster',
    url: `mapbox://${props.tilesetId}`
  })

  map.addLayer({
    id: LAYER_ID,
    type: 'raster',
    source: SOURCE_ID,
    layout: { visibility: props.layerVisible ? 'visible' : 'none' },
    paint: {
      'raster-opacity': props.opacity,
      // Categorical data: keep crisp class boundaries instead of blurring them.
      'raster-resampling': 'nearest'
    }
  })
}

function flyToAustralia() {
  map?.flyTo({ ...AUSTRALIA, duration: 1200, essential: true })
}

onMounted(() => {
  mapboxgl.accessToken = props.token

  map = new mapboxgl.Map({
    container: 'map-root',
    style: props.basemapUrl,
    center: AUSTRALIA.center,
    zoom: AUSTRALIA.zoom,
    attributionControl: true,
    projection: 'mercator'
  })

  map.addControl(new mapboxgl.NavigationControl({ visualizePitch: false }), 'top-left')
  map.addControl(new mapboxgl.ScaleControl({ unit: 'metric' }), 'bottom-right')

  // `style.load` fires on the initial load *and* after every setStyle() call,
  // so we use it as the single place to (re)attach our raster layer.
  map.on('style.load', addNvisLayer)
  map.on('load', () => emit('ready'))

  map.on('error', (e) => {
    const msg = e?.error?.message || 'Unknown map error'
    // Surface tileset/token problems to the parent without spamming.
    if (/tileset|source|40\d|not found|access/i.test(msg)) {
      emit('tile-error', msg)
    }
    // eslint-disable-next-line no-console
    console.warn('[mapbox]', msg)
  })
})

onBeforeUnmount(() => {
  map?.remove()
  map = null
})

// --- React to control changes coming from the parent -----------------------
watch(
  () => props.basemapUrl,
  (url) => map?.setStyle(url) // style.load re-adds the NVIS layer
)

watch(
  () => props.opacity,
  (value) => {
    if (map?.getLayer(LAYER_ID)) map.setPaintProperty(LAYER_ID, 'raster-opacity', value)
  }
)

watch(
  () => props.layerVisible,
  (visible) => {
    if (map?.getLayer(LAYER_ID)) {
      map.setLayoutProperty(LAYER_ID, 'visibility', visible ? 'visible' : 'none')
    }
  }
)

watch(
  () => props.tilesetId,
  () => addNvisLayer()
)

defineExpose({ flyToAustralia })
</script>

<template>
  <div id="map-root" class="map-root"></div>
</template>

<style scoped>
.map-root {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}
</style>
