// Turn-by-turn navigation types and utilities for OSRM steps

export interface NavigationStep {
  instruction: string;
  instructionEn: string;
  distance: number;
  duration: number;
  maneuverType: string;
  maneuverModifier: string;
  maneuverLocation: [number, number];
  bearingBefore: number;
  bearingAfter: number;
  roadName: string;
  geometry: any;
  lanes?: Array<{ indications: string[]; valid: boolean }>;
  exit?: number;
}

export interface NavigationRoute {
  geometry: any;
  distance: number;
  duration: number;
  index: number;
  steps: NavigationStep[];
  legSummary: string;
}

const MANEUVER_TYPE_JA: Record<string, string> = {
  turn: '曲がる',
  'new name': '道路変更',
  depart: '出発',
  arrive: '到着',
  merge: '合流',
  'on ramp': 'ランプ進入',
  'off ramp': 'ランプ退出',
  fork: '分岐',
  'end of road': '道路終端',
  continue: '直進',
  roundabout: 'ロータリー',
  rotary: 'ロータリー',
  'roundabout turn': 'ロータリー内曲折',
  notification: '通知',
  'exit roundabout': 'ロータリー出口',
  'exit rotary': 'ロータリー出口',
};

const MANEUVER_MODIFIER_JA: Record<string, string> = {
  uturn: 'Uターン',
  'sharp right': '鋭角右折',
  right: '右折',
  'slight right': '斜め右',
  straight: '直進',
  'slight left': '斜め左',
  left: '左折',
  'sharp left': '鋭角左折',
};

const MANEUVER_MODIFIER_EN: Record<string, string> = {
  uturn: 'Make a U-turn',
  'sharp right': 'Turn sharp right',
  right: 'Turn right',
  'slight right': 'Bear right',
  straight: 'Continue straight',
  'slight left': 'Bear left',
  left: 'Turn left',
  'sharp left': 'Turn sharp left',
};

export function buildStepInstruction(
  step: { maneuver: any; name?: string; ref?: string; distance?: number },
  lang: 'ja' | 'en' = 'ja',
): string {
  const { maneuver, name, ref } = step;
  const type: string = maneuver?.type || '';
  const modifier: string = maneuver?.modifier || '';
  const exit: number | undefined = maneuver?.exit;
  const roadName = name || ref || '';

  if (lang === 'en') {
    if (type === 'depart') return roadName ? `Start on ${roadName}` : 'Start';
    if (type === 'arrive') {
      if (modifier === 'left') return 'Destination is on the left';
      if (modifier === 'right') return 'Destination is on the right';
      return 'Arrive at destination';
    }
    if (type === 'roundabout' || type === 'rotary') {
      const e = exit || 1;
      return roadName ? `At roundabout, take exit ${e} onto ${roadName}` : `At roundabout, take exit ${e}`;
    }
    const modEn = MANEUVER_MODIFIER_EN[modifier] || modifier;
    if (type === 'turn' || type === 'fork' || type === 'end of road') {
      return roadName ? `${modEn} onto ${roadName}` : modEn;
    }
    if (type === 'new name' || type === 'continue') {
      return roadName ? `Continue on ${roadName}` : 'Continue';
    }
    if (type === 'merge') {
      return roadName ? `Merge onto ${roadName}` : `Merge ${modEn.toLowerCase()}`;
    }
    if (type === 'on ramp') return roadName ? `Take ramp onto ${roadName}` : 'Take ramp';
    if (type === 'off ramp') return roadName ? `Take exit toward ${roadName}` : 'Take exit';
    return roadName ? `${modEn} ${roadName}` : modEn || type;
  }

  // Japanese
  const modJa = modifier ? (MANEUVER_MODIFIER_JA[modifier] || modifier) : '';

  if (type === 'depart') return roadName ? `${roadName}を出発` : '出発';
  if (type === 'arrive') {
    if (modifier === 'left') return '目的地は左側です';
    if (modifier === 'right') return '目的地は右側です';
    return '目的地に到着';
  }
  if (type === 'roundabout' || type === 'rotary') {
    const e = exit || 1;
    return roadName
      ? `ロータリーで${e}番目の出口を${roadName}方面へ`
      : `ロータリーで${e}番目の出口を出る`;
  }
  if (type === 'turn' || type === 'fork' || type === 'end of road') {
    return roadName ? `${modJa}して${roadName}へ` : modJa;
  }
  if (type === 'new name' || type === 'continue') {
    return roadName ? `${roadName}を直進` : '直進';
  }
  if (type === 'merge') {
    return roadName ? `${roadName}に合流` : `${modJa}に合流`;
  }
  if (type === 'on ramp') return roadName ? `${roadName}のランプへ進入` : 'ランプへ進入';
  if (type === 'off ramp') return roadName ? `${roadName}方面の出口へ` : '出口へ';
  return roadName ? `${modJa} ${roadName}` : `${MANEUVER_TYPE_JA[type] || type} ${modJa}`;
}

export function getManeuverIcon(type: string, modifier?: string): string {
  if (type === 'depart') return 'A';
  if (type === 'arrive') return 'B';
  if (type === 'roundabout' || type === 'rotary') return '\u21BB';
  if (!modifier) return '\u2191';
  const icons: Record<string, string> = {
    uturn: '\u21B6',
    'sharp right': '\u2197',
    right: '\u2192',
    'slight right': '\u2197',
    straight: '\u2191',
    'slight left': '\u2196',
    left: '\u2190',
    'sharp left': '\u2196',
  };
  return icons[modifier] || '\u2191';
}

export function parseOSRMSteps(legs: any[]): NavigationStep[] {
  const steps: NavigationStep[] = [];
  for (const leg of legs) {
    for (const s of leg.steps || []) {
      steps.push({
        instruction: buildStepInstruction(s, 'ja'),
        instructionEn: buildStepInstruction(s, 'en'),
        distance: s.distance || 0,
        duration: s.duration || 0,
        maneuverType: s.maneuver?.type || '',
        maneuverModifier: s.maneuver?.modifier || '',
        maneuverLocation: s.maneuver?.location || [0, 0],
        bearingBefore: s.maneuver?.bearingBefore || 0,
        bearingAfter: s.maneuver?.bearingAfter || 0,
        roadName: s.name || s.ref || '',
        geometry: s.geometry,
        lanes: s.intersections?.[0]?.lanes,
        exit: s.maneuver?.exit,
      });
    }
  }
  return steps;
}

export function haversineDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Voice announcement triggers
export const VOICE_TRIGGER_FAR = 500;
export const VOICE_TRIGGER_NEAR = 100;
export const VOICE_TRIGGER_NOW = 20;
export const DEVIATION_THRESHOLD_METERS = 50;

// ── Multi-modal transit types ────────────────────────────────────────────────

export type LegMode = 'walk' | 'drive' | 'train' | 'subway' | 'bus' | 'ferry' | 'flight' | 'tram';

export interface JourneyLeg {
  mode: LegMode;
  lineName: string;
  fromStop: string;
  toStop: string;
  fromCoords: [number, number]; // [lng, lat]
  toCoords: [number, number];
  departureTime?: string;
  arrivalTime?: string;
  platform?: string;
  geometry: any;
  distanceMeters: number;
  durationSeconds: number;
  walkSteps?: NavigationStep[];
}

export interface MultiModalJourney {
  legs: JourneyLeg[];
  totalDistanceMeters: number;
  totalDurationSeconds: number;
  index: number;
}

export const LEG_MODE_COLOR: Record<LegMode, string> = {
  walk: '#888888',
  drive: '#4a90d9',
  train: '#e53935',
  subway: '#e53935',
  tram: '#f57c00',
  bus: '#43a047',
  ferry: '#1565c0',
  flight: '#7b1fa2',
};

export const LEG_MODE_ICON: Record<LegMode, string> = {
  walk: '\u{1F6B6}',
  drive: '\u{1F697}',
  train: '\u{1F683}',
  subway: '\u{1F687}',
  tram: '\u{1F68B}',
  bus: '\u{1F68C}',
  ferry: '\u26F4\uFE0F',
  flight: '\u2708\uFE0F',
};

export function buildBoardingInstruction(leg: JourneyLeg, lang: 'ja' | 'en' = 'ja'): string {
  if (leg.mode === 'walk') {
    return lang === 'ja'
      ? `${leg.toStop}まで徒歩`
      : `Walk to ${leg.toStop}`;
  }
  if (leg.mode === 'drive') {
    return lang === 'ja'
      ? `${leg.toStop}まで車で移動`
      : `Drive to ${leg.toStop}`;
  }
  if (leg.mode === 'flight') {
    return lang === 'ja'
      ? `${leg.lineName || '飛行機'}で${leg.fromStop}から${leg.toStop}へ`
      : `Fly ${leg.lineName || ''} from ${leg.fromStop} to ${leg.toStop}`.trim();
  }
  if (leg.mode === 'ferry') {
    return lang === 'ja'
      ? `${leg.lineName || 'フェリー'}で${leg.fromStop}から${leg.toStop}へ`
      : `Take ferry ${leg.lineName || ''} from ${leg.fromStop} to ${leg.toStop}`.trim();
  }
  // train / subway / bus / tram
  const modeName = lang === 'ja'
    ? { train: '電車', subway: '地下鉄', bus: 'バス', tram: '路面電車' }[leg.mode] || '電車'
    : leg.mode;
  return lang === 'ja'
    ? `${leg.lineName || modeName}に乗車 (${leg.fromStop}\u2192${leg.toStop})`
    : `Board ${leg.lineName || modeName} (${leg.fromStop} \u2192 ${leg.toStop})`;
}

export function buildTransferInstruction(
  fromLeg: JourneyLeg,
  toLeg: JourneyLeg,
  lang: 'ja' | 'en' = 'ja',
): string {
  return lang === 'ja'
    ? `${fromLeg.toStop}で${toLeg.lineName || '次の路線'}に乗り換え`
    : `Transfer to ${toLeg.lineName || 'next line'} at ${fromLeg.toStop}`;
}

export function generateGreatCircleArc(
  from: [number, number],
  to: [number, number],
  numPoints = 50,
): { type: 'LineString'; coordinates: [number, number][] } {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const toDeg = (r: number) => (r * 180) / Math.PI;
  const [lng1, lat1] = from;
  const [lng2, lat2] = to;
  const phi1 = toRad(lat1), phi2 = toRad(lat2);
  const lam1 = toRad(lng1), lam2 = toRad(lng2);
  const d = 2 * Math.asin(
    Math.sqrt(
      Math.sin((phi2 - phi1) / 2) ** 2 +
      Math.cos(phi1) * Math.cos(phi2) * Math.sin((lam2 - lam1) / 2) ** 2,
    ),
  );
  if (d < 1e-10) return { type: 'LineString', coordinates: [from, to] };
  const coords: [number, number][] = [];
  for (let i = 0; i <= numPoints; i++) {
    const f = i / numPoints;
    const A = Math.sin((1 - f) * d) / Math.sin(d);
    const B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(phi1) * Math.cos(lam1) + B * Math.cos(phi2) * Math.cos(lam2);
    const y = A * Math.cos(phi1) * Math.sin(lam1) + B * Math.cos(phi2) * Math.sin(lam2);
    const z = A * Math.sin(phi1) + B * Math.sin(phi2);
    coords.push([toDeg(Math.atan2(y, x)), toDeg(Math.atan2(z, Math.sqrt(x * x + y * y)))]);
  }
  return { type: 'LineString', coordinates: coords };
}
