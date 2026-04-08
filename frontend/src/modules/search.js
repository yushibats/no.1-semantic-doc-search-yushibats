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

function formatScore(score) {
  if (typeof score !== 'number' || Number.isNaN(score)) return '-';
  return score.toFixed(4);
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
    const pageNo = result.page_no ?? result.page_number ?? null;
    const contentExcerpt = result.content_excerpt || result.chunk_text || '';
    const imageUrl = result.url
      ? getAuthenticatedImageUrl(result.url)
      : (result.bucket && result.object_name ? getAuthenticatedImageUrl(result.bucket, result.object_name) : '');

    normalized.push({
      source_type: sourceType,
      score,
      vector_distance: typeof result.vector_distance === 'number' ? result.vector_distance : null,
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
      preview_index: 0,
      _raw: result
    });
  });

  return normalized;
}

function renderResultCard(item, index) {
  const isImage = item.source_type === 'image';
  const badgeClass = isImage
    ? 'background: #e0f2fe; color: #0369a1; border: 1px solid #7dd3fc;'
    : 'background: #ede9fe; color: #6d28d9; border: 1px solid #c4b5fd;';

  return `
    <div class="card search-result-card" style="margin-bottom: 12px;">
      <div class="card-body" style="padding: 16px;">
        <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; margin-bottom: 10px;">
          <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
            <span class="badge" style="${badgeClass} font-weight: 700;">${safeText(item.source_type || '-')}</span>
            <span class="badge search-result-stat-badge">score: ${formatScore(item.score)}</span>
            ${item.vector_distance !== null ? `<span class="badge search-result-stat-badge">distance: ${item.vector_distance.toFixed(4)}</span>` : ''}
          </div>
          ${item.download_url ? `
            <button
              onclick="window.searchModule.openResultFileByIndex(${index})"
              class="search-result-download-btn"
              title="ファイルを開く"
            >
              <i class="fas fa-download"></i> 開く
            </button>
          ` : ''}
        </div>

        <div style="font-size: 14px; color: #1f2937; margin-bottom: 6px;"><i class="fas fa-file"></i> ${safeText(item.file_name || '-')}</div>
        <div style="font-size: 12px; color: #64748b; margin-bottom: 10px; word-break: break-all;">${safeText(item.object_name || '-')}</div>
        ${item.page_no ? `<div style="font-size: 12px; color: #334155; margin-bottom: 10px;"><i class="far fa-file-alt"></i> page: ${safeText(item.page_no)}</div>` : ''}

        ${isImage && item.thumbnail_url ? `
          <div
            class="image-card"
            onclick="window.searchModule.openResultImageByIndex(${index})"
            style="max-width: 320px; border: 2px solid #e2e8f0; border-radius: 8px; overflow: hidden; cursor: pointer;"
          >
            <div class="search-result-image-aspect">
              <img
                src="${safeText(item.thumbnail_url)}"
                alt="preview"
                style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; object-fit: contain;"
              />
            </div>
          </div>
        ` : ''}

        ${!isImage ? `
          <div style="margin-top: 10px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 10px; color: #334155; font-size: 13px; line-height: 1.6; white-space: pre-wrap;">
            ${safeText(item.content_excerpt || '（抜粋なし）')}
          </div>
        ` : ''}
      </div>
    </div>
  `;
}

function updateResultsSummary(data, normalizedResults, mode) {
  const summarySpan = document.getElementById('searchResultsSummary');
  if (!summarySpan) return;

  const imageCount = normalizedResults.filter(r => r.source_type === 'image').length;
  const textCount = normalizedResults.filter(r => r.source_type === 'text').length;
  const processingTime = typeof data?.processing_time === 'number' ? data.processing_time.toFixed(2) : '-';
  const modeLabel = mode || currentRetrievalMode;

  summarySpan.textContent = `mode: ${modeLabel} / total: ${normalizedResults.length}件 (image: ${imageCount}, text: ${textCount}, ${processingTime}秒)`;
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

  if (!normalizedResults.length) {
    resultsDiv.style.display = 'block';
    updateResultsSummary(data, [], mode);
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
  updateResultsSummary(data, normalizedResults, mode);

  listDiv.innerHTML = normalizedResults.map((item, index) => renderResultCard(item, index)).join('');
  
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
  openResultFileByIndex
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