<script lang="ts">
	import { MapPin, Search, Navigation, Layers, ChevronLeft, X, Route, Cloud, ChevronRight } from 'lucide-svelte';
	import type { ActorContext } from '$lib/types';

	let { ctx }: { ctx: ActorContext } = $props();

	type ViewRoute = 'map' | 'search' | 'place' | 'routes' | 'route-detail';
	let currentRoute = $state<ViewRoute>('map');
	let routeParams = $state<Record<string, string>>({});
	let routeHistory = $state<Array<{ route: ViewRoute; params: Record<string, string> }>>([]);

	function navigate(route: ViewRoute, params: Record<string, string> = {}) {
		routeHistory = [...routeHistory, { route: currentRoute, params: routeParams }];
		currentRoute = route;
		routeParams = params;
	}

	function goBack() {
		const prev = routeHistory[routeHistory.length - 1];
		if (prev) {
			routeHistory = routeHistory.slice(0, -1);
			currentRoute = prev.route;
			routeParams = prev.params;
		} else {
			currentRoute = 'map';
			routeParams = {};
		}
	}

	const SVC = 'etzhayyim.maps.v1.MapsUIService';

	interface SearchResult {
		id: string;
		title: string;
		snippet?: string;
		source: string;
		kind: string;
		latitude?: number;
		longitude?: number;
		score: number;
	}

	interface SavedRoute {
		id: string;
		name: string;
		profile: string;
		'distance_meters': number;
		'duration_seconds': number;
		'created_at': string;
		start: { lat: number; lng: number; label: string };
		end: { lat: number; lng: number; label: string };
	}

	interface WeatherData {
		weather_wind_speed_10m?: number;
		weather_pressure_msl?: number;
		weather_precipitation?: number;
		weather_weather_code?: number;
	}

	// Map state
	let mapContainer = $state<HTMLElement>();
	let mapInstance = $state<any>(null);
	let mapReady = $state(false);
	let mapError = $state<string | null>(null);
	let lat = $state(35.6812);
	let lng = $state(139.7671);
	let zoom = $state(12);

	// Search state
	let searchQuery = $state('');
	let searchResults = $state<SearchResult[]>([]);
	let searching = $state(false);

	// Routes state
	let savedRoutes = $state<SavedRoute[]>([]);
	let routesLoading = $state(false);

	// Weather state
	let weather = $state<WeatherData | null>(null);

	// Map initialization
	async function initMap() {
		if (!mapContainer || mapInstance) return;
		try {
			const maplibregl = await import('maplibre-gl');
			await import('maplibre-gl/dist/maplibre-gl.css');

			let styleUrl = 'https://tiles.openfreemap.org/styles/liberty';
			try {
				const config = await ctx.backend.call<{ style_url?: string }>(SVC, 'RuntimeConfig', {});
				if (config.style_url) styleUrl = config.style_url;
			} catch (error) { console.warn("[silent-fail] projects/etzhayyim-project-maps/wasm/maps-ui-uqpel6i6/svelte/src/appview.svelte: suppressed error", error); }

			mapInstance = new maplibregl.Map({
				container: mapContainer,
				style: styleUrl,
				center: [lng, lat],
				zoom,
			});

			mapInstance.addControl(new maplibregl.NavigationControl(), 'top-right');

			mapInstance.on('load', () => {
				mapReady = true;
				loadWeather();
			});

			mapInstance.on('moveend', () => {
				const center = mapInstance.getCenter();
				lat = center.lat;
				lng = center.lng;
				zoom = mapInstance.getZoom();
			});

			mapInstance.on('click', async (e: any) => {
				const { lat: clickLat, lng: clickLng } = e.lngLat;
				try {
					const result = await ctx.backend.call<{ place?: { label: string; 'node_id': string } }>(
						SVC, 'PlaceReversGeocode', { lat: clickLat, lng: clickLng }
					);
					if (result.place) {
						navigate('place', {
							id: result.place.node_id,
							label: result.place.label,
							lat: String(clickLat),
							lng: String(clickLng),
						});
					}
				} catch (error) { console.warn("[silent-fail] projects/etzhayyim-project-maps/wasm/maps-ui-uqpel6i6/svelte/src/appview.svelte: suppressed error", error); }
			});
		} catch (e) {
			mapError = e instanceof Error ? e.message : 'Failed to initialize map';
		}
	}

	$effect(() => {
		if (mapContainer && currentRoute === 'map') initMap();
	});

	async function searchPlaces() {
		if (!searchQuery.trim()) return;
		searching = true;
		try {
			const result = await ctx.backend.call<{ results: SearchResult[] }>(SVC, 'SearchResources', {
				q: searchQuery.trim(), limit: 10,
			});
			searchResults = result.results ?? [];
		} catch {
			searchResults = [];
		} finally {
			searching = false;
		}
	}

	function flyTo(latitude: number, longitude: number) {
		if (mapInstance) {
			mapInstance.flyTo({ center: [longitude, latitude], zoom: 15 });
		}
		currentRoute = 'map';
		routeHistory = [];
		routeParams = {};
	}

	async function loadRoutes() {
		routesLoading = true;
		try {
			const result = await ctx.backend.call<{ routes: SavedRoute[] }>(SVC, 'RouteList', { offset: 0, limit: 20 });
			savedRoutes = result.routes ?? [];
		} catch {
			savedRoutes = [];
		} finally {
			routesLoading = false;
		}
	}

	async function loadWeather() {
		try {
			const result = await ctx.backend.call<{ features?: Array<{ properties: WeatherData }> }>(
				SVC, 'WeatherGrid', { latitude: lat, longitude: lng, 'grid_step': 0.5, 'grid_radius': 1 }
			);
			if (result.features?.length) {
				weather = result.features[0].properties;
			}
		} catch (error) { console.warn("[silent-fail] projects/etzhayyim-project-maps/wasm/maps-ui-uqpel6i6/svelte/src/appview.svelte: suppressed error", error); }
	}

	function formatDistance(meters: number): string {
		if (meters < 1000) return `${Math.round(meters)}m`;
		return `${(meters / 1000).toFixed(1)}km`;
	}

	function formatDuration(seconds: number): string {
		if (seconds < 60) return `${Math.round(seconds)}s`;
		if (seconds < 3600) return `${Math.round(seconds / 60)}min`;
		const h = Math.floor(seconds / 3600);
		const m = Math.round((seconds % 3600) / 60);
		return `${h}h ${m}m`;
	}

	function weatherIcon(code?: number): string {
		if (!code) return 'sun';
		if (code <= 3) return 'sun';
		if (code <= 49) return 'cloud';
		if (code <= 69) return 'cloud-rain';
		if (code <= 79) return 'cloud-snow';
		return 'cloud-lightning';
	}
</script>

<div class="min-h-full bg-[var(--gv2-bg-primary)] text-[var(--gv2-text-primary)]">
	{#if currentRoute === 'map'}
		<!-- Map View -->
		<div class="relative h-[100dvh] w-full">
			<div bind:this={mapContainer} class="absolute inset-0"></div>

			<!-- Search bar overlay -->
			<div class="absolute left-3 right-3 top-3 z-10">
				<div class="flex items-center gap-2 rounded-xl bg-[var(--gv2-bg-primary)]/95 px-3 py-2.5 shadow-lg backdrop-blur">
					<Search class="h-4 w-4 text-[var(--gv2-text-tertiary)]" />
					<input
						type="text"
						placeholder="Search places..."
						bind:value={searchQuery}
						onfocus={() => navigate('search')}
						class="flex-1 bg-transparent text-sm text-[var(--gv2-text-primary)] placeholder:text-[var(--gv2-text-tertiary)] outline-none"
					/>
				</div>
			</div>

			<!-- Weather chip -->
			{#if weather}
				<div class="absolute right-3 top-16 z-10 rounded-xl bg-[var(--gv2-bg-primary)]/90 px-3 py-2 shadow-lg backdrop-blur">
					<div class="flex items-center gap-2 text-xs">
						<Cloud class="h-3.5 w-3.5 text-[var(--gv2-text-secondary)]" />
						{#if weather.weather_precipitation !== undefined}
							<span>{weather.weather_precipitation}mm</span>
						{/if}
						{#if weather.weather_wind_speed_10m !== undefined}
							<span>{weather.weather_wind_speed_10m}m/s</span>
						{/if}
					</div>
				</div>
			{/if}

			<!-- Bottom action bar -->
			<div class="absolute bottom-6 left-3 right-3 z-10 flex items-center justify-center gap-3">
				<button
					onclick={() => { loadRoutes(); navigate('routes'); }}
					class="flex items-center gap-2 rounded-xl bg-[var(--gv2-bg-primary)]/95 px-4 py-3 shadow-lg backdrop-blur active:opacity-80"
				>
					<Route class="h-4 w-4 text-[var(--gv2-accent)]" />
					<span class="text-sm font-medium">Routes</span>
				</button>
				<button
					onclick={() => {
						if (navigator.geolocation) {
							navigator.geolocation.getCurrentPosition(
								(pos) => flyTo(pos.coords.latitude, pos.coords.longitude),
								() => {}
							);
						}
					}}
					class="flex h-12 w-12 items-center justify-center rounded-full bg-[var(--gv2-accent)] text-white shadow-lg active:opacity-80"
				>
					<Navigation class="h-5 w-5" />
				</button>
				<button
					onclick={loadWeather}
					class="flex items-center gap-2 rounded-xl bg-[var(--gv2-bg-primary)]/95 px-4 py-3 shadow-lg backdrop-blur active:opacity-80"
				>
					<Layers class="h-4 w-4 text-[var(--gv2-text-secondary)]" />
					<span class="text-sm font-medium">Layers</span>
				</button>
			</div>

			{#if mapError}
				<div class="absolute inset-0 flex items-center justify-center bg-[var(--gv2-bg-primary)]">
					<div class="text-center px-6">
						<MapPin class="mx-auto mb-3 h-12 w-12 text-[var(--gv2-text-tertiary)]" />
						<p class="text-sm text-red-400">{mapError}</p>
					</div>
				</div>
			{/if}
		</div>

	{:else if currentRoute === 'search'}
		<!-- Search View -->
		<div class="max-w-[600px] mx-auto p-4">
			<div class="flex items-center gap-2 mb-4">
				<button onclick={goBack} class="text-[var(--gv2-text-tertiary)] active:opacity-80">
					<ChevronLeft class="h-5 w-5" />
				</button>
				<div class="flex-1 flex items-center gap-2 px-3 py-2.5 rounded-xl bg-[var(--gv2-bg-secondary)]">
					<Search class="h-4 w-4 text-[var(--gv2-text-tertiary)]" />
					<input
						type="text"
						placeholder="Search places, addresses..."
						bind:value={searchQuery}
						onkeydown={(e) => e.key === 'Enter' && searchPlaces()}
						class="flex-1 bg-transparent text-sm text-[var(--gv2-text-primary)] placeholder:text-[var(--gv2-text-tertiary)] outline-none"
					/>
					{#if searchQuery}
						<button onclick={() => { searchQuery = ''; searchResults = []; }} class="text-[var(--gv2-text-tertiary)]">
							<X class="h-4 w-4" />
						</button>
					{/if}
				</div>
			</div>

			{#if searching}
				<p class="text-sm text-[var(--gv2-text-tertiary)] text-center py-6">Searching...</p>
			{:else if searchResults.length > 0}
				<div class="space-y-1">
					{#each searchResults as result (result.id)}
						<button
							onclick={() => {
								if (result.latitude && result.longitude) {
									flyTo(result.latitude, result.longitude);
								}
							}}
							class="w-full flex items-start gap-3 rounded-xl bg-[var(--gv2-bg-secondary)] p-3 text-left active:opacity-80"
						>
							<MapPin class="h-4 w-4 mt-0.5 text-[var(--gv2-accent)] shrink-0" />
							<div class="min-w-0 flex-1">
								<p class="text-sm font-medium text-[var(--gv2-text-primary)] truncate">{result.title}</p>
								{#if result.snippet}
									<p class="text-xs text-[var(--gv2-text-tertiary)] truncate mt-0.5">{result.snippet}</p>
								{/if}
								<div class="flex items-center gap-2 mt-1">
									<span class="text-[10px] px-1.5 py-0.5 rounded bg-[var(--gv2-bg-tertiary)] text-[var(--gv2-text-tertiary)]">{result.source}</span>
									<span class="text-[10px] text-[var(--gv2-text-tertiary)]">{result.kind}</span>
								</div>
							</div>
						</button>
					{/each}
				</div>
			{:else if searchQuery}
				<p class="text-sm text-[var(--gv2-text-tertiary)] text-center py-8">No results for "{searchQuery}"</p>
			{:else}
				<div class="space-y-4 pt-4">
					<p class="text-xs text-[var(--gv2-text-tertiary)] uppercase tracking-wider">Suggestions</p>
					{#each [
						{ label: 'Tokyo Station', lat: 35.6812, lng: 139.7671 },
						{ label: 'Shibuya Crossing', lat: 35.6595, lng: 139.7004 },
						{ label: 'Mount Fuji', lat: 35.3606, lng: 138.7274 },
						{ label: 'Osaka Castle', lat: 34.6873, lng: 135.5262 },
					] as suggestion}
						<button
							onclick={() => flyTo(suggestion.lat, suggestion.lng)}
							class="w-full flex items-center gap-3 rounded-xl bg-[var(--gv2-bg-secondary)] p-3 text-left active:opacity-80"
						>
							<MapPin class="h-4 w-4 text-[var(--gv2-text-tertiary)]" />
							<span class="text-sm text-[var(--gv2-text-primary)]">{suggestion.label}</span>
						</button>
					{/each}
				</div>
			{/if}
		</div>

	{:else if currentRoute === 'place'}
		<!-- Place Detail View -->
		<div class="max-w-[600px] mx-auto p-4">
			<button onclick={goBack} class="inline-flex items-center gap-1 text-sm text-[var(--gv2-text-tertiary)] active:opacity-80 mb-4">
				<ChevronLeft class="h-4 w-4" /> Back
			</button>

			<div class="rounded-xl bg-[var(--gv2-bg-secondary)] p-4 mb-3">
				<div class="flex items-start gap-3">
					<div class="flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--gv2-accent)]/20">
						<MapPin class="h-5 w-5 text-[var(--gv2-accent)]" />
					</div>
					<div class="flex-1 min-w-0">
						<h1 class="text-lg font-bold text-[var(--gv2-text-primary)]">{routeParams.label || 'Place'}</h1>
						<p class="text-xs text-[var(--gv2-text-tertiary)] mt-0.5">
							{Number(routeParams.lat).toFixed(4)}, {Number(routeParams.lng).toFixed(4)}
						</p>
					</div>
				</div>
			</div>

			<div class="flex gap-2 mb-3">
				<button
					onclick={() => flyTo(Number(routeParams.lat), Number(routeParams.lng))}
					class="flex-1 flex items-center justify-center gap-2 rounded-xl bg-[var(--gv2-accent)] px-4 py-3 text-sm font-medium text-white active:opacity-80"
				>
					<Navigation class="h-4 w-4" /> Navigate
				</button>
				<button
					onclick={() => {
						const url = `https://www.google.com/maps?q=${routeParams.lat},${routeParams.lng}`;
						window.open(url, '_blank');
					}}
					class="flex items-center justify-center gap-2 rounded-xl bg-[var(--gv2-bg-secondary)] px-4 py-3 text-sm font-medium text-[var(--gv2-text-secondary)] active:opacity-80"
				>
					Share
				</button>
			</div>
		</div>

	{:else if currentRoute === 'routes'}
		<!-- Saved Routes View -->
		<div class="max-w-[600px] mx-auto p-4">
			<button onclick={goBack} class="inline-flex items-center gap-1 text-sm text-[var(--gv2-text-tertiary)] active:opacity-80 mb-4">
				<ChevronLeft class="h-4 w-4" /> Map
			</button>

			<h1 class="text-xl font-bold text-[var(--gv2-text-primary)] mb-4">Saved Routes</h1>

			{#if routesLoading}
				<p class="text-sm text-[var(--gv2-text-tertiary)] text-center py-8">Loading...</p>
			{:else if savedRoutes.length === 0}
				<div class="flex flex-col items-center justify-center py-12 text-center">
					<Route class="mb-3 h-12 w-12 text-[var(--gv2-text-tertiary)]" />
					<p class="text-sm text-[var(--gv2-text-secondary)]">No saved routes yet.</p>
					<p class="text-xs text-[var(--gv2-text-tertiary)] mt-1">Long-press on the map to create a route.</p>
				</div>
			{:else}
				<div class="space-y-2">
					{#each savedRoutes as route (route.id)}
						<button
							onclick={() => navigate('route-detail', { routeId: route.id })}
							class="w-full rounded-xl bg-[var(--gv2-bg-secondary)] p-4 text-left active:opacity-80"
						>
							<div class="flex items-center justify-between">
								<div class="min-w-0 flex-1">
									<p class="text-sm font-medium text-[var(--gv2-text-primary)] truncate">{route.name || 'Unnamed route'}</p>
									<div class="flex items-center gap-3 mt-1 text-xs text-[var(--gv2-text-tertiary)]">
										<span>{formatDistance(route.distance_meters)}</span>
										<span>{formatDuration(route.duration_seconds)}</span>
										<span class="px-1.5 py-0.5 rounded bg-[var(--gv2-bg-tertiary)]">{route.profile}</span>
									</div>
									<p class="text-xs text-[var(--gv2-text-tertiary)] mt-1 truncate">
										{route.start?.label || 'Start'} -> {route.end?.label || 'End'}
									</p>
								</div>
								<ChevronRight class="h-4 w-4 text-[var(--gv2-text-tertiary)] shrink-0" />
							</div>
						</button>
					{/each}
				</div>
			{/if}
		</div>

	{:else if currentRoute === 'route-detail'}
		<!-- Route Detail View -->
		<div class="max-w-[600px] mx-auto p-4">
			<button onclick={goBack} class="inline-flex items-center gap-1 text-sm text-[var(--gv2-text-tertiary)] active:opacity-80 mb-4">
				<ChevronLeft class="h-4 w-4" /> Routes
			</button>

			{#if savedRoutes.find(r => r.id === routeParams.routeId)}
				{@const route = savedRoutes.find(r => r.id === routeParams.routeId)!}
				<div class="rounded-xl bg-[var(--gv2-bg-secondary)] p-4 mb-3">
					<h1 class="text-lg font-bold text-[var(--gv2-text-primary)] mb-2">{route.name || 'Unnamed route'}</h1>
					<div class="flex items-center gap-3 text-sm text-[var(--gv2-text-tertiary)]">
						<span>{formatDistance(route.distance_meters)}</span>
						<span>{formatDuration(route.duration_seconds)}</span>
						<span class="px-2 py-0.5 rounded bg-[var(--gv2-bg-tertiary)]">{route.profile}</span>
					</div>
				</div>

				<div class="rounded-xl bg-[var(--gv2-bg-secondary)] p-4 mb-3">
					<div class="space-y-3">
						<div class="flex items-center gap-3">
							<div class="h-3 w-3 rounded-full bg-green-500"></div>
							<div>
								<p class="text-xs text-[var(--gv2-text-tertiary)]">Start</p>
								<p class="text-sm text-[var(--gv2-text-primary)]">{route.start?.label || `${route.start?.lat}, ${route.start?.lng}`}</p>
							</div>
						</div>
						<div class="ml-1.5 border-l-2 border-dashed border-[var(--gv2-border)] h-4"></div>
						<div class="flex items-center gap-3">
							<div class="h-3 w-3 rounded-full bg-red-500"></div>
							<div>
								<p class="text-xs text-[var(--gv2-text-tertiary)]">End</p>
								<p class="text-sm text-[var(--gv2-text-primary)]">{route.end?.label || `${route.end?.lat}, ${route.end?.lng}`}</p>
							</div>
						</div>
					</div>
				</div>

				<button
					onclick={() => {
						if (route.start) flyTo(route.start.lat, route.start.lng);
					}}
					class="w-full rounded-xl bg-[var(--gv2-accent)] px-4 py-3 text-sm font-medium text-white text-center active:opacity-80"
				>
					Show on Map
				</button>
			{:else}
				<div class="rounded-xl bg-red-500/10 border border-red-500/20 p-3 text-red-400 text-sm">Route not found.</div>
			{/if}
		</div>
	{/if}
</div>
