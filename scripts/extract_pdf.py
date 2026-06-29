import sys
import pdfplumber

path = sys.argv[1]
texts = []

with pdfplumber.open(path) as pdf:
    for page in pdf.pages:
        text = page.extract_text(x_tolerance=1, y_tolerance=3) or ""
        if text:
            texts.append(text)

print("\n".join(texts))
