"""
LES PAGES SCANNÉES (décision 0019) — OCR tesseract, puis une PAGE RECOMPOSÉE que le moteur PDF → Word lit comme une autre.

Pourquoi deux passages : `-l ara+fra+eng` d'un seul tenant fait « deviner » au modèle une langue par mot, et il prend
des mots arabes pour du latin (« لدى » → « ça) », mesuré). On lit donc la page DEUX fois — `ara` puis `fra+eng` — et
chaque zone garde le mot le plus sûr (confiance tesseract). Les lignes sont remises en ordre logique par le même
algorithme que le texte des PDF (`normaliser.ordre_logique`), au niveau du mot.

La page est COMPOSÉE directement dans le Word, à la place de l'image que pdf2docx y a posée :
  • les lignes reconnues, regroupées en paragraphes (une ligne pleine se poursuit, une ligne courte finit), en ordre
    logique, police (Noto Naskh Arabic / Liberation Serif) et taille tirées de la ligne — direction posée ensuite par
    le même post-traitement que le reste (`docx_post`) ;
  • les TRAITS (OpenCV, ouverture morphologique) qui forment une grille → un VRAI tableau Word, chaque mot rangé dans
    sa cellule (de droite à gauche quand le tableau est arabe) ;
  • les ILLUSTRATIONS : l'encre qui reste une fois mots et traits retirés, en grandes composantes, découpée de
    l'image d'origine et posée en image.
Essayé d'abord : recomposer une page PDF texte et la repasser à pdf2docx — les polices de MuPDF Story relisent mal
l'arabe (mesuré : « ل » rendu « Ǆ »). Abandonné.
Si la page se lit mal (confiance moyenne < `SEUIL_CONFIANCE`), on ne prétend pas l'avoir reconstruite : son IMAGE est
gardée telle quelle, le texte reconnu suit.
"""

from __future__ import annotations

import csv
import re
from collections import Counter
import io
import statistics
import subprocess
import tempfile
from pathlib import Path

import pymupdf

from .normaliser import Grappe, est_arabe, ordre_logique, texte_propre

import os as _os

#: Résolution de lecture. Mesuré sur les scans du corpus (200 ppp d'origine) : 300 → CER arabe 1,5 % (harakat perdus),
#: 450 → voir décision 0019. Tesseract lit mieux les marques quand la hauteur d'x dépasse ~30 px.
PPP = 300
#: Le passage ARABE lit une image agrandie (×`AGRANDIR_ARABE`) : mesuré sur le scan arabe du corpus, les harakat (fatha,
#: chadda, kasra) passent de « الصَيْدَلِيَةٌ » à « الصَّيْدَلِيَّةُ » ; le passage LATIN, lui, se dégrade agrandi (mesuré :
#: CER français 1,4 % → 17 %) — il reste à 300 ppp. Les boîtes du passage arabe sont ramenées à l'échelle commune.
AGRANDIR_ARABE = float(_os.environ.get("AMD_OCR_AGRANDIR_ARABE", "1"))
SEUIL_CONFIANCE = 55.0


def options_tessdata() -> list[str]:
    """Les modèles « best » (LSTM flottants) de l'image du worker — `AMD_TESSDATA`. Mesuré sur le scan arabe du
    corpus : « للريع », « الوظنية », « للموادٍ » (modèles Debian) deviennent « للربع », « الوطنية », « للمواد »."""
    import os

    d = os.environ.get("AMD_TESSDATA")
    return ["--tessdata-dir", d] if d and Path(d, "ara.traineddata").exists() else []


def _tesseract_tsv(image: Path, langues: str, psm: int = 3) -> list[dict]:
    r = subprocess.run(["tesseract", str(image), "stdout", *options_tessdata(), "-l", langues, "--psm", str(psm), "tsv"],
                       capture_output=True, text=True, timeout=300)
    if r.returncode != 0 or "Can't open" in r.stderr or "Failed loading" in r.stderr:
        raise RuntimeError(f"tesseract : {r.stderr.strip()[:300]}")
    mots = []
    for l in csv.DictReader(io.StringIO(r.stdout), delimiter="\t", quoting=csv.QUOTE_NONE):
        if l.get("level") != "5":
            continue
        # Un trait vertical de tableau lu comme « | » collé à un mot : retiré (le texte d'un document n'en porte presque jamais).
        texte = texte_propre(l.get("text") or "").strip().replace("|’", "l’").replace("|'", "l'").strip("|").strip()
        if texte in ("--", "---"):
            texte = "—"  # le tiret long, que le modèle arabe rend en deux traits
        if not texte:
            continue
        x, y, w, h = (int(l[k]) for k in ("left", "top", "width", "height"))
        mots.append({"t": texte, "bbox": (x, y, x + w, y + h), "conf": float(l["conf"]), "langues": langues,
                     "ligne": (langues, l["block_num"], l["par_num"], l["line_num"])})
    return mots


def _passage_agrandi(png: Path, langues: str, facteur: float) -> list[dict]:
    """Un passage tesseract sur l'image agrandie ; boîtes ramenées à l'échelle de `png`."""
    if facteur <= 1.01:
        return _tesseract_tsv(png, langues)
    from PIL import Image

    grand = png.with_name(png.stem + f"-x{facteur:g}.png")
    with Image.open(png) as im:
        im.resize((int(im.width * facteur), int(im.height * facteur)), Image.LANCZOS).save(grand)
    mots = _tesseract_tsv(grand, langues)
    for m in mots:
        m["bbox"] = tuple(int(round(v / facteur)) for v in m["bbox"])
    return mots


def _recouvrement(a: tuple, b: tuple) -> float:
    ix = max(0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0, min(a[3], b[3]) - max(a[1], b[1]))
    aire = min((a[2] - a[0]) * (a[3] - a[1]), (b[2] - b[0]) * (b[3] - b[1])) or 1
    return ix * iy / aire


def _script_attendu(t: str) -> str:
    if any("؀" <= c <= "ۿ" for c in t):
        return "ara"
    if any(c.isalpha() for c in t):
        return "lat"
    return "num"


def _score(m: dict) -> float:
    """Confiance, moins une pénalité quand le mot n'est pas dans l'écriture du modèle qui l'a lu (du « latin » rendu
    par le modèle arabe, de l'« arabe » rendu par le modèle latin : c'est presque toujours du bruit)."""
    s = _script_attendu(m["t"])
    arabe = m["langues"] == "ara"
    if (s == "lat" and arabe) or (s == "ara" and not arabe):
        return m["conf"] - 30
    return m["conf"]


def _boite(mots: list[dict]) -> tuple:
    return (min(m["bbox"][0] for m in mots), min(m["bbox"][1] for m in mots), max(m["bbox"][2] for m in mots), max(m["bbox"][3] for m in mots))


def fusionner_passages(passages: list[list[dict]]) -> list[dict]:
    """LIGNE par ligne, le passage le plus sûr sert de base (moyenne des scores, pondérée par la longueur) ; l'autre
    comble ce que la base n'a pas lu, et ne remplace un mot que s'il est NETTEMENT plus sûr (+30). Choisir mot à mot
    laissait passer du bruit d'une écriture au milieu d'une ligne de l'autre (mesuré sur le corpus)."""
    lignes: list[dict] = []
    for mots in passages:
        groupes: dict = {}
        for m in mots:
            groupes.setdefault(m["ligne"], []).append(m)
        for g in groupes.values():
            poids = sum(len(m["t"]) for m in g) or 1
            lignes.append({"mots": g, "bbox": _boite(g), "score": sum(_score(m) * len(m["t"]) for m in g) / poids, "passe": g[0]["langues"]})
    lignes.sort(key=lambda l: -l["score"])
    retenus: list[dict] = []
    traitees: set[int] = set()
    for i, l in enumerate(lignes):
        if i in traitees:
            continue
        traitees.add(i)
        rivales = [j for j, r in enumerate(lignes) if j not in traitees and r["passe"] != l["passe"] and _recouvrement(l["bbox"], r["bbox"]) > 0.5]
        base = list(l["mots"])
        ecriture = Counter(_script_attendu(m["t"]) for m in base if _script_attendu(m["t"]) != "num").most_common(1)
        ecriture = ecriture[0][0] if ecriture else None
        for j in rivales:
            traitees.add(j)
            for m in lignes[j]["mots"]:
                # Un mot de l'AUTRE écriture que la ligne doit être franchement sûr et pas un fragment (« بآ », « نل »).
                etranger = ecriture is not None and _script_attendu(m["t"]) not in (ecriture, "num")
                exige = 50 if etranger else 30
                if etranger and len(m["t"]) < 3:
                    continue
                chevauches = [b for b in base if _recouvrement(m["bbox"], b["bbox"]) > 0.3]
                if not chevauches:
                    if _score(m) > (70 if etranger else 40):
                        base.append(m)
                elif _score(m) > max(_score(b) for b in chevauches) + exige:
                    base = [b for b in base if b not in chevauches] + [m]
        for m in base:
            if not any(_recouvrement(m["bbox"], r["bbox"]) > 0.3 for r in retenus):
                retenus.append(m)
    return retenus


PUCES_LUES = {"+", "*", "©", "®", "e", "°", "o", "»", "-", "«", "٠", "•", "·", "¢", "€", "ه", "ع", "ء"}


def _puce(seg: list[dict]) -> None:
    """Une puce mal lue (« + », « © », « ع »…) en tête d'une ligne : petit signe isolé avant un vrai mot → « • »."""
    if len(seg) < 2:
        return
    tete = seg[0]
    h = tete["bbox"][3] - tete["bbox"][1]
    w = tete["bbox"][2] - tete["bbox"][0]
    suivant = seg[1]
    if tete["t"] in PUCES_LUES and w < 1.6 * max(h, 1) and abs(suivant["bbox"][0] - tete["bbox"][2]) > 0.4 * h:
        tete["t"] = "•"


def lignes_de_mots(mots: list[dict]) -> list[dict]:
    """Mots → lignes (recouvrement vertical), chaque ligne remise en ORDRE LOGIQUE."""
    # Les mots HAUTS d'abord : ce sont eux qui posent la ligne ; un petit signe (« — ») la rejoint ensuite.
    mots = sorted(mots, key=lambda m: -(m["bbox"][3] - m["bbox"][1]))
    lignes: list[list[dict]] = []
    for m in mots:
        cy = (m["bbox"][1] + m["bbox"][3]) / 2
        for l in lignes:
            h = statistics.median(x["bbox"][3] - x["bbox"][1] for x in l)
            ly = statistics.median((x["bbox"][1] + x["bbox"][3]) / 2 for x in l)
            # Un petit signe (« — », « . ») n'a pas le centre de la ligne : il suffit qu'il tienne dans sa hauteur.
            haut, bas = ly - 0.5 * h, ly + 0.5 * h
            dedans = min(bas, m["bbox"][3]) - max(haut, m["bbox"][1]) >= 0.6 * (m["bbox"][3] - m["bbox"][1])
            if (abs(cy - ly) < 0.45 * h or dedans) and not any(_recouvrement(m["bbox"], x["bbox"]) > 0.3 for x in l):
                l.append(m)
                break
        else:
            lignes.append([m])
    out = []
    for l in lignes:
        l.sort(key=lambda m: m["bbox"][0])
        # Coupe en segments là où un grand blanc sépare deux groupes (cellules de tableau, colonnes).
        segments: list[list[dict]] = [[l[0]]]
        h = statistics.median(m["bbox"][3] - m["bbox"][1] for m in l)
        for m in l[1:]:
            if m["bbox"][0] - segments[-1][-1]["bbox"][2] > 2.2 * h:
                segments.append([m])
            else:
                segments[-1].append(m)
        for seg in segments:
            texte = " ".join(m["t"] for m in seg)
            rtl = est_arabe(texte)
            _puce(list(reversed(seg)) if rtl else seg)
            gr = []
            if rtl:
                # « 82-21 » lu d'un bloc dans une ligne arabe : deux nombres (UBA, W4) — on les sépare pour les remettre en ordre.
                eclates = []
                for m in seg:
                    parts = re.findall(r"\d+|[-+]|[^\d+-]+", m["t"]) if re.fullmatch(r"[\d.,/]*\d[-+]\d[\d.,/+-]*", m["t"]) else [m["t"]]
                    if len(parts) == 1:
                        eclates.append(m)
                        continue
                    x0, y0, x1, y1 = m["bbox"]
                    pas = (x1 - x0) / len(m["t"])
                    pos = x0
                    for p in parts:
                        eclates.append({**m, "t": p, "bbox": (pos, y0, pos + pas * len(p), y1), "orig": id(m)})
                        pos += pas * len(p)
                seg = eclates
            for m in seg:
                g = Grappe([{"c": m["t"], "bbox": m["bbox"], "orig": m.get("orig")}], m["bbox"][0], m["bbox"][2])
                s = _script_attendu(m["t"])
                g.cls = "R" if s == "ara" else "L" if s == "lat" else "N" if any(c.isdigit() for c in m["t"]) else "O"
                gr.append(g)
            ordre = ordre_logique(gr, rtl)
            if ordre and ordre[0].chars[0]["c"] != "•" and any(g.chars[0]["c"] == "•" for g in ordre):
                puce = next(g for g in ordre if g.chars[0]["c"] == "•")  # la puce ouvre la ligne logique
                ordre = [puce] + [g for g in ordre if g is not puce]
            if rtl:
                # Ponctuation latine rendue par l'OCR dans une phrase arabe → la ponctuation arabe (« 2026، », « ؟ »),
                # jamais entre deux chiffres (« 120,50 »).
                for g in ordre:
                    t = g.chars[0]["c"]
                    if re.search(r"[,;?]$", t) and not re.search(r"\d[,;?]\d", t):
                        g.chars[0]["c"] = t[:-1] + {",": "\u060c", ";": "\u061b", "?": "\u061f"}[t[-1]]
            out.append({
                "mots": [{"t": g.chars[0]["c"], "bbox": g.chars[0]["bbox"]} for g in ordre],
                "texte": "".join((("" if i and g.chars[0].get("orig") and g.chars[0].get("orig") == ordre[i - 1].chars[0].get("orig") else " " if i else "")
                                  + g.chars[0]["c"]) for i, g in enumerate(ordre)),
                "rtl": rtl,
                "bbox": (min(m["bbox"][0] for m in seg), min(m["bbox"][1] for m in seg), max(m["bbox"][2] for m in seg), max(m["bbox"][3] for m in seg)),
                "h": statistics.median(m["bbox"][3] - m["bbox"][1] for m in seg),
            })
    out.sort(key=lambda l: (l["bbox"][1], -l["bbox"][2] if l["rtl"] else l["bbox"][0]))
    return out


def traits_et_figures(png: Path, mots: list[dict]) -> tuple[list[tuple], list[tuple]]:
    """Les traits des TABLEAUX et les ILLUSTRATIONS d'une page, en pixels.

    D'abord les grandes composantes d'encre une fois les mots effacés : une composante qui contient beaucoup de mots
    (ou dont l'encre n'est que des traits fins) est un tableau ; les autres sont des illustrations. Ensuite les traits
    (ouverture morphologique), gardés seulement hors des illustrations — le cadre d'un graphique n'est pas un tableau."""
    import cv2
    import numpy as np

    img = cv2.imread(str(png), cv2.IMREAD_GRAYSCALE)
    if img is None:
        return [], []
    h, w = img.shape
    noir = cv2.adaptiveThreshold(img, 255, cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY_INV, 31, 15)
    masque_traits = np.zeros_like(noir)
    traits: list[tuple] = []
    for (kx, ky) in ((max(40, w // 25), 1), (1, max(40, h // 40))):
        ouvert = cv2.morphologyEx(noir, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (kx, ky)))
        masque_traits |= ouvert
        for c in cv2.findContours(ouvert, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)[0]:
            x, y, cw, ch = cv2.boundingRect(c)
            if kx > 1 and cw > w * 0.04:
                traits.append((x, y + ch / 2, x + cw, y + ch / 2))
            elif ky > 1 and ch > h * 0.02:
                traits.append((x + cw / 2, y, x + cw / 2, y + ch))
    sans_mots = noir.copy()
    for m in mots:
        x0, y0, x1, y1 = m["bbox"]
        sans_mots[max(0, y0 - 3):y1 + 3, max(0, x0 - 3):x1 + 3] = 0
    plein = cv2.morphologyEx(sans_mots, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (25, 25)))
    figures = []
    for c in cv2.findContours(plein, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)[0]:
        x, y, cw, ch = cv2.boundingRect(c)
        # Une illustration est HAUTE (≥ 4 % de la page) : des harakat ou une ligne mal lue n'en sont pas (mesuré sur
        # le scan vocalisé : sept « figures » qui étaient des bouts de texte).
        if cw * ch < 0.01 * w * h or cw < 60 or ch < max(60, 0.04 * h):
            continue
        boite = (x, y, x + cw, y + ch)
        dedans = [m for m in mots if _recouvrement(m["bbox"], boite) > 0.8]
        zone_encre = sans_mots[y:y + ch, x:x + cw]
        zone_traits = masque_traits[y:y + ch, x:x + cw]
        encre = int(np.count_nonzero(zone_encre)) or 1
        part_traits = int(np.count_nonzero(zone_encre & zone_traits)) / encre
        if len(dedans) >= 4 and part_traits > 0.5:
            continue  # un tableau : ses traits restent des traits
        # Du TEXTE que tesseract n'a pas lu (arabe vocalisé, scan dégradé) : beaucoup de petites composantes de la
        # hauteur d'une lettre. Une illustration a de grandes formes pleines.
        n, _, stats, _ = cv2.connectedComponentsWithStats(zone_encre, connectivity=8)
        hauteurs = [stats[i, cv2.CC_STAT_HEIGHT] for i in range(1, n) if stats[i, cv2.CC_STAT_AREA] > 8]
        grandes = sum(1 for i in range(1, n) if stats[i, cv2.CC_STAT_AREA] > 0.05 * cw * ch)
        if len(hauteurs) > 25 and not grandes and statistics.median(hauteurs) < 0.08 * ch:
            continue
        # Du BRUIT de numérisation que la fermeture a soudé : presque pas d'encre une fois les points isolés retirés.
        if sum(int(stats[i, cv2.CC_STAT_AREA]) for i in range(1, n) if stats[i, cv2.CC_STAT_AREA] > 8) < 0.02 * cw * ch:
            continue
        figures.append(boite)
    dans = lambda t, f: f[0] - 8 <= min(t[0], t[2]) and max(t[0], t[2]) <= f[2] + 8 and f[1] - 8 <= min(t[1], t[3]) and max(t[1], t[3]) <= f[3] + 8
    traits = [t for t in traits if not any(dans(t, f) for f in figures)]
    return traits, figures


# ─────────────────────────── Composer la page dans le Word ───────────────────────────

def lire_page(png: Path, langues: str) -> dict:
    """Les deux passages tesseract fusionnés, les traits et les illustrations."""
    passes = []
    langs = [l for l in langues.split("+") if l]
    if "ara" in langs:
        passes.append(_passage_agrandi(png, "ara", AGRANDIR_ARABE))
    latines = "+".join(l for l in langs if l != "ara")
    if latines:
        passes.append(_tesseract_tsv(png, latines))
    mots = fusionner_passages(passes)
    traits, figures = traits_et_figures(png, mots) if mots else ([], [])
    conf = statistics.mean(m["conf"] for m in mots) if mots else 0.0
    mots_texte = [m for m in mots if not any(_recouvrement(m["bbox"], f) > 0.6 for f in figures)]
    return {"mots": mots_texte, "confiance": conf, "traits": traits, "figures": figures}


def grille(traits: list[tuple], tol: float = 12) -> list[dict]:
    """Les traits → des TABLEAUX : chaque amas de traits qui se croisent donne une grille (abscisses des verticales ×
    ordonnées des horizontales)."""
    hs = [t for t in traits if abs(t[1] - t[3]) < 1]
    vs = [t for t in traits if abs(t[0] - t[2]) < 1]
    croise = lambda a, b: (min(a[0], a[2]) - tol <= b[0] <= max(a[0], a[2]) + tol and min(b[1], b[3]) - tol <= a[1] <= max(b[1], b[3]) + tol)
    tous = [("h", t) for t in hs] + [("v", t) for t in vs]
    parent = list(range(len(tous)))

    def racine(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i, (ga, a) in enumerate(tous):
        for j, (gb, b) in enumerate(tous):
            if ga == "h" and gb == "v" and croise(a, b):
                parent[racine(i)] = racine(j)
    amas: dict[int, list] = {}
    for i, e in enumerate(tous):
        amas.setdefault(racine(i), []).append(e)

    def regrouper(vals: list[float]) -> list[float]:
        vals = sorted(vals)
        g: list[list[float]] = [[vals[0]]]
        for v in vals[1:]:
            if v - g[-1][-1] < tol:
                g[-1].append(v)
            else:
                g.append([v])
        return [sum(x) / len(x) for x in g]

    tables = []
    for elements in amas.values():
        h = [t for g, t in elements if g == "h"]
        v = [t for g, t in elements if g == "v"]
        if len(h) < 2 or len(v) < 2:
            continue
        ys, xs = regrouper([t[1] for t in h]), regrouper([t[0] for t in v])
        if len(ys) >= 2 and len(xs) >= 2:
            tables.append({"xs": xs, "ys": ys, "bbox": (xs[0], ys[0], xs[-1], ys[-1])})
    return tables


def paragraphes_de_lignes(lignes: list[dict]) -> list[dict]:
    """Lignes consécutives, même direction, interligne normal, la précédente PLEINE → un paragraphe."""
    if not lignes:
        return []
    gauche = min(l["bbox"][0] for l in lignes)
    droite = max(l["bbox"][2] for l in lignes)
    paras: list[dict] = []
    for l in lignes:
        p = paras[-1] if paras else None
        if p is not None:
            prec = p["lignes"][-1]
            ecart = l["bbox"][1] - prec["bbox"][3]
            libre = (prec["bbox"][0] - gauche) if prec["rtl"] else (droite - prec["bbox"][2])
            premier = l["mots"][0]["bbox"] if l["mots"] else l["bbox"]
            mot = premier[2] - premier[0]
            if prec["rtl"] == l["rtl"] and 0 <= ecart < 0.9 * prec["h"] and libre < mot + prec["h"] and abs(l["h"] - prec["h"]) < 0.3 * prec["h"]:
                p["lignes"].append(l)
                continue
        paras.append({"lignes": [l]})
    for p in paras:
        p["texte"] = " ".join(l["texte"] for l in p["lignes"])
        p["rtl"] = est_arabe(p["texte"])
        p["y"] = p["lignes"][0]["bbox"][1]
        p["h"] = statistics.median(l["h"] for l in p["lignes"])
        p["bbox"] = (min(l["bbox"][0] for l in p["lignes"]), p["y"], max(l["bbox"][2] for l in p["lignes"]), p["lignes"][-1]["bbox"][3])
    return paras


def composer_dans_word(doc, png: Path, lecture: dict, largeur_px: float) -> list:
    """Compose la page lue en éléments Word (paragraphes, tableaux, images) ajoutés en fin de corps ; les rend."""
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.oxml import OxmlElement
    from docx.shared import Pt
    from PIL import Image

    echelle = 72 / PPP
    corps = doc.element.body
    avant = list(corps)
    tableaux = grille(lecture["traits"])

    def dans_tableau(b):
        cx, cy = (b[0] + b[2]) / 2, (b[1] + b[3]) / 2
        return next((t for t in tableaux if t["bbox"][0] - 6 <= cx <= t["bbox"][2] + 6 and t["bbox"][1] - 6 <= cy <= t["bbox"][3] + 6), None)

    hors = [m for m in lecture["mots"] if dans_tableau(m["bbox"]) is None]
    elements = [("p", p["y"], p) for p in paragraphes_de_lignes(lignes_de_mots(hors))]
    elements += [("t", t["bbox"][1], t) for t in tableaux]
    elements += [("f", f[1], f) for f in lecture["figures"]]
    elements.sort(key=lambda e: e[1])
    taille = lambda h, rtl: Pt(round(max(7.0, min(28.0, h * echelle * (0.78 if rtl else 0.92))) * 2) / 2)
    with Image.open(png) as im:
        for genre, _, e in elements:
            if genre == "f":
                b = io.BytesIO()
                im.crop(tuple(int(v) for v in e)).save(b, "PNG")
                p = doc.add_paragraph()
                p.add_run().add_picture(io.BytesIO(b.getvalue()), width=Pt((e[2] - e[0]) * echelle))
            elif genre == "p":
                p = doc.add_paragraph()
                r = p.add_run(e["texte"])
                r.font.size = taille(e["h"], e["rtl"])
                r.font.name = "Noto Naskh Arabic" if e["rtl"] else "Liberation Serif"
                centre = (e["bbox"][0] + e["bbox"][2]) / 2
                if len(e["lignes"]) == 1 and abs(centre - largeur_px / 2) < largeur_px * 0.04 and (e["bbox"][2] - e["bbox"][0]) < largeur_px * 0.6:
                    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
            else:
                xs, ys = e["xs"], e["ys"]
                rangs, cols = len(ys) - 1, len(xs) - 1
                cellules: list[list[list]] = [[[] for _ in range(cols)] for _ in range(rangs)]
                for m in lecture["mots"]:
                    cx, cy = (m["bbox"][0] + m["bbox"][2]) / 2, (m["bbox"][1] + m["bbox"][3]) / 2
                    i = next((k for k in range(rangs) if ys[k] <= cy <= ys[k + 1]), None)
                    j = next((k for k in range(cols) if xs[k] <= cx <= xs[k + 1]), None)
                    if i is not None and j is not None:
                        cellules[i][j].append(m)
                rtl = est_arabe(" ".join(m["t"] for row in cellules for c in row for m in c))
                t = doc.add_table(rows=rangs, cols=cols)
                if "Table Grid" in [s.name for s in doc.styles]:
                    t.style = "Table Grid"
                for i in range(rangs):
                    for j in range(cols):
                        jj = cols - 1 - j if rtl else j  # en arabe, la 1re cellule LOGIQUE est la plus à droite
                        lignes = lignes_de_mots(cellules[i][jj]) if cellules[i][jj] else []
                        cell = t.cell(i, j)
                        cell.width = Pt((xs[jj + 1] - xs[jj]) * echelle)
                        if lignes:
                            r = cell.paragraphs[0].add_run(" ".join(l["texte"] for l in lignes))
                            r.font.size = taille(statistics.median(l["h"] for l in lignes), rtl)
                if rtl:
                    tpr = t._tbl.tblPr
                    bv = OxmlElement("w:bidiVisual")
                    style = tpr.find("{http://schemas.openxmlformats.org/wordprocessingml/2006/main}tblStyle")
                    (style.addnext(bv) if style is not None else tpr.insert(0, bv))
    return [el for el in corps if el not in avant and el.tag != "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}sectPr"]


def composer_image_et_texte(doc, png: Path, lecture: dict) -> list:
    """Lecture trop incertaine : l'IMAGE de la page, puis le texte reconnu (signalé comme tel)."""
    from docx.shared import Pt

    corps = doc.element.body
    avant = list(corps)
    largeur = 72 / PPP
    from PIL import Image

    with Image.open(png) as im:
        w = im.width
    doc.add_paragraph().add_run().add_picture(str(png), width=Pt(min(w * largeur, 470)))
    for p in paragraphes_de_lignes(lignes_de_mots(lecture["mots"])):
        doc.add_paragraph(p["texte"])
    return [el for el in corps if el not in avant and el.tag != "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}sectPr"]


def entetes_pieds_lus(lectures: dict[int, dict], hauteurs: dict[int, float]) -> dict:
    """Sur des pages LUES : une ligne de la marge haute (basse) qui revient sur la majorité des pages, au texte près de
    l'OCR (ressemblance ≥ 0,8, chiffres masqués), est un en-tête (un pied) : ses mots quittent le corps."""
    from difflib import SequenceMatcher
    import re

    if len(lectures) < 2:
        return {"entete": [], "pied": []}
    candidates: list[tuple] = []
    for num, lec in lectures.items():
        h = hauteurs[num]
        marge = [m for m in lec["mots"] if m["bbox"][3] < 0.12 * h or m["bbox"][1] > 0.88 * h]
        # Une ligne ENTIÈRE de la marge (pas ses segments : un grand blanc ne la coupe pas ici).
        rangees: list[list[dict]] = []
        for m in sorted(marge, key=lambda m: m["bbox"][1]):
            cy = (m["bbox"][1] + m["bbox"][3]) / 2
            def meme(r: list[dict]) -> bool:
                h = statistics.median(x["bbox"][3] - x["bbox"][1] for x in r)
                ly = statistics.median((x["bbox"][1] + x["bbox"][3]) / 2 for x in r)
                return abs(cy - ly) < 0.5 * h or (ly - 0.5 * h <= m["bbox"][1] and m["bbox"][3] <= ly + 0.5 * h)
            r = next((r for r in rangees if meme(r)), None)
            (r.append(m) if r is not None else rangees.append([m]))
        for r in rangees:
            texte = " ".join(l["texte"] for l in lignes_de_mots(r)) if len(lignes_de_mots(r)) else ""
            rtl = est_arabe(texte)
            boite = (min(m["bbox"][0] for m in r), min(m["bbox"][1] for m in r), max(m["bbox"][2] for m in r), max(m["bbox"][3] for m in r))
            l = {"texte": texte, "rtl": rtl, "bbox": boite}
            zone = "entete" if boite[3] < 0.12 * h else "pied"
            candidates.append((zone, num, re.sub(r"\d+", "#", texte), l))
    seuil = max(2, int(0.6 * len(lectures) + 0.5))
    res: dict = {"entete": [], "pied": []}
    pris: set[int] = set()
    for i, (zone, num, cle, l) in enumerate(candidates):
        if i in pris:
            continue
        semblables = [j for j, c in enumerate(candidates) if c[0] == zone and SequenceMatcher(None, cle, c[2]).ratio() >= 0.8]
        if len({candidates[j][1] for j in semblables}) < seuil:
            continue
        pris.update(semblables)
        meilleure = max((candidates[j][3] for j in semblables), key=lambda x: len(x["texte"]))
        res[zone].append({"texte": meilleure["texte"], "rtl": meilleure["rtl"], "y": meilleure["bbox"][1],
                          "numero": "#" in cle, "cle": (zone, cle), "align": "center"})
        for j in semblables:
            lj = candidates[j][3]
            lec = lectures[candidates[j][1]]
            lec["mots"] = [m for m in lec["mots"] if not (_recouvrement(m["bbox"], lj["bbox"]) > 0.6)]
    for zone in ("entete", "pied"):
        for e in res[zone]:
            e["align"] = "center"
    return res


def image_vers_pdf_cherchable(images: list[Path], sortie: Path, langues: str = "ara+fra+eng") -> dict:
    """Image(s) → PDF dont l'image est la page et le texte reconnu un calque invisible (renderer PDF de tesseract)."""
    with tempfile.TemporaryDirectory(prefix="amd-ocr-") as tmp:
        parts = []
        for i, img in enumerate(images):
            base = Path(tmp) / f"p{i}"
            r = subprocess.run(["tesseract", str(img), str(base), *options_tessdata(), "-l", langues, "--psm", "3", "pdf"], capture_output=True, text=True, timeout=300)
            if r.returncode != 0:
                raise RuntimeError(f"tesseract : {r.stderr.strip()[:300]}")
            parts.append(base.with_suffix(".pdf"))
        with pymupdf.open() as out:
            for p in parts:
                with pymupdf.open(p) as d:
                    out.insert_pdf(d)
            out.save(sortie, garbage=3, deflate=True)
    return {"pages": len(images)}
