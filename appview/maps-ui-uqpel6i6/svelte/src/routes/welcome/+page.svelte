<script lang="ts">
	// Charter §1.17.6 (ADR-2606071009): standalone pre-entry guidance route for maps.
	import NondualExperienceGuide from '$lib/components/NondualExperienceGuide.svelte';
	import { goto } from '$app/navigation';

	function enterMap() {
		try {
			localStorage.setItem('etz-nondual-guide-seen', '1');
		} catch {
			/* ignore */
		}
		goto('/');
	}
</script>

<NondualExperienceGuide onContinue={enterMap} />
