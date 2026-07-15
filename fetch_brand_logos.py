#!/usr/bin/env python3
"""抓品牌官方 logo → frontend/liff/img/brands/（開發沙箱無公網，在 GitHub Actions 跑）。
星巴克海妖圖無法手繪，從 Wikimedia 抓官方 SVG（多候選 URL 容錯）；
SVG 全失敗 → 退 PNG 縮圖（Pillow 轉 48px webp）。已存在且非空則不重抓。"""
import sys
import urllib.request
from pathlib import Path

OUT_DIR = Path(__file__).parent / 'frontend/liff/img/brands'
UA = {'User-Agent': 'openrice-what-to-eat/1.0 (brand map markers)'}

TARGETS = {
    'starbucks': {
        'svg': [
            'https://upload.wikimedia.org/wikipedia/en/d/d3/Starbucks_Corporation_Logo_2011.svg',
            'https://upload.wikimedia.org/wikipedia/sco/d/d3/Starbucks_Corporation_Logo_2011.svg',
        ],
        'png': [
            'https://upload.wikimedia.org/wikipedia/en/thumb/d/d3/Starbucks_Corporation_Logo_2011.svg/192px-Starbucks_Corporation_Logo_2011.svg.png',
        ],
    },
}


def fetch(url, timeout=20):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    failed = []
    for name, cand in TARGETS.items():
        out_svg = OUT_DIR / f'{name}.svg'
        out_webp = OUT_DIR / f'{name}.webp'
        if (out_svg.exists() and out_svg.stat().st_size > 500) or (out_webp.exists() and out_webp.stat().st_size > 500):
            print(f'ℹ️ {name} 已存在，略過')
            continue
        done = False
        for url in cand.get('svg', []):
            try:
                data = fetch(url)
                if b'<svg' in data[:2000]:
                    out_svg.write_bytes(data)
                    print(f'✅ {name}.svg ← {url}（{len(data)} bytes）')
                    done = True
                    break
            except Exception as exc:  # noqa: BLE001
                print(f'  svg 失敗 {url}: {exc}', file=sys.stderr)
        if not done:
            for url in cand.get('png', []):
                try:
                    data = fetch(url)
                    from io import BytesIO
                    from PIL import Image
                    im = Image.open(BytesIO(data)).convert('RGBA')
                    side = max(im.size)
                    sq = Image.new('RGBA', (side, side), (0, 0, 0, 0))
                    sq.paste(im, ((side - im.width) // 2, (side - im.height) // 2))
                    sq.resize((48, 48), Image.LANCZOS).save(out_webp, 'WEBP', quality=90)
                    print(f'✅ {name}.webp ← {url}')
                    done = True
                    break
                except Exception as exc:  # noqa: BLE001
                    print(f'  png 失敗 {url}: {exc}', file=sys.stderr)
        if not done:
            failed.append(name)
    if failed:
        print(f'⚠️ 抓不到：{failed}（不擋，其餘照 commit）', file=sys.stderr)


if __name__ == '__main__':
    main()
