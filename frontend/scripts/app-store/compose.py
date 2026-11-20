"""Frame raw App Store screenshots with a headline (6.9-inch: 1320 x 2868).

    python compose.py <raw dir> <out dir>

Raw shots come from shoot.mjs (same names). Captions live here so they are
easy to change; the app name isn't in them, so a rename only needs a re-shoot.
Needs Pillow and the Windows Georgia/Arial fonts.
"""
import os
import sys

from PIL import Image, ImageDraw, ImageFilter, ImageFont

W, H = 1320, 2868
BG = (243, 239, 231)
INK = (34, 58, 51)
MUTED = (107, 114, 128)
GOLD = (176, 141, 87)
FONTS = "C:/Windows/Fonts/"

CAPTIONS = {
    "01_properties": ("Every home you're\nconsidering, in one place", "Save homes from any property website"),
    "02_book_viewing": ("Book a viewing\nin a tap", "See the agent's free times. No phone tag."),
    "03_watchlist": ("Follow every home\nfrom saved to sold", "Viewings, offers and notes together"),
    "04_calendar": ("All your viewings\nin one calendar", "Shared with everyone in your household"),
    "05_dashboard": ("See what needs\nyou today", "Price drops, viewings and next steps"),
    "06_search_map": ("Draw the area you\nwant to live in", "Agents' new listings that fit come to you"),
    "07_buying_position": ("Show agents you're\nready to move", "Share your buying position in one place"),
    "08_agent_hours": ("For agents: set your\nviewing hours once", "Every listing gets bookable times"),
    "09_agent_listing": ("Never\ndouble-booked", "Book one home and clashing times go"),
}


def rounded(im, radius):
    mask = Image.new("L", im.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, *im.size), radius, fill=255)
    out = Image.new("RGBA", im.size)
    out.paste(im, (0, 0), mask)
    return out, mask


def compose(raw_path, out_path, title, sub):
    canvas = Image.new("RGB", (W, H), BG)
    draw = ImageDraw.Draw(canvas)
    title_font = ImageFont.truetype(FONTS + "georgiab.ttf", 96)
    sub_font = ImageFont.truetype(FONTS + "arial.ttf", 46)

    y = 170
    for line in title.split("\n"):
        w = draw.textlength(line, font=title_font)
        draw.text(((W - w) / 2, y), line, font=title_font, fill=INK)
        y += 118
    y += 18
    w = draw.textlength(sub, font=sub_font)
    draw.text(((W - w) / 2, y), sub, font=sub_font, fill=MUTED)
    draw.rounded_rectangle(((W - 90) / 2, 110, (W + 90) / 2, 118), 4, fill=GOLD)

    shot = Image.open(raw_path).convert("RGB")
    sw = 1000
    sh = round(shot.height * sw / shot.width)
    shot = shot.resize((sw, sh), Image.LANCZOS)
    phone, mask = rounded(shot, 70)
    top = 630
    left = (W - sw) // 2

    shadow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle((left, top + 24, left + sw, top + sh + 24), 70, fill=(34, 58, 51, 70))
    shadow = shadow.filter(ImageFilter.GaussianBlur(40))
    canvas.paste(shadow, (0, 0), shadow)
    border = Image.new("RGBA", (sw + 16, sh + 16), (0, 0, 0, 0))
    ImageDraw.Draw(border).rounded_rectangle((0, 0, sw + 15, sh + 15), 78, fill=(34, 58, 51, 255))
    canvas.paste(border, (left - 8, top - 8), border)
    canvas.paste(phone, (left, top), mask)
    canvas.save(out_path, optimize=True)


def main(raw_dir, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    for name, (title, sub) in CAPTIONS.items():
        raw = os.path.join(raw_dir, name + ".png")
        if not os.path.exists(raw):
            print("missing", name)
            continue
        compose(raw, os.path.join(out_dir, name + ".png"), title, sub)
        print("framed", name)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
