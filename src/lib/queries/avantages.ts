import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { companyLabel, getMyCompanies } from "@/lib/company";
import { sansBloquer } from "@/lib/journal";
import { lienRapportTerrain } from "@/lib/chemins/rapports-terrain";
import { lettresDesPraticiens } from "@/lib/segmentation/lettres-service";
import { choisirEntree } from "@/lib/segmentation/lettre-requise";
import { avantagesAdPro } from "@/modules/ad-pro/api";
import {
  agregerRegistre, anneeDeLAvantage, cleDuProfessionnel, concentrationDesAvantages, ficheDuProfessionnel, filtrerAvantages, resoudreFusions, CLE_NON_RATTACHES,
  LIBELLE_NON_RATTACHES, type Avantage, type ConcentrationAvantages, type FicheAvantages, type FiltresAvantages, type ProfessionnelAvantages, type RegistreAvantages,
} from "@/modules/ad-pro/partage";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE REGISTRE DES AVANTAGES AUX PROFESSIONNELS DE SANTÉ — la lecture (Super Admin SEUL, décision du 24/11/2026).
 *
 * La garde est ICI, côté serveur, et elle tient au RÔLE : aucune clé de console, aucun droit de module ne l'ouvre à la
 * Direction ou au Directeur général. Les sources : l'Ad & Pro par sa porte (`avantagesAdPro`), le matériel promotionnel remis
 * nominativement en visite (registre du stock, valeur au coût du lot). Les sociétés sont celles du lecteur
 * (`getMyCompanies`) ; les fiches fusionnées remontent à leur survivante. Les règles : `src/modules/ad-pro/domaine/avantages.ts`.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const peutLireRegistreAvantages = (user: { role: string }): boolean => user.role === "SUPER_ADMIN";

export interface FicheVue {
  cle: string;
  nom: string;
  specialite: string | null;
  etablissement: string | null;
  wilaya: string | null;
  lettre: string | null;
  fiche: FicheAvantages;
}

export interface VueRegistreAvantages {
  filtres: FiltresAvantages;
  annees: number[];
  societes: { id: string; nom: string }[];
  specialites: string[];
  wilayas: string[];
  registre: RegistreAvantages;
  concentration: ConcentrationAvantages;
  fiche: FicheVue | null;
}

const n = (d: Prisma.Decimal | null | undefined) => (d == null ? 0 : Number(d));

/** Le matériel promotionnel remis à un médecin désigné (remises de visite non contre-passées), au coût de son lot. */
async function avantagesMaterielRemis(): Promise<Avantage[]> {
  const remises = await prisma.promoStockMovement.findMany({
    where: { kind: "DISTRIBUTION", doctorId: { not: null }, annulation: { is: null } },
    select: {
      id: true, delta: true, occurredAt: true, doctorId: true, createdById: true, fieldReportId: true,
      item: { select: { name: true, unit: true, companyId: true } }, lot: { select: { coutUnitaire: true } },
    },
  });
  const userIds = [...new Set(remises.map((r) => r.createdById).filter((x): x is string => Boolean(x)))];
  const users = userIds.length ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }) : [];
  const nomDe = new Map(users.map((u) => [u.id, u.name]));
  return remises.map((r) => {
    const quantite = Math.abs(n(r.delta));
    const valeur = r.lot.coutUnitaire == null ? null : Math.round(quantite * n(r.lot.coutUnitaire) * 100) / 100;
    return {
      id: `promo:${r.id}`, doctorId: r.doctorId, nomLibre: null, date: r.occurredAt.toISOString(), nature: "MATERIEL_PROMO" as const,
      objet: `${quantite.toLocaleString("fr-FR")} ${r.item.unit ?? "×"} ${r.item.name}`.replace(/\s+/g, " "),
      // Le matériel remis est sorti d'un stock déjà acheté : ce qui est remis est payé.
      engageDzd: valeur, payeDzd: valeur,
      societeId: r.item.companyId, demandeur: r.createdById ? nomDe.get(r.createdById) ?? null : null,
      reference: null, href: r.fieldReportId ? lienRapportTerrain(r.fieldReportId) : null,
      note: valeur == null ? "Coût du lot non renseigné" : null,
    };
  });
}

/** Les fiches fusionnées (décision FUSIONNEE) : absorbée → gardée. */
async function fusions(): Promise<(doctorId: string) => string> {
  const d = await prisma.decisionFusionMedecin.findMany({ where: { decision: "FUSIONNEE", gardeId: { not: null } }, select: { medecinAId: true, medecinBId: true, gardeId: true } });
  return resoudreFusions(d.map((x) => ({ gardeId: x.gardeId!, absorbeeId: x.medecinAId === x.gardeId ? x.medecinBId : x.medecinAId })));
}

async function professionnels(ids: readonly string[]): Promise<Map<string, ProfessionnelAvantages>> {
  if (ids.length === 0) return new Map();
  const [docs, entrees] = await Promise.all([
    prisma.medicalDoctor.findMany({
      where: { id: { in: [...ids] } },
      select: { id: true, name: true, specialty: true, institution: true, wilaya: true, specialtyRef: { select: { name: true } }, institutionRef: { select: { name: true } } },
    }),
    // La lettre est celle de la Segmentation, la même partout ; sans elle, le registre reste lisible.
    lettresDesPraticiens(ids).catch(sansBloquer("avantages.lettresDesPraticiens", new Map())),
  ]);
  return new Map(docs.map((d) => [d.id, {
    doctorId: d.id, nom: d.name,
    specialite: d.specialtyRef?.name ?? d.specialty ?? null,
    etablissement: d.institutionRef?.name ?? d.institution ?? null,
    wilaya: d.wilaya?.trim() || null,
    lettre: choisirEntree(entrees.get(d.id), null)?.lettre ?? null,
  }]));
}

/**
 * LE REGISTRE pour ces filtres (et la fiche d'un professionnel si `pro` est donné : sa clé, ou `non-rattaches`). `null` pour
 * tout autre rôle que le Super Admin — rien n'est lu.
 */
export async function registreAvantages(
  user: { id: string; role: string },
  filtres: FiltresAvantages,
  pro?: string | null,
): Promise<VueRegistreAvantages | null> {
  if (!peutLireRegistreAvantages(user)) return null;
  const [societesLues, adPro, promo, versGardee] = await Promise.all([getMyCompanies(user.id), avantagesAdPro(), avantagesMaterielRemis(), fusions()]);

  // LE CLOISONNEMENT : seules les sociétés du lecteur (un avantage sans société reste visible, comme partout ailleurs).
  const permises = new Set(societesLues.map((s) => s.id));
  const tous = [...adPro, ...promo]
    .filter((a) => a.societeId == null || permises.has(a.societeId))
    .map((a) => (a.doctorId ? { ...a, doctorId: versGardee(a.doctorId) } : a));
  const pros = await professionnels([...new Set(tous.map((a) => a.doctorId).filter((x): x is string => Boolean(x)))]);

  const dansLaSociete = filtres.societeId ? tous.filter((a) => a.societeId === filtres.societeId) : tous;
  const retenus = filtrerAvantages(tous, filtres, pros);
  const registre = agregerRegistre(retenus, pros);

  let fiche: FicheVue | null = null;
  if (pro) {
    const siens = dansLaSociete.filter((a) => cleDuProfessionnel(a) === pro);
    const p = pro === CLE_NON_RATTACHES ? null : pros.get(pro) ?? null;
    if (siens.length > 0 || p) {
      fiche = {
        cle: pro, nom: pro === CLE_NON_RATTACHES ? LIBELLE_NON_RATTACHES : p?.nom ?? "Fiche introuvable",
        specialite: p?.specialite ?? null, etablissement: p?.etablissement ?? null, wilaya: p?.wilaya ?? null, lettre: p?.lettre ?? null,
        fiche: ficheDuProfessionnel(siens),
      };
    }
  }

  const presents = [...new Set(dansLaSociete.map((a) => a.doctorId).filter((x): x is string => Boolean(x)))].map((id) => pros.get(id)).filter((p): p is ProfessionnelAvantages => Boolean(p));
  const trier = (xs: (string | null)[]) => [...new Set(xs.filter((x): x is string => Boolean(x)))].sort((a, b) => a.localeCompare(b, "fr"));
  return {
    filtres,
    annees: [...new Set(tous.map((a) => anneeDeLAvantage(a.date)))].sort((a, b) => b - a),
    societes: societesLues.map((s) => ({ id: s.id, nom: companyLabel(s) })),
    specialites: trier(presents.map((p) => p.specialite)),
    wilayas: trier(presents.map((p) => p.wilaya)),
    registre,
    concentration: concentrationDesAvantages(registre),
    fiche,
  };
}
