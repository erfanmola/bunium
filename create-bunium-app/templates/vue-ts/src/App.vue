<script setup lang="ts">
import { ref } from "vue";

// biome-ignore lint/correctness/noUnusedVariables: count is used in the template below; Biome doesn't cross-reference script-setup bindings with template usage.
const count = ref(0);
</script>

<template>
  <div style="font-family: sans-serif; padding: 2rem">
    <h1>__PROJECT_NAME__</h1>
    <p>A bunium + Vue + TypeScript app.</p>
    <button type="button" @click="count++">count is {{ count }}</button>
  </div>
</template>
