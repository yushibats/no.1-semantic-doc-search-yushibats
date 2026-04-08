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

import { apiCall as authApiCall } from './auth.js';
import { showLoading as utilsShowLoading, hideLoading as utilsHideLoading, showToast as utilsShowToast, showImageModal as utilsShowImageModal } from './utils.js';

// 検索画像の状態管理
let selectedSearchImage = null;
let currentSearchType = 'text'; // 'text' or 'image'
let currentRetrievalMode = 'image'; // 'image' | 'text' | 'hybrid'

function formatMatchPercent(score) {
  if (typeof score !== 'number' || Number.isNaN(score)) return '-';
  return `${(score * 100).toFixed(1)}%`;
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

    const previewUrls = matchedImages.map(img => (
      img.url ? getAuthenticatedImageUrl(img.url) : getAuthenticatedImageUrl(img.bucket, img.object_name)
    ));
    const previewTitles = matchedImages.map(img => {
      const score = typeof img.vector_distance === 'number' ? (1 - img.vector_distance) * 100 : null;
      return `ページ ${img.page_number ?? '-'}${score !== null ? ` - マッチ度: ${score.toFixed(1)}%` : ''}${typeof img.vector_distance === 'number' ? ` | 距離: ${img.vector_distance.toFixed(4)}` : ''}`;
    });

    matchedImages.forEach((img, imgIndex) => {
      const vectorDistance = typeof img.vector_distance === 'number' ? img.vector_distance : null;
      items.push({
        source_type: 'image',
        score: vectorDistance !== null ? (1 - vectorDistance) : null,
        vector_distance: vectorDistance,
        file_name: originalFilename,
        object_name: fileResult.object_name || img.object_name || '-',
        page_no: img.page_number ?? null,
        content_excerpt: '',
        thumbnail_url: img.url ? getAuthenticatedImageUrl(img.url) : getAuthenticatedImageUrl(img.bucket, img.object_name),
        download_url: fileResult.url ? getAuthenticatedImageUrl(fileResult.url) : getAuthenticatedImageUrl(fileResult.bucket, fileResult.object_name),
        preview_urls: previewUrls,
        preview_titles: previewTitles,
        preview_index: imgIndex,
        _raw_ref: { fileIndex, imgIndex }
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
    const score =
      (typeof result.score === 'number' && result.score) ||
      (typeof result.hybrid_score === 'number' && result.hybrid_score) ||
      (typeof result.vector_score === 'number' && result.vector_score) ||
      (typeof result.vector_distance === 'number' ? (1 - result.vector_distance) : null);

    const fileName = result.file_name || result.original_filename || (result.object_name || '').split('/').pop() || '-';
    const pageNo = sourceType === 'text'
      ? inferTextRelatedPageNo(result)
      : (result.page_no ?? result.page_number ?? null);
    const contentExcerpt = result.content_excerpt || result.chunk_text || '';
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

    normalized.push({
      source_type: sourceType,
      score,
      vector_distance: typeof result.vector_distance === 'number' ? result.vector_distance : null,
      bucket: result.bucket || '',
      file_name: fileName,
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
      preview_index: 0,
      _raw: result
    });
  });

  return normalized;
}

function renderResultCard(item, index, options = {}) {
  const compact = !!options.compact;
  const isImage = item.source_type === 'image';
  const fullText = item.content_excerpt || '（抜粋なし）';
  const relatedImageUrls = Array.isArray(item.text_related_image_urls) ? item.text_related_image_urls : [];
  const relatedImageTitles = Array.isArray(item.text_related_image_titles) ? item.text_related_image_titles : [];
  const primaryRelatedImageUrl = relatedImageUrls[0] || '';
  const primaryRelatedImageTitle = relatedImageTitles[0] || `page ${item.page_no || (item._raw?.chunk_index + 1) || 1}`;
  const badgeClass = isImage
    ? 'background: #e0f2fe; color: #0369a1; border: 1px solid #7dd3fc;'
    : 'background: #ede9fe; color: #6d28d9; border: 1px solid #c4b5fd;';

  const previewThumbUrl = isImage ? item.thumbnail_url : primaryRelatedImageUrl;
  const pageLabel = item.page_no ? `ページ ${safeText(item.page_no)}` : '';

  const cardInner = `
      <div class="card-body search-result-card-body">
        <div class="search-result-thumb-column">
          ${previewThumbUrl ? `
            <div
              class="image-card search-result-thumb-card"
              onclick="${isImage ? `window.searchModule.openResultImageByIndex(${index})` : `window.searchModule.openTextRelatedImageByIndex(${index}, 0)`}"
            >
              <div class="search-result-thumb-aspect">
                <img
                  src="${safeText(previewThumbUrl)}"
                  alt="preview"
                  style="position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain;"
                  ${!isImage ? 'onerror="this.closest(\'.search-result-thumb-card\')?.classList.add(\'is-hidden\');"' : ''}
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
            <span class="badge" style="${badgeClass} font-weight: 700;">${safeText(item.source_type || '-')}</span>
            <span class="badge search-result-inline-stat-badge">マッチ度: ${formatMatchPercent(item.score)}</span>
            ${item.vector_distance !== null ? `<span class="badge search-result-inline-stat-badge">距離: ${item.vector_distance.toFixed(4)}</span>` : ''}
            ${pageLabel ? `<span class="badge search-result-inline-stat-badge">${pageLabel}</span>` : ''}
            </div>
            <div class="search-result-card-actions">
              ${!isImage ? `
                <button
                  type="button"
                  class="search-text-popup-btn"
                  onclick="window.searchModule.openResultTextModalByIndex(${index})"
                >
                  <i class="far fa-file-alt"></i> テキスト表示
                </button>
              ` : ''}
            </div>
          </div>

          ${!isImage ? `
            <div class="search-text-thumb-caption">
              <i class="far fa-image"></i> ${safeText(primaryRelatedImageTitle)}
            </div>
          ` : ''}
        </div>
      </div>
  `;

  if (compact) {
    return `<div class="search-result-entry">${cardInner}</div>`;
  }

  return `<div class="card search-result-card" style="margin-bottom: 12px;">${cardInner}</div>`;
}

function renderDocumentGroupCard(group, groupIndex) {
  const sourceTypeLabel = group.source_types.length === 1
    ? group.source_types[0]
    : `mixed(${group.source_types.join(', ')})`;

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
        <div class="search-doc-group-body-title"><i class="far fa-images"></i> マッチした項目（距離が小さい順）</div>
        <div class="search-doc-group-entries">
          ${group.entries.map(({ item, index }) => renderResultCard(item, index, { compact: true })).join('')}
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
  if (!item || item.source_type !== 'text') {
    utilsShowToast('テキストデータが見つかりません', 'warning');
    return;
  }

  const modalTitle = `${item.file_name || 'テキスト結果'}${item.page_no ? ` / page ${item.page_no}` : ''}`;
  showResultTextModal(modalTitle, item.content_excerpt || '（抜粋なし）');
}

function updateResultsSummary(data, normalizedResults, mode, groupedResults = null) {
  const summarySpan = document.getElementById('searchResultsSummary');
  if (!summarySpan) return;

  const imageCount = normalizedResults.filter(r => r.source_type === 'image').length;
  const textCount = normalizedResults.filter(r => r.source_type === 'text').length;
  const processingTime = typeof data?.processing_time === 'number' ? data.processing_time.toFixed(2) : '-';
  const modeLabel = mode || currentRetrievalMode;
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
 * @param {string} mode - 'image' | 'text' | 'hybrid'
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
    setRetrievalMode('image');
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
    displaySearchResultsWithMode(data, { mode: 'image' });
    
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
    const url = urlOrBucket;
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
    const baseUrl = `/ai/api/object/${urlOrBucket}/${encodeURIComponent(objectName)}`;
    if (token) {
      return `${baseUrl}?token=${encodeURIComponent(token)}`;
    }
    return baseUrl;
  }
  
  return urlOrBucket || '';
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
    const loadingLabel = retrievalMode === 'hybrid' ? 'ハイブリッド検索中...' : (retrievalMode === 'text' ? 'テキスト検索中...' : '画像検索中...');
    utilsShowLoading(loadingLabel);
    
    const requestBody = { query, top_k: topK, min_score: minScore, search_mode: retrievalMode };
    if (filenameFilter) {
      requestBody.filename_filter = filenameFilter;
    }
    
    const endpoint = retrievalMode === 'text'
      ? '/ai/api/search/text'
      : (retrievalMode === 'hybrid' ? '/ai/api/search/hybrid' : '/ai/api/search');

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
  const normalizedResults = normalizeSearchResults(data, mode);
  const groupedResults = groupResultsByDocument(normalizedResults);

  if (!normalizedResults.length) {
    resultsDiv.style.display = 'block';
    updateResultsSummary(data, [], mode, []);
    listDiv.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon"><i class="fas fa-search" style="color: #94a3b8;"></i></div>
        <div class="empty-state-title">検索結果が見つかりませんでした</div>
        <div class="empty-state-subtitle">mode: ${safeText(mode)} / 別のキーワードで検索してみてください</div>
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
    [selectedUrl],
    0,
    [selectedTitle]
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