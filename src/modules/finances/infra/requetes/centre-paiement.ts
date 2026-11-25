import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ficheScopedWhere, getMyCompanies, myCompanyScope, companyLabel } from "@/lib/company";
import { toNumber } from "@/lib/utils";
import type { SessionUser } from "@/lib/rbac";
import { awaitsCentre, awaitsRequester, HORS_DU_CENTRE, sitsOnPaymentCentre, ORDRE_NON_ANNULE, type CentralStatus } from "../../domaine/authorization";
import { ENTITE_SANS, choisirEntite } from "../../domaine/entite-centre";

/**
 * LE CHARGEUR DU CENTRE DE PAIEMENT — les entités en haut, UNE file dessous.
 *
 * ── CE QUE CE MODULE DÉCIDE, ET CE QU'IL NE DÉCIDE PAS ──────────────────────────────────────
 *
 * Il ne décide RIEN du droit : les ordres lus sont ceux du centre, pour qui y siège — et RIEN pour qui n'y siège pas, pas
 * même ses propres demandes (25/11/2026 : le demandeur suit les siennes depuis « Mes demandes de paiement » ; la page l'y
 * renvoie, le chargeur ne lui rend rien au cas où un autre lecteur l'appellerait) — dans les sociétés auxquelles la personne a droit
 * (`ficheScopedWhere`), les ordres sans société compris (§118.154 : une ligne sans entité n'est le
 * secret de personne, et la cacher la rendrait impossible à rattacher). Il ne fait que REGROUPER
 * par entité : toutes les origines (Regulatory, Ad & Pro, RH…) partagent la même file (Super
 * Admin, 24/11/2026), dans l'ordre de toujours — du plus récent au plus ancien.
 *
 * `ficheScopedWhere` et non `companyScopedWhere` : la liste suivait avant le sélecteur de la barre
 * supérieure ; l'entité se choisit maintenant DANS la page, parmi toutes celles que la personne a
 * le droit de voir. Le cookie n'est lu que comme une PRÉFÉRENCE de départ, et VALIDÉE
 * (`myCompanyScope`) — jamais l'identifiant brut d'un cookie qui se modifie à la main (§118.177).
 * Une valeur d'adresse qui ne désigne aucune pastille n'ouvre rien : elle retombe sur le défaut.
 *
 * Les comptes par entité sont EXACTS : ils se calculent sur toutes les lignes (colonnes légères),
 * pas sur les trois cents que l'écran affiche. Une coupe qui se lit comme un compte est un
 * mensonge (§118.60) — l'écran dit combien de lignes plus anciennes il ne montre pas.
 */

export const LIMITE_LIGNES_CENTRE = 300;

export interface EntiteDuCentre {
  /** Identifiant de la société, ou `ENTITE_SANS`. */
  cle: string;
  label: string;
  /** Ordres qui attendent une décision du centre. */
  enAttente: number;
  montantEnAttente: number;
  total: number;
}

export interface CentreCharge {
  canDecide: boolean;
  /** Rien à montrer ET aucun droit de siège : l'écran dit la règle. */
  aucunOrdre: boolean;
  entites: EntiteDuCentre[];
  entiteChoisie: string | null;
  /** Les compteurs de l'entité choisie. */
  bilan: { enAttente: number; montantEnAttente: number; autorises: number; refuses: number };
  /** Les identifiants à afficher, du plus récent au plus ancien — au plus `LIMITE_LIGNES_CENTRE`. */
  idsAffiches: string[];
  /** Combien de lignes de l'entité l'écran ne montre PAS (les plus anciennes). */
  nonAffiches: number;
  /** K7 (décision 0037) — pour l'EXPORT : toutes les lignes de l'entité choisie (sans la coupe d'affichage). */
  idsEntite: string[];
  /**
   * LA FILE « À DÉCIDER » (maquette du 24/11/2026) : les seuls ordres EN COURS — les décidés en sortent. Toute
   * l'entité, sans coupe : une file d'attente coupée cacherait un paiement à décider.
   */
  idsEnAttente: string[];
  /** L'HISTORIQUE (menu ⋯ « Déjà décidés ») : le reste de l'entité, au plus `LIMITE_LIGNES_CENTRE`. */
  idsDecides: string[];
}

interface Ligne {
  id: string;
  companyId: string | null;
  centralStatus: CentralStatus;
  amount: number;
}

const cleDeLEntite = (companyId: string | null): string => companyId ?? ENTITE_SANS;
/** EN COURS : le centre doit trancher, ou (dossier d'avant le 02/09/2026) le demandeur doit répondre. */
const enCours = (s: CentralStatus): boolean => awaitsCentre(s) || awaitsRequester(s);

export async function chargerCentre(
  user: SessionUser, demande: { entite?: string | null },
): Promise<CentreCharge> {
  const canDecide = sitsOnPaymentCentre(user);

  const base: Prisma.ExpenseOrderWhereInput = {
    AND: [
      // Ni l'historique d'avant le centre, ni l'ordre qui attend encore son justificatif (24/11/2026) : il n'y est pas entré.
      { centralStatus: { notIn: [...HORS_DU_CENTRE] } },
      // Une demande retirée annule son ordre : il quitte le centre — liste, compteurs, bilan (`ORDRE_NON_ANNULE`).
      ORDRE_NON_ANNULE,
      // Qui n'y siège pas ne lit AUCUN ordre du centre (25/11/2026) — `id: { in: [] }` : une clause qui ne rend rien.
      ...(canDecide ? [] : [{ id: { in: [] as string[] } }]),
    ],
  };
  const where = await ficheScopedWhere(user.id, base);
  const rows = await prisma.expenseOrder.findMany({
    where,
    orderBy: [{ createdAt: "desc" }],
    select: { id: true, companyId: true, centralStatus: true, amount: true },
  });
  const lignes: Ligne[] = rows.map((r) => ({ ...r, centralStatus: r.centralStatus as CentralStatus, amount: toNumber(r.amount) }));

  // ── Les pastilles : chaque société que la personne voit, même vide (changer d'entité se fait
  //    d'un clic, un compte à zéro est une information) ; « Sans entité » seulement s'il y a des lignes.
  const mesSocietes = await getMyCompanies(user.id);
  const connues = new Set(mesSocietes.map((c) => c.id));
  const inconnues = [...new Set(lignes.map((l) => l.companyId).filter((c): c is string => Boolean(c) && !connues.has(c as string)))];
  const horsListe = inconnues.length
    ? await prisma.company.findMany({ where: { id: { in: inconnues } }, select: { id: true, name: true, shortName: true } })
    : [];

  const entites = new Map<string, EntiteDuCentre>();
  for (const c of mesSocietes) entites.set(c.id, { cle: c.id, label: companyLabel(c), enAttente: 0, montantEnAttente: 0, total: 0 });
  // Une société désactivée porte encore des ordres : elle garde sa pastille, dite « (désactivée) ».
  for (const c of horsListe) entites.set(c.id, { cle: c.id, label: `${c.shortName || c.name} (désactivée)`, enAttente: 0, montantEnAttente: 0, total: 0 });
  if (lignes.some((l) => !l.companyId)) entites.set(ENTITE_SANS, { cle: ENTITE_SANS, label: "Sans entité", enAttente: 0, montantEnAttente: 0, total: 0 });
  for (const l of lignes) {
    const e = entites.get(cleDeLEntite(l.companyId));
    if (!e) continue;
    e.total += 1;
    if (awaitsCentre(l.centralStatus)) { e.enAttente += 1; e.montantEnAttente += l.amount; }
  }
  const liste = [...entites.values()];

  const preferee = await myCompanyScope(user.id);
  const entiteChoisie = choisirEntite(liste, demande.entite, preferee);

  // ── L'entité choisie : son bilan, ses lignes — toutes origines confondues, une seule file.
  const deLEntite = lignes.filter((l) => cleDeLEntite(l.companyId) === entiteChoisie);
  const bilan = { enAttente: 0, montantEnAttente: 0, autorises: 0, refuses: 0 };
  for (const l of deLEntite) {
    if (awaitsCentre(l.centralStatus)) { bilan.enAttente += 1; bilan.montantEnAttente += l.amount; }
    if (l.centralStatus === "APPROVED") bilan.autorises += 1;
    if (l.centralStatus === "REFUSED") bilan.refuses += 1;
  }

  return {
    canDecide,
    aucunOrdre: lignes.length === 0,
    entites: liste,
    entiteChoisie,
    bilan,
    idsAffiches: deLEntite.slice(0, LIMITE_LIGNES_CENTRE).map((l) => l.id),
    nonAffiches: Math.max(0, deLEntite.length - LIMITE_LIGNES_CENTRE),
    idsEntite: deLEntite.map((l) => l.id),
    idsEnAttente: deLEntite.filter((l) => enCours(l.centralStatus)).map((l) => l.id),
    idsDecides: deLEntite.filter((l) => !enCours(l.centralStatus)).slice(0, LIMITE_LIGNES_CENTRE).map((l) => l.id),
  };
}
