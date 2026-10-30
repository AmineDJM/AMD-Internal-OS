"""
LE WORD RELU ET CORRIGÉ (décision 0019) — ce que pdf2docx laisse, et que la Direction ne veut pas voir.

pdf2docx reconstruit la mise en page (paragraphes, tableaux, images, colonnes, polices, tailles, couleurs) mais :
  • il garde chaque LIGNE du PDF : un paragraphe de cinq lignes devient cinq morceaux séparés par des retours forcés
    et des tabulations de positionnement — en Word, le texte ne se reflue plus ;
  • il ne connaît pas le bidi : aucun w:bidi (paragraphe de droite à gauche), aucun w:rtl (texte arabe), aucune police
    de script complexe (w:cs) — Word affiche alors l'arabe avec la police latine, gras et tailles perdus (w:bCs, w:szCs) ;
  • il fusionne les éléments d'une liste en un seul paragraphe, puce comprise.

Ici, on repasse sur le XML (python-docx + lxml) : corps, cellules, en-têtes et pieds.
"""

from __future__ import annotations

import copy
import re
import subprocess
from functools import lru_cache

from docx.oxml import OxmlElement
from docx.oxml.ns import qn

from .normaliser import a_de_l_arabe, classe, est_arabe, texte_propre

W_P, W_R, W_T, W_BR, W_TAB, W_PPR, W_RPR = (qn(x) for x in ("w:p", "w:r", "w:t", "w:br", "w:tab", "w:pPr", "w:rPr"))
PUCES = "•▪◦○■□◆❖➢✓-–o"
RE_PUCE = re.compile(r"^\s*([•▪◦○■□◆❖➢✓–]|o(?=\s)|-(?=\s))\s*")
POLICE_ARABE_DEFAUT = "Noto Naskh Arabic"
_ARABES_CONNUES = ("naskh", "amiri", "arab", "kufi", "traditional", "sakkal", "tahoma", "times new roman", "arial", "scheherazade", "dubai", "cairo", "tajawal", "almarai")


@lru_cache(maxsize=1)
def familles_installees() -> dict[str, str]:
    """« NotoNaskhArabic » → « Noto Naskh Arabic » : les noms PostScript du PDF ramenés aux familles installées."""
    try:
        sortie = subprocess.run(["fc-list", ":", "family"], capture_output=True, text=True, timeout=20).stdout
    except (OSError, subprocess.SubprocessError):
        return {}
    familles: dict[str, str] = {}
    for ligne in sortie.splitlines():
        for f in ligne.split(","):
            f = f.strip()
            if f:
                familles.setdefault(re.sub(r"[\s_-]", "", f).lower(), f)
    return familles


def famille(nom: str | None) -> str | None:
    if not nom:
        return None
    base = re.sub(r"^[A-Z]{6}\+", "", nom)
    base = re.split(r"[-,]", base)[0]
    cle = re.sub(r"(MT|PS|Std|Pro)$", "", re.sub(r"[\s_]", "", base)).lower()
    fam = familles_installees()
    return fam.get(cle) or fam.get(re.sub(r"[\s_]", "", base).lower()) or re.sub(r"(?<=[a-z])(?=[A-Z])", " ", base)


def _enfant(parent, tag: str, avant: tuple[str, ...] = ()):
    el = parent.find(qn(tag))
    if el is None:
        el = OxmlElement(tag)
        suivant = next((parent.find(qn(t)) for t in avant if parent.find(qn(t)) is not None), None)
        if suivant is not None:
            suivant.addprevious(el)
        else:
            parent.append(el)
    return el


# L'ordre du schéma (CT_PPr / CT_RPr) : un élément mal rangé est ignoré par Word, parfois par LibreOffice.
APRES_BIDI = ("w:adjustRightInd", "w:snapToGrid", "w:spacing", "w:ind", "w:contextualSpacing", "w:mirrorIndents",
              "w:suppressOverlap", "w:jc", "w:textDirection", "w:textAlignment", "w:textboxTightWrap", "w:outlineLvl",
              "w:divId", "w:cnfStyle", "w:rPr", "w:sectPr", "w:pPrChange")
ORDRE_RPR = ("w:rStyle", "w:rFonts", "w:b", "w:bCs", "w:i", "w:iCs", "w:caps", "w:smallCaps", "w:strike", "w:dstrike",
             "w:outline", "w:shadow", "w:emboss", "w:imprint", "w:noProof", "w:snapToGrid", "w:vanish", "w:webHidden",
             "w:color", "w:spacing", "w:w", "w:kern", "w:position", "w:sz", "w:szCs", "w:highlight", "w:u", "w:effect",
             "w:bdr", "w:shd", "w:fitText", "w:vertAlign", "w:rtl", "w:cs", "w:em", "w:lang", "w:eastAsianLayout",
             "w:specVanish", "w:oMath")


def _rpr_inserer(rpr, tag: str):
    """Ajoute `tag` à sa place dans w:rPr (s'il n'y est pas) et le rend."""
    el = rpr.find(qn(tag))
    if el is not None:
        return el
    el = OxmlElement(tag)
    rang = ORDRE_RPR.index(tag)
    for t in ORDRE_RPR[rang + 1:]:
        suivant = rpr.find(qn(t))
        if suivant is not None:
            suivant.addprevious(el)
            return el
    rpr.append(el)
    return el


def _ppr(p):
    ppr = p.find(W_PPR)
    if ppr is None:
        ppr = OxmlElement("w:pPr")
        p.insert(0, ppr)
    return ppr


def texte_du_paragraphe(p) -> str:
    morceaux = []
    for el in p.iter(W_T, W_TAB, W_BR):
        morceaux.append(el.text or "" if el.tag == W_T else "\t" if el.tag == W_TAB else "\n")
    return "".join(morceaux)


def _runs(p):
    return [r for r in p.iter(W_R)]


# ─────────────────────────── 1. Retours et tabulations de positionnement ───────────────────────────

def _espacement(ppr, avant: str | None = None, apres: str | None = None) -> None:
    sp = _enfant(ppr, "w:spacing", ("w:ind", "w:contextualSpacing", "w:mirrorIndents", "w:suppressOverlap", "w:jc",
                                     "w:textDirection", "w:textAlignment", "w:outlineLvl", "w:rPr", "w:sectPr"))
    if avant is not None:
        sp.set(qn("w:before"), avant)
    if apres is not None:
        sp.set(qn("w:after"), apres)


def scinder_aux_retours(p) -> list:
    """Un retour forcé laissé par la reconstruction est VOULU (fin de paragraphe, ligne d'adresse, puce suivante) :
    on en fait un vrai paragraphe — même mise en forme, sans doubler l'espacement. Rend les paragraphes obtenus."""
    morceaux = [p]
    courant = p
    for r in list(p):
        if r.tag != W_R:
            continue
        br = next((el for el in r if el.tag == W_BR and el.get(qn("w:type")) in (None, "textWrapping")), None)
        if br is None:
            if courant is not p:
                courant.append(r)
            continue
        # Le run porteur du retour : ce qui précède le retour reste, ce qui suit part dans le paragraphe neuf.
        apres = []
        vu = False
        for el in list(r):
            if el is br:
                vu = True
                r.remove(el)
            elif vu and el.tag != W_RPR:
                apres.append(el)
                r.remove(el)
        if courant is not p:
            courant.append(r)
        neuf = OxmlElement("w:p")
        ppr = p.find(W_PPR)
        if ppr is not None:
            neuf.append(copy.deepcopy(ppr))
        morceaux[-1].addnext(neuf)
        if apres:
            nr = OxmlElement("w:r")
            if r.find(W_RPR) is not None:
                nr.append(copy.deepcopy(r.find(W_RPR)))
            for el in apres:
                nr.append(el)
            neuf.append(nr)
        morceaux.append(neuf)
        courant = neuf
    if len(morceaux) > 1:
        for i, q in enumerate(morceaux):
            ppr = _ppr(q)
            _espacement(ppr, avant="0" if i > 0 else None, apres="0" if i < len(morceaux) - 1 else None)
    for q in morceaux:
        _retirer_tabulations_de_tete(q)
    return morceaux


def _retirer_tabulations_de_tete(p) -> None:
    """Les tabulations qui POSITIONNAIENT une ligne du PDF : au début d'un paragraphe, elles ne sont que du vide."""
    for r in _runs(p):
        for el in list(r):
            if el.tag == W_RPR:
                continue
            if el.tag == W_TAB:
                r.remove(el)
                continue
            if el.tag == W_T and not (el.text or "").strip():
                r.remove(el)
                continue
            if el.tag == W_T:
                el.text = el.text.lstrip()
            return
    return


# ─────────────────────────── 2. Texte : normalisation finale ───────────────────────────

def nettoyer_textes(p) -> None:
    for t in p.iter(W_T):
        if t.text:
            propre = texte_propre(t.text)
            propre = re.sub(r" {2,}", " ", propre)
            if propre != t.text:
                t.text = propre
                t.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
    # Espace de fin de paragraphe : parasite.
    ts = [t for t in p.iter(W_T) if t.text]
    if ts:
        ts[-1].text = ts[-1].text.rstrip()
        ts[0].text = ts[0].text.lstrip() if not ts[0].text.startswith("\t") else ts[0].text


# ─────────────────────────── 3. Listes ───────────────────────────

def poser_liste(p, styles_disponibles: set[str]) -> bool:
    """« • texte » → paragraphe de style « List Bullet » (vraie liste Word), puce retirée du texte."""
    ts = [t for t in p.iter(W_T)]
    texte = "".join(t.text or "" for t in ts)
    m = RE_PUCE.match(texte)
    if not m or not texte[m.end():].strip():
        return False
    a_retirer = m.end()
    for t in ts:
        if a_retirer <= 0:
            break
        n = len(t.text or "")
        t.text = (t.text or "")[a_retirer:]
        a_retirer -= n
    for r in _runs(p):
        for tab in r.findall(W_TAB):
            if not "".join(x.text or "" for x in p.iter(W_T)).strip():
                break
        # Une tabulation entre la puce et le texte : retirée.
        if r.find(W_TAB) is not None and not "".join(x.text or "" for x in r.iter(W_T)).strip():
            p.remove(r) if r.getparent() is p else None
    if "ListBullet" in styles_disponibles:
        ppr = _ppr(p)
        style = ppr.find(qn("w:pStyle"))
        if style is None:
            style = OxmlElement("w:pStyle")
            ppr.insert(0, style)
        style.set(qn("w:val"), "ListBullet")
        ind = ppr.find(qn("w:ind"))
        if ind is not None:
            ppr.remove(ind)
    return True


# ─────────────────────────── 3 bis. Runs morcelés ───────────────────────────

def fusionner_runs(p) -> None:
    """Deux runs voisins de même mise en forme, texte seul → un run. pdf2docx en pose un par grappe de glyphes sur
    un texte arabe vocalisé : une marque (fatha, chadda) isolée dans son run se dessine mal dans Word."""
    from lxml import etree

    precedent = None
    cle_prec = None
    for r in list(p):
        if r.tag != W_R or any(c.tag not in (W_RPR, W_T) for c in r) or len(r.findall(W_T)) != 1:
            precedent = None
            continue
        rpr = r.find(W_RPR)
        cle = etree.tostring(rpr) if rpr is not None else b""
        if precedent is not None and cle == cle_prec:
            t_prec = precedent.find(W_T)
            t_prec.text = (t_prec.text or "") + (r.find(W_T).text or "")
            t_prec.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
            p.remove(r)
            continue
        precedent, cle_prec = r, cle


# ─────────────────────────── 4. Direction et polices de script complexe ───────────────────────────

RE_ARABE_SEGMENT = re.compile(r"[؀-ۿݐ-ݿࢠ-ࣿ](?:[^A-Za-zÀ-ɏ]*[؀-ۿݐ-ݿࢠ-ࣿ])?")


def _scinder_run_par_script(r) -> list:
    """Un run qui mêle latin et arabe → plusieurs runs (même mise en forme) : w:rtl ne se pose que sur l'arabe."""
    ts = r.findall(W_T)
    if len(ts) != 1 or len(list(r)) != (2 if r.find(W_RPR) is not None else 1):
        return [r]
    texte = ts[0].text or ""
    if not a_de_l_arabe(texte) or not any(classe(c) == "L" for c in texte):
        return [r]
    morceaux, pos = [], 0
    for m in RE_ARABE_SEGMENT.finditer(texte):
        if m.start() > pos:
            morceaux.append(texte[pos:m.start()])
        morceaux.append(texte[m.start():m.end()])
        pos = m.end()
    if pos < len(texte):
        morceaux.append(texte[pos:])
    if len(morceaux) <= 1:
        return [r]
    nouveaux = []
    for m in morceaux:
        n = copy.deepcopy(r)
        n.find(W_T).text = m
        n.find(W_T).set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
        r.addprevious(n)
        nouveaux.append(n)
    r.getparent().remove(r)
    return nouveaux


def poser_direction(p) -> bool:
    """w:bidi sur un paragraphe arabe ; w:rtl + w:cs + bCs/iCs/szCs sur ses runs arabes. Rend vrai si RTL."""
    texte = texte_du_paragraphe(p)
    rtl = est_arabe(texte)
    if rtl:
        ppr = _ppr(p)
        _enfant(ppr, "w:bidi", APRES_BIDI)
        jc = ppr.find(qn("w:jc"))
        # Dans un paragraphe bidi, Word (et LibreOffice, mesuré) lit « left »/« right » comme DÉBUT/FIN : pdf2docx a mesuré
        # une position physique, on l'inverse.
        if jc is not None and jc.get(qn("w:val")) in ("left", "right", "start", "end"):
            jc.set(qn("w:val"), {"left": "right", "right": "left", "start": "end", "end": "start"}[jc.get(qn("w:val"))])
        # Les retraits calculés par pdf2docx supposent une ligne de GAUCHE À DROITE (retrait suspendu, marge droite
        # énorme) : en bidi, Word les lit en début/fin et rejette la première ligne hors de la page. Les marges suffisent.
        ind = ppr.find(qn("w:ind"))
        if ind is not None:
            ppr.remove(ind)
    for r in list(_runs(p)):
        for n in _scinder_run_par_script(r):
            t = "".join(x.text or "" for x in n.iter(W_T))
            rpr = n.find(W_RPR)
            if rpr is None:
                rpr = OxmlElement("w:rPr")
                n.insert(0, rpr)
            # La mise en forme vaut AUSSI pour le script complexe (sinon Word perd gras, italique et taille sur l'arabe).
            if rpr.find(qn("w:b")) is not None and rpr.find(qn("w:b")).get(qn("w:val")) not in ("0", "false"):
                _rpr_inserer(rpr, "w:bCs")
            if rpr.find(qn("w:i")) is not None and rpr.find(qn("w:i")).get(qn("w:val")) not in ("0", "false"):
                _rpr_inserer(rpr, "w:iCs")
            sz = rpr.find(qn("w:sz"))
            if sz is not None:
                _rpr_inserer(rpr, "w:szCs").set(qn("w:val"), sz.get(qn("w:val")))
            if a_de_l_arabe(t) or (rtl and re.search(r"[\u0610-\u061a\u064b-\u065f\u0670\u06d6-\u06ed]", t)):
                _rpr_inserer(rpr, "w:rtl")
                fonts = _rpr_inserer(rpr, "w:rFonts")
                nom = fonts.get(qn("w:ascii")) or fonts.get(qn("w:hAnsi"))
                fam = famille(nom)
                cs = fam if fam and any(k in fam.lower() for k in _ARABES_CONNUES) else POLICE_ARABE_DEFAUT
                fonts.set(qn("w:cs"), cs)
                if fam and nom != fam:
                    fonts.set(qn("w:ascii"), fam)
                    fonts.set(qn("w:hAnsi"), fam)
                lang = _rpr_inserer(rpr, "w:lang")
                lang.set(qn("w:bidi"), "ar-DZ")
            else:
                fonts = rpr.find(qn("w:rFonts"))
                if fonts is not None:
                    nom = fonts.get(qn("w:ascii"))
                    fam = famille(nom)
                    if fam and fam != nom:
                        for a in ("w:ascii", "w:hAnsi", "w:eastAsia"):
                            if fonts.get(qn(a)) == nom:
                                fonts.set(qn(a), fam)
    return rtl


def tableau_rtl(tbl) -> None:
    """Un tableau dont les cellules sont arabes se lit de droite à gauche : w:bidiVisual, colonnes dans l'ordre logique."""
    textes = "".join(t.text or "" for t in tbl.iter(W_T))
    if not est_arabe(textes):
        return
    tpr = tbl.find(qn("w:tblPr"))
    if tpr is None:
        tpr = OxmlElement("w:tblPr")
        tbl.insert(0, tpr)
    if tpr.find(qn("w:bidiVisual")) is not None:
        return
    # pdf2docx a écrit les cellules de GAUCHE À DROITE ; avec bidiVisual, Word les pose de droite à gauche : on les retourne.
    for tr in tbl.findall(qn("w:tr")):
        cellules = tr.findall(qn("w:tc"))
        for c in cellules:
            tr.remove(c)
        for c in reversed(cellules):
            tr.append(c)
    grid = tbl.find(qn("w:tblGrid"))
    if grid is not None:
        cols = grid.findall(qn("w:gridCol"))
        for c in cols:
            grid.remove(c)
        for c in reversed(cols):
            grid.append(c)
    _enfant(tpr, "w:bidiVisual", ("w:tblStyle", "w:tblpPr", "w:tblOverlap"))
    # bidiVisual se place juste après tblStyle/tblpPr/tblOverlap : on le remonte s'il a atterri trop bas.
    bv = tpr.find(qn("w:bidiVisual"))
    tpr.remove(bv)
    rang = 0
    for i, el in enumerate(tpr):
        if el.tag in (qn("w:tblStyle"), qn("w:tblpPr"), qn("w:tblOverlap")):
            rang = i + 1
    tpr.insert(rang, bv)


def marges_de_cellules(racine) -> None:
    """pdf2docx pose des marges de cellule NULLES : le texte touche le trait (et, en arabe, déborde à l'œil)."""
    for mar in racine.iter(qn("w:tcMar")):
        for el in mar:
            if el.get(qn("w:w")) in ("0", "0.0"):
                el.set(qn("w:w"), "57")


# ─────────────────────────── Le passage ───────────────────────────

def tous_les_paragraphes(racine) -> list:
    return list(racine.iter(W_P))


def corriger_document(doc) -> dict:
    """Repasse sur tout le document python-docx. Rend un petit bilan (paragraphes RTL, listes, lignes recousues)."""
    styles = {s.style_id for s in doc.styles}
    bilan = {"paragraphes": 0, "rtl": 0, "listes": 0}
    racines = [doc.element.body]
    for s in doc.sections:
        for hf in (s.header, s.footer, s.first_page_header, s.first_page_footer):
            if not hf.is_linked_to_previous:
                racines.append(hf._element)
    for racine in racines:
        for p in tous_les_paragraphes(racine):
            for q in scinder_aux_retours(p):
                fusionner_runs(q)
                nettoyer_textes(q)
                if poser_liste(q, styles):
                    bilan["listes"] += 1
                if poser_direction(q):
                    bilan["rtl"] += 1
                if texte_du_paragraphe(q).strip():
                    bilan["paragraphes"] += 1
        for tbl in racine.iter(qn("w:tbl")):
            tableau_rtl(tbl)
        marges_de_cellules(racine)
    return bilan
