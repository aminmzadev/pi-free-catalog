"""Read the production cache format and pre-0.1.2 plain-JSON caches."""
import gzip
import json
from pathlib import Path


def read_catalog(path):
    data = Path(path).read_bytes()
    if data.startswith(b"\x1f\x8b"):
        data = gzip.decompress(data)
    return json.loads(data.decode("utf-8"))
