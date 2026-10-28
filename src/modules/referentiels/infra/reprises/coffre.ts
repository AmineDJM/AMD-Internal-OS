import { prisma } from "@/lib/prisma";
import { MODELES_SENSIBLES, type ModeleSensible } from "@/modules/coffre/partage";
import { chargerCles, ErreurCleCoffre, copierAuCoffre, type ResultatCopie } from "@/modules/coffre/api";
import type { RefTitulaire } from "@/modules/coffre/partage";
import { bilanVide, type BilanReprise, type Reprise } from "../../domaine/reprises/types";

/**
 * REPRISE « COFFRE » (refonte V2-E) — copie au coffre les colonnes sensibles en clair : RIB / IBAN, NIN et
 * salaires des salariés, RIB des partenaires de l'annuaire (fournisseurs compris), RIB et IBAN des sociétés.
 *
 * Même règle que la double écriture (`coffre/copies.ts`) : rejouée, elle ne recrée rien ; rejouée après les
 * reprises Personnes / Organisations (V2-B / V2-C), elle RATTACHE chaque copie à sa fiche (`liees`) ; une
 * colonne changée pendant que l'écriture double était fermée est recopiée, l'ancienne copie datée.
 * Les colonnes en clair ne sont pas touchées (P5 = accord de la Direction).
 *
 * Le curseur parcourt les trois tables dans l'ordre : `Employee:<id>` → `CompanyContact:<id>` → …
 */

export const SEPARATEUR = ":";

export function lireCurseur(apresId: string | null | undefined): { modele: ModeleSensible; apres: string | null } | null {
  if (!apresId) return { modele: MODELES_SENSIBLES[0], apres: null };
  const i = apresId.indexOf(SEPARATEUR);
  const modele = MODELES_SENSIBLES.find((m) => m === apresId.slice(0, i));
  if (i < 0 || !modele) return null;
  return { modele, apres: apresId.slice(i + 1) || null };
}

const modeleSuivant = (m: ModeleSensible): ModeleSensible | null => MODELES_SENSIBLES[MODELES_SENSIBLES.indexOf(m) + 1] ?? null;

/** Ajoute au bilan les issues d'une ligne source. Les erreurs nomment la colonne, jamais la valeur. */
export function compterIssues(bilan: BilanReprise, modele: ModeleSensible, id: string, resultats: ResultatCopie[]): void {
  bilan.lues++;
  for (const r of resultats) {
    if (r.issue === "CREEE" || r.issue === "REMPLACEE") bilan.creees++;
    else if (r.issue === "LIEE") bilan.liees++;
    else if (r.issue === "IGNOREE") {
      bilan.ignorees++;
      bilan.erreurs.push(`${modele} ${id} · ${r.champ} : ${r.raison ?? "valeur refusée"} (laissée en clair, à corriger sur la fiche).`);
    }
  }
}

interface LigneSource { id: string; valeurs: Record<string, unknown>; titulaire: RefTitulaire | null }

async function lireLot(modele: ModeleSensible, apres: string | null, taille: number | undefined, seulement?: readonly string[]): Promise<LigneSource[]> {
  const where = { ...(apres ? { id: { gt: apres } } : {}), ...(seulement ? { id: { in: [...seulement], ...(apres ? { gt: apres } : {}) } } : {}) };
  const page = { where, orderBy: { id: "asc" as const }, ...(taille ? { take: taille } : {}) };
  if (modele === "Employee") {
    const rows = await prisma.employee.findMany({ ...page, select: { id: true, personneId: true, iban: true, nationalId: true, baseSalary: true, grossSalary: true, netToPay: true, employerCost: true } });
    return rows.map(({ id, personneId, ...valeurs }) => ({ id, valeurs, titulaire: personneId ? { genre: "PERSONNE", personneId } : null }));
  }
  if (modele === "CompanyContact") {
    const rows = await prisma.companyContact.findMany({ ...page, select: { id: true, organisationId: true, rib: true } });
    return rows.map(({ id, organisationId, ...valeurs }) => ({ id, valeurs, titulaire: organisationId ? { genre: "ORGANISATION", organisationId } : null }));
  }
  const rows = await prisma.companyLegalIdentity.findMany({ ...page, select: { id: true, rib: true, iban: true, company: { select: { organisationId: true } } } });
  return rows.map(({ id, company, ...valeurs }) => ({ id, valeurs, titulaire: company.organisationId ? { genre: "ORGANISATION", organisationId: company.organisationId } : null }));
}

async function traiter(modele: ModeleSensible, lignes: LigneSource[], bilan: BilanReprise, aBlanc: boolean): Promise<void> {
  for (const l of lignes) {
    try {
      const resultats = aBlanc
        ? await copierAuCoffre(prisma, { modele, origineId: l.id, valeurs: l.valeurs, titulaire: l.titulaire, parId: null }, { aBlanc: true })
        : await prisma.$transaction((tx) => copierAuCoffre(tx, { modele, origineId: l.id, valeurs: l.valeurs, titulaire: l.titulaire, parId: null }));
      compterIssues(bilan, modele, l.id, resultats);
    } catch (err) {
      bilan.lues++;
      bilan.erreurs.push(`${modele} ${l.id} : échec (${err instanceof Error ? err.name : "erreur"}) — rejouer le lot.`);
    }
  }
}

/** La clé du coffre se charge-t-elle ? Sans elle, rien n'est copié et le bilan le dit. */
function cleManquante(): string | null {
  try { chargerCles(); return null; } catch (e) { if (e instanceof ErreurCleCoffre) return e.message; throw e; }
}

/**
 * La reprise, éventuellement restreinte à quelques lignes source (`seulement` : les bancs, sur une base
 * partagée). L'écran utilise `repriseCoffre`, sans restriction.
 */
export function creerRepriseCoffre(seulement?: readonly string[]): Reprise {
  return {
    cle: "coffre",
    titre: "Coffre des données sensibles",
    description:
      "Copie chiffrée au coffre des RIB / IBAN, NIN et salaires des salariés, des RIB des partenaires (fournisseurs) et des RIB / IBAN des sociétés. Les colonnes en clair restent. Rejouable : rattache les copies aux fiches Personne / Organisation dès qu'elles existent.",

    async apercu() {
      const bilan = bilanVide();
      const cle = cleManquante();
      if (cle) return { ...bilan, erreurs: [cle] };
      for (const m of MODELES_SENSIBLES) await traiter(m, await lireLot(m, null, undefined, seulement), bilan, true);
      return bilan;
    },

    async executer({ taille, apresId }) {
      const bilan = bilanVide();
      const cle = cleManquante();
      if (cle) return { ...bilan, erreurs: [cle], suite: apresId ?? null };
      const curseur = lireCurseur(apresId);
      if (!curseur) return { ...bilan, erreurs: [`Curseur de reprise illisible : « ${apresId} ».`], suite: null };
      const n = Math.max(1, Math.min(500, Math.floor(taille)));
      const lignes = await lireLot(curseur.modele, curseur.apres, n, seulement);
      await traiter(curseur.modele, lignes, bilan, false);
      if (lignes.length === n) return { ...bilan, suite: `${curseur.modele}${SEPARATEUR}${lignes[lignes.length - 1].id}` };
      const suivant = modeleSuivant(curseur.modele);
      return { ...bilan, suite: suivant ? `${suivant}${SEPARATEUR}` : null };
    },
  };
}

export const repriseCoffre: Reprise = creerRepriseCoffre();
