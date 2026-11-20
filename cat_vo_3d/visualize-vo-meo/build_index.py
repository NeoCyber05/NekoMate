"""Nhúng lại vo-meo-tuy-bien.html vào index.html (thay cho render.py của skill Visualize).

Chạy: python build_index.py
"""
import html
from pathlib import Path

here = Path(__file__).parent
index_path = here / "index.html"
source = (here / "vo-meo-tuy-bien.html").read_text(encoding="utf-8")
page = index_path.read_text(encoding="utf-8")

start = page.index("&lt;section id=&quot;cat-shell-preview&quot;")
# Đoạn nguồn kết thúc ở script đầu tiên đóng bằng "})();" sau section.
end_marker = "})();\n&lt;/script&gt;"
end = page.index(end_marker, start) + len(end_marker)
page = page[:start] + html.escape(source.rstrip("\n")) + page[end:]
# iframe sandbox phải cho phép tải file thì nút Xuất JSON / tải STL mới chạy.
page = page.replace('sandbox="allow-scripts"', 'sandbox="allow-scripts allow-downloads"', 1)
index_path.write_text(page, encoding="utf-8", newline="")
print("Updated", index_path.name)
