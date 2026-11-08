import sys, glob
from PIL import Image, ImageDraw, ImageFont
shots, out, cells = sys.argv[1], sys.argv[2], sys.argv[3:]
font = None
for f in glob.glob('/usr/share/fonts/**/*.tt[cf]', recursive=True) + glob.glob('/usr/share/fonts/**/*.otf', recursive=True):
    if any(k in f.lower() for k in ['noto', 'cjk', 'wqy', 'droid']):
        try: font = ImageFont.truetype(f, 40); break
        except Exception: pass
font = font or ImageFont.load_default()
ims = []
for c in cells:
    name, label = c.split('=', 1)
    im = Image.open(f'{shots}/{name}.png').convert('RGB')
    d = ImageDraw.Draw(im); d.rectangle([0, 0, im.width, 64], fill=(20, 21, 24)); d.text((20, 10), label, fill=(240, 240, 240), font=font)
    ims.append(im)
w, h = ims[0].size; cols = 2; rows = (len(ims) + 1) // 2
g = Image.new('RGB', (w * cols, h * rows), (43, 45, 49))
for i, im in enumerate(ims): g.paste(im, ((i % cols) * w, (i // cols) * h))
g = g.resize((g.width * 3 // 4, g.height * 3 // 4))
g.save(out, quality=88); print(out, g.size, 'font', getattr(font, 'path', 'default'))
