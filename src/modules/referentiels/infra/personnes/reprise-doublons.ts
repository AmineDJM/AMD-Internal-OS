/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA REPRISE QUI PROPOSE LES DOUBLONS ENTRE PERSONNES (lot V2-B) — après les reprises des neuf tables.
 *
 * Le moteur compare toutes les fiches reliées (`fiches-doublons.ts` → `paires.ts`) ; chaque paire de
 * Personnes qui se ressemblent devient une ligne `DoublonPersonne` « PROPOSE ». Rien n'est fusionné :
 * une personne tranche depuis `/personnes/doublons` (fusionner, ou écarter — une paire écartée ne
 * revient pas, la clé unique A < B la retient).
 *
 * Le calcul est GLOBAL (un doublon se voit entre deux tables) ; l'écriture se fait par lots, dans l'ordre
 * des paires, le curseur étant la clé de la dernière paire écrite. Rejouable : `skipDuplicates`.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import { prisma } from "@/lib/prisma";
import { bilanVide, type Reprise } from "../../domaine/reprises/types";
import { chargerFichesPersonnes } from "./fiches-doublons";
import { clePaire, pairesDePersonnes, type PaireProposee } from "../../domaine/personnes/paires";

/** Les paires NOUVELLES (jamais proposées, quel qu'en soit le sort), dans l'ordre de leur clé. */
async function pairesNouvelles(): Promise<{ lues: number; ignorees: number; paires: PaireProposee[] }> {
  const fiches = await chargerFichesPersonnes(prisma);
  const reliees = fiches.filter((f): f is { fiche: typeof f.fiche; personneId: string } => !!f.personneId);
  const paires = pairesDePersonnes(reliees);
  const connues = new Set(
    (await prisma.doublonPersonne.findMany({ select: { personneAId: true, personneBId: true } })).map((d) => clePaire({ a: d.personneAId, b: d.personneBId })),
  );
  return { lues: fiches.length, ignorees: fiches.length - reliees.length, paires: paires.filter((p) => !connues.has(clePaire(p))) };
}

export const repriseDoublonsPersonnes: Reprise = {
  cle: "personnes-doublons",
  titre: "Personnes — doublons proposés",
  description: "Compare les fiches de toutes les tables reliées et PROPOSE les Personnes qui se ressemblent (même NIN, même "
    + "e-mail personnel, même mobile, même nom et même établissement…). Rien n'est fusionné : chaque proposition se tranche "
    + "dans « Personnes › Doublons ». À lancer après les reprises des tables ; les lignes non encore reliées sont ignorées.",

  async apercu() {
    const { lues, ignorees, paires } = await pairesNouvelles();
    return { ...bilanVide(), lues, ignorees, doublonsProposes: paires.length };
  },

  async executer({ taille, apresId }) {
    const { lues, ignorees, paires } = await pairesNouvelles();
    // Le curseur est une clé de paire : les paires écrites au lot précédent sont désormais « connues ».
    const restantes = apresId ? paires.filter((p) => clePaire(p) > apresId) : paires;
    const lot = restantes.slice(0, taille);
    const b = { ...bilanVide(), lues, ignorees };
    if (lot.length) {
      const { count } = await prisma.doublonPersonne.createMany({
        data: lot.map((p) => ({ personneAId: p.a, personneBId: p.b, niveau: p.niveau, score: p.score, raisons: p.raisons, reserves: p.reserves })),
        skipDuplicates: true,
      });
      b.doublonsProposes = count;
    }
    return { ...b, suite: restantes.length > taille ? clePaire(lot[lot.length - 1]) : null };
  },
};
