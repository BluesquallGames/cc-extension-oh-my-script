<script setup lang="ts">
import { onMounted, onUnmounted, PropType, ref } from 'vue';
import { BuildStateType, RightPanelState } from './state.js';
import dayjs from 'dayjs';

defineOptions({ name: 'OmsFooterRight' });

const props = defineProps({
  state: {
    type: Object as PropType<RightPanelState>,
    required: true,
  },
});

let ago = ref('');

let setIntervalHandle: ReturnType<typeof setInterval> | undefined;

onMounted(() => {
  setIntervalHandle = setInterval(() => {
    if (props.state.state === BuildStateType.completed) {
      ago.value = getAgoTime(props.state.startTime);
    }
  }, 1000);
});

onUnmounted(() => {
  if (setIntervalHandle) {
    clearInterval (setIntervalHandle);
  }
});

function getAgoTime(time: number) {
  const diff = Math.abs(dayjs(time).diff(dayjs(), 'seconds', true));
  if (diff < 1) {
    return 'just now';
  } else if (diff < 60) {
    return `Under 1 min`;
  } else if (diff < 60 * 60) {
    return `${Math.floor(diff / 60)} minutes ago`;
  } else {
    return `${Math.floor(diff / (60 * 60))} hours ago`;
  }
}
</script>

<template>
  <div class="oms-right">
    <span v-if="state.state === BuildStateType.never">N/A</span>

    <span v-else-if="state.state === BuildStateType.building">
      <ui-icon
        color
        value="refresh"
      />
    </span>

    <span v-else-if="state.state === BuildStateType.completed">
      <ui-icon
        color
        value="check"
      />
      <span>{{ ago }}</span>
    </span>
    <span v-else />
  </div>
</template>

<style lang="less" scoped>
.oms-right {
  height: 100%;
}
</style>
