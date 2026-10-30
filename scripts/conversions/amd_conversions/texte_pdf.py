"""
LE TEXTE D'UNE PAGE PDF, REMIS À L'ENDROIT (décision 0019).

Travaille sur le `rawdict` de PyMuPDF (blocs → lignes → spans → caractères avec leur boîte), c'est-à-dire sur ce que
pdf2docx consomme : le correctif est posé AVANT la reconstruction de la mise en page, chaque span garde sa police, sa
taille, sa couleur et ses drapeaux (gras, italique) — seul l'ORDRE et l'IDENTITÉ des caractères changent.

  1. les lignes d'un même bloc posées sur la même ligne de base sont FUSIONNÉES (PyMuPDF coupe une ligne arabe en
     morceaux, que pdf2docx rangerait de gauche à droite : l'ordre logique serait perdu) ;
  2. chaque caractère est normalisé (`normaliser.normaliser_caractere`) ;
  3. les grappes sont rangées par position, puis remises en ordre logique selon la direction de base de la ligne ;
  4. les spans sont reconstruits : une suite de caractères du même span d'origine = un span.
"""

from __future__ import annotations

from typing import Any

from .normaliser import classe, est_arabe, grappes, normaliser_caractere, ordre_logique

Bloc = dict[str, Any]


def _meme_rangee(a: tuple, b: tuple) -> bool:
    haut = max(a[1], b[1])
    bas = min(a[3], b[3])
    return bas - haut > 0.5 * min(a[3] - a[1], b[3] - b[1])


def _cle_style(span: dict) -> tuple:
    return (span.get("font"), round(span.get("size", 0), 2), span.get("color"), span.get("flags"))


class Statistiques:
    def __init__(self) -> None:
        self.caracteres = 0
        self.inconnus = 0
        self.normalises = 0
        self.lignes_rtl = 0

    def taux_inconnus(self) -> float:
        return self.inconnus / self.caracteres if self.caracteres else 0.0


def _taille(l: dict) -> float:
    return max((s.get("size", 10) for s in l.get("spans", [])), default=10)


def _proches(r: list[dict], l: dict) -> bool:
    """Assez proches pour être une même ligne de texte : pas deux cellules d'un tableau, pas deux colonnes."""
    seuil = 1.5 * max(_taille(l), max(_taille(x) for x in r))
    return any(max(x["bbox"][0], l["bbox"][0]) - min(x["bbox"][2], l["bbox"][2]) < seuil for x in r)


def _rangees(lignes: list[dict]) -> list[list[dict]]:
    """Regroupe les lignes HORIZONTALES posées à la même hauteur et voisines ; les autres restent seules."""
    rangees: list[list[dict]] = []
    for l in lignes:
        d = l.get("dir", (1, 0))
        horizontale = abs(d[0] - 1) < 1e-3 and abs(d[1]) < 1e-3
        for r in rangees:
            if horizontale and r[0].get("_h") and _meme_rangee(tuple(r[0]["bbox"]), tuple(l["bbox"])) and _proches(r, l):
                r.append(l)
                break
        else:
            l["_h"] = horizontale
            rangees.append([l])
    return rangees


def _union(boites: list) -> tuple:
    return (min(b[0] for b in boites), min(b[1] for b in boites), max(b[2] for b in boites), max(b[3] for b in boites))


def remettre_a_l_endroit(blocs: list[Bloc], stats: Statistiques | None = None, exclure: list[tuple] | None = None) -> list[Bloc]:
    """Corrige EN PLACE les blocs texte d'un rawdict (et les rend). `exclure` : zones (en-têtes, pieds) à retirer."""
    stats = stats or Statistiques()
    sortie: list[Bloc] = []
    for bloc in blocs:
        if bloc.get("type", 0) != 0:
            sortie.append(bloc)
            continue
        texte_bloc = "".join(ch["c"] for l in bloc.get("lines", []) for s in l.get("spans", []) for ch in s.get("chars", []))
        rtl_bloc = est_arabe(texte_bloc)
        nouvelles: list[dict] = []
        for rangee in _rangees(bloc.get("lines", [])):
            caracteres: list[dict] = []
            for ligne in rangee:
                for span in ligne.get("spans", []):
                    gabarit = {k: v for k, v in span.items() if k not in ("chars", "bbox", "text")}
                    for ch in span.get("chars", []):
                        if exclure and any(z[0] <= (ch["bbox"][0] + ch["bbox"][2]) / 2 <= z[2] and z[1] <= (ch["bbox"][1] + ch["bbox"][3]) / 2 <= z[3] for z in exclure):
                            continue
                        stats.caracteres += 1
                        n = normaliser_caractere(ch["c"])
                        if n != ch["c"]:
                            stats.normalises += 1
                        if n == "�":
                            stats.inconnus += 1
                            continue
                        for c in n:  # une forme de présentation « ﻻ » donne deux lettres, même boîte : une grappe
                            caracteres.append({**ch, "c": c, "_span": gabarit})
            if not caracteres:
                continue
            texte = "".join(c["c"] for c in caracteres)
            fort = [classe(c) for c in texte if classe(c) in ("R", "L")]
            rtl = est_arabe(texte) if fort else rtl_bloc
            if rtl:
                stats.lignes_rtl += 1
            gr = grappes(caracteres)
            gr.sort(key=lambda g: ((g.x0 + g.x1) / 2, g.x0))
            if len(rangee) > 1:
                # Une espace SYNTHÉTISÉE par PyMuPDF dans un trou où une autre ligne posait un glyphe (« 15 09 2026 » + « / »).
                pleins = [(g.x0 + g.x1) / 2 for g in gr if g.texte().strip()]
                gr = [g for g in gr if g.texte().strip() or not any(g.x0 < c < g.x1 for c in pleins)]
            ordonnees = ordre_logique(gr, rtl) if any(g.cls == "R" for g in gr) or rtl else gr
            spans: list[dict] = []
            for g in ordonnees:
                for ch in g.chars:
                    gab = ch["_span"]
                    propre = {k: v for k, v in ch.items() if not k.startswith("_")}
                    # Une espace rejoint le span courant : pdf2docx jette les spans qui ne sont que du blanc.
                    if spans and (spans[-1]["_gab"] is gab or not ch["c"].strip()):
                        spans[-1]["chars"].append(propre)
                    else:
                        spans.append({**gab, "chars": [propre], "_gab": gab})
            for s in spans:
                s.pop("_gab")
                s["bbox"] = _union([c["bbox"] for c in s["chars"]])
            premiere = rangee[0]
            nouvelles.append({
                "wmode": premiere.get("wmode", 0),
                "dir": premiere.get("dir", (1, 0)),
                "bbox": _union([s["bbox"] for s in spans]),
                "spans": spans,
                "_rtl": rtl,
            })
        if nouvelles:
            bloc["lines"] = sorted(nouvelles, key=lambda l: (round(l["bbox"][1], 1), l["bbox"][0]))
            bloc["bbox"] = _union([l["bbox"] for l in nouvelles])
            sortie.append(bloc)
    return sortie


def texte_des_lignes(blocs: list[Bloc]) -> list[tuple[tuple, str, bool]]:
    """(boîte, texte logique, rtl) de chaque ligne — pour repérer en-têtes et pieds."""
    out = []
    for b in blocs:
        if b.get("type", 0) != 0:
            continue
        for l in b.get("lines", []):
            out.append((tuple(l["bbox"]), "".join(ch["c"] for s in l["spans"] for ch in s["chars"]), bool(l.get("_rtl"))))
    return out
