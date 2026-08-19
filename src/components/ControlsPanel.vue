<script setup>
const emit = defineEmits(['reset-view'])
</script>

<template>
  <div class="controls panel">
    <h2 class="controls__title">Layer controls</h2>

    <button type="button" class="reset" @click="emit('reset-view')">
      ↺ Reset view to Australia
    </button>
  </div>
</template>

<style scoped>
.controls {
  position: absolute;
  top: 16px;
  right: 16px;
  width: 260px;
  padding: 16px;
  z-index: 5;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.controls__title {
  margin: 0;
  font-size: 13px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--muted);
}

.row {
  display: flex;
  font-size: 14px;
}

.row--switch {
  align-items: center;
  gap: 10px;
  font-weight: 600;
}

.row--switch input {
  width: 18px;
  height: 18px;
  accent-color: var(--accent);
}

.row--stack {
  flex-direction: column;
  gap: 6px;
}

.row__label {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  color: var(--muted);
  font-size: 13px;
}

.row__value {
  font-variant-numeric: tabular-nums;
  color: var(--text);
  font-weight: 600;
}

input[type='range'] {
  width: 100%;
  accent-color: var(--accent);
}

input:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.segmented {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 6px;
}

.segmented__btn {
  padding: 7px 8px;
  border: 1px solid var(--panel-border);
  background: #fff;
  border-radius: 8px;
  font-size: 13px;
  color: var(--text);
  transition: all 0.12s ease;
}

.segmented__btn:hover {
  border-color: var(--accent);
}

.segmented__btn.is-active {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
  font-weight: 600;
}

.reset {
  margin-top: 2px;
  padding: 9px 10px;
  border: 1px solid var(--panel-border);
  background: #fff;
  border-radius: 8px;
  font-size: 13px;
  color: var(--text);
}

.reset:hover {
  border-color: var(--accent-2);
  color: var(--accent-2);
}

.hint {
  margin: -4px 0 0;
  font-size: 12px;
  line-height: 1.4;
  color: var(--muted);
}

.hint code {
  background: #eef1f4;
  padding: 1px 4px;
  border-radius: 4px;
}
</style>
