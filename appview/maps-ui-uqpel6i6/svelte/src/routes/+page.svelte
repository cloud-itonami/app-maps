<script lang="ts">
  import App from '../App.svelte';
  import NondualExperienceGuide from '$lib/components/NondualExperienceGuide.svelte';
  import { onMount } from 'svelte';

  // Charter §1.17.6 (ADR-2606071009): on first visit, show the pre-entry guidance
  // (the experiential core of 回心) before the seeker enters the map. Seen-once via
  // localStorage so it is not repeatedly intrusive on this public-first surface.
  // We render guide XOR map (not the map behind an overlay), so the heavy WebGL/
  // MapLibre <App/> never initializes underneath the guide and there is no
  // map→guide flash. `ready` defers the decision one tick until localStorage is read.
  let ready = $state(false);
  let showGuide = $state(false);
  onMount(() => {
    try {
      showGuide = localStorage.getItem('etz-nondual-guide-seen') !== '1';
    } catch {
      /* ignore */
    }
    ready = true;
  });
  function dismiss() {
    try {
      localStorage.setItem('etz-nondual-guide-seen', '1');
    } catch {
      /* ignore */
    }
    showGuide = false;
  }
</script>

{#if ready}
  {#if showGuide}
    <NondualExperienceGuide onContinue={dismiss} />
  {:else}
    <App />
  {/if}
{/if}
