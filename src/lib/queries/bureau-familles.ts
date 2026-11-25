import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/lib/rbac";
import { getRequestList } from "@/lib/queries/admin-requests";
import { faitsDesDemandes } from "@/lib/queries/demandes-tableau";
import { fichesDuBureau, voitBureauAdPro } from "@/lib/queries/reservations-fiches";
import { dossiersPromoAMonTour } from "@/lib/queries/promo-circuit";
import { statutAffiche } from "@/lib/secretariat/traitement";
import { chezQuiDeLaDemande } from "@/lib/secretariat/bureau";
import { periodeCourte } from "@/lib/secretariat/tableau-bureau";
import type { LigneBureau } from "@/lib/secretariat/ligne-bureau";
import {
  etatDemandeDePiece, etatDemandeSecretariat, etatDevisPriseEnCharge, etatFicheVoyage, etatMaterielPromo,
} from "@/lib/secretariat/etat-unifie";
import { NATURE_LIBELLE } from "@/lib/reservation-fiche/etat";
import { estDemandeBcAEtablir } from "@/modules/ad-pro/partage";
import { peutSaisirLesDevis } from "@/modules/ad-pro/api";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES FAMILLES DU BUREAU DU SECRÉTARIAT (Super Admin, 24/11/2026) — chacune lit SA source existante et la
 * traduit en `LigneBureau` ; rien n'est recalculé à côté (l'état par `etat-unifie.ts`, la visibilité des demandes par
 * `clauseDemandesSecretariatVisibles`, celle des fiches par `clauseFichesVisibles`). Assemblées par `lignesDuBureau` (`queries/bureau.ts`).
 *
 * « Un demandeur ordinaire ne voit que ses demandes » : ses demandes au secrétariat et les fiches de voyage qu'il a
 * envoyées. Le TRAVAIL de l'assistante (matériel promotionnel, devis de prise en charge) n'entre qu'au bureau de qui le
 * traite — l'assistante de direction et le Super Admin (`voitBureauAdPro`). Les postes agence et les BC de poste vivent sur
 * « Prospection d'agences », module à part (25/11/2026).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/** Les noms de personnes, en UNE requête. */
async function nomsDe(ids: readonly (string | null | undefined)[]): Promise<Map<string, string>> {
  const l = [...new Set(ids.filter((x): x is string => Boolean(x)))];
  if (l.length === 0) return new Map();
  return new Map((await prisma.user.findMany({ where: { id: { in: l } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
}

/** « Vous » quand la personne est celle qui regarde : la colonne « Chez qui » parle à elle. */
const pourMoi = (user: SessionUser & { name?: string }, nom: string | null | undefined) => (nom && nom === user.name ? "Vous" : nom ?? null);

/** Le type d'une demande du secrétariat, dit court (la colonne « Type »). */
const TYPE_DEMANDE: Record<string, string> = {
  TRAVEL: "Déplacement", MAIL: "Courrier", SIGNATURE: "Signature", PURCHASE: "Achat", QUOTE: "Devis", PAYMENT: "Paiement",
  GUEST_VISA: "Invité / visa", DRIVER: "Mission chauffeur", HR_SIMPLE: "Demande RH", OTHER: "Autre",
};

const champ = (fields: unknown, cle: string): string | null => {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) return null;
  const v = (fields as Record<string, unknown>)[cle];
  return typeof v === "string" && v.trim() ? v.trim() : null;
};

// ─────────────────────────── (a) Les demandes du secrétariat ───────────────────────────

/** Les demandes du secrétariat — la clause du bureau, INCHANGÉE (`clauseDemandesSecretariatVisibles`). */
export async function lignesDemandesSecretariat(user: SessionUser): Promise<LigneBureau[]> {
  const list = await getRequestList(user, {});
  const faits = await faitsDesDemandes(list.rows.map((r) => ({ id: r.id, fields: r.fields })));
  return list.rows.map((r) => {
    const statut = statutAffiche(r.status, r.blockedReason);
    const f = faits.get(r.id);
    const chez = chezQuiDeLaDemande({
      statut, responsable: r.assignedTo?.name ?? null, demandeur: r.requester?.name ?? null,
      validateurEnAttente: r.approvals[0]?.validator?.name ?? r.validator?.name ?? null,
      bc: f?.bc ?? null, devisARetenir: f?.devisARetenir ?? false,
    });
    const bcAEtablir = estDemandeBcAEtablir(r);
    const personne = chez?.personne ?? null;
    const chezQui = chez
      ? (chez.etape === "Assistante" && r.assignedToId === user.id) || (chez.etape === "Demandeur" && r.requesterId === user.id)
        ? "Vous"
        : `${chez.etape}${personne ? ` · ${pourMoi(user, personne)}` : ""}`
      : null;
    const dates = r.type === "TRAVEL"
      ? periodeCourte(champ(r.fields, "dateDepart"), champ(r.fields, "dateRetour"))
      : r.type === "PAYMENT" ? periodeCourte(champ(r.fields, "datePaiement"), null) : null;
    return {
      cle: `demande:${r.id}`, famille: "demande",
      type: bcAEtablir ? "Bon de commande" : TYPE_DEMANDE[r.type] ?? "Autre",
      objet: r.title, reference: r.reference, demandeur: r.requester?.name ?? null, dates,
      etat: etatDemandeSecretariat({ statut, bc: f?.bc ?? null, devisARetenir: f?.devisARetenir ?? false }),
      chezQui, echeance: iso(r.deadline), depuis: r.createdAt.toISOString(), href: `/demandes/${r.id}`,
      termineeLe: iso(r.completedAt ?? (statut === "CANCELLED" || statut === "DONE" ? r.updatedAt : null)),
      recherche: [r.department?.name, r.assignedTo?.name, champ(r.fields, "beneficiaire"), champ(r.fields, "destinataire"), champ(r.fields, "nom")].filter(Boolean).join(" "),
      cleMetier: bcAEtablir && r.linkedEntityType === "AD_PRO_ITEM" && r.linkedEntityId ? `poste:${r.linkedEntityId}:bc` : null,
    };
  });
}

// ─────────────────────────── (b) Les fiches billet / hôtel ───────────────────────────

/** Les fiches de voyage — `clauseFichesVisibles` : l'assistante et le Super Admin toutes, le demandeur les siennes. */
export async function lignesFichesVoyage(user: SessionUser): Promise<LigneBureau[]> {
  const { lignes } = await fichesDuBureau(user);
  return lignes.map((l) => {
    const etat = etatFicheVoyage(l.etat);
    const chezQui = etat === "A_PRENDRE" ? (voitBureauAdPro(user) ? "Vous" : "Assistante")
      : etat === "EN_COURS" ? pourMoi(user, l.priseParNom) ?? "Assistante"
        : etat === "CHEZ_LE_DEMANDEUR" ? `${l.demandeurId === user.id ? "Vous" : l.demandeur} · ${l.etat === "MANQUE_SIGNALE" ? "manque signalé" : "modifiée après l'envoi"}`
          : null;
    return {
      cle: `fiche-voyage:${l.demandeId}`, famille: "fiche-voyage", type: NATURE_LIBELLE[l.nature],
      objet: `${l.personne} — ${l.resume}`, reference: l.operation.ref, demandeur: l.demandeur,
      dates: l.dates === "à préciser" ? null : l.dates, etat, chezQui, echeance: null, depuis: l.envoyeeLe,
      href: `/demandes/fiches/${l.demandeId}`, termineeLe: l.closeLe,
      recherche: [l.personne, l.poste, l.reference, l.priseParNom].filter(Boolean).join(" "),
    };
  });
}

// ─────────────────────────── (d) Le BC d'un poste (demande de pièce) ───────────────────────────

/**
 * LES BC DE POSTE QUE L'ASSISTANTE DOIT DÉPOSER (§118.204) — à établir, ou refusés et à redéposer. Ce n'est plus une famille
 * du bureau (Super Admin, 25/11/2026) : ils se lisent dans « Vos autres tâches » de « Prospection d'agences », sous la même
 * forme de ligne.
 */
export async function lignesBcDePoste(user: SessionUser): Promise<LigneBureau[]> {
  if (!voitBureauAdPro(user)) return [];
  const toutes = user.role === "SUPER_ADMIN";
  const pieces = await prisma.documentRequest.findMany({
    where: { entityType: "AD_PRO_ITEM", kind: "PURCHASE_ORDER", status: { in: ["PENDING", "DECLINED"] }, ...(toutes ? {} : { askedToId: user.id }) },
    select: {
      id: true, reference: true, label: true, entityId: true, createdAt: true, dueDate: true, status: true,
      askedBy: { select: { name: true } }, askedTo: { select: { name: true } },
    },
    orderBy: { createdAt: "asc" }, take: 300,
  });
  const postes = pieces.length
    ? new Map((await prisma.adProItem.findMany({ where: { id: { in: [...new Set(pieces.map((p) => p.entityId))] } }, select: { id: true, label: true } })).map((p) => [p.id, p.label]))
    : new Map<string, string>();
  return pieces.map((p) => {
    const etat = etatDemandeDePiece(String(p.status));
    const chezQui = `${pourMoi(user, p.askedTo.name)}${p.status === "DECLINED" ? " · à redéposer" : ""}`;
    return {
      cle: `bc-poste:${p.id}`, famille: "bc-poste", type: "Bon de commande",
      objet: postes.get(p.entityId) ? `${p.label} — ${postes.get(p.entityId)}` : p.label, reference: p.reference,
      demandeur: p.askedBy.name, dates: null, etat, chezQui, echeance: iso(p.dueDate), depuis: p.createdAt.toISOString(),
      href: `/pieces/${p.id}`, recherche: p.askedTo.name, cleMetier: `poste:${p.entityId}:bc`,
    };
  });
}

// ─────────────────────────── (e) Le matériel promotionnel à retranscrire ───────────────────────────

/** Les dossiers de matériel promotionnel dont c'est le tour de l'assistante de retranscrire les devis (circuit 2). */
export async function lignesMaterielPromo(user: SessionUser): Promise<LigneBureau[]> {
  if (!voitBureauAdPro(user)) return [];
  const aMoi = (await dossiersPromoAMonTour(user)).filter((d) => d.tour === "GESTE" && d.etat === "QUOTE_REQUESTED");
  if (aMoi.length === 0) return [];
  const lus = new Map((await prisma.promoMaterial.findMany({
    where: { id: { in: aMoi.map((d) => d.id) } }, select: { id: true, createdAt: true, updatedAt: true, requesterId: true },
  })).map((p) => [p.id, p]));
  const noms = await nomsDe([...lus.values()].map((p) => p.requesterId));
  return aMoi.map((d) => {
    const p = lus.get(d.id);
    return {
      cle: `promo:${d.id}`, famille: "promo", type: "Matériel promotionnel", objet: d.title, reference: d.reference,
      demandeur: (p?.requesterId ? noms.get(p.requesterId) : null) ?? null, dates: null, etat: etatMaterielPromo(d.etat), chezQui: "Vous · devis à retranscrire",
      echeance: null, depuis: (p?.updatedAt ?? p?.createdAt ?? new Date()).toISOString(), href: `/promo-material/${d.id}`,
    };
  });
}

// ─────────────────────────── (f) Les devis de prise en charge ───────────────────────────

type PerimetreDevis = "NATIONAL" | "INTERNATIONAL";
const CHEMIN_PRISE_EN_CHARGE: Record<PerimetreDevis, string> = { NATIONAL: "/congress-national", INTERNATIONAL: "/congress-international" };

/**
 * LES PRISES EN CHARGE DONT ON LUI A DEMANDÉ LES DEVIS et où des éléments attendent encore un chiffre — une ligne par
 * prise en charge, qui ouvre sa page « Devis » ; seulement celles que cette page lui ouvre (`peutSaisirLesDevis`).
 */
export async function lignesDevisPriseEnCharge(user: SessionUser): Promise<LigneBureau[]> {
  if (!voitBureauAdPro(user)) return [];
  const sujet = { careReservationDossierId: { not: null }, requestStatus: { notIn: ["REJECTED" as const, "CANCELLED" as const] } };
  const cases = await prisma.careCell.findMany({
    where: { kind: "SERVICE", status: "REQUESTED", beneficiary: { status: "APPROVED", OR: [{ congressNational: sujet }, { congressInternational: sujet }] } },
    select: {
      beneficiary: {
        select: {
          congressNational: { select: { id: true, name: true, careReservationDossierId: true, requesterId: true } },
          congressInternational: { select: { id: true, name: true, careReservationDossierId: true, requesterId: true } },
        },
      },
    },
    take: 1000,
  });
  const demandes = new Map<string, { scope: PerimetreDevis; id: string; nom: string; demandeurId: string | null; sujetId: string | null; n: number }>();
  for (const c of cases) {
    const nat = c.beneficiary.congressNational;
    const d = nat ?? c.beneficiary.congressInternational;
    if (!d) continue;
    const scope: PerimetreDevis = nat ? "NATIONAL" : "INTERNATIONAL";
    const cle = `${scope}:${d.id}`;
    const x = demandes.get(cle) ?? { scope, id: d.id, nom: d.name, demandeurId: d.requesterId, sujetId: d.careReservationDossierId, n: 0 };
    x.n += 1;
    demandes.set(cle, x);
  }
  if (demandes.size === 0) return [];
  // Depuis la demande des devis : le sujet de l'assistante s'ouvre à ce moment-là (`requestCareQuotes`).
  const sujets = [...new Set([...demandes.values()].map((d) => d.sujetId).filter((x): x is string => Boolean(x)))];
  const noms = await nomsDe([...demandes.values()].map((d) => d.demandeurId));
  const ouvertLe = new Map((await prisma.dossier.findMany({ where: { id: { in: sujets } }, select: { id: true, createdAt: true } })).map((s) => [s.id, s.createdAt.toISOString()]));
  // La porte de la page « Devis » elle-même — lue ENSEMBLE pour toutes les prises en charge, pas l'une après l'autre.
  const liste = [...demandes.values()];
  const ouvertes = await Promise.all(liste.map((d) => peutSaisirLesDevis(user, d.scope, d.id)));
  return liste.filter((_, i) => ouvertes[i]).map((d) => ({
    cle: `devis-pec:${d.scope}:${d.id}`, famille: "devis-pec", type: "Devis de prise en charge", objet: d.nom, reference: null,
    demandeur: (d.demandeurId ? noms.get(d.demandeurId) : null) ?? null, dates: null, etat: etatDevisPriseEnCharge(d.n),
    chezQui: `Vous · ${d.n} élément${d.n > 1 ? "s" : ""} à chiffrer`, echeance: null,
    depuis: (d.sujetId ? ouvertLe.get(d.sujetId) : null) ?? new Date().toISOString(), href: `${CHEMIN_PRISE_EN_CHARGE[d.scope]}/${d.id}/devis`,
    recherche: d.scope === "NATIONAL" ? "prise en charge nationale" : "prise en charge internationale",
  }));
}
