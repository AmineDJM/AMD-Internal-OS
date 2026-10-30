"""Tests PURS de l'OCR vision (décision 0019, suite) : désignation, lecture de la transcription, arbitrage, contrôle."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from amd_conversions.vision import arbitrer_harakat, lignes_de_transcription, raison_vision, verifier, vocalise  # noqa: E402


class Vision(unittest.TestCase):
    def test_designation(self):
        self.assertTrue(vocalise("تُحْفَظُ الأَدْوِيَةُ فِي مَكَانٍ بَارِدٍ وَجَافٍّ، بَعِيدًا عَنْ"))
        self.assertFalse(vocalise("تحفظ الأدوية في مكان بارد وجاف بعيدا عن متناول الأطفال"))
        self.assertIsNone(raison_vision({"mots": [{"t": "Bonjour", "conf": 96}] * 30, "confiance": 96}))
        self.assertEqual(raison_vision({"mots": [], "confiance": 0}), "aucun mot lu par tesseract")

    def test_transcription(self):
        l = lignes_de_transcription("Titre\n\n| Produit | Prix |\n|---|---|\n| A | 1 |\nfin")
        self.assertEqual([x["genre"] for x in l], ["texte", "vide", "rangee", "rangee", "texte"])
        self.assertEqual(l[3]["cellules"], ["A", "1"])

    def test_soukoun_de_l_article_ajoute(self):
        self.assertEqual(arbitrer_harakat("الْمَعْلُومَاتِ وَالْأَدْوِيَةُ لِلْمَرِيضِ", []), "المَعْلُومَاتِ وَالأَدْوِيَةُ لِلْمَرِيضِ")
        self.assertEqual(arbitrer_harakat("الْمَعْلُومَاتِ", ["الْمَعْلُومَاتِ"]), "الْمَعْلُومَاتِ")  # lu des deux côtés : gardé

    def test_controle_croise(self):
        c = verifier(lignes_de_transcription("سطر أول\nالصيدلية المركزية للمستشفيات"), [{"texte": "سطر أول"}])
        self.assertEqual(c["absentes_de_tesseract"], 1)
        self.assertEqual(c["absentes_de_la_vision"], 0)


if __name__ == "__main__":
    unittest.main()
