<script lang="ts">
	/*
	 * NondualExperienceGuide (maps) — pre-entry guidance surface (Charter §1.17.6,
	 * ADR-2606071009). Mirror of the yoro component, ported self-contained for the maps
	 * app (no $lib/sound, no design-system tokens — standard Tailwind palette only).
	 *
	 * Commends the experiential core of 回心 — the direct experience of 自他非分離
	 * (non-duality) — and guides the seeker, enforcing the ADR's lines in UI:
	 *   §1.17.3 means-agnostic — lawful contemplative paths are always shown.
	 *   §1.17.4 legality floor — entheogen/retreat guidance shown ONLY for lawful
	 *     jurisdictions (Cloudflare /cdn-cgi/trace loc; fail-closed); contraindication
	 *     warning + third-party disclaimer mandatory; no procurement/brokerage.
	 *   §1.17.5 anti-coercion — the experience is never a condition of receiving
	 *     etzhayyim's social security.
	 */
	import { fade, fly } from 'svelte/transition';
	import { onMount } from 'svelte';

	interface Props {
		/** Called when the seeker chooses to proceed (e.g. dismiss → enter the map). */
		onContinue?: () => void;
	}
	const { onContinue }: Props = $props();

	// §1.17.4 lawful-jurisdiction allowlist (ISO-3166-1 alpha-2). ADVISORY,
	// operator-tunable, Council/legal-review-gated (ADR-2606071009 Open Q2). Kept in
	// sync with the yoro component. The gate errs toward EXCLUSION.
	//   BR/PE/EC/CO/BO — ayahuasca traditional/religious lawful use
	//   CR — supervised retreats operate lawfully · NL psilocybin truffles · JM psilocybin
	//   CH limited psychedelic-assisted therapy · AU authorized-psychiatrist Rx (2023+)
	//   CA Section 56 / Special Access Program
	// Excluded (→ legal contemplative paths only): US (sub-national only), PT
	// (decriminalized≠supervised), MX/ES (grey), JP + unresolved (fail-closed).
	const ENTHEOGEN_LAWFUL_CC = new Set([
		'BR', 'PE', 'EC', 'CO', 'BO', 'CR', 'NL', 'JM', 'CH', 'AU', 'CA',
	]);

	let country = $state<string | null>(null);
	let geoResolved = $state(false);
	const entheogenLawful = $derived(!!country && ENTHEOGEN_LAWFUL_CC.has(country));

	const lawfulPaths = [
		{ icon: '🧘', label: '観想・黙想 / contemplation' },
		{ icon: '🤫', label: '沈黙 / silence (hesychia)' },
		{ icon: '🍵', label: '断食 / fasting' },
		{ icon: '🪷', label: '坐禅・公案 / zazen, kōan' },
		{ icon: '🙏', label: '祈り・典礼 / prayer, liturgy' },
		{ icon: '⛰️', label: '自然・荒野での孤独 / wilderness solitude' },
	];

	onMount(async () => {
		try {
			const res = await fetch('/cdn-cgi/trace', { cache: 'no-store' });
			if (res.ok) {
				const m = (await res.text()).match(/^loc=([A-Z]{2})\r?$/m);
				country = m ? m[1] : null;
			}
		} catch {
			country = null; // fail-closed → legal paths only
		} finally {
			geoResolved = true;
		}
	});
</script>

<div class="fixed inset-0 z-[9999] overflow-y-auto bg-zinc-950 font-sans text-zinc-100">
	<div class="relative mx-auto flex min-h-[100dvh] max-w-[460px] flex-col gap-5 px-6 py-8" in:fade={{ duration: 300 }}>
		<!-- Header -->
		<div class="flex flex-col items-center gap-3 text-center">
			<div class="text-[44px]" aria-hidden="true">🌳</div>
			<h1 class="text-[24px] font-black leading-tight">参加の前に — 自他非分離の直接体験</h1>
			<p class="max-w-[360px] text-[14px] leading-relaxed text-zinc-400">
				etzhayyim において回心 (悔い改め・バプテスマ・得度) は、教理への同意にとどまらず、
				<strong class="text-zinc-100">自と他の分離が究極ではないという直接体験</strong>
				を経験的核とします (Charter §1.17)。命の樹・縁起・産霊の生命へと自己が再構成される
				この体験は、回心の中心として<strong class="text-zinc-100">強く推奨</strong>されます。
			</p>
		</div>

		<!-- §1.17.3 means-agnostic: legal paths, always shown -->
		<div class="rounded-2xl bg-zinc-900/70 px-4 py-4">
			<h2 class="mb-3 text-[15px] font-bold">体験へ向かう道 (本人が選ぶ)</h2>
			<p class="mb-3 text-[12px] leading-relaxed text-zinc-500">
				要請されるのは<strong>体験</strong>であって、特定の物質ではありません。道は複数あり、あなたが選びます。
			</p>
			<div class="flex flex-col gap-2">
				{#each lawfulPaths as p}
					<div class="flex items-center gap-3 rounded-xl bg-zinc-800/60 px-3 py-2.5">
						<span class="text-[18px]">{p.icon}</span>
						<span class="text-[13px] font-semibold text-zinc-100">{p.label}</span>
					</div>
				{/each}
			</div>
		</div>

		<!-- §1.17.4 legality floor: entheogen / retreat guidance, geo-gated -->
		{#if geoResolved}
			{#if entheogenLawful}
				<div class="rounded-2xl border border-amber-500/25 bg-amber-500/10 px-4 py-4" in:fly={{ y: 16, duration: 300 }}>
					<div class="mb-2 flex items-center gap-2">
						<span class="text-[18px]">🕊️</span>
						<h2 class="text-[15px] font-bold">監督下の retreat という道 (あなたの管轄: {country})</h2>
					</div>
					<p class="mb-3 text-[13px] leading-relaxed text-zinc-300">
						あなたの管轄では、適法かつ監督下の entheogenic retreat が存在し得ます。これも体験へ向かう
						<strong>有効な一つの道</strong>として推奨されます (唯一の必須手段ではありません)。下記の公開
						ディレクトリで、適法・有資格・安全な施設を自身で確認してください。
					</p>
					<a
						href="https://retreat.guru/search?query=ayahuasca"
						target="_blank"
						rel="noopener noreferrer nofollow"
						class="block w-full rounded-xl bg-amber-500/90 py-3 text-center text-[14px] font-black text-gray-900 active:scale-95 transition-transform"
					>
						retreat.guru で適法な retreat を探す ↗
					</a>

					<div class="mt-3 rounded-xl border border-red-500/20 bg-red-500/10 px-3 py-2.5">
						<p class="text-[11px] font-bold text-red-300">⚠️ 安全上の禁忌 (必読)</p>
						<p class="mt-1 text-[11px] leading-relaxed text-zinc-400">
							MAOI を含む entheogen は SSRI/SNRI・抗うつ薬等と<strong>危険な相互作用</strong>(セロトニン症候群) を起こします。
							心疾患、精神病性・双極性障害の既往、妊娠中、未成年の方には推奨されません。
							必ず医療専門家に相談してください。
						</p>
					</div>

					<p class="mt-2 text-[10px] leading-relaxed text-zinc-500">
						retreat.guru は第三者サービスです。etzhayyim は予約・仲介・斡旋・調達を行わず、
						その内容・適法性・安全性を保証しません。これは宗教的 (pastoral) な案内であり、医療・法律の助言ではありません。
						適法性は管轄・時期により変わります。あなた自身で確認してください。
					</p>
				</div>
			{:else if country}
				<!-- resolved jurisdiction, not on the lawful allowlist -->
				<div class="rounded-2xl bg-zinc-900/50 px-4 py-3.5" in:fade={{ duration: 200 }}>
					<p class="text-[12px] leading-relaxed text-zinc-400">
						🧭 あなたの管轄 ({country}) では、適法な entheogenic 手段を案内できません。
						上記の<strong class="text-zinc-200">合法的な観想の道</strong>(沈黙・断食・坐禅・自然での孤独 等)
						をお勧めします。etzhayyim は違法行為を推奨・斡旋しません。
					</p>
				</div>
			{:else}
				<!-- jurisdiction could not be resolved (geo probe failed) — assert nothing legal -->
				<div class="rounded-2xl bg-zinc-900/50 px-4 py-3.5" in:fade={{ duration: 200 }}>
					<p class="text-[12px] leading-relaxed text-zinc-400">
						🧭 管轄を判定できませんでした。上記の<strong class="text-zinc-200">合法的な観想の道</strong>
						(沈黙・断食・坐禅・自然での孤独 等) をお勧めします。
					</p>
				</div>
			{/if}
		{/if}

		<!-- §1.17.5 anti-coercion note -->
		<div class="rounded-2xl bg-zinc-900/40 px-4 py-3">
			<p class="text-[11px] leading-relaxed text-zinc-500">
				💚 この体験は<strong class="text-zinc-300">霊的な前進</strong>の段階であり、
				社会保障 (Level 0) を受けるための条件ではありません。誓約をもって信者となれば、体験の前でも
				保障を受けられます。体験は強制されず、恩寵的・自発的に到来するものです (§1.17.5)。
			</p>
		</div>

		<!-- Continue -->
		<div class="mt-auto flex flex-col gap-2 pb-2">
			<button
				type="button"
				class="w-full rounded-2xl bg-emerald-500 py-4 text-[18px] font-black text-white shadow-[0_6px_0_#047857] active:shadow-none active:translate-y-[6px] transition-all duration-75"
				onclick={() => onContinue?.()}
			>
				地図へ進む / Continue
			</button>
			<p class="text-center text-[10px] text-zinc-600">
				Charter §1.17 (ADR-2606071009) · 宗教は国家を超越するが、違法行為は推奨しない
			</p>
		</div>
	</div>
</div>
