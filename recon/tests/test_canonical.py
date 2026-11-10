"""规范化 JSON 与内容哈希（SHAPES 5）。期望值与接口服务生成的测试向量相同（内联一份）。"""

import hashlib

import numpy as np
import pytest

from metaverse_recon.canonical import (
    CanonicalError,
    canonical_json,
    canonicalize_text,
    content_hash,
    format_number,
)
from metaverse_recon.records import record_hash


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (1.0, "1"),
        (-1.5, "-1.5"),
        (0.1, "0.1"),
        (0.1 + 0.2, "0.30000000000000004"),
        (100.0, "100"),
        (1e16, "10000000000000000"),
        (1e20, "100000000000000000000"),
        (1e21, "1e+21"),
        (1.5e21, "1.5e+21"),
        (1e-6, "0.000001"),
        (1e-7, "1e-7"),
        (1.25e-7, "1.25e-7"),
        (123456.789, "123456.789"),
        (5e-324, "5e-324"),
        (1.7976931348623157e308, "1.7976931348623157e+308"),
        (-0.0, "0"),
    ],
)
def test_numbers_follow_ecmascript(value, expected):
    assert format_number(value) == expected


def test_non_finite_numbers_are_rejected():
    for bad in (float("nan"), float("inf"), -float("inf")):
        with pytest.raises(CanonicalError):
            format_number(bad)


# (输入文本, 规范化结果, sha256)：来自 api/crates/metaverse-core/tests/vectors/canonical_*.json
INLINE_VECTORS = [
    (
        "[1.0, -0, 0.1, 0.30000000000000004, 100, 1e2, 1e16, 1e20, 1e21, 1.5e300, 1e-6, 1e-7, -1.25e-7, "
        "123456789012, -42, 2.5, 5e-324, 1.7976931348623157e308, 9007199254740991]",
        "[1,0,0.1,0.30000000000000004,100,100,10000000000000000,100000000000000000000,1e+21,1.5e+300,"
        "0.000001,1e-7,-1.25e-7,123456789012,-42,2.5,5e-324,1.7976931348623157e+308,9007199254740991]",
        "0443d807413386a8a38b9aae010b33f75b87fdcd805123c935fdb504e5777577",
    ),
    (
        '["quote \\" backslash \\\\ slash \\/", "\\b\\f\\n\\r\\t", "\\u0000\\u0001\\u001f\\u007f", '
        '"\\u00e9\\u4e2d\\ud83d\\ude00\\u2028"]',
        '["quote \\" backslash \\\\ slash /","\\b\\f\\n\\r\\t","\\u0000\\u0001\\u001f\x7f","é中😀 "]',
        "3b512f8b781100c1d8ab98f8a0ccec08afc3000a233d47cfb7c295bd08c531fb",
    ),
    (
        '{"😀": 1, "｡": 2, "a": 3, "A": 4, "é": 5, "aa": 6, "": 7}',
        '{"":7,"A":4,"a":3,"aa":6,"é":5,"｡":2,"😀":1}',
        "59a2bf377b56a74a29a62f89729a0d099a6f1403aa554b7acca7aafff4a0cb51",
    ),
]


@pytest.mark.parametrize(("text", "canonical", "sha"), INLINE_VECTORS)
def test_inline_vectors(text, canonical, sha):
    out = canonicalize_text(text)
    assert out == canonical
    assert hashlib.sha256(out.encode()).hexdigest() == sha


def test_entity_record_hash_matches_rust():
    body = {
        "entityId": "counter-01",
        "layer": "rebuilt",
        "kind": "object",
        "label": "前台",
        "anchorId": "counter-01",
        "shape": {
            "type": "box",
            "size": [2.4, 1.1, 0.6],
            "fillet": 0.02,
            "transform": {"position": [3, 0, 1.5]},
            "material": {"color": [182, 140, 96]},
        },
        "bounds": {"min": [1.8, 0, 1.2], "max": [4.2, 1.1, 1.8]},
        "fit": {"meanCm": 1.8, "p90Cm": 4.2, "coverage3cm": 0.81},
        "props": {},
    }
    assert content_hash(body) == "4ee5deb57153dcf2b21a386d406548f0b0b951ce044deea8116247bdbed42584"
    assert record_hash("entity", "front-hall", body) == (
        "1a3f585bcab334d42862b833e951c47c92ea90b7d1ed4ba6bdbf66a012947f11"
    )


def test_unsafe_integers_are_rejected():
    assert canonical_json(9007199254740991) == "9007199254740991"
    for bad in (9007199254740992, -9007199254740992):
        with pytest.raises(CanonicalError) as err:
            canonical_json({"n": bad})
        assert err.value.code == "unsafe_integer"
    with pytest.raises(CanonicalError):
        canonicalize_text('{"n": 9007199254740992}')


def test_whitespace_removed_and_numpy_values_accepted():
    assert canonical_json({"b": np.float64(1.0), "a": np.array([1, 2]), "c": (True, None)}) == (
        '{"a":[1,2],"b":1,"c":[true,null]}'
    )
    assert content_hash({"a": 1, "b": [1.0, 2.5]}) == hashlib.sha256(b'{"a":1,"b":[1,2.5]}').hexdigest()


def test_non_string_keys_rejected():
    with pytest.raises(CanonicalError):
        canonical_json({1: "x"})
