#!/usr/bin/env python3
"""
LE CONVERTISSEUR DU WORKER (décision 0019) — appelé par `src/lib/office/conversions-haute-fidelite.ts`.

    convertir.py --source F --de PDF|DOCX|PPTX|XLSX|IMAGE --vers DOCX|PDF|XLSX|IMAGES --sortie F [--langues ara+fra+eng]
    convertir.py --verifier

Écrit UNE ligne JSON sur la sortie standard : {"ok": true, "bilan": {...}} ou {"ok": false, "erreur": "..."}.
Les journaux des bibliothèques (pdf2docx…) partent sur la sortie d'erreur : ils ne polluent jamais la réponse.
"""

from __future__ import annotations

import argparse
import contextlib
import io
import json
import logging
import shutil
import subprocess
import sys
import time
import warnings
from pathlib import Path

ICI = Path(__file__).resolve().parent
sys.path.insert(0, str(ICI))


def verifier() -> dict:
    """Ce que cette machine sait faire — le worker le dit au démarrage, l'écran d'administration l'affiche."""
    etat: dict = {"python": sys.version.split()[0]}
    for mod in ("pymupdf", "pdf2docx", "docx", "openpyxl", "cv2", "PIL", "lxml"):
        try:
            m = __import__(mod)
            etat[mod] = getattr(m, "__version__", None) or getattr(m, "VersionBind", None) or "ok"
        except Exception as e:  # noqa: BLE001 — on rend l'absence, pas une trace
            etat[mod] = None
            etat.setdefault("manquants", []).append(f"{mod} ({type(e).__name__})")
    tess = shutil.which("tesseract")
    etat["tesseract"] = None
    if tess:
        r = subprocess.run([tess, "--list-langs"], capture_output=True, text=True, timeout=30)
        langues = [l.strip() for l in (r.stdout + r.stderr).splitlines()[1:] if l.strip() and " " not in l.strip()]
        etat["tesseract"] = langues
        for l in ("ara", "fra", "eng"):
            if l not in langues:
                etat.setdefault("manquants", []).append(f"tesseract-{l}")
    else:
        etat.setdefault("manquants", []).append("tesseract")
    etat["libreoffice"] = shutil.which("soffice") or shutil.which("libreoffice")
    if not etat["libreoffice"]:
        etat.setdefault("manquants", []).append("libreoffice")
    try:
        r = subprocess.run(["fc-list", ":", "family"], capture_output=True, text=True, timeout=30)
        familles = r.stdout
        etat["polices"] = {f: (f in familles) for f in ("Noto Naskh Arabic", "Amiri", "Noto Sans", "Noto Serif", "DejaVu Sans", "Liberation Serif", "Carlito", "Caladea")}
        for f, ok in etat["polices"].items():
            if not ok:
                etat.setdefault("manquants", []).append(f"police {f}")
    except (OSError, subprocess.SubprocessError):
        etat["polices"] = None
    etat["pret"] = not etat.get("manquants")
    return etat


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--verifier", action="store_true")
    ap.add_argument("--source")
    ap.add_argument("--de")
    ap.add_argument("--vers")
    ap.add_argument("--sortie")
    ap.add_argument("--langues", default="ara+fra+eng")
    a = ap.parse_args()
    if a.verifier:
        print(json.dumps({"ok": True, "bilan": verifier()}, ensure_ascii=False))
        return 0
    source, sortie = Path(a.source), Path(a.sortie)
    de, vers = (a.de or "").upper(), (a.vers or "").upper()
    debut = time.time()
    logging.basicConfig(stream=sys.stderr, level=logging.ERROR)
    warnings.filterwarnings("ignore")
    try:
        # pdf2docx écrit sur la sortie standard : on la détourne le temps de la conversion.
        with contextlib.redirect_stdout(io.StringIO()) as bruit:
            from amd_conversions import autres
            from amd_conversions.pdf_docx import pdf_vers_docx

            if de == "PDF" and vers == "DOCX":
                bilan = pdf_vers_docx(source, sortie, langues=a.langues)
            elif de == "PDF" and vers == "XLSX":
                bilan = autres.pdf_vers_xlsx(source, sortie, langues=a.langues)
            elif de in ("DOCX", "PPTX", "XLSX") and vers == "PDF":
                bilan = autres.office_vers_pdf(source, sortie)
            elif de == "PPTX" and vers == "IMAGES":
                bilan = autres.pptx_vers_images(source, sortie)
            elif de == "IMAGE" and vers == "PDF":
                bilan = autres.image_vers_pdf(source, sortie, langues=a.langues)
            elif de == "IMAGE" and vers == "DOCX":
                bilan = autres.image_vers_docx(source, sortie, langues=a.langues)
            else:
                raise ValueError(f"conversion {de} → {vers} non prise en charge")
        sys.stderr.write(bruit.getvalue()[-2000:])
        bilan["duree_s"] = round(time.time() - debut, 2)
        print(json.dumps({"ok": True, "bilan": bilan}, ensure_ascii=False, default=str))
        return 0
    except Exception as e:  # noqa: BLE001 — l'appelant reçoit le motif, en clair
        print(json.dumps({"ok": False, "erreur": f"{type(e).__name__}: {e}"[:600]}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main())
