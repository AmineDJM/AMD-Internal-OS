import { prisma } from "@/lib/prisma";
import { hasRole, userCan, type SessionUser } from "@/lib/rbac";
import { ETATS_FICHES_A_TRAITER, travauxAdPro } from "@/lib/queries/reservations-fiches";
import { dossiersPromoAMonTour } from "@/lib/queries/promo-circuit";
import { libelleEtape } from "@/lib/promo-material/circuit";
import { sansBloquer } from "@/lib/journal";
import { peutSaisirLesDevis } from "@/modules/ad-pro/api";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * « VOS AUTRES TÂCHES » — ce que l'assistante de direction faisait AILLEURS dans Ad & Pro, sur sa page « Prospection d'agences »
 * (Direction, 23/11/2026 : « tout ce qu'elle faisait dans Ad & Pro dans UNE page »).
 *
 * Rien n'est recalculé : ce sont les files qui la nourrissent déjà — l'onglet « Ad & Pro » du bureau (`travauxAdPro` : BC de
 * poste à établir, devis à obtenir ; le compteur de ses fiches de voyage), le circuit du matériel promotionnel
 * (`dossiersPromoAMonTour`), et la page « Devis » des prises en charge (`peutSaisirLesDevis`, la porte de cette page). Chaque
 * ligne mène à UNE page qu'elle ouvre, avec UN geste ; la plus ancienne d'abord.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

interface AutreTache {
  cle: string;
  titre: string;
  detail: string;
  /** Le geste, dit sur le lien (« Établir le BC », « Saisir les devis »…). */
  geste: string;
  href: string;
  /** ISO — depuis quand ; `null` quand rien ne le date. */
  depuis: string | null;
}

export interface GroupeAutresTaches {
  cle: "BC" | "DEVIS" | "PROMO" | "VOYAGES";
  titre: string;
  lignes: AutreTache[];
}

/** La plus ancienne d'abord ; ce que rien ne date garde son rang, après. */
const parAnciennete = (a: AutreTache, b: AutreTache) => (a.depuis ?? "￿").localeCompare(b.depuis ?? "￿");

type PerimetreDevis = "NATIONAL" | "INTERNATIONAL";
const CHEMIN_PRISE_EN_CHARGE: Record<PerimetreDevis, string> = { NATIONAL: "/congress-national", INTERNATIONAL: "/congress-international" };

/** Les prises en charge dont on lui a demandé les devis et où des éléments attendent encore un devis. */
async function devisDePriseEnCharge(user: SessionUser): Promise<AutreTache[]> {
  const sujet = { careReservationDossierId: { not: null }, requestStatus: { notIn: ["REJECTED" as const, "CANCELLED" as const] } };
  const cases = await prisma.careCell.findMany({
    where: { kind: "SERVICE", status: "REQUESTED", beneficiary: { status: "APPROVED", OR: [{ congressNational: sujet }, { congressInternational: sujet }] } },
    select: {
      beneficiary: {
        select: {
          congressNational: { select: { id: true, name: true, careReservationDossierId: true } },
          congressInternational: { select: { id: true, name: true, careReservationDossierId: true } },
        },
      },
    },
    take: 1000,
  });
  const demandes = new Map<string, { scope: PerimetreDevis; id: string; nom: string; sujetId: string | null; n: number }>();
  for (const c of cases) {
    const nat = c.beneficiary.congressNational;
    const d = nat ?? c.beneficiary.congressInternational;
    if (!d) continue;
    const scope: PerimetreDevis = nat ? "NATIONAL" : "INTERNATIONAL";
    const cle = `${scope}:${d.id}`;
    const x = demandes.get(cle) ?? { scope, id: d.id, nom: d.name, sujetId: d.careReservationDossierId, n: 0 };
    x.n += 1;
    demandes.set(cle, x);
  }
  if (demandes.size === 0) return [];
  // Depuis la demande des devis : le sujet de l'assistante s'ouvre à ce moment-là (`requestCareQuotes`).
  const sujets = [...new Set([...demandes.values()].map((d) => d.sujetId).filter((x): x is string => Boolean(x)))];
  const ouvertLe = new Map((await prisma.dossier.findMany({ where: { id: { in: sujets } }, select: { id: true, createdAt: true } })).map((s) => [s.id, s.createdAt.toISOString()]));
  const out: AutreTache[] = [];
  for (const d of demandes.values()) {
    // La porte de la page « Devis » elle-même : une ligne qui mène à une page refusée n'est pas un geste.
    if (!(await peutSaisirLesDevis(user, d.scope, d.id))) continue;
    out.push({
      cle: `pec-${d.id}`, titre: d.nom,
      detail: `Prise en charge ${d.scope === "NATIONAL" ? "nationale" : "internationale"} · ${d.n} élément${d.n > 1 ? "s" : ""} à chiffrer`,
      geste: "Saisir les devis", href: `${CHEMIN_PRISE_EN_CHARGE[d.scope]}/${d.id}/devis`,
      depuis: d.sujetId ? ouvertLe.get(d.sujetId) ?? null : null,
    });
  }
  return out;
}

/** Les fiches de voyage (billets, hôtels) qui attendent le bureau — UNE ligne : le bureau les range, groupées par opération. */
async function fichesDeVoyage(): Promise<AutreTache[]> {
  const where = { etat: { in: ETATS_FICHES_A_TRAITER } };
  const [n, plusAncienne] = await Promise.all([
    prisma.demandeReservation.count({ where }),
    prisma.demandeReservation.findFirst({ where, orderBy: { envoyeeLe: "asc" }, select: { envoyeeLe: true } }),
  ]);
  if (n === 0) return [];
  return [{
    cle: "fiches", titre: `${n} fiche${n > 1 ? "s" : ""} de voyage à traiter`, detail: "Billets et hôtels envoyés par les demandeurs",
    geste: "Ouvrir les fiches", href: "/demandes?onglet=adpro", depuis: plusAncienne?.envoyeeLe.toISOString() ?? null,
  }];
}

/**
 * LES AUTRES TÂCHES DE L'ASSISTANTE, par famille — `[]` pour toute autre personne (sa page à elle seule). Une source qui échoue
 * n'éteint pas les autres : la page dit ce qu'elle sait.
 */
export async function autresTachesAssistante(user: SessionUser): Promise<GroupeAutresTaches[]> {
  if (!hasRole(user, "DIRECTION_ASSISTANT")) return [];
  // Le bureau du secrétariat (`/demandes`) est SON module : sans lui, ses lignes ne s'ouvriraient pas.
  const bureau = userCan(user, "ADMIN_REQUESTS", "VIEW");
  const [travaux, promo, priseEnCharge, voyages] = await Promise.all([
    travauxAdPro(user).catch(sansBloquer("ad-pro.autresTachesAssistante.travauxAdPro", [])),
    dossiersPromoAMonTour(user).catch(sansBloquer("ad-pro.autresTachesAssistante.dossiersPromoAMonTour", [])),
    devisDePriseEnCharge(user).catch(sansBloquer("ad-pro.autresTachesAssistante.devisDePriseEnCharge", [])),
    bureau ? fichesDeVoyage().catch(sansBloquer("ad-pro.autresTachesAssistante.fichesDeVoyage", [])) : Promise.resolve([]),
  ]);
  // Le matériel promotionnel se lit sur son circuit (toutes ses étapes, pas seulement la retranscription) : le bureau n'en garde rien.
  const ouvrables = travaux.filter((t) => !t.href.startsWith("/promo-material/") && (bureau || !t.href.startsWith("/demandes")));
  const ligne = (t: (typeof travaux)[number]): AutreTache => ({
    cle: `${t.type}-${t.id}`, titre: t.titre, detail: t.sousTitre, href: t.href, depuis: t.le,
    geste: t.type === "BC" ? (t.statut === "à redéposer" ? "Redéposer le BC" : "Établir le BC") : "Obtenir les devis",
  });
  const groupes: GroupeAutresTaches[] = [
    { cle: "BC", titre: "Bons de commande à établir", lignes: ouvrables.filter((t) => t.type === "BC").map(ligne).sort(parAnciennete) },
    { cle: "DEVIS", titre: "Devis à obtenir", lignes: [...ouvrables.filter((t) => t.type === "DEVIS").map(ligne), ...priseEnCharge].sort(parAnciennete) },
    {
      cle: "PROMO", titre: "Matériel promotionnel",
      lignes: promo.map((d) => ({
        cle: `pm-${d.id}`, titre: d.title, detail: `${d.reference} · ${libelleEtape(d.etat, d.version)}`,
        geste: "Ouvrir le dossier", href: `/promo-material/${d.id}`, depuis: null,
      })),
    },
    { cle: "VOYAGES", titre: "Billets et hôtels", lignes: voyages },
  ];
  return groupes.filter((g) => g.lignes.length > 0);
}
