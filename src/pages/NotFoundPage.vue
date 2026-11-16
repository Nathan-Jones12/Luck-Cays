<script setup lang="ts">
/** 404. */
</script>

<template>
  <div class="page center not-found">
    <h1>Nothing here</h1>
    <p class="muted">That page does not exist. The games are all one click away.</p>
    <div class="row actions">
      <RouterLink to="/" class="btn btn-primary">Back to the lobby</RouterLink>
      <RouterLink to="/slots" class="btn btn-ghost">Play slots</RouterLink>
    </div>
  </div>
</template>

<style scoped>
.not-found {
  padding-top: 80px;
  max-width: 480px;
}

.actions {
  justify-content: center;
  margin-top: 20px;
}
</style>
