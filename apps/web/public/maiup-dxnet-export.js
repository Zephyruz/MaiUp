void (async () => {
  'use strict';

  const EXPECTED_HOST = 'maimaidx-eng.com';
  const DEFAULT_MAIUP_ORIGIN = 'http://localhost:3000';
  const HANDOFF_CHANNEL = 'maiup.dxnet-import';
  const HANDOFF_VERSION = 1;
  const SEARCH_PATH = '/maimai-mobile/record/musicGenre/search/';
  const RATING_PATH = '/maimai-mobile/home/ratingTargetMusic/';
  const DETAIL_PATH = '/maimai-mobile/record/musicDetail/';
  const DIFFICULTIES = ['basic', 'advanced', 'expert', 'master', 'remaster'];
  const DETAIL_CONCURRENCY = 3;
  const MAX_DETAIL_REQUESTS = 180;

  if (location.hostname !== EXPECTED_HOST) {
    alert(
      'MaiUp exporter: open the International maimai DX NET Song Scores page first.',
    );
    return;
  }

  function resolveMaiUpOrigin() {
    const configured = globalThis.__MAIUP_IMPORT_ORIGIN__;
    delete globalThis.__MAIUP_IMPORT_ORIGIN__;
    try {
      const url = new URL(
        typeof configured === 'string' ? configured : DEFAULT_MAIUP_ORIGIN,
      );
      if (
        url.protocol !== 'http:' ||
        !['localhost', '127.0.0.1'].includes(url.hostname)
      ) {
        return DEFAULT_MAIUP_ORIGIN;
      }
      return url.origin;
    } catch {
      return DEFAULT_MAIUP_ORIGIN;
    }
  }

  const maiupOrigin = resolveMaiUpOrigin();
  const handoffId =
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const handoffWindow = window.open(
    `${maiupOrigin}/dxnet-import#${encodeURIComponent(handoffId)}`,
    '_blank',
    'popup,width=560,height=720',
  );
  let handoffReady = false;
  let resolveHandoffReady;
  let resolveHandoffResult;
  const handoffReadyPromise = new Promise((resolve) => {
    resolveHandoffReady = resolve;
  });
  const handoffResultPromise = new Promise((resolve) => {
    resolveHandoffResult = resolve;
  });

  function onHandoffMessage(event) {
    if (event.origin !== maiupOrigin || event.source !== handoffWindow) return;
    const message = event.data;
    if (
      !message ||
      typeof message !== 'object' ||
      message.channel !== HANDOFF_CHANNEL ||
      message.version !== HANDOFF_VERSION ||
      message.handoffId !== handoffId
    ) {
      return;
    }
    if (message.type === 'receiver-ready') {
      handoffReady = true;
      resolveHandoffReady(true);
    } else if (message.type === 'import-complete') {
      resolveHandoffResult({ ok: true, importId: message.importId });
    } else if (message.type === 'import-error') {
      resolveHandoffResult({
        ok: false,
        message:
          typeof message.message === 'string'
            ? message.message
            : 'The local importer rejected the payload.',
      });
    }
  }

  window.addEventListener('message', onHandoffMessage);

  const existing = document.getElementById('maiup-export-status');
  if (existing) existing.remove();
  const status = document.createElement('div');
  status.id = 'maiup-export-status';
  Object.assign(status.style, {
    position: 'fixed',
    inset: '16px 16px auto 16px',
    zIndex: '2147483647',
    padding: '14px 18px',
    borderRadius: '14px',
    background: '#111827',
    color: '#cffafe',
    font: '600 14px/1.5 system-ui, sans-serif',
    boxShadow: '0 12px 40px rgba(0,0,0,.45)',
  });
  document.body.append(status);

  function waitFor(promise, timeoutMs, fallback) {
    return Promise.race([
      promise,
      new Promise((resolve) => setTimeout(() => resolve(fallback), timeoutMs)),
    ]);
  }

  function downloadPayload(payload) {
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: 'application/json;charset=utf-8',
    });
    const link = document.createElement('a');
    const downloadUrl = URL.createObjectURL(blob);
    link.href = downloadUrl;
    link.download = `maiup-scores-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(link);
    link.click();
    setTimeout(() => {
      URL.revokeObjectURL(downloadUrl);
      link.remove();
    }, 1000);
  }

  async function deliverToMaiUp(payload) {
    if (!handoffWindow || handoffWindow.closed) {
      return {
        ok: false,
        message: 'The local MaiUp window was blocked or disconnected.',
      };
    }
    const ready =
      handoffReady || (await waitFor(handoffReadyPromise, 5000, false));
    if (!ready || handoffWindow.closed) {
      return {
        ok: false,
        message: 'MaiUp did not become ready on localhost.',
      };
    }
    handoffWindow.postMessage(
      {
        channel: HANDOFF_CHANNEL,
        version: HANDOFF_VERSION,
        type: 'score-payload',
        handoffId,
        payload,
      },
      maiupOrigin,
    );
    return waitFor(handoffResultPromise, 45000, {
      ok: false,
      message: 'MaiUp did not confirm the import in time.',
    });
  }

  const iconStem = (image) => {
    const source = image.getAttribute('src') || '';
    return source.split('/').pop().split('?')[0];
  };
  const comboMap = { fc: 'FC', fcp: 'FC+', ap: 'AP', app: 'AP+' };
  const syncMap = { fs: 'FS', fsp: 'FS+', fsd: 'FSD', fsdp: 'FSD+' };
  const exportWarnings = [];

  function scoreCardRoot(card) {
    return card.closest('.w_450.m_15.p_r.f_0') || card;
  }

  function findScoreCards(page) {
    const knownRows = [
      ...page.querySelectorAll('.main_wrapper.t_c .w_450.m_15.p_r.f_0'),
    ].filter((row) => /\d{1,3}\.\d{4}%/.test(row.textContent || ''));
    if (knownRows.length) return knownRows;

    return [
      ...new Set(
        [...page.querySelectorAll('div[class*="_score_back"]')].map(
          scoreCardRoot,
        ),
      ),
    ];
  }

  function readTitle(card) {
    const selectors = ['.music_name_block', '.basic_block.break'];
    for (const selector of selectors) {
      const title = card.querySelector(selector)?.textContent?.trim();
      if (title) return title;
    }
    return null;
  }

  function warnSkippedCard(card, context, reason, achievement) {
    const warning = {
      section: context.section,
      difficultyPage: context.difficulty ?? null,
      reason,
      achievement: achievement?.[1] ?? null,
      cardId: card.id || null,
      cardClass: card.className || null,
    };
    exportWarnings.push(warning);
    console.warn('MaiUp skipped one unreadable score card.', warning, card);
  }

  function parseDisplayedLevel(card) {
    const raw =
      card.querySelector('.music_lv_block')?.textContent?.trim() || '';
    const match = raw.match(/(\d{1,2})(\+)?/);
    if (!match) return null;
    return Number(match[1]) + (match[2] ? 0.7 : 0);
  }

  function detailIndex(card) {
    const row = card.closest('.w_450.m_15.p_r.f_0') || card.parentElement;
    const field = row?.querySelector('[name="idx"]');
    if (
      (field instanceof HTMLInputElement ||
        field instanceof HTMLButtonElement) &&
      field.value
    ) {
      return field.value;
    }
    const form = row?.querySelector('form[action*="musicDetail"]');
    const action = form?.getAttribute('action') || '';
    const actionIndex = action.match(/[?&]idx=([^&]+)/)?.[1];
    if (actionIndex) return decodeURIComponent(actionIndex);
    const markupIndex = row?.innerHTML.match(
      /musicDetail\/\?idx=([^&"'<>\s]+)/,
    )?.[1];
    return markupIndex ? decodeURIComponent(markupIndex) : null;
  }

  function coverSource(card) {
    const images = [...card.querySelectorAll('img')];
    const cover =
      card.querySelector('img.music_img, img[class*="music_img"]') ||
      images.find((image) => {
        const source =
          image.getAttribute('src') ||
          image.getAttribute('data-src') ||
          image.getAttribute('data-original') ||
          '';
        const name = source.split('/').pop()?.split('?')[0] || '';
        return (
          /\/Music\//i.test(source) ||
          (!name.startsWith('diff_') &&
            !name.startsWith('music_icon_') &&
            !/(?:standard|deluxe|dx).*\.png$/i.test(name))
        );
      });
    return (
      cover?.getAttribute('src') ||
      cover?.getAttribute('data-src') ||
      cover?.getAttribute('data-original') ||
      null
    );
  }

  function parseDate(text) {
    const yearFirst = text.match(
      /(20\d{2})[/.-](\d{1,2})[/.-](\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?/,
    );
    const monthFirst = text.match(
      /(\d{1,2})[/.-](\d{1,2})[/.-](20\d{2})(?:\s+(\d{1,2}):(\d{2}))?/,
    );
    const match = yearFirst || monthFirst;
    if (!match) {
      const namedDate = text.match(
        /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+20\d{2}(?:\s+\d{1,2}:\d{2})?/i,
      )?.[0];
      if (!namedDate) return null;
      const parsed = new Date(namedDate);
      return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString();
    }
    const [, first, second, third, hour = '00', minute = '00'] = match;
    const [year, month, day] = yearFirst
      ? [first, second, third]
      : [third, first, second];
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T${hour.padStart(2, '0')}:${minute}:00Z`;
  }

  function parseDetailDates(page) {
    const table = page.querySelector('.music_detail_table');
    if (!table) return new Map();
    const rows = [...(table.tBodies[0]?.rows ?? [])];
    const dates = new Map();
    rows.slice(0, DIFFICULTIES.length).forEach((row, index) => {
      if (!/(\d{1,3}\.\d{4})%/.test(row.textContent || '')) return;
      const playedAt = parseDate(row.textContent || '');
      if (playedAt) dates.set(DIFFICULTIES[index], playedAt);
    });
    return dates;
  }

  function publicScore(score) {
    const { _detailIndex, _displayedLevel, _sourceSongKey, ...result } = score;
    return {
      ...result,
      displayedLevel: _displayedLevel,
      sourceSongKey: _sourceSongKey,
    };
  }

  function parseCard(candidate, context) {
    const card = scoreCardRoot(candidate);
    const images = [...card.querySelectorAll('img')].map(iconStem);
    const text = card.textContent || '';
    const achievement = text.match(/(\d{1,3}\.\d{4})%/);
    if (!achievement) return null;
    const rawDifficultyFromIcon = images
      .find((name) => name.startsWith('diff_'))
      ?.match(/^diff_(.+)\.png$/)?.[1];
    const difficultyFromIcon = rawDifficultyFromIcon?.replace(
      /^re_?master$/,
      'remaster',
    );
    const difficultyFromClass = [
      card,
      ...card.querySelectorAll('div[class*="_score_back"]'),
    ]
      .flatMap((element) => [...element.classList])
      .find((name) =>
        /^music_(basic|advanced|expert|master|remaster)_score_back$/.test(name),
      )
      ?.match(/^music_(.+)_score_back$/)?.[1];
    const difficulty =
      difficultyFromIcon ?? difficultyFromClass ?? context.difficulty;
    const title = readTitle(card);
    if (!title || !difficulty) {
      warnSkippedCard(
        card,
        context,
        !title ? 'missing_title' : 'missing_difficulty',
        achievement,
      );
      return null;
    }
    const imageSources = [...card.querySelectorAll('img')]
      .flatMap((image) =>
        ['src', 'data-src', 'data-original'].map(
          (attribute) => image.getAttribute(attribute) || '',
        ),
      )
      .join(' ');
    const rowId = card.id.toLowerCase();
    const chartType =
      rowId.includes('sta_') || /(?:music|kind)_standard/i.test(imageSources)
        ? 'std'
        : 'dx';
    const dxScore = text.match(/([\d,]+)\s*\/\s*([\d,]+)/);
    const comboKey = Object.keys(comboMap).find((key) =>
      images.includes(`music_icon_${key}.png`),
    );
    const syncKey = Object.keys(syncMap).find((key) =>
      images.includes(`music_icon_${key}.png`),
    );
    const sourceDetailIndex = detailIndex(card);
    return {
      title,
      chartType,
      difficulty,
      achievement: achievement[1],
      fullCombo: comboKey ? comboMap[comboKey] : null,
      syncStatus: syncKey ? syncMap[syncKey] : null,
      dxScore: dxScore ? Number(dxScore[1].replaceAll(',', '')) : null,
      dxScoreMax: dxScore ? Number(dxScore[2].replaceAll(',', '')) : null,
      playedAt: null,
      _detailIndex: sourceDetailIndex,
      _displayedLevel: parseDisplayedLevel(card),
      _sourceSongKey: sourceDetailIndex || coverSource(card),
    };
  }

  async function addLastPlayedDates(scores, referenceScores) {
    const referenceLevels = referenceScores
      .map((score) => score._displayedLevel)
      .filter((level) => typeof level === 'number');
    const scoreLevels = scores
      .map((score) => score._displayedLevel)
      .filter((level) => typeof level === 'number');
    const referenceFloor = referenceLevels.length
      ? Math.min(...referenceLevels) - 1
      : Math.max(...scoreLevels, 0) - 2;
    const detailLevels = new Map();
    for (const score of scores) {
      if (!score._detailIndex || score._displayedLevel === null) continue;
      if (score._displayedLevel < referenceFloor) continue;
      detailLevels.set(
        score._detailIndex,
        Math.max(
          detailLevels.get(score._detailIndex) || 0,
          score._displayedLevel,
        ),
      );
    }
    const detailIds = [...detailLevels]
      .sort((left, right) => right[1] - left[1])
      .slice(0, MAX_DETAIL_REQUESTS)
      .map(([detailId]) => detailId);
    if (!detailIds.length) return { requested: 0, matched: 0 };

    const datesByDetail = new Map();
    let cursor = 0;
    let completed = 0;
    async function worker() {
      while (cursor < detailIds.length) {
        const detailId = detailIds[cursor];
        cursor += 1;
        try {
          const response = await fetch(
            `${location.origin}${DETAIL_PATH}?idx=${encodeURIComponent(detailId)}`,
            {
              credentials: 'include',
              cache: 'no-store',
              headers: {
                Accept: 'text/html',
                'X-Requested-With': 'XMLHttpRequest',
              },
            },
          );
          if (response.ok) {
            const html = await response.text();
            const page = new DOMParser().parseFromString(html, 'text/html');
            const dates = parseDetailDates(page);
            if (dates.size) datesByDetail.set(detailId, dates);
          }
        } catch {
          /* A missing timestamp must not make the complete-score export fail. */
        }
        completed += 1;
        status.textContent = `MaiUp: reading recent activity (${completed} / ${detailIds.length})…`;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    await Promise.all(
      Array.from(
        { length: Math.min(DETAIL_CONCURRENCY, detailIds.length) },
        () => worker(),
      ),
    );

    let matched = 0;
    for (const score of scores) {
      const playedAt = datesByDetail
        .get(score._detailIndex)
        ?.get(score.difficulty);
      if (!playedAt) continue;
      score.playedAt = playedAt;
      matched += 1;
    }
    return { requested: detailIds.length, matched };
  }

  try {
    const scores = [];
    for (const [difficultyIndex, difficulty] of DIFFICULTIES.entries()) {
      status.textContent = `MaiUp: reading ${difficulty.toUpperCase()} scores (${difficultyIndex + 1} / ${DIFFICULTIES.length})…`;
      const response = await fetch(
        `${location.origin}${SEARCH_PATH}?genre=99&diff=${difficultyIndex}`,
        {
          credentials: 'include',
          cache: 'no-store',
          headers: {
            Accept: 'text/html',
            'X-Requested-With': 'XMLHttpRequest',
          },
        },
      );
      if (!response.ok)
        throw new Error(`DX NET returned HTTP ${response.status}.`);
      const html = await response.text();
      const page = new DOMParser().parseFromString(html, 'text/html');
      if (
        html.includes(
          'Please agree to the following terms of service before log in.',
        ) ||
        !page.querySelector('.music_name_block')
      ) {
        throw new Error(
          'The login session expired or the score page layout changed.',
        );
      }
      const cards = findScoreCards(page);
      scores.push(
        ...cards
          .map((card) => parseCard(card, { section: 'scores', difficulty }))
          .filter(Boolean),
      );
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    status.textContent = 'MaiUp: reading the official B35 / B15 list…';
    const ratingResponse = await fetch(`${location.origin}${RATING_PATH}`, {
      credentials: 'include',
      cache: 'no-store',
      headers: { Accept: 'text/html', 'X-Requested-With': 'XMLHttpRequest' },
    });
    if (!ratingResponse.ok) {
      throw new Error(
        `DX NET Rating Target returned HTTP ${ratingResponse.status}.`,
      );
    }
    const ratingHtml = await ratingResponse.text();
    const newIndex = ratingHtml.indexOf('Songs for Rating(New)');
    const othersIndex = ratingHtml.indexOf('Songs for Rating(Others)');
    const selectionIndex = ratingHtml.indexOf('Songs for Rating Selection');
    let officialBest50 = null;
    if (newIndex >= 0 && othersIndex > newIndex) {
      const endIndex =
        selectionIndex > othersIndex ? selectionIndex : ratingHtml.length;
      const parseSection = (html, bucket) => {
        const page = new DOMParser().parseFromString(html, 'text/html');
        return findScoreCards(page)
          .map((card) => parseCard(card, { section: bucket }))
          .filter(Boolean)
          .map((score, index) => ({ ...score, bucket, position: index + 1 }));
      };
      const b15 = parseSection(ratingHtml.slice(newIndex, othersIndex), 'b15');
      const b35 = parseSection(ratingHtml.slice(othersIndex, endIndex), 'b35');
      if (b15.length === 15 && b35.length === 35) {
        officialBest50 = [...b35, ...b15];
      }
    }

    const activityCoverage = await addLastPlayedDates(
      scores,
      officialBest50 ?? [],
    );
    const scoreKey = (score) =>
      `${score.title}\u0000${score.chartType}\u0000${score.difficulty}\u0000${score._sourceSongKey ?? ''}`;
    const playedAtByChart = new Map(
      scores
        .filter((score) => score.playedAt)
        .map((score) => [scoreKey(score), score.playedAt]),
    );
    const exportedScores = scores.map(publicScore);
    const exportedBest50 =
      officialBest50?.map((score) =>
        publicScore({
          ...score,
          playedAt: playedAtByChart.get(scoreKey(score)) ?? score.playedAt,
        }),
      ) ?? null;

    const payload = {
      schemaVersion: 1,
      sourceRegion: 'international',
      sourceName: 'maimai DX NET complete score export',
      exportedAt: new Date().toISOString(),
      scores: exportedScores,
      officialBest50: exportedBest50,
      exportWarnings,
    };
    status.textContent = 'MaiUp: sending scores to the local importer…';
    const handoffResult = await deliverToMaiUp(payload);
    const activityText = activityCoverage.requested
      ? ` Last-play dates matched ${activityCoverage.matched} chart scores.`
      : ' Last-play dates were unavailable.';
    const warningText = exportWarnings.length
      ? ` Skipped ${exportWarnings.length} unreadable card(s); details are included in exportWarnings.`
      : '';
    if (handoffResult.ok) {
      status.textContent =
        (officialBest50
          ? `MaiUp: imported ${scores.length} played charts and the official B35 / B15.${activityText}`
          : `MaiUp: imported ${scores.length} played charts; official B50 was unavailable.${activityText}`) +
        warningText;
    } else {
      downloadPayload(payload);
      status.style.color = '#fde68a';
      status.textContent = `MaiUp automatic import was unavailable: ${handoffResult.message} A JSON fallback was downloaded.`;
    }
    setTimeout(() => status.remove(), 8000);
  } catch (error) {
    status.style.color = '#fecdd3';
    const message = error instanceof Error ? error.message : String(error);
    status.textContent = `MaiUp export failed: ${message}`;
  } finally {
    window.removeEventListener('message', onHandoffMessage);
  }
})();
