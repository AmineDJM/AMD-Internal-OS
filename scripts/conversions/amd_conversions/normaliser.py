"""
LE TEXTE EXACT (décision 0019) — normalisation Unicode et ordre LOGIQUE retrouvé à partir des positions.

Un PDF ne stocke pas du texte : il pose des glyphes. Selon le producteur (Word, LibreOffice, Chromium, un scanner
OCRisé…), l'arabe arrive :
  • en ordre VISUEL (de gauche à droite à l'écran) ou en ordre logique, ou un mélange par morceaux ;
  • en FORMES DE PRÉSENTATION (U+FB50–U+FDFF, U+FE70–U+FEFF : ﻼ au lieu de « لا ») ;
  • avec des ligatures latines (ﬁ, ﬂ), des puces de la police Symbol en zone privée (U+F0B7), parfois du mojibake.

La règle : on ne fait PAS confiance à l'ordre du flux. On regroupe chaque ligne en GRAPPES (un glyphe et ses marques
— harakat, chadda — ou une ligature qui porte plusieurs lettres), on les range par position horizontale (l'ordre
visuel, celui que l'œil lit), puis on applique l'inverse de l'algorithme bidi selon la direction de base de la ligne :
  RTL : on retourne toute la ligne, puis on remet à l'endroit chaque séquence LTR (latin, chiffres, « 15/09/2026 ») ;
  LTR : on retourne chaque séquence arabe (marques et chiffres arabes compris), chiffres remis à l'endroit dedans.
Module PUR (aucune dépendance) : testé seul (`tests/test_normaliser.py`).
"""

from __future__ import annotations

import re
import unicodedata

# ─────────────────────────── Caractères ───────────────────────────

#: Puces et symboles des polices Symbol / Wingdings, rangés en zone privée par Word.
PUA_SYMBOLES = {
    "": "•", "": "▪", "": "❖", "": "➢", "": "✓", "": "□", "": "o",
    "": "-", "": "→", "": "➔", "": "○", "": "■", "": "❑", "": "◆",
}
#: Contrôles bidi : utiles dans un flux logique, PARASITES dans un document (Word porte la direction par w:bidi/w:rtl).
CONTROLES_BIDI = set("‎‏‪‫‬‭‮⁦⁧⁨⁩؜")
INVISIBLES = set("﻿​­")


def forme_de_presentation(c: str) -> bool:
    o = ord(c)
    return 0xFB50 <= o <= 0xFDFF or 0xFE70 <= o <= 0xFEFE


def ligature_latine(c: str) -> bool:
    return 0xFB00 <= ord(c) <= 0xFB06


def zone_privee(c: str) -> bool:
    return 0xE000 <= ord(c) <= 0xF8FF


def normaliser_caractere(c: str) -> str:
    """Un caractère du PDF → ce qu'il DIT (0, 1 ou plusieurs caractères). NFKC CIBLÉ : seulement les formes de
    présentation et les ligatures — jamais sur « ½ », « ² » ou « ᵉ », qui sont le texte voulu."""
    if c in CONTROLES_BIDI or c in INVISIBLES:
        return ""
    if c in PUA_SYMBOLES:
        return PUA_SYMBOLES[c]
    if forme_de_presentation(c) or ligature_latine(c):
        return unicodedata.normalize("NFKC", c)
    if c == "�" or zone_privee(c):
        return "�"  # inconnu : signalé (le taux d'inconnus décide de l'OCR de la page), retiré à la fin
    return c


_SUITE = "\u0080-\u00bf\u2018-\u203a\u20ac\u0152\u0153\u0160\u0161\u0178\u017d\u017e\u0192\u02c6\u02dc"
# Deux paires ou plus (n'importe quelle tête), ou une seule derrière les têtes typiques (« Ã© », « Ø§ »).
_MOJIBAKE = re.compile(f"(?:[\u00c2-\u00df][{_SUITE}]){{2,}}|[\u00c3\u00d8\u00d9\u00da\u00db][{_SUITE}]")


def reparer_mojibake(texte: str) -> str:
    """« Ø§Ù„ » (UTF-8 relu en Windows-1252) → « ال ». Seulement là où l'aller-retour réussit."""
    def un(m: re.Match) -> str:
        s = m.group(0)
        for enc in ("cp1252", "latin-1"):
            try:
                return s.encode(enc).decode("utf-8")
            except (UnicodeEncodeError, UnicodeDecodeError):
                continue
        return s
    return _MOJIBAKE.sub(un, texte)


def texte_propre(texte: str) -> str:
    """Le filet final d'une chaîne : mojibake, normalisation ciblée, NFC (diacritiques recomposés), inconnus retirés."""
    t = reparer_mojibake(texte)
    t = "".join(normaliser_caractere(c) for c in t)
    t = unicodedata.normalize("NFC", t.replace("�", ""))
    return t


# ─────────────────────────── Direction ───────────────────────────

def classe(c: str) -> str:
    """R (arabe, hébreu), L (latin…), N (chiffres européens/arabes : ordre LTR interne), M (marque), O (neutre)."""
    if not c:
        return "O"
    b = unicodedata.bidirectional(c[0])
    if b in ("R", "AL"):
        return "R"
    if b == "L":
        return "L"
    if b in ("EN", "AN"):
        return "N"
    if b == "NSM":
        return "M"
    return "O"


def est_arabe(texte: str) -> bool:
    """Majorité de lettres arabes parmi les lettres fortes — la direction de base d'un paragraphe."""
    r = sum(1 for c in texte if classe(c) == "R")
    l = sum(1 for c in texte if classe(c) == "L")
    return r > l


def a_de_l_arabe(texte: str) -> bool:
    return any(classe(c) == "R" for c in texte)


# ─────────────────────────── Grappes et ordre logique ───────────────────────────

class Grappe:
    """Un glyphe affiché et les caractères qu'il porte (base + marques, ou ligature)."""

    __slots__ = ("chars", "x0", "x1", "cls")

    def __init__(self, chars: list, x0: float, x1: float):
        self.chars = chars  # objets quelconques portant .c (str)
        self.x0, self.x1 = x0, x1
        self.cls = "O"

    def texte(self) -> str:
        return "".join(ch["c"] for ch in self.chars)

    def calculer_classe(self) -> None:
        cl = [classe(ch["c"]) for ch in self.chars]
        self.cls = "R" if "R" in cl else "L" if "L" in cl else "N" if "N" in cl else "M" if all(c == "M" for c in cl) else "O"


def _largeur_nulle(ch: dict) -> bool:
    return ch["bbox"][2] - ch["bbox"][0] < 0.05


def retirer_echos(chars: list[dict]) -> list[dict]:
    """LibreOffice entoure chaque lettre vocalisée d'un `/ActualText` (« نَ ») qui couvre DEUX glyphes (la marque et la
    base) : PyMuPDF rend le texte deux fois — d'abord à la vraie place de la base, puis un ÉCHO de largeur nulle. Une
    séquence répétée à l'identique juste après elle-même, dont la répétition n'a aucune largeur, est cet écho."""
    out: list[dict] = []
    i, n = 0, len(chars)
    while i < n:
        for longueur in (4, 3, 2, 1):
            a, b = chars[i:i + longueur], chars[i + longueur:i + 2 * longueur]
            # (Une lettre liée à la précédente — « لأ » — n'a pas de largeur propre : son écho est alors un point à côté.)
            if (len(b) == longueur and [c["c"] for c in a] == [c["c"] for c in b] and any(classe(c["c"]) == "R" for c in a)
                    and all(_largeur_nulle(c) for c in b)
                    and (not all(_largeur_nulle(c) for c in a) or abs(a[-1]["bbox"][0] - b[-1]["bbox"][0]) < 2)):
                out.extend(a)
                i += 2 * longueur
                break
        else:
            out.append(chars[i])
            i += 1
    return out


def grappes(chars: list[dict]) -> list[Grappe]:
    """Chars (dict : c, bbox) DANS L'ORDRE DU FLUX → grappes.

    • Une marque (harakat, chadda — NSM) rejoint sa base VOISINE DANS LE FLUX (avant ou après : selon le producteur),
      celle dont la position coïncide le mieux — la géométrie seule échoue quand le producteur pose des boîtes nulles.
    • Des caractères qui partagent la même boîte (ligature émise en plusieurs caractères) restent ensemble.
    • Un DOUBLON de largeur nulle (LibreOffice émet parfois la base une seconde fois pour porter une marque :
      « طَط ») posé dans la boîte d'une base identique, voisine dans le flux, se fond dans celle-ci.
    • Une même marque deux fois sur une base n'en fait qu'une."""
    avant = len(chars)
    chars = retirer_echos(chars)
    # La convention du producteur, ligne par ligne. Une marque est posée sur la JOINTURE de deux lettres (bord gauche
    # de l'une = bord droit de l'autre) : la géométrie ne tranche pas, l'ordre du flux si. Mesuré :
    #   LibreOffice 24.x : [marque, base] + un écho par grappe → la base est celle qui SUIT ;
    #   LibreOffice 7.4  : [base, marque], sans écho           → la base est celle qui PRÉCÈDE.
    marques = sum(1 for c in chars if classe(c["c"]) == "M")
    suivante_dabord = marques > 0 and (avant - len(chars)) >= 0.3 * marques
    n = len(chars)
    est_marque = [classe(ch["c"]) == "M" for ch in chars]
    res: list[Grappe] = []
    grappe_de: list[int] = [-1] * n
    for i, ch in enumerate(chars):
        if est_marque[i]:
            continue
        x0, _, x1, _ = ch["bbox"]
        if res and abs(res[-1].x0 - x0) < 0.01 and abs(res[-1].x1 - x1) < 0.01 and x1 - x0 > 0.01:
            res[-1].chars.append(ch)
            grappe_de[i] = len(res) - 1
            continue
        if res and x1 - x0 <= 0.01 and abs(res[-1].x0 - x0) < 0.5 and classe(ch["c"]) != "R":
            res[-1].chars.append(ch)
            grappe_de[i] = len(res) - 1
            continue
        if _largeur_nulle(ch) and classe(ch["c"]) == "R":
            # Doublon ? une base identique, à largeur réelle, voisine dans le flux, dont la boîte contient ce point.
            jumeau = next((grappe_de[k] for k in (i - 1, i - 2, i + 1, i + 2) if 0 <= k < n and grappe_de[k] >= 0
                           and chars[k]["c"] == ch["c"] and not _largeur_nulle(chars[k])
                           and chars[k]["bbox"][0] - 0.5 <= x0 <= chars[k]["bbox"][2] + 0.5), None)
            if jumeau is None:
                jumeau = next((k for k in (i + 1, i + 2) if 0 <= k < n and not est_marque[k] and chars[k]["c"] == ch["c"]
                               and not _largeur_nulle(chars[k]) and chars[k]["bbox"][0] - 0.5 <= x0 <= chars[k]["bbox"][2] + 0.5), None)
                if jumeau is not None:
                    grappe_de[i] = -2 - jumeau  # rattaché plus tard à la grappe de chars[jumeau]
                    continue
            else:
                grappe_de[i] = jumeau
                continue
        res.append(Grappe([ch], x0, x1))
        grappe_de[i] = len(res) - 1
    for i in range(n):
        if grappe_de[i] <= -2:
            grappe_de[i] = grappe_de[-2 - grappe_de[i]]
    for i, ch in enumerate(chars):
        if not est_marque[i]:
            continue
        mx = ch["bbox"][0]
        bases = [k for k in range(n) if not est_marque[k] and grappe_de[k] >= 0]
        # 1. Une base de largeur nulle posée EXACTEMENT là (LibreOffice : la marque partage l'origine de sa base).
        exactes = [k for k in bases if _largeur_nulle(chars[k]) and abs(chars[k]["bbox"][0] - mx) < 0.05]
        # 2. Une base à largeur réelle, proche dans le flux, qui CONTIENT la marque.
        contenantes = [k for k in bases if abs(k - i) <= 3 and not _largeur_nulle(chars[k])
                       and chars[k]["bbox"][0] - 0.05 <= mx <= chars[k]["bbox"][2] + 0.05]
        voisins = [k for k in (i - 1, i + 1) if 0 <= k < n and not est_marque[k] and grappe_de[k] >= 0]
        for pas in (-1, 1):  # marques consécutives (chadda + fatha) : la base est au-delà
            k = i + pas
            while 0 <= k < n and est_marque[k]:
                k += pas
            if 0 <= k < n and grappe_de[k] >= 0 and k not in voisins:
                voisins.append(k)
        # Motif LibreOffice ([marque…, base], échos retirés) : la base est la PREMIÈRE lettre qui suit dans le flux.
        k_suiv = i + 1
        while k_suiv < n and est_marque[k_suiv]:
            k_suiv += 1
        k_prec = i - 1
        while k_prec >= 0 and est_marque[k_prec]:
            k_prec -= 1
        k_conv = k_suiv if suivante_dabord else k_prec
        if (marques and 0 <= k_conv < n and grappe_de[k_conv] >= 0 and classe(chars[k_conv]["c"]) == "R"
                and not _largeur_nulle(chars[k_conv])
                and chars[k_conv]["bbox"][0] - 0.6 <= mx <= chars[k_conv]["bbox"][2] + 0.6):
            exactes, contenantes = [k_conv], []
        # Une marque arabe ne se pose pas sur un point ou une espace quand une lettre arabe la réclame : on prend la
        # première liste qui offre une LETTRE ARABE — au besoin celle qui la touche, où qu'elle soit dans le flux (la
        # marque de la dernière lettre, émise en tête de ligne par LibreOffice 7.4).
        arabes = lambda ks: [k for k in ks if classe(chars[k]["c"]) == "R"]
        loin = [k for k in bases if classe(chars[k]["c"]) == "R" and chars[k]["bbox"][0] - 0.6 <= mx <= chars[k]["bbox"][2] + 0.6]
        loin = sorted(loin, key=lambda k: abs(chars[k]["bbox"][0] - mx))[:1]
        prefere = arabes(exactes) or arabes(contenantes) or loin or arabes(voisins)
        if prefere:
            exactes, contenantes, voisins = prefere, [], []
        choix = exactes or contenantes or voisins
        if choix:
            # À distance égale, la base qui SUIT la marque dans le flux : LibreOffice émet [marque, base], et une marque
            # posée sur la jointure de deux lettres (bord droit de l'une = bord gauche de l'autre) est à la suivante.
            k = min(choix, key=lambda k: (abs(chars[k]["bbox"][0] - mx) > 0.05 if choix is voisins else 0,
                                          (k < i) if suivante_dabord else (k > i), abs(k - i), k < i))
            cible = res[grappe_de[k]]
        elif res:
            cible = min(res, key=lambda g: 0 if g.x0 <= mx <= g.x1 else min(abs(g.x0 - mx), abs(g.x1 - mx)))
        else:
            res.append(Grappe([ch], ch["bbox"][0], ch["bbox"][2]))
            continue
        if not any(c["c"] == ch["c"] for c in cible.chars):
            cible.chars.append(ch)
    _replacer_orphelines(res)
    for g in res:
        g.calculer_classe()
    return res


def _replacer_orphelines(res: list[Grappe]) -> None:
    """Une base de largeur nulle SANS jumelle (son glyphe réel perdu par le producteur) posée DANS la boîte d'une autre
    lettre serait rangée au hasard (« ؤْيُ » pour « يُؤْ »). On la place par l'ordre du flux : juste à côté de la base
    réelle qui la suit (flux de droite à gauche, LibreOffice) ou la précède (flux de gauche à droite)."""
    reelles = [g for g in res if g.x1 - g.x0 > 0.05]
    descend = sum(1 for a, b in zip(reelles, reelles[1:]) if b.x0 < a.x0) > len(reelles) / 2
    for j, g in enumerate(res):
        if g.x1 - g.x0 > 0.05 or not any(classe(c["c"]) == "R" for c in g.chars):
            continue
        if not any(r.x0 + 0.05 < g.x0 < r.x1 - 0.05 for r in reelles if any(classe(c["c"]) == "R" for c in r.chars)):
            continue
        voisines = res[j + 1:] if descend else res[:j][::-1]
        v = next((r for r in voisines if r.x1 - r.x0 > 0.05), None)
        if v is not None:
            g.x0 = g.x1 = v.x1 + 0.001


SEPARATEURS_NOMBRE = set("/.,:-+\u060c\u066b\u066c")
#: Séparateurs EUROPÉENS (ES) : ils lient deux nombres en contexte latin seulement (UBA, W4) — « 21-82 » dans une
#: phrase arabe s'affiche « 82-21 » : deux nombres, pas un.
SEPARATEURS_ES = set("-+")


def _marquer_nombres(seq: list[Grappe], rtl: bool) -> list[str]:
    """La classe EFFECTIVE de chaque grappe : un nombre (avec ses séparateurs internes « 15/09/2026 ») prend la
    direction de ses voisins forts — collé à du latin il en fait partie (« Amoxicilline 1 g », « DZ-2026-114 »),
    entouré d'arabe il reste un nombre autonome (« الهاتف 021 45 67 89 » : quatre nombres, pas un). L'ordre visuel
    seul est ambigu (« lot 12 ءاود ») : le latin l'emporte, c'est le cas courant des références."""
    cls = [g.cls for g in seq]
    n = len(seq)
    i = 0
    while i < n:
        if cls[i] != "N":
            i += 1
            continue
        j = i
        while j + 1 < n and (cls[j + 1] == "N" or (seq[j + 1].texte() in SEPARATEURS_NOMBRE and j + 2 < n and cls[j + 2] == "N")):
            j += 1
        gauche = next((cls[k] for k in range(i - 1, -1, -1) if cls[k] in ("R", "L")), None)
        droite = next((cls[k] for k in range(j + 1, n) if cls[k] in ("R", "L")), None)
        cotes = {gauche, droite}
        if rtl:
            eff = "L" if "L" in cotes else "A"
        else:
            eff = "A" if "R" in cotes and "L" not in cotes else "L"
        for k in range(i, j + 1):
            cls[k] = "O" if eff == "A" and seq[k].texte() in SEPARATEURS_ES else eff
        i = j + 1
    return cls


def _retourner(seq: list, cls: list[str], forts: set[str], interdits: set[str]) -> None:
    """Retourne EN PLACE chaque séquence maximale qui commence et finit par une classe de `forts`, sans `interdits`."""
    i, n = 0, len(seq)
    while i < n:
        if cls[i] in forts:
            j, dernier = i, i
            while j < n and cls[j] not in interdits:
                if cls[j] in forts:
                    dernier = j
                j += 1
            seq[i:dernier + 1] = seq[i:dernier + 1][::-1]
            cls[i:dernier + 1] = cls[i:dernier + 1][::-1]
            i = dernier + 1
        else:
            i += 1


def ordre_logique(visuel: list[Grappe], rtl: bool) -> list[Grappe]:
    """Grappes rangées de GAUCHE À DROITE (ordre visuel) → ordre logique, selon la direction de base."""
    seq = list(visuel)
    cls = _marquer_nombres(seq, rtl)
    if rtl:
        seq.reverse()
        cls.reverse()
        _retourner(seq, cls, {"L"}, {"R", "A"})  # le latin (et ses nombres) revient à l'endroit
        _retourner(seq, cls, {"A"}, {"R", "L", "O", "M"})  # chaque nombre autonome aussi
        return seq
    _retourner(seq, cls, {"R", "A"}, {"L"})  # chaque passage arabe (avec ses nombres) est retourné…
    _retourner(seq, cls, {"A"}, {"R", "L", "O", "M"})  # … et ses nombres remis à l'endroit
    return seq


def miroir(c: str) -> str:
    return {"(": ")", ")": "(", "[": "]", "]": "[", "{": "}", "}": "{", "«": "»", "»": "«", "<": ">", ">": "<"}.get(c, c)
