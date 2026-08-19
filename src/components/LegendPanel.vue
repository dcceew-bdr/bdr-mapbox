<script setup>
import { computed, ref } from 'vue'
import { NVIS_MVG_CLASSES, rgbToCss } from '../data/nvisMvgLegend.js'

const props = defineProps({
  // Viewport-aware classes emitted by the map: { value, name, css }.
  items: { type: Array, default: () => [] }
})

const open = ref(true)

// Show only the classes currently on screen; fall back to the full list.
const rows = computed(() =>
  props.items.length
    ? props.items.map((i) => ({ value: i.value, name: i.name, css: i.css }))
    : NVIS_MVG_CLASSES.map((c) => ({ value: c.value, name: c.name, css: rgbToCss(c.rgb) }))
)
</script>

<template>
  <div class="legend panel" :class="{ 'is-collapsed': !open }">
    <button type="button" class="legend__header" @click="open = !open">
      <span class="legend__title">NVIS Major Vegetation Groups</span>
      <span class="legend__chevron">{{ open ? '▾' : '▸' }}</span>
    </button>

    <div v-show="open" class="legend__body">
      <ul class="legend__list">
        <li v-for="c in rows" :key="c.value" class="legend__item">
          <span class="swatch" :style="{ background: c.css }"></span>
          <span class="legend__name">
            <span class="legend__value">{{ c.value }}</span>
            {{ c.name }}
          </span>
        </li>
      </ul>
      <p class="legend__source">
        Source: NVIS v7.0 — Major Vegetation Groups (30&nbsp;m), DCCEEW.
      </p>
    </div>
  </div>
</template>

<style scoped>
.legend {
  position: absolute;
  bottom: 28px;
  left: 16px;
  width: 320px;
  max-height: calc(100% - 56px);
  z-index: 5;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.legend__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 12px 14px;
  border: none;
  background: transparent;
  text-align: left;
}

.legend__title {
  font-size: 13px;
  font-weight: 700;
  color: var(--text);
}

.legend__chevron {
  color: var(--muted);
}

.legend__body {
  padding: 0 14px 12px;
  overflow-y: auto;
}

.legend__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.legend__item {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  font-size: 12.5px;
  line-height: 1.3;
}

.swatch {
  flex: 0 0 auto;
  width: 16px;
  height: 16px;
  margin-top: 1px;
  border-radius: 3px;
  border: 1px solid rgba(0, 0, 0, 0.18);
}

.legend__name {
  color: var(--text);
}

.legend__value {
  display: inline-block;
  min-width: 18px;
  margin-right: 2px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}

.legend__source {
  margin: 12px 0 0;
  font-size: 11px;
  color: var(--muted);
}
</style>
