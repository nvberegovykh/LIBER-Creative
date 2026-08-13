"""Offline sentence embeddings for architectural space reasoning.

The release includes a pinned, quantized ONNX export of
onnx-community/all-MiniLM-L6-v2-ONNX.  This module intentionally uses only
NumPy and ONNX Runtime at inference time; it does not require PyTorch,
Transformers, an API key, or an internet connection.
"""
from __future__ import annotations

import math
import os
import re
import unicodedata
from pathlib import Path
from typing import Iterable, List, Sequence


MODEL_NAME = "onnx-community/all-MiniLM-L6-v2-ONNX"
MODEL_REVISION = "aff7a1dc4e8a1ea593e6ea21e95c22ef0a25966f"
MODEL_FILE = "model_q4.onnx"
MODEL_DIMENSION = 384


class LocalAIUnavailable(RuntimeError):
    """Raised when the bundled model or its runtime is not available."""


class WordPieceTokenizer:
    """Small BERT-compatible tokenizer backed by the bundled vocab.txt."""

    def __init__(self, vocab_path: Path, max_length: int = 128) -> None:
        self.vocab = {
            token.rstrip("\r\n"): index
            for index, token in enumerate(vocab_path.read_text(encoding="utf-8").splitlines())
        }
        self.max_length = max(8, int(max_length))
        self.unk_id = self.vocab.get("[UNK]", 100)
        self.cls_id = self.vocab.get("[CLS]", 101)
        self.sep_id = self.vocab.get("[SEP]", 102)
        self.pad_id = self.vocab.get("[PAD]", 0)

    @staticmethod
    def _basic_tokens(text: str) -> List[str]:
        text = unicodedata.normalize("NFD", text.lower())
        text = "".join(ch for ch in text if unicodedata.category(ch) != "Mn")
        text = "".join(
            f" {ch} " if unicodedata.category(ch).startswith(("P", "S")) else ch
            for ch in text
        )
        return [token for token in re.split(r"\s+", text.strip()) if token]

    def _wordpieces(self, token: str) -> List[int]:
        if token in self.vocab:
            return [self.vocab[token]]
        if len(token) > 100:
            return [self.unk_id]
        pieces: List[int] = []
        start = 0
        while start < len(token):
            end = len(token)
            found = None
            while end > start:
                piece = token[start:end]
                if start:
                    piece = "##" + piece
                if piece in self.vocab:
                    found = self.vocab[piece]
                    break
                end -= 1
            if found is None:
                return [self.unk_id]
            pieces.append(found)
            start = end
        return pieces

    def encode(self, text: str) -> List[int]:
        ids = [self.cls_id]
        for token in self._basic_tokens(text):
            ids.extend(self._wordpieces(token))
            if len(ids) >= self.max_length - 1:
                break
        ids.append(self.sep_id)
        return ids


class LocalMiniLM:
    """CPU/GPU local embedding runtime with deterministic provider fallback."""

    def __init__(self, model_dir: Path | None = None, max_length: int = 128) -> None:
        self.model_dir = Path(model_dir or Path(__file__).with_name("local_ai_model"))
        model_path = self.model_dir / MODEL_FILE
        vocab_path = self.model_dir / "vocab.txt"
        missing = [str(path) for path in (model_path, vocab_path) if not path.is_file()]
        if missing:
            raise LocalAIUnavailable("Bundled local-AI assets are missing: " + ", ".join(missing))
        try:
            import numpy as np
            import onnxruntime as ort
        except Exception as exc:
            raise LocalAIUnavailable(
                "Local AI needs NumPy and ONNX Runtime. Run INSTALL_LOCAL_AI.bat once."
            ) from exc

        self.np = np
        self.ort = ort
        self.tokenizer = WordPieceTokenizer(vocab_path, max_length=max_length)
        self.provider = "CPUExecutionProvider"
        available = set(ort.get_available_providers())
        requested = [
            name
            for name in (
                "CUDAExecutionProvider",
                "DmlExecutionProvider",
                "OpenVINOExecutionProvider",
                "CoreMLExecutionProvider",
                "CPUExecutionProvider",
            )
            if name in available
        ]
        if not requested:
            requested = ["CPUExecutionProvider"]

        options = ort.SessionOptions()
        options.log_severity_level = 3
        if "DmlExecutionProvider" in requested:
            options.enable_mem_pattern = False
            options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        try:
            self.session = ort.InferenceSession(
                str(model_path), sess_options=options, providers=requested
            )
        except Exception:
            self.session = ort.InferenceSession(
                str(model_path), sess_options=options, providers=["CPUExecutionProvider"]
            )
        active = self.session.get_providers()
        self.provider = active[0] if active else "CPUExecutionProvider"

    def encode(self, texts: Sequence[str], batch_size: int = 32) -> List[List[float]]:
        if not texts:
            return []
        vectors: List[List[float]] = []
        np = self.np
        for start in range(0, len(texts), max(1, int(batch_size))):
            batch = list(texts[start : start + batch_size])
            token_rows = [self.tokenizer.encode(text) for text in batch]
            width = max(len(row) for row in token_rows)
            input_ids = np.full(
                (len(token_rows), width), self.tokenizer.pad_id, dtype=np.int64
            )
            attention = np.zeros((len(token_rows), width), dtype=np.int64)
            for row_index, row in enumerate(token_rows):
                input_ids[row_index, : len(row)] = row
                attention[row_index, : len(row)] = 1
            token_types = np.zeros_like(input_ids)
            output = self.session.run(
                None,
                {
                    "input_ids": input_ids,
                    "attention_mask": attention,
                    "token_type_ids": token_types,
                },
            )[0]
            mask = attention[..., None].astype(np.float32)
            pooled = (output * mask).sum(axis=1) / np.maximum(mask.sum(axis=1), 1e-9)
            norms = np.linalg.norm(pooled, axis=1, keepdims=True)
            pooled = pooled / np.maximum(norms, 1e-12)
            vectors.extend(pooled.astype(float).tolist())
        return vectors


def cosine_similarity(left: Sequence[float], right: Sequence[float]) -> float:
    """Cosine similarity for already-normalized or ordinary vectors."""
    if not left or not right or len(left) != len(right):
        return 0.0
    dot = sum(a * b for a, b in zip(left, right))
    ln = math.sqrt(sum(a * a for a in left))
    rn = math.sqrt(sum(b * b for b in right))
    return dot / max(1e-12, ln * rn)

