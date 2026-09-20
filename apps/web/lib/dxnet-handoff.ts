export const DXNET_ORIGIN = 'https://maimaidx-eng.com';
export const DXNET_HANDOFF_CHANNEL = 'maiup.dxnet-import';
export const DXNET_HANDOFF_VERSION = 1;
export const MAX_SCORE_PAYLOAD_BYTES = 5 * 1024 * 1024;

type UnknownRecord = Record<string, unknown>;

export type DxnetScorePayload = {
  schemaVersion: 1;
  sourceRegion: 'international';
  sourceName: string;
  exportedAt: string;
  scores: UnknownRecord[];
  officialBest50?: UnknownRecord[] | null;
};

export type DxnetPayloadMessage = {
  channel: typeof DXNET_HANDOFF_CHANNEL;
  version: typeof DXNET_HANDOFF_VERSION;
  type: 'score-payload';
  handoffId: string;
  payload: DxnetScorePayload;
};

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isScoreEntry(value: unknown): value is UnknownRecord {
  if (!isRecord(value)) return false;
  return (
    typeof value.title === 'string' &&
    value.title.trim().length > 0 &&
    (value.chartType === 'std' || value.chartType === 'dx') &&
    ['basic', 'advanced', 'expert', 'master', 'remaster'].includes(
      String(value.difficulty),
    ) &&
    (typeof value.achievement === 'string' ||
      typeof value.achievement === 'number')
  );
}

export function readHandoffId(hash: string): string | null {
  try {
    const value = decodeURIComponent(hash.replace(/^#/, ''));
    return /^[A-Za-z0-9-]{20,128}$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

export function parseDxnetPayloadMessage(
  value: unknown,
  handoffId: string,
): DxnetPayloadMessage | null {
  if (!isRecord(value)) return null;
  if (
    value.channel !== DXNET_HANDOFF_CHANNEL ||
    value.version !== DXNET_HANDOFF_VERSION ||
    value.type !== 'score-payload' ||
    value.handoffId !== handoffId ||
    !isRecord(value.payload)
  ) {
    return null;
  }
  const payload = value.payload;
  if (
    payload.schemaVersion !== 1 ||
    payload.sourceRegion !== 'international' ||
    typeof payload.sourceName !== 'string' ||
    typeof payload.exportedAt !== 'string' ||
    !Array.isArray(payload.scores) ||
    payload.scores.length < 1 ||
    payload.scores.length > 10000 ||
    !payload.scores.every(isScoreEntry)
  ) {
    return null;
  }
  if (
    payload.officialBest50 !== undefined &&
    payload.officialBest50 !== null &&
    (!Array.isArray(payload.officialBest50) ||
      payload.officialBest50.length > 50 ||
      !payload.officialBest50.every(isScoreEntry))
  ) {
    return null;
  }
  try {
    if (new Blob([JSON.stringify(payload)]).size > MAX_SCORE_PAYLOAD_BYTES) {
      return null;
    }
  } catch {
    return null;
  }
  return value as DxnetPayloadMessage;
}
