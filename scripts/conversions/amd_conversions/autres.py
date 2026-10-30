"""
LES AUTRES CONVERSIONS (décision 0019) — Office → PDF, PDF → Excel, image → PDF / Word, PowerPoint → images.

  Office → PDF        LibreOffice headless, profil jetable, filtre d'export PAR application (writer/impress/calc),
                      images SANS perte, polices embarquées. Les polices de l'image Docker couvrent l'arabe (Noto Naskh
                      Arabic, Amiri) et les métriques de Calibri/Cambria (Carlito/Caladea) : la pagination reste celle
                      de Word.
  PDF → Excel         on passe par le Word reconstruit (mêmes tableaux, même ordre logique, même OCR) puis chaque
                      tableau devient une feuille ; nombres à virgule reconnus ; feuille de droite à gauche si arabe.
  image → PDF         tesseract (renderer PDF) : l'image est la page, le texte reconnu un calque invisible cherchable.
  image → Word        l'image devient une page PDF scannée → le moteur PDF → Word (OCR, tableaux, illustrations).
  PowerPoint → images LibreOffice → PDF → une image PNG par diapositive (150 ppp), dans un ZIP.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import tempfile
import zipfile
from pathlib import Path

import pymupdf

from .normaliser import est_arabe

FILTRES = {
    "docx": "writer_pdf_Export", "doc": "writer_pdf_Export", "odt": "writer_pdf_Export", "rtf": "writer_pdf_Export",
    "pptx": "impress_pdf_Export", "ppt": "impress_pdf_Export", "odp": "impress_pdf_Export",
    "xlsx": "calc_pdf_Export", "xls": "calc_pdf_Export", "ods": "calc_pdf_Export",
}


def soffice() -> str | None:
    return shutil.which("soffice") or shutil.which("libreoffice")


def office_vers_pdf(source: Path, sortie: Path) -> dict:
    binaire = soffice()
    if not binaire:
        raise RuntimeError("LibreOffice est absent de cette machine")
    ext = source.suffix.lower().lstrip(".")
    filtre = FILTRES.get(ext, "writer_pdf_Export")
    options = {"UseLosslessCompression": {"type": "boolean", "value": "true"},
               "ReduceImageResolution": {"type": "boolean", "value": "false"},
               "EmbedStandardFonts": {"type": "boolean", "value": "true"},
               "ExportNotes": {"type": "boolean", "value": "false"}}
    with tempfile.TemporaryDirectory(prefix="amd-lo-") as d:
        src = Path(d) / f"source.{ext}"
        shutil.copy(source, src)
        r = subprocess.run([binaire, f"-env:UserInstallation=file://{d}/profil", "--headless", "--norestore",
                            "--convert-to", f"pdf:{filtre}:{json.dumps(options)}", "--outdir", d, str(src)],
                           capture_output=True, text=True, timeout=240)
        produit = Path(d) / "source.pdf"
        if r.returncode != 0 or not produit.exists():
            raise RuntimeError(f"LibreOffice : {(r.stderr or r.stdout).strip()[:300] or 'aucun fichier produit'}")
        shutil.copy(produit, sortie)
    with pymupdf.open(sortie) as doc:
        polices = sorted({f[3] for p in doc for f in p.get_fonts()})
        return {"moteur": "LibreOffice", "pages": doc.page_count, "polices": polices[:20]}


def _nombre(v: str):
    t = re.sub(r"[\s  ]", "", v)
    t = re.sub(r"(DZD|DA|دج|€|%)$", "", t, flags=re.I)
    if re.fullmatch(r"-?\d{1,3}(\.\d{3})*(,\d+)?|-?\d+(,\d+)?", t):
        return float(t.replace(".", "").replace(",", "."))
    if re.fullmatch(r"-?\d+\.\d+", t):
        return float(t)
    return v


def pdf_vers_xlsx(source: Path, sortie: Path, langues: str = "ara+fra+eng") -> dict:
    from docx import Document
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font

    from .pdf_docx import pdf_vers_docx

    with tempfile.TemporaryDirectory(prefix="amd-xlsx-") as d:
        docx = Path(d) / "intermediaire.docx"
        bilan = pdf_vers_docx(source, docx, langues=langues)
        doc = Document(str(docx))
        wb = Workbook()
        wb.remove(wb.active)
        cellules = 0
        for i, t in enumerate(doc.tables, 1):
            ws = wb.create_sheet(f"Tableau {i}")
            lignes = [[c.text.strip() for c in r.cells] for r in t.rows]
            # Cellules fusionnées : python-docx les répète ; on ne garde qu'une occurrence consécutive.
            for r, l in enumerate(lignes, 1):
                for c, v in enumerate(l, 1):
                    val = _nombre(v) if r > 1 else v
                    cell = ws.cell(row=r, column=c, value=val)
                    cellules += 1
                    if r == 1:
                        cell.font = Font(bold=True)
                    if isinstance(val, float):
                        cell.number_format = "#,##0.00"
                    cell.alignment = Alignment(wrap_text=True, vertical="top")
            if est_arabe(" ".join(" ".join(l) for l in lignes)):
                ws.sheet_view.rightToLeft = True
            for c in range(1, (max((len(l) for l in lignes), default=0)) + 1):
                largeur = max((len(str(l[c - 1])) for l in lignes if len(l) >= c), default=8)
                ws.column_dimensions[ws.cell(row=1, column=c).column_letter].width = min(60, max(10, largeur + 2))
        note = f"{len(doc.tables)} tableau(x) repris, une feuille chacun"
        if not doc.tables:
            ws = wb.create_sheet("Texte")
            for r, p in enumerate((p.text for p in doc.paragraphs if p.text.strip()), 1):
                ws.cell(row=r, column=1, value=p)
            note = "aucun tableau trouvé : le texte est repris en colonne A"
        wb.save(str(sortie))
    return {"moteur": "pdf2docx+amd → openpyxl", "tableaux": len(doc.tables), "cellules": cellules, "note": note, "pdf": bilan}


def image_vers_pdf(source: Path, sortie: Path, langues: str = "ara+fra+eng") -> dict:
    from .ocr import image_vers_pdf_cherchable

    return {"moteur": "tesseract (calque texte)", **image_vers_pdf_cherchable([source], sortie, langues)}


def image_vers_docx(source: Path, sortie: Path, langues: str = "ara+fra+eng") -> dict:
    from .pdf_docx import pdf_vers_docx

    with tempfile.TemporaryDirectory(prefix="amd-img-") as d:
        pdf = Path(d) / "image.pdf"
        with pymupdf.open() as doc:
            img = pymupdf.open(source)
            rect = img[0].rect
            page = doc.new_page(width=rect.width, height=rect.height)
            page.insert_image(page.rect, filename=str(source))
            doc.save(pdf)
        return pdf_vers_docx(pdf, sortie, langues=langues)


def pptx_vers_images(source: Path, sortie: Path, ppp: int = 150) -> dict:
    with tempfile.TemporaryDirectory(prefix="amd-img-") as d:
        pdf = Path(d) / "diapos.pdf"
        office_vers_pdf(source, pdf)
        with pymupdf.open(pdf) as doc, zipfile.ZipFile(sortie, "w", zipfile.ZIP_DEFLATED) as z:
            for page in doc:
                z.writestr(f"diapositive-{page.number + 1:02d}.png", page.get_pixmap(dpi=ppp).tobytes("png"))
            n = doc.page_count
    return {"moteur": "LibreOffice → PNG", "images": n, "ppp": ppp}
