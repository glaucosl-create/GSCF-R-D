import sys
import re
import pdfplumber

path = sys.argv[1]
texts = []

DATE_RE = re.compile(r"\b\d{1,2}\s*(?:[/.-]\s*\d{1,2}|\s+[A-Za-zÀ-ÿ]{3,9})\b")
MONEY_RE = re.compile(r"(?:R\$\s*)?-?\d{1,3}(?:\.\d{3})*,\d{2}-?")
TOTAL_LINE_RE = re.compile(r"^\s*(?:total|subtotal)\b", re.IGNORECASE)


def extract_text(page):
    return page.extract_text(x_tolerance=1, y_tolerance=3) or ""


def likely_interleaved_columns(text):
    for line in text.splitlines():
        if len(DATE_RE.findall(line)) >= 2 and len(MONEY_RE.findall(line)) >= 2:
            return True
    return False


def extract_columns(page):
    split = page.width / 2
    left = page.crop((0, 0, split, page.height))
    right = page.crop((split, 0, page.width, page.height))
    column_texts = [extract_text(left), extract_text(right)]
    regular_lines = []
    total_lines = []
    for column_text in column_texts:
        for line in column_text.splitlines():
            if TOTAL_LINE_RE.search(line):
                total_lines.append(line)
            else:
                regular_lines.append(line)
    return "\n".join(line for line in [*regular_lines, *total_lines] if line.strip())


with pdfplumber.open(path) as pdf:
    for page in pdf.pages:
        text = extract_text(page)
        if likely_interleaved_columns(text):
            text = extract_columns(page)
        if text:
            texts.append(text)

print("\n".join(texts))
