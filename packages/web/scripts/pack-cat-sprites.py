"""Export verified lossless WebP; requires Pillow and the project's Node runtime."""
from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[3]
OUTPUT = ROOT / "packages/web/public/mascots/cat"
DISPLAY_SIZE = 64


def display_quality(sheets: list[dict], paper: dict) -> dict:
    result = subprocess.run([
        "node", "--input-type=module", "-e",
        "import { CAT_APPEARANCES, getCatAppearanceCrop } from './packages/web/src/components/cat-catalog.ts';"
        "console.log(JSON.stringify(CAT_APPEARANCES.map(({id,sheet}) => ({id,sheet,crop:getCatAppearanceCrop(id)}))));",
    ], cwd=ROOT, check=True, capture_output=True, text=True)
    appearances = json.loads(result.stdout)
    if len(appearances) != 24:
        raise ValueError("Expected all 24 runtime appearance crops")
    crops = []
    for appearance in appearances:
        size = appearance["crop"][2]
        if not 0 < size <= sheets[appearance["sheet"]]["cellSize"]:
            raise ValueError(f"Invalid native crop size: {appearance['id']}")
        crops.append({"id": appearance["id"], "crop": appearance["crop"], "pixelRatio": size / DISPLAY_SIZE})
    return {
        "displaySize": DISPLAY_SIZE,
        "nativeFramePixelRatio": min(sheet["cellSize"] for sheet in sheets) / DISPLAY_SIZE,
        "minimumPixelRatio": min(item["pixelRatio"] for item in crops),
        "paperPixelRatio": min(paper["width"], paper["height"]) / DISPLAY_SIZE,
        "appearanceCrops": crops,
    }


def save_lossless(image: Image.Image, destination: Path) -> dict:
    image.save(destination, "WEBP", lossless=True, exact=True, quality=100, method=6)
    with Image.open(destination) as decoded:
        if decoded.convert(image.mode).tobytes() != image.tobytes():
            raise ValueError(f"WebP pixel round trip failed: {destination}")
    data = destination.read_bytes()
    return {
        "file": destination.name,
        "width": image.width,
        "height": image.height,
        "bytes": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
        "pixelSha256": hashlib.sha256(image.tobytes()).hexdigest(),
        "lossless": True,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("sources", type=Path, help="Directory containing actions-0.png through actions-5.png")
    args = parser.parse_args()
    OUTPUT.mkdir(parents=True, exist_ok=True)
    sheets = []
    original_bytes = 0
    for index in range(6):
        source = args.sources / f"actions-{index}.png"
        original_bytes += source.stat().st_size
        with Image.open(source) as opened:
            original = opened.convert("RGBA")
        if original.width != original.height or original.width // 4 < 256:
            raise ValueError(f"Expected a square 4x4 atlas with at least 256px native cells: {source}")
        if original.getchannel("A").getextrema() != (0, 255):
            raise ValueError(f"Sprite atlas must retain genuine transparency: {source}")
        cell = (original.width + 3) // 4
        atlas = Image.new("RGBA", (cell * 4, cell * 4))
        for row in range(4):
            for column in range(4):
                # Integer padding preserves all source pixels without resampling the artwork.
                frame = original.crop((column * original.width // 4, row * original.height // 4,
                                       (column + 1) * original.width // 4, (row + 1) * original.height // 4))
                atlas.paste(frame, (column * cell + (cell - frame.width) // 2,
                                    row * cell + cell - frame.height))
        entry = save_lossless(atlas, OUTPUT / f"actions-{index}.webp")
        entry.update({"cellSize": cell, "columns": 4, "rows": 4, "frames": 16})
        sheets.append(entry)
    with Image.open(ROOT / "packages/desktop/assets/kulo-icon-source.png") as icon:
        paper = icon.convert("RGB").crop((0, 0, 192, 192))
    paper_entry = save_lossless(paper, OUTPUT / "paper.webp")
    manifest = {
        "formatVersion": 1,
        "appearances": 24,
        "frames": 96,
        **display_quality(sheets, paper_entry),
        "resampled": False,
        "pixelRoundTripVerified": True,
        "sourcePngBytes": original_bytes,
        "runtimeImageBytes": sum(sheet["bytes"] for sheet in sheets) + paper_entry["bytes"],
        "sheets": sheets,
        "paper": paper_entry,
    }
    (OUTPUT / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({key: value for key, value in manifest.items() if key not in {"sheets", "paper"}}, indent=2))


if __name__ == "__main__":
    main()
