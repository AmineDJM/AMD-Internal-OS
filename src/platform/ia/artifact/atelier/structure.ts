/**
 * LA STRUCTURE D'UN DOCUMENT OUVERT, DITE AU MODÈLE (Atelier, J3) — ce qu'il lui faut pour DÉSIGNER une cible
 * (rang humain, fragment de texte, diapositive, cellule) sans recevoir le document entier. Bornée : un contrat
 * de quarante pages ne part pas en entier, la fin est dite tronquée. Le texte est une DONNÉE (l'appelant
 * l'encadre comme contenu tiers, §104.10). Module PUR.
 */

import type { VueContenu } from "@/lib/artifact/render/view";

const court = (t: string, n: number) => {
  const s = t.replace(/\s+/g, " ").trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

export function structurePourModele(vue: VueContenu, budget = 7000): string {
  const lignes: string[] = [];
  if (vue.kind === "DOCX") {
    lignes.push(`Word — ${vue.paragraphes} paragraphes, ${vue.pages} page${vue.pages > 1 ? "s" : ""}. Paragraphes (rang : texte) et tableaux (T rang) :`);
    const ordre = [...vue.blocs].sort((a, b) => (a.page ?? 0) - (b.page ?? 0));
    for (const b of ordre) {
      if (b.type === "paragraphe" && b.texte.trim()) lignes.push(`¶${b.index}${b.styleName && /titre|heading|title/i.test(b.styleName) ? " [titre]" : ""} : ${court(b.texte, 220)}`);
      if (b.type === "tableau") lignes.push(`T${b.index} (${b.lignes.length} lignes) : ${b.lignes.slice(0, 3).map((l) => l.join(" | ")).join(" / ")}`);
    }
  } else if (vue.kind === "PPTX") {
    lignes.push(`PowerPoint — ${vue.diapos.length} diapositive${vue.diapos.length > 1 ? "s" : ""} :`);
    for (const d of vue.diapos) {
      lignes.push(`Diapo ${d.index} — titre : « ${court(d.titre, 120)} »`);
      for (const f of d.formes) if (f.texte.trim()) lignes.push(`   zone ${f.index} (${f.role}) : ${court(f.texte, 160)}`);
    }
  } else if (vue.kind === "XLSX") {
    lignes.push(`Excel — ${vue.feuilles.length} feuille${vue.feuilles.length > 1 ? "s" : ""} :`);
    for (const f of vue.feuilles) {
      lignes.push(`Feuille « ${f.nom} » (${f.lignes} × ${f.colonnes}) :`);
      for (const c of f.cellules.slice(0, 160)) if (c.valeur || c.formule) lignes.push(`   ${c.ref} = ${c.formule ? `=${c.formule.replace(/^=/, "")} → ` : ""}${court(c.valeur, 60)}`);
    }
  } else {
    lignes.push(`PDF — ${vue.pages.length} page${vue.pages.length > 1 ? "s" : ""} (se modifie par pages : supprimer, pivoter, filigrane ; le texte d'un PDF ne se réécrit pas) :`);
    for (const p of vue.pages.slice(0, 40)) lignes.push(`Page ${p.index} : ${court(p.apercu, 120)}`);
  }
  let out = "";
  for (const l of lignes) {
    if (out.length + l.length > budget) return `${out}… (suite tronquée — désignez par un fragment de texte)`;
    out += `${l}\n`;
  }
  return out.trimEnd();
}
