"""Tests PURS de la normalisation et de l'ordre logique (décision 0019) — `python3 -m unittest discover scripts/conversions/tests`."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from amd_conversions.normaliser import Grappe, normaliser_caractere, ordre_logique, reparer_mojibake, texte_propre  # noqa: E402


def visuel(texte_visuel: str) -> list[Grappe]:
    """Une ligne telle que l'œil la voit, de gauche à droite : un caractère = une grappe."""
    out = []
    for i, c in enumerate(texte_visuel):
        g = Grappe([{"c": c, "bbox": (i, 0, i + 1, 1)}], i, i + 1)
        g.calculer_classe()
        out.append(g)
    return out


def logique(texte_visuel: str, rtl: bool) -> str:
    return "".join(g.texte() for g in ordre_logique(visuel(texte_visuel), rtl))


class Normalisation(unittest.TestCase):
    def test_formes_de_presentation_et_ligatures(self):
        self.assertEqual(normaliser_caractere("ﻻ"), "لا")
        self.assertEqual(normaliser_caractere("ﬁ"), "fi")
        self.assertEqual(normaliser_caractere(""), "•")
        self.assertEqual(normaliser_caractere("‏"), "")
        self.assertEqual(normaliser_caractere("ᵉ"), "ᵉ")  # pas de NFKC aveugle

    def test_mojibake(self):
        self.assertEqual(reparer_mojibake("Ø§Ù„"), "ال")
        self.assertEqual(texte_propre("Ã©tÃ©"), "été")


class OrdreLogique(unittest.TestCase):
    def test_arabe_seul(self):
        self.assertEqual(logique("مالس", True), "سلام")

    def test_nombre_dans_une_phrase_arabe(self):
        # « رقم 2026 » s'affiche « 2026 مقر » : le nombre reste dans son sens.
        self.assertEqual(logique("2026 مقر", True), "رقم 2026")

    def test_separateur_europeen_entre_nombres_arabes(self):
        # « 21-82 » dans une phrase arabe s'affiche « 82-21 » (UBA, W4) : deux nombres.
        self.assertEqual(logique("82-21 مقر", True), "رقم 21-82")

    def test_date_et_reference_latine(self):
        self.assertEqual(logique("DZ-2026-114 مقرلا", True), "الرقم DZ-2026-114")
        self.assertEqual(logique("15/09/2026 خيراتب", True), "بتاريخ 15/09/2026")

    def test_arabe_dans_une_phrase_francaise(self):
        self.assertEqual(logique("Le produit « ءاود » est", False), "Le produit « دواء » est")


if __name__ == "__main__":
    unittest.main()
