import sys
import re
import pdfplumber

path = sys.argv[1]
texts = []

DATE_RE = re.compile(r"\b\d{1,2}\s*(?:[/.-]\s*\d{1,2}|\s+[A-Za-zÀ-ÿ]{3,9})\b")
MONEY_RE = re.compile(r"(?:R\$\s*)?-?\d{1,3}(?:\.\d{3})*,\d{2}-?")
TOTAL_LINE_RE = re.compile(r"^\s*(?:total|subtotal)\b", re.IGNORECASE)
DATE_WORD_RE = re.compile(r"^\d{1,2}\s*[/.-]\s*\d{1,2}$")


def extract_text(page):
    words = page.extract_words(x_tolerance=1, y_tolerance=3) or []
    if not words:
        return page.extract_text(x_tolerance=1, y_tolerance=3) or ""

    lines = []
    current = []
    current_top = None
    for word in sorted(words, key=lambda item: (item["top"], item["x0"])):
        top = word["top"]
        if current_top is None or abs(top - current_top) <= 3:
            current.append(word)
            current_top = top if current_top is None else current_top
            continue
        lines.append(current)
        current = [word]
        current_top = top
    if current:
        lines.append(current)

    return "\n".join(
        " ".join(word["text"] for word in sorted(line, key=lambda item: item["x0"]))
        for line in lines
    )


def likely_interleaved_columns(text):
    for line in text.splitlines():
        if len(DATE_RE.findall(line)) >= 2 and len(MONEY_RE.findall(line)) >= 2:
            return True
    return False


def detect_column_split(page):
    words = page.extract_words(x_tolerance=1, y_tolerance=3) or []
    date_xs = sorted(
        word["x0"]
        for word in words
        if DATE_WORD_RE.match(word.get("text", "").strip())
    )
    if date_xs:
        left_date_x = date_xs[0]
        right_dates = [
            x for x in date_xs
            if x > left_date_x + (page.width * 0.25) and x > page.width * 0.45
        ]
        if right_dates:
            split = min(right_dates) - 4
            if page.width * 0.45 <= split <= page.width * 0.75:
                return split
    return page.width * 0.58


def extract_columns(page):
    split = detect_column_split(page)
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
