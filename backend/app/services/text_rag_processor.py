"""
テキストRAG処理サービス

PDF / DOCX からテキストを抽出し、段落ベース + max_chars でチャンク化、
embedding化してTEXT_CHUNKSテーブルへ保存します。

注意:
- スキャンPDF（テキスト抽出不可）は対象外
- 既存の image_vectorizer.generate_text_embedding() を優先利用
"""

from __future__ import annotations

import io
import logging
import os
import re
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)


class TextRAGProcessor:
    EMPTY_PAGE_PLACEHOLDER = "（このページは画像主体のため本文テキストを抽出できませんでした）"

    def __init__(self, oci_service, database_service, image_vectorizer):
        self.oci_service = oci_service
        self.database_service = database_service
        self.image_vectorizer = image_vectorizer

    @staticmethod
    def _extract_pages_from_pdf(file_bytes: bytes) -> List[str]:
        # 依存を遅延importして、PyPDF2未導入環境でもモジュール読込自体は失敗させない
        from PyPDF2 import PdfReader

        reader = PdfReader(io.BytesIO(file_bytes))
        pages: List[str] = []
        for page in reader.pages:
            text = (page.extract_text() or "").strip()
            # 空ページも保持してページ数との対応を維持する
            pages.append(text)
        return pages

    @staticmethod
    def _extract_text_from_pdf(file_bytes: bytes) -> str:
        pages = TextRAGProcessor._extract_pages_from_pdf(file_bytes)
        text = "\n\n".join(pages)
        return text.strip()

    @staticmethod
    def _extract_pages_from_docx(file_bytes: bytes) -> List[str]:
        # 依存を遅延importして、docx未導入環境でもモジュール読込自体は失敗させない
        from docx import Document

        doc = Document(io.BytesIO(file_bytes))
        pages: List[str] = []
        current_parts: List[str] = []

        for paragraph in doc.paragraphs:
            text = (paragraph.text or "").strip()
            if text:
                current_parts.append(text)

            has_page_break = False
            for run in paragraph.runs:
                run_el = run._element
                ns = run_el.nsmap
                # 明示的なページ区切り
                for br in run_el.findall(".//w:br", ns):
                    if br.get("{http://schemas.openxmlformats.org/wordprocessingml/2006/main}type") == "page":
                        has_page_break = True
                        break
                # レンダリング由来の改ページ
                if not has_page_break and run_el.findall(".//w:lastRenderedPageBreak", ns):
                    has_page_break = True
                if has_page_break:
                    break

            if has_page_break:
                page_text = "\n\n".join(current_parts).strip()
                if page_text:
                    pages.append(page_text)
                current_parts = []

        # 最終ページ
        page_text = "\n\n".join(current_parts).strip()
        if page_text:
            pages.append(page_text)

        return pages

    @staticmethod
    def _extract_text_from_docx(file_bytes: bytes) -> str:
        pages = TextRAGProcessor._extract_pages_from_docx(file_bytes)
        return "\n\n".join(pages).strip()

    @staticmethod
    def _chunk_text_by_paragraphs(text: str, max_chars: int = 1200) -> List[str]:
        if not text or not text.strip():
            return []

        # まず段落分割（空行単位）
        paragraphs = [p.strip() for p in re.split(r"\n\s*\n+", text) if p and p.strip()]
        chunks: List[str] = []
        current = ""

        for paragraph in paragraphs:
            # 単一段落がmax_charsを超える場合は強制分割
            if len(paragraph) > max_chars:
                if current:
                    chunks.append(current)
                    current = ""
                for i in range(0, len(paragraph), max_chars):
                    sub = paragraph[i:i + max_chars].strip()
                    if sub:
                        chunks.append(sub)
                continue

            candidate = f"{current}\n\n{paragraph}" if current else paragraph
            if len(candidate) <= max_chars:
                current = candidate
            else:
                if current:
                    chunks.append(current)
                current = paragraph

        if current:
            chunks.append(current)

        return chunks

    @staticmethod
    def _chunk_text_by_pages(page_texts: List[str], max_chars: int = 1200) -> List[str]:
        """
        ページ境界を跨がずにチャンク化する。
        - ページテキストが max_chars 以下なら「1ページ=1チャンク」
        - max_chars を超えるページはページ内でのみ分割
        """
        chunks: List[str] = []
        for page_no, page_text in enumerate(page_texts, start=1):
            text = (page_text or "").strip()
            if not text:
                # 空ページも1ページ=1レコードで保持
                chunks.append(f"{TextRAGProcessor.EMPTY_PAGE_PLACEHOLDER} [page:{page_no}]")
                continue

            if len(text) <= max_chars:
                chunks.append(text)
                continue

            # 長すぎるページは、ページ内だけで分割（他ページとは結合しない）
            chunks.extend(TextRAGProcessor._chunk_text_by_paragraphs(text, max_chars=max_chars))

        return chunks

    @staticmethod
    def _keyword_score(query: str, chunk_text: str) -> float:
        query_tokens = [t for t in re.split(r"\s+", query.lower().strip()) if t]
        if not query_tokens:
            return 0.0

        chunk_lower = chunk_text.lower()
        hit = sum(1 for token in query_tokens if token in chunk_lower)
        return hit / len(query_tokens)

    def index_documents(self, object_names: List[str], max_chars: int = 1200) -> Dict[str, Any]:
        if not object_names:
            return {
                "success": False,
                "message": "index対象ファイルが指定されていません",
                "total": 0,
                "success_count": 0,
                "failed_count": 0,
                "results": [],
            }

        bucket = os.getenv("OCI_BUCKET", "")

        # テーブル作成（未作成時）
        ddl_result = self.database_service.ensure_text_chunks_table()
        if not ddl_result.get("success"):
            return {
                "success": False,
                "message": ddl_result.get("message", "TEXT_CHUNKSテーブル作成に失敗"),
                "total": len(object_names),
                "success_count": 0,
                "failed_count": len(object_names),
                "results": [],
            }

        results: List[Dict[str, Any]] = []
        success_count = 0

        for object_name in object_names:
            row: Dict[str, Any] = {"object_name": object_name, "success": False}
            try:
                ext = object_name.lower().rsplit(".", 1)[-1] if "." in object_name else ""
                if ext not in ("pdf", "docx"):
                    row["message"] = f"サポート対象外拡張子: {ext}"
                    results.append(row)
                    continue

                file_bytes = self.oci_service.download_object(object_name)
                if not file_bytes:
                    row["message"] = "Object Storageからファイル取得に失敗"
                    results.append(row)
                    continue

                if ext == "pdf":
                    page_texts = self._extract_pages_from_pdf(file_bytes)
                    extracted_text = "\n\n".join(page_texts).strip()
                    chunks = self._chunk_text_by_pages(page_texts, max_chars=max_chars)
                else:
                    page_texts = self._extract_pages_from_docx(file_bytes)
                    extracted_text = "\n\n".join(page_texts).strip()
                    chunks = self._chunk_text_by_pages(page_texts, max_chars=max_chars)

                if not page_texts:
                    row["message"] = "ページテキスト抽出に失敗しました"
                    results.append(row)
                    continue

                if not chunks:
                    row["message"] = "チャンク生成結果が空です"
                    results.append(row)
                    continue

                chunk_rows: List[Dict[str, Any]] = []
                for idx, chunk_text in enumerate(chunks):
                    embedding = self.image_vectorizer.generate_text_embedding(chunk_text)
                    if embedding is None:
                        continue
                    chunk_rows.append(
                        {
                            "chunk_index": idx,
                            "chunk_text": chunk_text,
                            "char_count": len(chunk_text),
                            "embedding": embedding,
                        }
                    )

                if not chunk_rows:
                    row["message"] = "embedding生成に失敗しました"
                    results.append(row)
                    continue

                save_result = self.database_service.replace_text_chunks(
                    bucket=bucket,
                    object_name=object_name,
                    original_filename=object_name.split("/")[-1],
                    chunks=chunk_rows,
                )

                row["success"] = bool(save_result.get("success"))
                row["message"] = save_result.get("message")
                row["chunk_count"] = len(chunk_rows)
                if row["success"]:
                    success_count += 1

            except Exception as e:
                logger.error(f"テキスト索引化エラー: object={object_name}, error={e}", exc_info=True)
                row["message"] = str(e)

            results.append(row)

        return {
            "success": success_count > 0,
            "total": len(object_names),
            "success_count": success_count,
            "failed_count": len(object_names) - success_count,
            "results": results,
        }

    def search_text(
        self,
        query: str,
        top_k: int = 10,
        min_score: float = 0.7,
        filename_filter: Optional[str] = None,
    ) -> Dict[str, Any]:
        query_embedding = self.image_vectorizer.generate_text_embedding(query)
        if query_embedding is None:
            return {"success": False, "query": query, "results": [], "message": "query embedding生成失敗"}

        rows = self.database_service.search_text_chunks_by_vector(
            query_embedding=query_embedding,
            limit=top_k,
            threshold=min_score,
            filename_filter=filename_filter,
        ) or []

        results: List[Dict[str, Any]] = []
        for r in rows:
            vector_distance = float(r.get("vector_distance", 1.0))
            vector_score = max(0.0, min(1.0, 1.0 - vector_distance))
            results.append(
                {
                    "chunk_id": r.get("chunk_id"),
                    "bucket": r.get("bucket"),
                    "object_name": r.get("object_name"),
                    "original_filename": r.get("original_filename"),
                    "chunk_index": r.get("chunk_index"),
                    "chunk_text": r.get("chunk_text"),
                    "char_count": r.get("char_count"),
                    "vector_distance": vector_distance,
                    "vector_score": vector_score,
                }
            )

        return {"success": True, "query": query, "results": results, "total": len(results)}

    def search_hybrid(
        self,
        query: str,
        top_k: int = 10,
        min_score: float = 0.7,
        filename_filter: Optional[str] = None,
        vector_weight: float = 0.7,
        keyword_weight: float = 0.3,
    ) -> Dict[str, Any]:
        query_embedding = self.image_vectorizer.generate_text_embedding(query)
        if query_embedding is None:
            return {"success": False, "query": query, "results": [], "message": "query embedding生成失敗"}

        vector_rows = self.database_service.search_text_chunks_by_vector(
            query_embedding=query_embedding,
            limit=max(top_k * 3, top_k),
            threshold=min_score,
            filename_filter=filename_filter,
        ) or []
        keyword_rows = self.database_service.search_text_chunks_by_keyword(
            query=query,
            limit=max(top_k * 3, top_k),
            filename_filter=filename_filter,
        ) or []

        merged: Dict[int, Dict[str, Any]] = {}

        for row in vector_rows:
            chunk_id = int(row["chunk_id"])
            vector_distance = float(row.get("vector_distance", 1.0))
            vector_score = max(0.0, min(1.0, 1.0 - vector_distance))
            merged[chunk_id] = {
                "chunk_id": chunk_id,
                "bucket": row.get("bucket"),
                "object_name": row.get("object_name"),
                "original_filename": row.get("original_filename"),
                "chunk_index": row.get("chunk_index"),
                "chunk_text": row.get("chunk_text"),
                "char_count": row.get("char_count"),
                "vector_distance": vector_distance,
                "scores": {
                    "text_vector": vector_score,
                    "keyword": 0.0,
                    "image": None,  # 将来拡張ポイント
                },
            }

        for row in keyword_rows:
            chunk_id = int(row["chunk_id"])
            keyword_score = self._keyword_score(query, row.get("chunk_text", ""))
            if chunk_id not in merged:
                merged[chunk_id] = {
                    "chunk_id": chunk_id,
                    "bucket": row.get("bucket"),
                    "object_name": row.get("object_name"),
                    "original_filename": row.get("original_filename"),
                    "chunk_index": row.get("chunk_index"),
                    "chunk_text": row.get("chunk_text"),
                    "char_count": row.get("char_count"),
                    "vector_distance": None,
                    "scores": {
                        "text_vector": 0.0,
                        "keyword": keyword_score,
                        "image": None,  # 将来拡張ポイント
                    },
                }
            else:
                merged[chunk_id]["scores"]["keyword"] = max(
                    merged[chunk_id]["scores"].get("keyword", 0.0), keyword_score
                )

        results = []
        for row in merged.values():
            hybrid_score = (
                vector_weight * row["scores"].get("text_vector", 0.0)
                + keyword_weight * row["scores"].get("keyword", 0.0)
            )
            row["hybrid_score"] = hybrid_score
            results.append(row)

        results.sort(key=lambda x: x.get("hybrid_score", 0.0), reverse=True)
        results = results[:top_k]

        return {
            "success": True,
            "query": query,
            "weights": {
                "vector_weight": vector_weight,
                "keyword_weight": keyword_weight,
            },
            "results": results,
            "total": len(results),
        }
