from pathlib import Path

from PIL import Image, ImageDraw


root = Path(__file__).resolve().parents[1]
source = root / "apps/web/public/chatty-avatar.png"
output = root / "apps/desktop/build/icon-master.png"

image = Image.open(source).convert("RGBA")
side = min(image.size)
left = (image.width - side) // 2
top = (image.height - side) // 2
image = image.crop((left, top, left + side, top + side)).resize((1024, 1024), Image.Resampling.LANCZOS)

mask = Image.new("L", image.size, 0)
ImageDraw.Draw(mask).rounded_rectangle((22, 22, 1001, 1001), radius=218, fill=255)
image.putalpha(mask)
image.save(output)
