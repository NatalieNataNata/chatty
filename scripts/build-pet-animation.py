from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter


def remove_connected_background(frame: Image.Image) -> Image.Image:
    cropped = frame.convert("RGB").crop((146, 315, 446, 645))
    marker = (255, 0, 255)
    flood_source = cropped.copy()
    ImageDraw.floodfill(flood_source, (0, 0), marker, thresh=16)

    alpha = Image.new("L", flood_source.size, 255)
    alpha_pixels = alpha.load()
    source_pixels = flood_source.load()
    for y in range(flood_source.height):
        for x in range(flood_source.width):
            if source_pixels[x, y] == marker:
                alpha_pixels[x, y] = 0

    # Pull the mask in by one pixel to remove the screen-recording fringe.
    alpha = alpha.filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(0.55))
    cropped.putalpha(alpha)
    return cropped.resize((220, 242), Image.Resampling.LANCZOS)


def main() -> None:
    source_dir = Path(sys.argv[1])
    output = Path(sys.argv[2])
    frames = [remove_connected_background(Image.open(path)) for path in sorted(source_dir.glob("*.png"))]
    if not frames:
        raise SystemExit("No frames found")

    frames[0].save(
        output,
        save_all=True,
        append_images=frames[1:],
        duration=42,
        loop=0,
        disposal=2,
        blend=0,
        optimize=False,
    )


if __name__ == "__main__":
    main()
