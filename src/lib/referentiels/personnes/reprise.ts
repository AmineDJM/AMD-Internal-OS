/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA REPRISE R1 D'UNE TABLE — chaque ligne de la table devient (ou rejoint) une Personne
 * (refonte des données, palier P2, lot V2-B). Un seul geste par ligne : `rattacherLigne`, celui de la
 * double écriture.
 *
 *   aperçu   — toute la table, À BLANC : combien de Personnes naîtraient, combien de lignes rejoindraient
 *              une Personne existante, combien sont déjà reliées ou laissées de côté (et pourquoi) ;
 *   exécuter — un LOT de lignes par ordre d'identifiant, après le curseur ; chaque ligne dans sa propre
 *              transaction (une ligne en échec n'emporte pas le lot : elle est nommée dans `erreurs`).
 *
 * Rejouable : une ligne reliée est « déjà reliée » ; une Personne née d'une racine a un identifiant
 * déterministe. La reprise ne propose aucun doublon : c'est la reprise `personnes-doublons`, qui passe
 * après toutes les tables.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import { prisma } from "@/lib/prisma";
import { bilanVide, type BilanReprise, type Reprise } from "@/lib/referentiels/reprises/types";
import { delegue, rattacherLigne, type IssueRattachement } from "@/lib/referentiels/personnes/rattachement";
import { LIBELLE_ROLE, ROLE_DE_LA_SOURCE, SELECTION, lireLigne, type SourcePersonne } from "@/lib/referentiels/personnes/sources";

/** Les erreurs gardées dans un bilan : au-delà, le compte suffit (un bilan n'est pas un journal de mille lignes). */
const ERREURS_MAX = 50;
const PAGE_APERCU = 500;

/** Ajoute l'issue d'une ligne au bilan. */
export function compter(b: BilanReprise, issue: IssueRattachement): void {
  if (issue.etat === "creee") b.creees++;
  else if (issue.etat === "liee") b.liees++;
  else b.ignorees++;
}

const noterErreur = (b: BilanReprise, msg: string) => {
  if (b.erreurs.length < ERREURS_MAX) b.erreurs.push(msg);
  else if (b.erreurs.length === ERREURS_MAX) b.erreurs.push("… erreurs suivantes non détaillées.");
};

export function reprisePersonnes(p: { cle: string; source: SourcePersonne; titre: string; precision: string }): Reprise {
  const { cle, source } = p;
  const table = delegue(prisma, source);
  const lot = (apresId: string | null | undefined, taille: number) =>
    table.findMany({
      where: apresId ? { id: { gt: apresId } } : {},
      select: SELECTION[source],
      orderBy: { id: "asc" },
      take: taille,
    });

  return {
    cle,
    titre: p.titre,
    description: `Chaque ligne de \`${source}\` devient une Personne (rôle « ${LIBELLE_ROLE[ROLE_DE_LA_SOURCE[source]]} ») ou rejoint celle `
      + `que l'ERP lui relie déjà. ${p.precision}`,

    async apercu() {
      const b = bilanVide();
      const creeesABlanc = new Set<string>();
      for (let apres: string | null = null; ;) {
        const lignes = await lot(apres, PAGE_APERCU);
        for (const r of lignes) {
          b.lues++;
          try {
            compter(b, await rattacherLigne(prisma, lireLigne(source, r as never), { aBlanc: true, creeesABlanc }));
          } catch (e) {
            noterErreur(b, `${source}:${String(r.id)} — ${(e as Error).message}`);
          }
        }
        if (lignes.length < PAGE_APERCU) break;
        apres = String(lignes[lignes.length - 1].id);
      }
      return b;
    },

    async executer({ taille, apresId }) {
      const b = bilanVide();
      const lignes = await lot(apresId, taille);
      for (const r of lignes) {
        b.lues++;
        try {
          compter(b, await prisma.$transaction((tx) => rattacherLigne(tx, lireLigne(source, r as never))));
        } catch (e) {
          noterErreur(b, `${source}:${String(r.id)} — ${(e as Error).message}`);
        }
      }
      return { ...b, suite: lignes.length === taille ? String(lignes[lignes.length - 1].id) : null };
    },
  };
}
