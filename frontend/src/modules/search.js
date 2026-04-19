/**
 * 検索モジュール
 * 
 * セマンティック検索機能を担当（テキスト検索・画像検索）
 * 
 * 主な機能:
 * - テキストベースのセマンティック検索
 * - 画像ベースの類似画像検索
 * - 検索結果の表示と管理
 * - ファイルダウンロード機能
 * 
 * ネットワーク通信:
 * - バックエンドAPIとのHTTPS通信
 * - ファイルアップロード（FormData）
 * - 認証トークン付きリクエスト
 * - エラーハンドリングとユーザー通知
 */

import { appState } from '../state.js';
import { apiCall as authApiCall } from './auth.js';
import { showLoading as utilsShowLoading, hideLoading as utilsHideLoading, showToast as utilsShowToast, showImageModal as utilsShowImageModal } from './utils.js';

// 検索画像の状態管理
let selectedSearchImage = null;
let currentSearchType = 'text'; // 'text' or 'image'
let currentRetrievalMode = 'image'; // 'image' | 'text' | 'image-text' | 'image-text-vector' | 'image-text-keyword'

function formatMatchPercent(score) {
  if (typeof score !== 'number' || Number.isNaN(score)) return '-';
  return `${(score * 100).toFixed(1)}%`;
}

function formatDistance(distance) {
  if (typeof distance !== 'number' || Number.isNaN(distance)) return '-';
  return Number(distance).toFixed(4);
}

function formatMetricValue(value, formatter = (v) => v) {
  if (value === null || value === undefined || Number.isNaN(value)) return '-';
  return formatter(value);
}

function safeMetricLabel(label = '') {
  return safeText(String(label || '').replace(/_/g, ' '));
}

function buildMetricRows(metricEntries = []) {
  const rows = metricEntries
    .filter((entry) => entry && (entry.score !== null && entry.score !== undefined || entry.distance !== null && entry.distance !== undefined || entry.extra))
    .map((entry) => {
      const extra = entry.extra ? `<span class="search-result-metric-extra">${safeText(entry.extra)}</span>` : '';
      const distancePill = entry.distance === null || entry.distance === undefined || Number.isNaN(entry.distance)
        ? ''
        : `<span class="search-result-metric-pill">距離: ${formatMetricValue(entry.distance, formatDistance)}</span>`;
      return `
        <div class="search-result-metric-row">
          <div class="search-result-metric-name">${safeMetricLabel(entry.label)}</div>
          <div class="search-result-metric-values">
            <span class="search-result-metric-pill">score: ${formatMetricValue(entry.score, formatMatchPercent)}</span>
            ${distancePill}
            ${extra}
          </div>
        </div>
      `;
    })
    .join('');

  if (!rows) return '';

  return `
    <div class="search-result-metric-panel">
      ${rows}
    </div>
  `;
}

function getModeMetricEntries(item, mode) {
  const raw = item?._raw || {};
  const scores = raw?.scores || item?.scores || {};
  const metrics = item?.metrics || {};

  if (mode === 'image-text-keyword' || mode === 'image-hybrid') {
    return [
      {
        label: 'image',
        score: scores.image ?? metrics.image?.score ?? item.score,
        distance: raw.min_distance ?? metrics.image?.vector_distance ?? item.vector_distance,
        extra: ''
      },
      {
        label: 'keyword',
        score: scores.keyword ?? null,
        distance: null,
        extra: Array.isArray(item.keyword_matches) && item.keyword_matches.length ? `一致: ${item.keyword_matches.length}件` : ''
      },
      {
        label: 'total',
        score: raw.hybrid_score ?? item.score,
        distance: null,
        extra: raw.weights ? `weight image:${formatMetricValue(raw.weights.image_weight, v => `${(v * 100).toFixed(0)}%`)} / keyword:${formatMetricValue(raw.weights.keyword_weight, v => `${(v * 100).toFixed(0)}%`)}` : ''
      }
    ];
  }

  if (mode === 'image-text' || mode === 'image-text-vector' || mode === 'hybrid') {
    return [
      {
        label: 'image',
        score: scores.image ?? metrics.image?.score ?? (item.source_type === 'image' ? item.score : null),
        distance: raw.min_distance ?? metrics.image?.vector_distance ?? (item.source_type === 'image' ? item.vector_distance : null),
        extra: ''
      },
      {
        label: 'text_vector',
        score: scores.text_vector ?? raw.vector_score ?? metrics.text?.score ?? (item.source_type === 'text' ? item.score : null),
        distance: raw.vector_distance ?? metrics.text?.vector_distance ?? (item.source_type === 'text' ? item.vector_distance : null),
        extra: item._merged_chunk_count ? `chunk: ${item._merged_chunk_count}` : ''
      },
      {
        label: 'total',
        score: raw.hybrid_score ?? scores.total ?? item.score,
        distance: null,
        extra: raw.weights ? `weight vector:${formatMetricValue(raw.weights.vector_weight ?? raw.weights.image_weight, v => `${(v * 100).toFixed(0)}%`)}` : ''
      }
    ];
  }

  return [
    {
      label: item.source_type || 'result',
      score: item.score,
      distance: item.vector_distance,
      extra: ''
    }
  ];
}

function getRetrievalModeLabel(mode) {
  switch (mode) {
    case 'image-text':
      return 'image×text';
    case 'image-text-vector':
    case 'hybrid':
      return 'image×text hybrid';
    case 'image-text-keyword':
    case 'image-hybrid':
      return 'image×keyword';
    default:
      return mode || 'image';
  }
}

function getResultMatchTabs(item, mode) {
  const sourceTypes = Array.isArray(item?.source_types) ? item.source_types : [item?.source_type].filter(Boolean);
  const raw = item?._raw || {};
  const metrics = item?.metrics || {};
  const keywordMatches = Array.isArray(item?.keyword_matches) ? item.keyword_matches : [];
  const tabs = [];
  const isKeywordMode = mode === 'image-text-keyword' || mode === 'image-hybrid';
  const isTextVectorMode = mode === 'image-text' || mode === 'image-text-vector' || mode === 'hybrid';

  const hasImageMatch = sourceTypes.includes('image') || metrics.image || Array.isArray(raw.matched_images);
  const hasTextMatch = sourceTypes.includes('text') || metrics.text;
  const hasKeywordMatch = isKeywordMode && (
    keywordMatches.length > 0 || typeof raw?.scores?.keyword === 'number' || typeof raw?.keyword_score === 'number'
  );

  if (isKeywordMode) {
    if (hasImageMatch) tabs.push({ key: 'image', label: 'image' });
    if (hasKeywordMatch) tabs.push({ key: 'keyword', label: 'keyword' });
    return tabs;
  }

  if (isTextVectorMode) {
    if (hasImageMatch) tabs.push({ key: 'image', label: 'image' });
    if (hasTextMatch) tabs.push({ key: 'text', label: 'text' });
    return tabs;
  }

  if (hasImageMatch) return [{ key: 'image', label: 'image' }];
  if (hasTextMatch) return [{ key: 'text', label: 'text' }];
  return [{ key: 'result', label: item?.source_type || 'result' }];
}

function buildResultMatchTabs(item, mode) {
  const tabs = getResultMatchTabs(item, mode);
  if (tabs.length <= 1) {
    return tabs.length === 1
      ? `<span class="search-result-match-tab is-single">${safeText(tabs[0].label)}</span>`
      : '';
  }

  return `
    <div class="search-result-match-tabs" aria-label="一致した検索種別">
      ${tabs.map((tab) => `<span class="search-result-match-tab search-result-match-tab-${safeText(tab.key)}">${safeText(tab.label)}</span>`).join('')}
    </div>
  `;
}

function buildKeywordMatchExcerpt(result) {
  const matches = Array.isArray(result?.keyword_matches) ? result.keyword_matches : [];
  if (!matches.length) return '';

  return matches
    .map((match) => {
      const pageLabel = match?.page_number ? `page ${match.page_number}: ` : '';
      return `${pageLabel}${match?.chunk_text || ''}`;
    })
    .filter(Boolean)
    .join('\n\n---\n\n');
}

function safeText(text = '') {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function inferSourceType(result) {
  if (result?.source_type) return result.source_type;
  if (result?.matched_images) return 'image';
  if (result?.chunk_text || result?.content_excerpt || result?.chunk_id) return 'text';
  if (result?.page_number || result?.page_no || result?.embed_id) return 'image';
  return 'text';
}

function getTextPreviewByLines(text = '', maxLines = 5) {
  const normalized = String(text || '').replace(/\r\n/g, '\n');
  return normalized.split('\n').slice(0, maxLines).join('\n');
}

function hasMoreTextContent(text = '', maxLines = 5, maxChars = 260) {
  const normalized = String(text || '').replace(/\r\n/g, '\n');
  const lineCount = normalized.split('\n').length;
  return lineCount > maxLines || normalized.length > maxChars;
}

function showResultTextModal(title, text) {
  if (window.UIComponents?.showModal) {
    window.UIComponents.showModal({
      title: title || 'テキスト内容',
      content: `
        <div class="search-result-text-modal-body">${safeText(text || '（テキストなし）')}</div>
      `,
      size: 'lg'
    });
    return;
  }

  window.alert(text || '（テキストなし）');
}

function inferTextRelatedPageNo(result) {
  if (typeof result?.page_no === 'number') return result.page_no;
  if (typeof result?.page_number === 'number') return result.page_number;
  if (typeof result?.chunk_index === 'number') return result.chunk_index + 1;
  return 1;
}

function getDocumentGroupKey(item) {
  const bucket = item?.bucket || '';
  const documentObjectName = item?.document_object_name || '';
  if (documentObjectName) {
    return `${bucket}::${documentObjectName}`;
  }
  const objectName = item?.object_name || '';
  const normalizedObjectName = objectName.replace(/\/page_(\d{3}|\d{6})\.png$/i, '');
  const fallbackName = item?.file_name || objectName || '-';
  return `${bucket}::${normalizedObjectName || fallbackName}`;
}

function compareResultItems(a, b) {
  const aDistance = typeof a?.vector_distance === 'number' ? a.vector_distance : Number.POSITIVE_INFINITY;
  const bDistance = typeof b?.vector_distance === 'number' ? b.vector_distance : Number.POSITIVE_INFINITY;
  if (aDistance !== bDistance) return aDistance - bDistance;

  const aScore = typeof a?.score === 'number' ? a.score : Number.NEGATIVE_INFINITY;
  const bScore = typeof b?.score === 'number' ? b.score : Number.NEGATIVE_INFINITY;
  if (aScore !== bScore) return bScore - aScore;

  const aPage = typeof a?.page_no === 'number' ? a.page_no : Number.POSITIVE_INFINITY;
  const bPage = typeof b?.page_no === 'number' ? b.page_no : Number.POSITIVE_INFINITY;
  return aPage - bPage;
}

function groupResultsByDocument(normalizedResults = []) {
  const groupsMap = new Map();

  normalizedResults.forEach((item, index) => {
    const key = getDocumentGroupKey(item);
    if (!groupsMap.has(key)) {
      groupsMap.set(key, {
        key,
        file_name: item.file_name || '-',
        object_name: item.object_name || '-',
        bucket: item.bucket || '',
        download_url: item.download_url || '',
        entries: []
      });
    }

    const group = groupsMap.get(key);
    if (!group.download_url && item.download_url) {
      group.download_url = item.download_url;
    }
    if ((!group.file_name || group.file_name === '-') && item.file_name) {
      group.file_name = item.file_name;
    }
    if ((!group.object_name || group.object_name === '-') && item.object_name) {
      group.object_name = item.object_name;
    }

    group.entries.push({ index, item });
  });

  const groups = Array.from(groupsMap.values()).map((group) => {
    const sortedEntries = [...group.entries].sort((a, b) => compareResultItems(a.item, b.item));
    const scores = sortedEntries.map(e => e.item.score).filter(v => typeof v === 'number' && !Number.isNaN(v));
    const distances = sortedEntries.map(e => e.item.vector_distance).filter(v => typeof v === 'number' && !Number.isNaN(v));
    const pages = sortedEntries
      .map(e => e.item.page_no)
      .filter(v => typeof v === 'number' && Number.isFinite(v));

    return {
      ...group,
      entries: sortedEntries,
      best_score: scores.length ? Math.max(...scores) : null,
      best_distance: distances.length ? Math.min(...distances) : null,
      matched_pages_count: new Set(pages).size,
      source_types: Array.from(new Set(sortedEntries.map(e => e.item.source_type || '-')))
    };
  });

  groups.sort((a, b) => {
    const aScore = typeof a.best_score === 'number' ? a.best_score : Number.NEGATIVE_INFINITY;
    const bScore = typeof b.best_score === 'number' ? b.best_score : Number.NEGATIVE_INFINITY;
    if (aScore !== bScore) return bScore - aScore;
    const aDist = typeof a.best_distance === 'number' ? a.best_distance : Number.POSITIVE_INFINITY;
    const bDist = typeof b.best_distance === 'number' ? b.best_distance : Number.POSITIVE_INFINITY;
    return aDist - bDist;
  });

  return groups;
}

function mergeTextResultsByPage(normalizedResults = []) {
  const mergedMap = new Map();

  normalizedResults.forEach((item) => {
    if (item?.source_type !== 'text') {
      const key = `raw::${mergedMap.size}`;
      mergedMap.set(key, item);
      return;
    }

    const bucket = item?.bucket || '';
    const documentObjectName = item?.document_object_name || item?.object_name || item?.file_name || '-';
    const pageNo = typeof item?.page_no === 'number' && Number.isFinite(item.page_no) ? item.page_no : inferTextRelatedPageNo(item);
    const key = `text::${bucket}::${documentObjectName}::${pageNo}`;

    if (!mergedMap.has(key)) {
      mergedMap.set(key, {
        ...item,
        page_no: pageNo,
      });
      return;
    }

    const existing = mergedMap.get(key);
    const existingScore = typeof existing?.score === 'number' ? existing.score : Number.NEGATIVE_INFINITY;
    const nextScore = typeof item?.score === 'number' ? item.score : Number.NEGATIVE_INFINITY;
    const existingDistance = typeof existing?.vector_distance === 'number' ? existing.vector_distance : Number.POSITIVE_INFINITY;
    const nextDistance = typeof item?.vector_distance === 'number' ? item.vector_distance : Number.POSITIVE_INFINITY;

    mergedMap.set(key, {
      ...existing,
      score: nextScore > existingScore ? item.score : existing.score,
      vector_distance: nextDistance < existingDistance ? item.vector_distance : existing.vector_distance,
      content_excerpt: [existing.content_excerpt, item.content_excerpt]
        .filter(Boolean)
        .join('\n\n---\n\n'),
      text_related_image_urls: existing.text_related_image_urls?.length ? existing.text_related_image_urls : item.text_related_image_urls,
      text_related_image_titles: existing.text_related_image_titles?.length ? existing.text_related_image_titles : item.text_related_image_titles,
      _merged_chunk_count: (existing._merged_chunk_count || 1) + 1,
    });
  });

  return Array.from(mergedMap.values());
}

function mergeMixedResultsByDocumentPage(normalizedResults = []) {
  const mergedMap = new Map();

  normalizedResults.forEach((item) => {
    const bucket = item?.bucket || '';
    const documentObjectName = item?.document_object_name || item?.object_name || item?.file_name || '-';
    const pageNo = typeof item?.page_no === 'number' && Number.isFinite(item.page_no)
      ? item.page_no
      : inferTextRelatedPageNo(item);
    const key = `${bucket}::${documentObjectName}::${pageNo}`;

    if (!mergedMap.has(key)) {
      mergedMap.set(key, {
        ...item,
        page_no: pageNo,
        source_types: [item.source_type],
        metrics: {
          [item.source_type]: {
            score: item.score,
            vector_distance: item.vector_distance,
          }
        }
      });
      return;
    }

    const existing = mergedMap.get(key);
    const existingDistance = typeof existing?.vector_distance === 'number' ? existing.vector_distance : Number.POSITIVE_INFINITY;
    const nextDistance = typeof item?.vector_distance === 'number' ? item.vector_distance : Number.POSITIVE_INFINITY;
    const existingScore = typeof existing?.score === 'number' ? existing.score : Number.NEGATIVE_INFINITY;
    const nextScore = typeof item?.score === 'number' ? item.score : Number.NEGATIVE_INFINITY;
    const preferredBase = nextDistance < existingDistance || (nextDistance === existingDistance && nextScore > existingScore)
      ? item
      : existing;

    mergedMap.set(key, {
      ...existing,
      ...preferredBase,
      page_no: pageNo,
      source_type: existing.source_type === item.source_type ? existing.source_type : 'mixed',
      source_types: Array.from(new Set([...(existing.source_types || [existing.source_type]), item.source_type])),
      metrics: {
        ...(existing.metrics || {}),
        [item.source_type]: {
          score: item.score,
          vector_distance: item.vector_distance,
        }
      },
      content_excerpt: item.source_type === 'text'
        ? [existing.content_excerpt, item.content_excerpt].filter(Boolean).join('\n\n---\n\n')
        : existing.content_excerpt,
      text_related_image_urls: existing.text_related_image_urls?.length ? existing.text_related_image_urls : item.text_related_image_urls,
      text_related_image_titles: existing.text_related_image_titles?.length ? existing.text_related_image_titles : item.text_related_image_titles,
      preview_urls: existing.preview_urls?.length ? existing.preview_urls : item.preview_urls,
      preview_titles: existing.preview_titles?.length ? existing.preview_titles : item.preview_titles,
      thumbnail_url: existing.thumbnail_url || item.thumbnail_url,
      _merged_chunk_count: (existing._merged_chunk_count || 1) + (item.source_type === 'text' ? 1 : 0),
    });
  });

  return Array.from(mergedMap.values());
}

function buildRelatedImagePreview(itemLike) {
  const objectName = itemLike?.object_name;
  const bucket = itemLike?.bucket;
  if (!objectName || objectName === '-') {
    return { urls: [], titles: [] };
  }

  const pageNo = Math.max(1, parseInt(inferTextRelatedPageNo(itemLike), 10) || 1);
  const page3 = String(pageNo).padStart(3, '0');
  const page6 = String(pageNo).padStart(6, '0');
  const basePath = objectName.replace(/\.[^.\/]+$/, '');

  const objectNameCandidates = [
    `${basePath}/page_${page3}.png`,
    `${basePath}/page_${page6}.png`
  ];

  const urls = objectNameCandidates.map(name => (
    bucket ? getAuthenticatedImageUrl(bucket, name) : ''
  )).filter(Boolean);
  const titles = objectNameCandidates.map(() => (
    `${itemLike.file_name || '関連画像'} - page ${pageNo}`
  )).slice(0, urls.length);

  return { urls, titles };
}

function preloadImageUrl(url) {
  return new Promise((resolve) => {
    if (!url) {
      resolve(false);
      return;
    }
    const img = new Image();
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
    img.src = url;
  });
}

async function resolveValidImageCandidates(urls = [], titles = []) {
  const checks = await Promise.all((urls || []).map(url => preloadImageUrl(url)));
  const validUrls = [];
  const validTitles = [];
  checks.forEach((ok, i) => {
    if (ok) {
      validUrls.push(urls[i]);
      validTitles.push(titles[i] || '関連ページ画像');
    }
  });
  return { validUrls, validTitles };
}

function normalizeImageFileResultsToItems(fileResults = []) {
  const items = [];
  fileResults.forEach((fileResult, fileIndex) => {
    const originalFilename = fileResult.original_filename || (fileResult.object_name || '').split('/').pop() || '-';
    const matchedImages = Array.isArray(fileResult.matched_images) ? fileResult.matched_images : [];

    matchedImages.forEach((img, imgIndex) => {
      const vectorDistance = typeof img.vector_distance === 'number' ? img.vector_distance : null;
      const imageObjectName = img.object_name || fileResult.object_name || '-';
      const imageBucket = img.bucket || fileResult.bucket || '';
      const previewUrl = img.url
        ? getAuthenticatedImageUrl(img.url)
        : getAuthenticatedImageUrl(imageBucket, imageObjectName);
      const previewTitle = `ページ ${img.page_number ?? '-'}${vectorDistance !== null ? ` - マッチ度: ${((1 - vectorDistance) * 100).toFixed(1)}%` : ''}${vectorDistance !== null ? ` | 距離: ${vectorDistance.toFixed(4)}` : ''}`;
      items.push({
        source_type: 'image',
        score: vectorDistance !== null ? (1 - vectorDistance) : null,
        vector_distance: vectorDistance,
        bucket: imageBucket,
        file_name: originalFilename,
        document_object_name: fileResult.object_name || imageObjectName,
        object_name: imageObjectName,
        page_no: img.page_number ?? null,
        content_excerpt: '',
        thumbnail_url: previewUrl,
        download_url: fileResult.url ? getAuthenticatedImageUrl(fileResult.url) : getAuthenticatedImageUrl(fileResult.bucket, fileResult.object_name),
        preview_urls: previewUrl ? [previewUrl] : [],
        preview_titles: previewTitle ? [previewTitle] : [],
        preview_index: 0,
        _raw_ref: { fileIndex, imgIndex },
        _raw: fileResult
      });
    });
  });

  return items;
}

function normalizeSearchResults(data, mode) {
  const rawResults = Array.isArray(data?.results) ? data.results : [];

  // 既存の image 検索レスポンス（ファイル単位）
  if (mode === 'image' && rawResults.length > 0 && rawResults[0]?.matched_images) {
    return normalizeImageFileResultsToItems(rawResults);
  }

  const normalized = [];
  rawResults.forEach((result) => {
    // hybrid で image ファイル単位が混在するケースも許容
    if (result?.matched_images) {
      normalized.push(...normalizeImageFileResultsToItems([result]));
      return;
    }

    const sourceType = inferSourceType(result);
    const scoreCandidates = [
      result.score,
      result.hybrid_score,
      result.vector_score,
      typeof result.vector_distance === 'number' ? (1 - result.vector_distance) : null,
    ];
    const score = scoreCandidates.find((value) => typeof value === 'number' && !Number.isNaN(value)) ?? null;

    const fileName = result.file_name || result.original_filename || (result.object_name || '').split('/').pop() || '-';
    const pageNo = sourceType === 'text'
      ? inferTextRelatedPageNo(result)
      : (result.page_no ?? result.page_number ?? null);
    const keywordExcerpt = buildKeywordMatchExcerpt(result);
    const contentExcerpt = result.content_excerpt || result.chunk_text || keywordExcerpt || '';
    const imageUrl = result.url
      ? getAuthenticatedImageUrl(result.url)
      : (result.bucket && result.object_name ? getAuthenticatedImageUrl(result.bucket, result.object_name) : '');
    const textRelatedPreview = sourceType === 'text' ? buildRelatedImagePreview({
      object_name: result.object_name,
      bucket: result.bucket,
      file_name: fileName,
      chunk_index: result.chunk_index,
      page_no: result.page_no,
      page_number: result.page_number
    }) : { urls: [], titles: [] };

    const normalizedItem = {
      source_type: sourceType,
      score,
      vector_distance: typeof result.vector_distance === 'number' ? result.vector_distance : null,
      bucket: result.bucket || '',
      file_name: fileName,
      document_object_name: result.file_object_name || result.object_name || '-',
      object_name: result.object_name || '-',
      page_no: pageNo,
      content_excerpt: contentExcerpt,
      thumbnail_url: sourceType === 'image' ? imageUrl : '',
      download_url: (result.file_url || result.url)
        ? getAuthenticatedImageUrl(result.file_url || result.url)
        : (result.bucket && result.object_name ? getAuthenticatedImageUrl(result.bucket, result.object_name) : ''),
      preview_urls: sourceType === 'image' && imageUrl ? [imageUrl] : [],
      preview_titles: sourceType === 'image' ? [`${fileName}${pageNo ? ` - ページ ${pageNo}` : ''}`] : [],
      text_related_image_urls: textRelatedPreview.urls,
      text_related_image_titles: textRelatedPreview.titles,
      keyword_matches: Array.isArray(result.keyword_matches) ? result.keyword_matches : [],
      preview_index: 0,
      _raw: result
    };

    if (mode !== 'image-text-keyword' && mode !== 'image-hybrid') {
      normalizedItem.keyword_matches = [];
      if (normalizedItem._raw && typeof normalizedItem._raw === 'object') {
        if (normalizedItem._raw.scores && typeof normalizedItem._raw.scores === 'object') {
          normalizedItem._raw = {
            ...normalizedItem._raw,
            scores: {
              ...normalizedItem._raw.scores,
              keyword: undefined,
            },
            keyword_score: undefined,
          };
        } else {
          normalizedItem._raw = {
            ...normalizedItem._raw,
            keyword_score: undefined,
          };
        }
      }
    }

    normalized.push(normalizedItem);
  });

  return normalized;
}

function renderResultCard(item, index, options = {}) {
  const compact = !!options.compact;
  const mode = options.mode || currentRetrievalMode || 'image';
  const sourceTypes = Array.isArray(item.source_types) ? item.source_types : [item.source_type];
  const isImage = item.source_type === 'image';
  const isMixed = sourceTypes.includes('image') && sourceTypes.includes('text');
  const fullText = item.content_excerpt || '（抜粋なし）';
  const keywordMatches = Array.isArray(item.keyword_matches) ? item.keyword_matches : [];
  const relatedImageUrls = Array.isArray(item.text_related_image_urls) ? item.text_related_image_urls : [];
  const relatedImageTitles = Array.isArray(item.text_related_image_titles) ? item.text_related_image_titles : [];
  const primaryRelatedImageUrl = relatedImageUrls[0] || '';
  const primaryRelatedImageTitle = relatedImageTitles[0] || `page ${item.page_no || (item._raw?.chunk_index + 1) || 1}`;
  const badgeClass = isMixed
    ? 'background: #ecfeff; color: #0f766e; border: 1px solid #99f6e4;'
    : isImage
    ? 'background: #e0f2fe; color: #0369a1; border: 1px solid #7dd3fc;'
    : 'background: #ede9fe; color: #6d28d9; border: 1px solid #c4b5fd;';

  const previewThumbUrl = (isImage || isMixed) ? item.thumbnail_url : primaryRelatedImageUrl;
  const pageLabel = item.page_no ? `ページ ${safeText(item.page_no)}` : '';
  const metrics = item.metrics || {};
  const matchTabs = buildResultMatchTabs(item, mode);
  const metricDetailPanel = buildMetricRows(getModeMetricEntries(item, mode));
  const keywordHitBadge = keywordMatches.length > 0
    ? `<span class="badge search-result-inline-stat-badge" title="キーワード一致あり"><i class="fas fa-key" style="margin-right: 4px;"></i></span>`
    : '';

  const cardInner = `
      <div class="card-body search-result-card-body">
        <div class="search-result-thumb-column">
          ${previewThumbUrl ? `
            <div
              class="image-card search-result-thumb-card"
              onclick="${(isImage || isMixed) ? `window.searchModule.openResultImageByIndex(${index})` : `window.searchModule.openTextRelatedImageByIndex(${index}, 0)`}"
            >
              <div class="search-result-thumb-aspect">
                <img
                  src="${safeText(previewThumbUrl)}"
                  alt="preview"
                  style="position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain;"
                  ${!(isImage || isMixed) ? 'onerror="this.closest(\'.search-result-thumb-card\')?.classList.add(\'is-hidden\');"' : ''}
                />
              </div>
            </div>
          ` : `
            <div class="search-result-thumb-empty">
              <i class="far fa-image"></i>
              <span>サムネイルなし</span>
            </div>
          `}
        </div>

        <div class="search-result-content-column">
          <div class="search-result-entry-header">
            <div class="search-result-entry-badges">
            ${matchTabs}
            ${keywordHitBadge}
            ${pageLabel ? `<span class="badge search-result-inline-stat-badge">${pageLabel}</span>` : ''}
            </div>
            <div class="search-result-card-actions">
              ${sourceTypes.includes('text') ? `
                <button
                  type="button"
                  class="search-text-popup-btn"
                  onclick="window.searchModule.openResultTextModalByIndex(${index})"
                >
                  <i class="far fa-file-alt"></i> テキスト表示
                </button>
              ` : ''}
              ${keywordMatches.length > 0 ? `
                <button
                  type="button"
                  class="search-text-popup-btn"
                  onclick="window.searchModule.openResultTextModalByIndex(${index})"
                >
                  <i class="fas fa-key"></i> キーワード一致
                </button>
              ` : ''}
            </div>
          </div>

          ${sourceTypes.includes('text') ? `
            <div class="search-text-thumb-caption">
              <i class="far fa-image"></i> ${safeText(primaryRelatedImageTitle)}
            </div>
          ` : keywordMatches.length > 0 ? `
            <div class="search-text-thumb-caption">
              <i class="fas fa-key"></i> キーワード一致あり（${safeText(keywordMatches.length)}件）
            </div>
          ` : ''}

          ${metricDetailPanel}
        </div>
      </div>
  `;

  if (compact) {
    return `<div class="search-result-entry">${cardInner}</div>`;
  }

  return `<div class="card search-result-card" style="margin-bottom: 12px;">${cardInner}</div>`;
}

function renderDocumentGroupCard(group, groupIndex) {
  const hasText = group.entries.some(({ item }) => item.source_type === 'text');
  const hasImage = group.entries.some(({ item }) => item.source_type === 'image');
  const sourceTypeLabel = hasText && hasImage
    ? 'text + image'
    : (hasText ? 'text' : 'image');

  const mode = window._searchResultsData?.mode || currentRetrievalMode || 'image';
  const topEntry = group.entries?.[0]?.item;
  const groupMetricPanel = topEntry ? buildMetricRows(getModeMetricEntries(topEntry, mode)) : '';

  return `
    <div class="card search-doc-group-card">
      <div class="search-doc-group-header">
        <div class="search-doc-group-header-main">
          <div class="search-doc-group-title-row">
            <span class="search-doc-rank-badge">#${groupIndex + 1}</span>
            <span><i class="fas fa-file"></i> ${safeText(group.file_name || '-')}</span>
          </div>
          <div class="search-doc-group-path">${safeText(group.object_name || '-')}</div>
        </div>
        <div class="search-doc-group-stats">
          <span class="badge search-result-stat-badge">タイプ: ${safeText(sourceTypeLabel)}</span>
          <span class="badge search-result-stat-badge">マッチ度: ${formatMatchPercent(group.best_score)}</span>
          ${group.best_distance !== null ? `<span class="badge search-result-stat-badge">距離: ${group.best_distance.toFixed(4)}</span>` : ''}
          <span class="badge search-result-stat-badge">件数: ${group.entries.length}</span>
          ${group.matched_pages_count > 0 ? `<span class="badge search-result-stat-badge">ページ: ${group.matched_pages_count}</span>` : ''}
        </div>
      </div>

      <div class="search-doc-group-body">
        ${groupMetricPanel ? `
          <div class="search-doc-group-section">
            ${groupMetricPanel}
          </div>
        ` : ''}

        <div class="search-doc-group-entries">
          ${group.entries.map(({ item, index }) => renderResultCard(item, index, { compact: true, mode })).join('')}
        </div>
      </div>
    </div>
  `;
}

export function toggleResultTextByIndex(resultIndex) {
  return openResultTextModalByIndex(resultIndex);
}

export function openResultTextModalByIndex(resultIndex) {
  const resultData = window._searchResultsData;
  const item = resultData?.results?.[resultIndex];
  const hasKeywordMatch = Array.isArray(item?.keyword_matches) && item.keyword_matches.length > 0;
  if (!item || (item.source_type !== 'text' && !hasKeywordMatch)) {
    utilsShowToast('テキストデータが見つかりません', 'warning');
    return;
  }

  const modalTitle = `${item.file_name || 'テキスト結果'}${item.page_no ? ` / page ${item.page_no}` : ''}${hasKeywordMatch && item.source_type !== 'text' ? ' / キーワード一致' : ''}`;
  showResultTextModal(modalTitle, item.content_excerpt || '（抜粋なし）');
}

function updateResultsSummary(data, normalizedResults, mode, groupedResults = null) {
  const summarySpan = document.getElementById('searchResultsSummary');
  if (!summarySpan) return;

  const imageCount = normalizedResults.filter(r => r.source_type === 'image').length;
  const textCount = normalizedResults.filter(r => r.source_type === 'text').length;
  const processingTime = typeof data?.processing_time === 'number' ? data.processing_time.toFixed(2) : '-';
  const modeLabel = getRetrievalModeLabel(mode || currentRetrievalMode);
  const docsCount = Array.isArray(groupedResults) ? groupedResults.length : 0;

  summarySpan.textContent = `mode: ${modeLabel} / docs: ${docsCount}件 / hits: ${normalizedResults.length}件 (image: ${imageCount}, text: ${textCount}, ${processingTime}秒)`;
}

/**
 * 検索タイプを切り替え
 * 
 * テキスト検索と画像検索のUIを切り替える関数です。
 * 
 * @param {string} type - 検索タイプ ('text' または 'image')
 * 
 * ネットワーク通信の影響:
 * - UIの表示切り替えのみ（ネットワーク通信なし）
 * - ユーザーエクスペリエンスの向上
 */
export function switchSearchType(type) {
  currentSearchType = type;
  
  const textTab = document.getElementById('searchTypeTextTab');
  const imageTab = document.getElementById('searchTypeImageTab');
  const textPanel = document.getElementById('textSearchPanel');
  const imagePanel = document.getElementById('imageSearchPanel');
  
  if (type === 'text') {
    // テキスト検索タブをアクティブに
    textTab.style.borderBottomColor = '#1a365d';
    textTab.style.color = '#1a365d';
    imageTab.style.borderBottomColor = 'transparent';
    imageTab.style.color = '#64748b';
    
    textPanel.style.display = 'block';
    imagePanel.style.display = 'none';
  } else {
    // 画像検索タブをアクティブに
    imageTab.style.borderBottomColor = '#1a365d';
    imageTab.style.color = '#1a365d';
    textTab.style.borderBottomColor = 'transparent';
    textTab.style.color = '#64748b';
    
    imagePanel.style.display = 'block';
    textPanel.style.display = 'none';
  }
}

/**
 * Retrieval mode を設定
 * @param {string} mode - 'image' | 'text' | 'image-text' | 'image-text-vector' | 'image-text-keyword'
 */
export function setRetrievalMode(mode) {
  currentRetrievalMode = mode || 'image';
  const selector = document.getElementById('retrievalMode');
  if (selector && selector.value !== currentRetrievalMode) {
    selector.value = currentRetrievalMode;
  }
}

/**
 * 検索画像を選択
 * @param {Event} event - ファイル選択イベント
 */
export function handleSearchImageSelect(event) {
  const file = event.target.files[0];
  if (!file) return;
  
  // ファイルサイズチェック (最大10MB)
  const maxSize = 10 * 1024 * 1024;
  if (file.size > maxSize) {
    utilsShowToast('画像ファイルは10MB以下にしてください', 'warning');
    return;
  }
  
  // ファイルタイプチェック
  if (!file.type.match(/^image\/(png|jpeg|jpg)$/)) {
    utilsShowToast('PNG, JPG, JPEG形式の画像のみ対応しています', 'warning');
    return;
  }
  
  selectedSearchImage = file;
  
  // プレビュー表示
  const reader = new FileReader();
  reader.onload = (e) => {
    const previewImg = document.getElementById('searchImagePreviewImg');
    const previewDiv = document.getElementById('imageSearchPreview');
    const placeholder = document.getElementById('imageSearchPlaceholder');
    const filenameSpan = document.getElementById('searchImageFilename');
    
    if (previewImg && previewDiv && placeholder && filenameSpan) {
      previewImg.src = e.target.result;
      filenameSpan.textContent = file.name;
      previewDiv.style.display = 'block';
      placeholder.style.display = 'none';
    }
  };
  reader.readAsDataURL(file);
}

/**
 * 検索画像をクリア
 */
export function clearSearchImage() {
  selectedSearchImage = null;
  
  const fileInput = document.getElementById('searchImageInput');
  const previewDiv = document.getElementById('imageSearchPreview');
  const placeholder = document.getElementById('imageSearchPlaceholder');
  
  if (fileInput) fileInput.value = '';
  if (previewDiv) previewDiv.style.display = 'none';
  if (placeholder) placeholder.style.display = 'block';
}

/**
 * 画像検索を実行
 */
export async function performImageSearch() {
  if (!selectedSearchImage) {
    utilsShowToast('検索する画像を選択してください', 'warning');
    return;
  }
  
  // 共通のフィルター値を使用
  const filenameFilter = document.getElementById('filenameFilter').value.trim();
  const topK = parseInt(document.getElementById('topK').value) || 10;
  const minScore = parseFloat(document.getElementById('minScore').value) || 0.7;
  
  try {
    const retrievalModeElement = document.getElementById('retrievalMode');
    const retrievalMode = retrievalModeElement?.value || currentRetrievalMode || 'image';
    if (retrievalMode !== 'image') {
      const modeLabel = getRetrievalModeLabel(retrievalMode);
      utilsShowToast(`${modeLabel} はテキスト検索タブから実行してください`, 'warning');
      return;
    }
    setRetrievalMode(retrievalMode);
    utilsShowLoading('画像検索中...');
    
    // FormDataを作成
    const formData = new FormData();
    formData.append('image', selectedSearchImage);
    formData.append('top_k', topK.toString());
    formData.append('min_score', minScore.toString());
    if (filenameFilter) {
      formData.append('filename_filter', filenameFilter);
    }
    
    const data = await authApiCall('/ai/api/search/image', {
      method: 'POST',
      body: formData
    });
    
    utilsHideLoading();
    displaySearchResultsWithMode(data, { mode: retrievalMode });
    
    // 検索完了メッセージを表示
    utilsShowToast('画像検索が完了しました', 'success');
    
  } catch (error) {
    utilsHideLoading();
    utilsShowToast(`画像検索に失敗しました: ${error.message}`, 'error');
  }
}

/**
 * 認証トークン付きのURLを生成
 * @param {string} url - ベースURL(検索APIから返却されたURLまたはバケット/オブジェクト名)
 * @param {string} bucket - バケット名(オプション、旧形式互換用)
 * @param {string} objectName - オブジェクト名(オプション、旧形式互換用)
 * @returns {string} トークン付きのURL
 */
function getAuthenticatedImageUrl(urlOrBucket, objectName) {
  const token = localStorage.getItem('loginToken');
  const apiBase = appState.get('apiBase') || '';
  const rewriteLocalhostUrl = (rawUrl) => {
    if (!rawUrl) return rawUrl;
    try {
      const parsed = new URL(rawUrl, window.location.origin);
      if (parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
        return rawUrl;
      }

      const normalizedPath = parsed.pathname.startsWith('/ai/')
        ? parsed.pathname
        : `/ai${parsed.pathname}`;

      if (apiBase) {
        const apiUrl = new URL(apiBase, window.location.origin);
        return `${apiUrl.origin}${normalizedPath}${parsed.search}${parsed.hash}`;
      }

      return `${window.location.origin}${normalizedPath}${parsed.search}${parsed.hash}`;
    } catch (_) {
      return rawUrl;
    }
  };

  const hasAuthLikeQuery = (url) => {
    if (!url || !url.includes('?')) return false;
    try {
      const parsed = new URL(url, window.location.origin);
      return (
        parsed.searchParams.has('t') ||
        parsed.searchParams.has('token') ||
        parsed.searchParams.has('api_key')
      );
    } catch (_) {
      // URLパースに失敗しても、単純判定で既存クエリを尊重
      return /[?&](t|token|api_key)=/.test(url);
    }
  };
  
  // 既に完全なURLが渡された場合(検索APIのurlフィールド)
  if (urlOrBucket && (urlOrBucket.startsWith('http://') || urlOrBucket.startsWith('https://') || urlOrBucket.startsWith('/'))) {
    let url = rewriteLocalhostUrl(urlOrBucket);
    // 検索APIが返す一時トークン(t)付きURL等はそのまま利用
    if (hasAuthLikeQuery(url)) {
      return url;
    }
    if (token) {
      const separator = url.includes('?') ? '&' : '?';
      return `${url}${separator}token=${encodeURIComponent(token)}`;
    }
    return url;
  }
  
  // 旧形式互換: bucket + objectName が渡された場合
  if (urlOrBucket && objectName) {
    const normalizedObjectName = String(objectName)
      .split('/')
      .map(segment => encodeURIComponent(segment))
      .join('/');
    const baseUrl = `/ai/api/object/${urlOrBucket}/${normalizedObjectName}`;
    if (token) {
      return `${baseUrl}?token=${encodeURIComponent(token)}`;
    }
    return baseUrl;
  }
  
  return rewriteLocalhostUrl(urlOrBucket || '');
}

/**
 * 検索を実行
 */
export async function performSearch() {
  const query = document.getElementById('searchQuery').value.trim();
  const filenameFilter = document.getElementById('filenameFilter').value.trim();
  const topK = parseInt(document.getElementById('topK').value) || 10;
  const minScore = parseFloat(document.getElementById('minScore').value) || 0.7;
  
  if (!query) {
    utilsShowToast('検索クエリを入力してください', 'warning');
    return;
  }
  
  const retrievalModeElement = document.getElementById('retrievalMode');
  const retrievalMode = retrievalModeElement?.value || currentRetrievalMode || 'image';
  setRetrievalMode(retrievalMode);

  try {
    const loadingLabel = (retrievalMode === 'image-text')
      ? 'image×text 検索中...'
      : ((retrievalMode === 'image-text-vector' || retrievalMode === 'hybrid')
      ? 'image×text hybrid 検索中...'
      : (retrievalMode === 'text'
        ? 'テキスト検索中...'
        : ((retrievalMode === 'image-text-keyword' || retrievalMode === 'image-hybrid') ? 'image×keyword 検索中...' : '画像検索中...')));
    utilsShowLoading(loadingLabel);

    if ((retrievalMode === 'image-text-keyword' || retrievalMode === 'image-hybrid') && currentSearchType === 'image') {
      utilsHideLoading();
      utilsShowToast('image×keyword はテキスト検索タブから実行してください', 'warning');
      return;
    }
    
    const requestBody = { query, top_k: topK, min_score: minScore, search_mode: retrievalMode };
    if (filenameFilter) {
      requestBody.filename_filter = filenameFilter;
    }
    
    let endpoint = '/ai/api/search';
    if (retrievalMode === 'text') {
      endpoint = '/ai/api/search/text';
    } else if (retrievalMode === 'image-text') {
      endpoint = '/ai/api/search/image-text';
    } else if (retrievalMode === 'image-text-vector' || retrievalMode === 'hybrid') {
      endpoint = '/ai/api/search/image-text-vector';
    } else if (retrievalMode === 'image-text-keyword' || retrievalMode === 'image-hybrid') {
      endpoint = '/ai/api/search/image-text-keyword';
    }

    const data = await authApiCall(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    });
    
    utilsHideLoading();
    displaySearchResults(data, { mode: retrievalMode });
    
    // 検索完了メッセージを表示
    utilsShowToast('検索が完了しました', 'success');
    
  } catch (error) {
    utilsHideLoading();
    utilsShowToast(`検索に失敗しました: ${error.message}`, 'error');
  }
}

/**
 * 検索結果を表示
 * @param {Object} data - 検索結果データ
 */
export function displaySearchResults(data, options = {}) {
  return displaySearchResultsWithMode(data, { mode: options.mode || currentRetrievalMode });
}

/**
 * 検索結果を表示（mode対応）
 * @param {Object} data
 * @param {{mode?: string}} options
 */
export function displaySearchResultsWithMode(data, options = {}) {
  const resultsDiv = document.getElementById('searchResults');
  const listDiv = document.getElementById('searchResultsList');

  const mode = options.mode || currentRetrievalMode || 'image';

  window._searchResultsData = {
    raw: null,
    mode,
    results: []
  };

  const normalizedResults = mergeMixedResultsByDocumentPage(mergeTextResultsByPage(normalizeSearchResults(data, mode)));
  const groupedResults = groupResultsByDocument(normalizedResults);

  if (!normalizedResults.length) {
    resultsDiv.style.display = 'block';
    updateResultsSummary(data, [], mode, []);
    listDiv.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon"><i class="fas fa-search" style="color: #94a3b8;"></i></div>
        <div class="empty-state-title">検索結果が見つかりませんでした</div>
        <div class="empty-state-subtitle">mode: ${safeText(getRetrievalModeLabel(mode))} / 別のキーワードで検索してみてください</div>
      </div>
    `;
    return;
  }
  
  resultsDiv.style.display = 'block';
  updateResultsSummary(data, normalizedResults, mode, groupedResults);

  listDiv.innerHTML = groupedResults.map((group, index) => renderDocumentGroupCard(group, index)).join('');
  
  // 検索結果データをグローバルに保存（画像モーダル用）
  window._searchResultsData = {
    raw: data,
    mode,
    results: normalizedResults
  };

}

/**
 * 結果一覧のindexから画像モーダルを表示
 */
export function openResultImageByIndex(resultIndex) {
  const resultData = window._searchResultsData;
  const item = resultData?.results?.[resultIndex];
  if (!item || item.source_type !== 'image') {
    utilsShowToast('画像データが見つかりません', 'warning');
    return;
  }

  const urls = item.preview_urls?.length ? item.preview_urls : [item.thumbnail_url];
  const titles = item.preview_titles?.length
    ? item.preview_titles
    : [`${item.file_name || '画像'}${item.page_no ? ` - ページ ${item.page_no}` : ''}`];
  const selectedIndex = typeof item.preview_index === 'number' ? item.preview_index : 0;
  utilsShowImageModal(urls[selectedIndex], titles[selectedIndex], urls, selectedIndex, titles);
}

/**
 * 結果一覧のindexからファイルを開く
 */
export function openResultFileByIndex(resultIndex) {
  const resultData = window._searchResultsData;
  const item = resultData?.results?.[resultIndex];
  if (!item?.download_url) {
    utilsShowToast('ファイルURLが見つかりません', 'warning');
    return;
  }
  return downloadFile(item.download_url, '');
}

/**
 * テキスト検索結果に紐づくページ画像を開く
 */
export async function openTextRelatedImageByIndex(resultIndex, imageIndex = 0) {
  const resultData = window._searchResultsData;
  const item = resultData?.results?.[resultIndex];
  const urls = item?.text_related_image_urls || [];
  const titles = item?.text_related_image_titles || [];
  if (!urls.length) {
    utilsShowToast('関連画像が見つかりません', 'warning');
    return;
  }

  const { validUrls, validTitles } = await resolveValidImageCandidates(urls, titles);
  if (!validUrls.length) {
    utilsShowToast('関連画像が見つかりません（未生成または取得不可）', 'warning');
    return;
  }

  const safeIndex = Math.min(Math.max(imageIndex, 0), validUrls.length - 1);
  const selectedUrl = validUrls[safeIndex];
  const selectedTitle = validTitles[safeIndex] || 'ページ画像';
  utilsShowImageModal(
    selectedUrl,
    selectedTitle,
    validUrls,
    safeIndex,
    validTitles
  );
}

/**
 * 検索結果用画像モーダルを表示（ナビゲーション対応版）
 * @param {number} fileIndex - ファイルのインデックス
 * @param {number} imageIndex - 画像のインデックス
 */
export function showSearchImageModal(fileIndex, imageIndex) {
  // 旧呼び出し互換: rawレスポンス構造から表示
  const rawData = window._searchResultsData?.raw;
  if (!rawData || !rawData.results || !rawData.results[fileIndex]) {
    utilsShowToast('画像データが見つかりません', 'error');
    return;
  }
  
  const fileResult = rawData.results[fileIndex];
  const matchedImages = fileResult.matched_images;
  
  if (!matchedImages || imageIndex >= matchedImages.length) {
    utilsShowToast('画像が見つかりません', 'error');
    return;
  }
  
  // 画像URLとタイトルのリストを作成
  const imageUrls = matchedImages.map(img => {
    return img.url ? getAuthenticatedImageUrl(img.url) : getAuthenticatedImageUrl(img.bucket, img.object_name);
  });
  
  const imageTitles = matchedImages.map(img => {
    const matchPercent = (1 - img.vector_distance) * 100;
    return `ページ ${img.page_number} - マッチ度: ${matchPercent.toFixed(1)}% | 距離: ${img.vector_distance.toFixed(4)}`;
  });
  
  // 共通のshowImageModal関数を呼び出す（画像リストとインデックスを渡す）
  utilsShowImageModal(imageUrls[imageIndex], imageTitles[imageIndex], imageUrls, imageIndex, imageTitles);
}

/**
 * ファイルをダウンロード
 * @param {string} bucket - バケット名
 * @param {string} encodedObjectName - エンコードされたオブジェクト名
 */
export async function downloadFile(bucket, encodedObjectName) {
  try {
    // bucket が既に完全なURLの場合(検索結果のurl)と、bucket+objectNameの場合の両対応
    let fileUrl;
    if (bucket && (bucket.startsWith('http://') || bucket.startsWith('https://') || bucket.startsWith('/'))) {
      fileUrl = getAuthenticatedImageUrl(bucket);
    } else {
      fileUrl = getAuthenticatedImageUrl(bucket, decodeURIComponent(encodedObjectName));
    }
    
    // 新しいタブで開く
    window.open(fileUrl, '_blank');
    
    utilsShowToast('ファイルを開きました', 'success');
  } catch (error) {
    utilsShowToast(`ダウンロードに失敗しました: ${error.message}`, 'error');
  }
}

/**
 * 検索結果をクリア
 */
export function clearSearchResults() {
  // テキスト検索のクリア
  document.getElementById('searchQuery').value = '';
  
  // 画像検索のクリア
  clearSearchImage();
  
  // 検索結果を非表示
  document.getElementById('searchResults').style.display = 'none';
  document.getElementById('searchResultsList').innerHTML = '';
  document.getElementById('searchResultsSummary').textContent = '';
}

// windowオブジェクトに登録（HTMLから呼び出せるように）
window.searchModule = {
  performSearch,
  performImageSearch,
  displaySearchResults,
  showSearchImageModal,
  downloadFile,
  clearSearchResults,
  switchSearchType,
  handleSearchImageSelect,
  clearSearchImage,
  setRetrievalMode,
  openResultImageByIndex,
  openResultFileByIndex,
  openTextRelatedImageByIndex,
  toggleResultTextByIndex,
  openResultTextModalByIndex
};

// デフォルトエクスポート
export default {
  performSearch,
  performImageSearch,
  displaySearchResults,
  showSearchImageModal,
  downloadFile,
  clearSearchResults,
  switchSearchType,
  handleSearchImageSelect,
  clearSearchImage,
  setRetrievalMode,
  openResultImageByIndex,
  openResultFileByIndex,
  openTextRelatedImageByIndex,
  toggleResultTextByIndex,
  openResultTextModalByIndex,
  displaySearchResultsWithMode
}

/**
 * 画像モーダルを閉じる
 */
export function closeImageModal() {
  const modal = document.getElementById('imageModal');
  if (!modal) return;
  
  // ESCハンドラーを削除（グローバル変数を参照）
  const escapeHandler = window._imageModalEscapeHandler;
  if (escapeHandler) {
    document.removeEventListener('keydown', escapeHandler);
    window._imageModalEscapeHandler = null;
  }
  
  // 即座に削除（フラッシュを防ぐためアニメーションなし）
  modal.remove();
  
  // 追加の安全策：app.js側のグローバル変数もクリーンアップ
  if (typeof window._imageModalEscapeHandler !== 'undefined') {
    window._imageModalEscapeHandler = null;
  }
}