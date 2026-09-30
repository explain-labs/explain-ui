<script setup lang="ts"></script>

<template>
  <!-- keyed on the lesson id so /lesson/a → /lesson/b remounts the page (a
       ?step= change keeps the same key) -->
  <router-view :key="String($route.name) + ':' + ($route.params.id ?? '')" />
</template>
