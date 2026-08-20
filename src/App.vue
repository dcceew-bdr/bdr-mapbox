<script setup>
import { computed, ref } from 'vue'
import NvisVectorMap from './components/NvisVectorMap.vue'
import ControlsPanel from './components/ControlsPanel.vue'
import LegendPanel from './components/LegendPanel.vue'

// --- Configuration from environment (.env) ---------------------------------
const token = import.meta.env.VITE_MAPBOX_TOKEN || ''
const tilesetId = import.meta.env.VITE_NVIS_VECTOR_TILESET_ID || ''
const rasterTilesetId = import.meta.env.VITE_NVIS_TILESET_ID || ''
// Zoom at which the map switches raster → vector. Match it to the vector
// tileset's minimum zoom (9 for the shipped z9–13 build; set to 0 for a
// full-range vector build). Non-numeric env values fall back to 9.
const vectorMinZoom = Number.parseInt(import.meta.env.VITE_VEG_VECTOR_MIN_ZOOM, 10)
const vegVectorMinZoom = Number.isFinite(vectorMinZoom) ? vectorMinZoom : 9

const hasToken = computed(() => token.startsWith('pk.'))
const isConfigured = (id) => id.includes('.') && !id.includes('your_')
const tilesetConfigured = computed(
  () => isConfigured(tilesetId) || isConfigured(rasterTilesetId)
)

// --- Base map options -------------------------------------------------------
const BASEMAPS = [
  { id: 'light', label: 'Light', url: 'mapbox://styles/mapbox/light-v11' },
  { id: 'satellite', label: 'Satellite', url: 'mapbox://styles/mapbox/satellite-streets-v12' },
  { id: 'streets', label: 'Streets', url: 'mapbox://styles/mapbox/streets-v12' },
  { id: 'dark', label: 'Dark', url: 'mapbox://styles/mapbox/dark-v11' }
]

// --- Reactive UI state ------------------------------------------------------
const opacity = ref(0.85)
const layerVisible = ref(true)
const basemapId = ref('light')
const basemapUrl = computed(
  () => BASEMAPS.find((b) => b.id === basemapId.value)?.url ?? BASEMAPS[0].url
)

const mapRef = ref(null)
const tileError = ref('')
const legendItems = ref([])

function onTileError(msg) {
  tileError.value = msg
}

function onLegendChange(items) {
  legendItems.value = items
}
</script>

<template>
  <!-- Setup screen shown until a public token is provided -->
  <div v-if="!hasToken" class="setup">
    <div class="setup__card panel">
      <div class="setup__badge">NVIS × Mapbox</div>
      <h1>Almost there — add your Mapbox token</h1>
      <p>
        This proof of concept needs a public Mapbox access token to load the map.
      </p>
      <ol>
        <li>
          Copy <code>.env.example</code> to <code>.env</code> in the
          <code>mapbox-poc</code> folder.
        </li>
        <li>
          Set <code>VITE_MAPBOX_TOKEN</code> to a public token (starts with
          <code>pk.</code>) from your
          <a href="https://console.mapbox.com/account/access-tokens" target="_blank" rel="noreferrer">
            Mapbox account
          </a>.
        </li>
        <li>Restart <code>npm run dev</code>.</li>
      </ol>
      <p class="setup__tip">
        Tip: you can also run <code>npm run token:create</code> to mint one
        from the command line.
      </p>
    </div>
  </div>

  <!-- Main application -->
  <template v-else>
    <header class="appbar">
      <div class="appbar__brand">
        <span class="appbar__logo">🛰️</span>
        <div>
          <h1 class="appbar__title">NVIS Major Vegetation Groups</h1>
          <p class="appbar__subtitle">
            GeoTIFF → Mapbox Tiling Service → Mapbox GL JS · proof of concept
          </p>
        </div>
      </div>
      <div class="appbar__status">
        <span class="pill" :class="tilesetConfigured ? 'pill--ok' : 'pill--warn'">
          <span class="dot"></span>
          {{ tilesetConfigured ? 'Tileset connected' : 'Base map only' }}
        </span>
      </div>
    </header>

    <main class="stage">
      <NvisVectorMap
        ref="mapRef"
        :token="token"
        :tileset-id="tilesetId"
        :raster-tileset-id="rasterTilesetId"
        :vector-min-zoom="vegVectorMinZoom"
        :basemap-url="basemapUrl"
        :opacity="opacity"
        :layer-visible="layerVisible"
        @tile-error="onTileError"
        @legend-change="onLegendChange"
      />

      <ControlsPanel @reset-view="mapRef?.flyToAustralia()" />

      <LegendPanel :items="legendItems" />

      <div v-if="tileError" class="toast panel">
        <strong>Couldn’t load the tileset.</strong>
        <span>{{ tileError }}</span>
        <small>
          Check <code>VITE_NVIS_VECTOR_TILESET_ID</code> and that the publish job
          has finished (see <code>npm run mb:status</code>).
        </small>
        <button type="button" @click="tileError = ''" aria-label="Dismiss">×</button>
      </div>
    </main>
  </template>
</template>

<style scoped>
/* App bar -------------------------------------------------------------------*/
.appbar {
  height: var(--header-h);
  flex: 0 0 var(--header-h);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 20px;
  background: linear-gradient(180deg, #0b3d2e 0%, #0b6b3a 100%);
  color: #fff;
  z-index: 10;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.25);
}

.appbar__brand {
  display: flex;
  align-items: center;
  gap: 12px;
}

.appbar__logo {
  font-size: 26px;
}

.appbar__title {
  margin: 0;
  font-size: 18px;
  line-height: 1.1;
}

.appbar__subtitle {
  margin: 2px 0 0;
  font-size: 12px;
  opacity: 0.82;
}

.pill {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 6px 12px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
  background: rgba(255, 255, 255, 0.14);
}

.pill .dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: currentColor;
}

.pill--ok {
  color: #7ef0b0;
}

.pill--warn {
  color: #ffd479;
}

/* Stage (map + overlays) ----------------------------------------------------*/
.stage {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
}

/* Error toast ---------------------------------------------------------------*/
.toast {
  position: absolute;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%);
  max-width: 460px;
  padding: 12px 40px 12px 16px;
  display: flex;
  flex-direction: column;
  gap: 3px;
  z-index: 8;
  font-size: 13px;
}

.toast strong {
  color: #b3261e;
}

.toast small {
  color: var(--muted);
}

.toast code {
  background: #eef1f4;
  padding: 1px 4px;
  border-radius: 4px;
}

.toast button {
  position: absolute;
  top: 8px;
  right: 10px;
  border: none;
  background: transparent;
  font-size: 18px;
  line-height: 1;
  color: var(--muted);
}

/* Setup screen --------------------------------------------------------------*/
.setup {
  flex: 1 1 auto;
  display: grid;
  place-items: center;
  padding: 24px;
  background: radial-gradient(1200px 600px at 50% -10%, #0b6b3a22, transparent),
    #f4f6f8;
}

.setup__card {
  max-width: 520px;
  padding: 28px 30px;
}

.setup__badge {
  display: inline-block;
  padding: 4px 10px;
  border-radius: 999px;
  background: var(--accent);
  color: #fff;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.04em;
}

.setup__card h1 {
  margin: 14px 0 8px;
  font-size: 22px;
}

.setup__card ol {
  margin: 14px 0;
  padding-left: 20px;
  line-height: 1.6;
}

.setup__card code {
  background: #eef1f4;
  padding: 1px 5px;
  border-radius: 4px;
  font-size: 0.92em;
}

.setup__card a {
  color: var(--accent-2);
}

.setup__tip {
  margin: 6px 0 0;
  font-size: 13px;
  color: var(--muted);
}
</style>
