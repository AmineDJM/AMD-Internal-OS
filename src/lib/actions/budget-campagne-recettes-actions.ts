"use server";

import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import { requireUser, type CurrentUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { toNumber } from "@/lib/utils";
import { fdStr, fdNum, fdCase, type ActionResult } from "@/lib/actions/types";
import { CHEMIN_CAMPAGNE_BUDGETAIRE } from "@/lib/chemins/budget-campagne";
import { annulable } from "@/lib/effets/ecran";
import { contexteRecettes, catalogueRecettes, calculerPrevisionsCampagne, type ContexteRecettes } from "@/lib/budget-campagne/recettes-requetes";
import {
  MOIS_COURTS, calculerMontantRecette, cleRapprochementRecette, normaliserClient, repartirSurDouzeMois, verdictSaisieRecettes,
  type SourcePrix,
} from "@/lib/budget-campagne/recettes";
import {
  LIBELLE_IMPOT, MOIS_EXERCICE_SUIVANT, TAUX_TVA_PCT, estCleImpot, lireCalendrierTexte, lireParametresImpots,
  verifierCalendrierIbs, type NatureTva, type ParametresImpots,
} from "@/lib/budget-campagne/impots";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA CAMPAGNE BUDGÉTAIRE — LES RECETTES ET LE VOLET « IMPÔTS & TAXES » (Super Admin, 24/11/2026).
 *
 * Seuls le Super Admin et la Direction générale écrivent ici (`verdictSaisieRecettes`) — la règle est tenue par le
 * serveur, pas par l'écran : un directeur qui appellerait ces actions est refusé avec le remède. Les directions
 * saisissent leurs dépenses dans leur pôle (`budget-campagne-actions.ts`), comme avant. Une campagne close a figé ses
 * recettes et ses impôts prévus : ils sont la référence de l'exercice.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const MODULE_AUDIT = "Campagne budgétaire";
const revalider = () => revalidatePath(CHEMIN_CAMPAGNE_BUDGETAIRE);
const fmt = (n: number) => `${n.toLocaleString("fr-FR", { maximumFractionDigits: 2 })} DZD`;

type Garde = { ok: true; ctx: ContexteRecettes } | { ok: false; res: ActionResult };

/** Les droits ET l'état, en une fois : saisie réservée, campagne non figée, société ouverte à la personne. */
async function garde(user: CurrentUser, campaignId: string | null, companyId?: string | null): Promise<Garde> {
  if (!campaignId) return { ok: false, res: { ok: false, error: "Campagne introuvable." } };
  const ctx = await contexteRecettes(user, campaignId);
  if (!ctx) return { ok: false, res: { ok: false, error: "Campagne introuvable." } };
  const v = verdictSaisieRecettes({ droits: ctx.droits, figeesLe: ctx.campagne.recettesFigeesLe });
  if (!v.ok) return { ok: false, res: { ok: false, error: v.raison } };
  if (companyId !== undefined && (!companyId || !ctx.societes.some((s) => s.id === companyId))) {
    return { ok: false, res: { ok: false, error: "Choisissez une société du groupe concernée par la campagne." } };
  }
  return { ok: true, ctx };
}

function lireTaux(formData: FormData, cle: string): number | null | "invalide" {
  if (!fdStr(formData, cle)) return null;
  const t = fdNum(formData, cle);
  return t !== null && TAUX_TVA_PCT.includes(t) ? t : "invalide";
}

function lirePct(formData: FormData, cle: string): number | null | "invalide" {
  if (!fdStr(formData, cle)) return null;
  const v = fdNum(formData, cle);
  return v !== null && v >= 0 && v <= 100 ? v : "invalide";
}

// ─────────────────────────────── Les recettes ───────────────────────────────

/**
 * Enregistre une recette prévue : une société, un mois (ou « l'année », répartie en douze), un produit et/ou une BU (ou
 * un libellé), un client (celui par défaut s'il n'est pas nommé), quantité × prix (le prix hôpital saisi du produit, repris s'il n'est pas tapé)
 * ou montant direct, et un taux de TVA. La même clé de rapprochement remplace la ligne existante.
 */
export async function enregistrerRecetteCampagne(formData: FormData): Promise<ActionResult> { return annulable("budget-campagne-recettes-actions:enregistrerRecetteCampagne", "Enregistrer une recette prévue", async () => {
  const user = await requireUser();
  const campaignId = fdStr(formData, "campaignId");
  const companyId = fdStr(formData, "companyId");
  const g = await garde(user, campaignId, companyId);
  if (!g.ok) return g.res;
  const { ctx } = g;
  const annee = ctx.campagne.year;
  const moisBrut = fdStr(formData, "mois");
  const toutLAn = moisBrut === "ANNEE";
  const mois = toutLAn ? null : fdNum(formData, "mois");
  if (!toutLAn && !(mois !== null && Number.isInteger(mois) && mois >= 1 && mois <= 12)) return { ok: false, error: "Choisissez le mois (ou « toute l'année »)." };

  // Le produit et la BU viennent du catalogue de la société : on ne les croit pas sur parole.
  const cat = await catalogueRecettes([companyId!], annee);
  const productId = fdStr(formData, "productId");
  const produit = productId ? cat.produits.find((p) => p.id === productId && (p.companyId === null || p.companyId === companyId)) : null;
  if (productId && !produit) return { ok: false, error: "Ce produit n'appartient pas à la société choisie." };
  const buDemandee = fdStr(formData, "businessUnitId");
  const businessUnitId = buDemandee ?? produit?.businessUnitId ?? null;
  const bu = businessUnitId ? cat.bus.find((b) => b.id === businessUnitId && (b.companyId === null || b.companyId === companyId)) : null;
  if (businessUnitId && !bu) return { ok: false, error: "Cette BU n'appartient pas à la société choisie." };
  const label = produit?.label ?? bu?.label ?? fdStr(formData, "label");
  if (!label) return { ok: false, error: "Choisissez un produit ou une BU, ou nommez la recette." };
  const client = normaliserClient(fdStr(formData, "client"));
  const tva = lireTaux(formData, "tvaPct");
  if (tva === "invalide") return { ok: false, error: "Taux de TVA admis : 0, 9 ou 19 %." };

  const prixTape = fdNum(formData, "prixUnitaire");
  const prixUnitaire = prixTape ?? produit?.prixHopital ?? null;
  const sourcePrix: SourcePrix | null = prixTape !== null ? "SAISIE" : produit?.prixHopital ? "PRIX_HOPITAL" : null;
  const total = calculerMontantRecette({ quantite: fdNum(formData, "quantite"), prixUnitaire, montant: fdNum(formData, "montant") });
  if (!total.ok) return { ok: false, error: total.raison };

  // « Toute l'année » : la quantité (ou le montant direct) se répartit en douze parts, au centime près.
  const parMois: { mois: number; quantite: number | null; montant: number }[] = toutLAn
    ? (() => {
      const qs = total.quantite !== null && total.prixUnitaire !== null ? repartirSurDouzeMois(total.quantite) : null;
      const ms = repartirSurDouzeMois(total.montant);
      return ms.map((m, i) => ({ mois: i + 1, quantite: qs ? qs[i]! : null, montant: qs ? Math.round(qs[i]! * total.prixUnitaire! * 100) / 100 : m }));
    })()
    : [{ mois: mois!, quantite: total.quantite, montant: total.montant }];

  const id = fdStr(formData, "id");
  for (const m of parMois) {
    const matchKey = cleRapprochementRecette({ companyId: companyId!, annee, mois: m.mois, productId: produit?.id ?? null, businessUnitId, label, client });
    const data = {
      companyId: companyId!, month: m.mois, productId: produit?.id ?? null, businessUnitId, client, label,
      quantity: m.quantite, unitPrice: total.prixUnitaire, amount: m.montant, vatRate: tva, priceSource: total.prixUnitaire !== null ? sourcePrix : null,
      matchKey, updatedById: user.id,
    };
    if (id && !toutLAn) {
      const deja = await prisma.budgetCampaignRevenue.findFirst({ where: { campaignId: campaignId!, matchKey, NOT: { id } }, select: { id: true } });
      if (deja) return { ok: false, error: "Une recette existe déjà pour ce mois, ce produit et ce client : modifiez-la plutôt." };
      const n = await prisma.budgetCampaignRevenue.updateMany({ where: { id, campaignId: campaignId! }, data });
      if (n.count === 0) return { ok: false, error: "Recette introuvable." };
    } else {
      await prisma.budgetCampaignRevenue.upsert({
        where: { campaignId_matchKey: { campaignId: campaignId!, matchKey } },
        create: { ...data, campaignId: campaignId!, createdById: user.id },
        update: data,
      });
    }
  }
  const quand = toutLAn ? `${annee} (12 mois)` : `${MOIS_COURTS[mois! - 1]} ${annee}`;
  await recordAudit({
    actorId: user.id, action: id ? "UPDATE" : "CREATE", module: MODULE_AUDIT, entityType: "BUDGET", entityId: campaignId!,
    summary: `Recette prévue « ${label} » (${client}) — ${quand} : ${fmt(total.montant)}`,
  });
  revalider();
  return { ok: true, message: toutLAn ? "Recette répartie sur les douze mois." : undefined };
}); }

/** Retire une recette prévue (Super Admin, DG ; campagne non close). */
export async function supprimerRecetteCampagne(formData: FormData): Promise<ActionResult> { return annulable("budget-campagne-recettes-actions:supprimerRecetteCampagne", "Retirer une recette prévue", async () => {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  const r = id ? await prisma.budgetCampaignRevenue.findUnique({ where: { id }, select: { campaignId: true, companyId: true, label: true, month: true, amount: true } }) : null;
  if (!r) return { ok: false, error: "Recette introuvable." };
  const g = await garde(user, r.campaignId, r.companyId);
  if (!g.ok) return g.res;
  await prisma.budgetCampaignRevenue.delete({ where: { id: id! } });
  await recordAudit({ actorId: user.id, action: "DELETE", module: MODULE_AUDIT, entityType: "BUDGET", entityId: r.campaignId, summary: `Recette prévue « ${r.label} » (${MOIS_COURTS[r.month - 1]}) retirée : ${fmt(toNumber(r.amount))}` });
  revalider();
  return { ok: true };
}); }

// ─────────────────────────────── Impôts & taxes ───────────────────────────────

/** Règle les paramètres du volet (TVA par nature, IBS par société et calendrier, confirmation du cabinet). */
export async function reglerParametresImpotsCampagne(formData: FormData): Promise<ActionResult> { return annulable("budget-campagne-recettes-actions:reglerParametresImpotsCampagne", "Régler les impôts prévus de la campagne", async () => {
  const user = await requireUser();
  const campaignId = fdStr(formData, "campaignId");
  const g = await garde(user, campaignId);
  if (!g.ok) return g.res;
  const avant = lireParametresImpots(g.ctx.campagne.taxSettings);
  const p: ParametresImpots = structuredClone(avant);
  // Chaque champ est nommé en clair (le contrat d'action lit la source) : la TVA par nature, puis les taux.
  const tvas: [NatureTva, number | null | "invalide"][] = [
    ["RECETTES", lireTaux(formData, "tvaRecettes")], ["DEPENSES", lireTaux(formData, "tvaDepenses")],
    ["MASSE_SALARIALE", lireTaux(formData, "tvaMasseSalariale")], ["VERSEMENTS_ETAT", lireTaux(formData, "tvaVersementsEtat")],
  ];
  for (const [n, t] of tvas) {
    if (t === "invalide") return { ok: false, error: "Taux de TVA admis : 0, 9 ou 19 %." };
    if (t !== null) p.tvaParNature[n] = t;
  }
  const ibsDefaut = lirePct(formData, "ibsTauxDefaut");
  if (ibsDefaut === "invalide") return { ok: false, error: "Un taux s'écrit entre 0 et 100 %." };
  if (ibsDefaut !== null) p.ibsTauxDefaut = ibsDefaut;
  // L'IBS PAR SOCIÉTÉ : deux listes parallèles (la société, son taux ; un taux vide = le taux par défaut).
  const ibsSocietes = formData.getAll("ibsSociete").map(String);
  const ibsTaux = formData.getAll("ibsTaux").map((x) => String(x).trim());
  for (const [i, id] of ibsSocietes.entries()) {
    const s = g.ctx.societes.find((x) => x.id === id);
    if (!s) continue;
    const brut = ibsTaux[i] ?? "";
    const v = brut === "" ? null : Number(brut.replace(/\s/g, "").replace(",", "."));
    if (v !== null && !(Number.isFinite(v) && v >= 0 && v <= 100)) return { ok: false, error: `Taux d'IBS de ${s.label} : entre 0 et 100 %.` };
    if (v === null) delete p.ibsParSociete[s.id];
    else p.ibsParSociete[s.id] = v;
  }
  const calTexte = fdStr(formData, "calendrierIbs");
  if (calTexte) {
    const cal = lireCalendrierTexte(calTexte);
    if (!cal) return { ok: false, error: "Calendrier de l'IBS : « mois:part » séparés par des virgules, « + » pour l'exercice suivant (ex. 3:30, 6:30, 11:30, 5:10+)." };
    const v = verifierCalendrierIbs(cal);
    if (!v.ok) return { ok: false, error: v.raison };
    p.calendrierIbs = cal;
  }
  const confirme = fdCase(formData, "confirmesParCabinet");
  if (confirme !== undefined) p.confirmesParCabinet = confirme;
  await prisma.budgetCampaign.update({ where: { id: campaignId! }, data: { taxSettings: p as unknown as Prisma.InputJsonValue } });
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: MODULE_AUDIT, entityType: "BUDGET", entityId: campaignId!, field: "taxSettings",
    oldValue: JSON.stringify(avant), newValue: JSON.stringify(p), summary: "Paramètres des impôts prévus modifiés",
  });
  revalider();
  return { ok: true };
}); }

/**
 * AJUSTE (ou saisit) un montant du volet pour une société et un mois — mois 13 : l'exercice suivant (solde d'IBS). Le
 * calcul remplacé est gardé à côté et l'écart part dans l'audit. Un montant vide rend la main au calcul.
 */
export async function ajusterImpotCampagne(formData: FormData): Promise<ActionResult> { return annulable("budget-campagne-recettes-actions:ajusterImpotCampagne", "Ajuster un impôt prévu de la campagne", async () => {
  const user = await requireUser();
  const campaignId = fdStr(formData, "campaignId");
  const companyId = fdStr(formData, "companyId");
  const g = await garde(user, campaignId, companyId);
  if (!g.ok) return g.res;
  const cle = fdStr(formData, "cle");
  if (!estCleImpot(cle)) return { ok: false, error: "Ligne d'impôt inconnue." };
  const mois = fdNum(formData, "mois");
  const maxMois = cle === "IBS" ? MOIS_EXERCICE_SUIVANT : 12;
  if (!(mois !== null && Number.isInteger(mois) && mois >= 1 && mois <= maxMois)) return { ok: false, error: "Choisissez le mois." };
  const brut = fdStr(formData, "montant");
  const montant = brut === null ? null : fdNum(formData, "montant");
  // Seule la TVA nette peut être négative (un crédit) ; un impôt à payer, jamais.
  if (brut !== null && (montant === null || (cle !== "TVA_NETTE" && montant < 0))) return { ok: false, error: "Montant invalide." };
  const motif = fdStr(formData, "motif");

  const { previsions } = await calculerPrevisionsCampagne(g.ctx.campagne, [companyId!]);
  const cellule = previsions.find((x) => x.companyId === companyId)?.impots[cle][mois - 1];
  const calcule = cellule?.calcule ?? null;
  const where = { campaignId_companyId_month_key: { campaignId: campaignId!, companyId: companyId!, month: mois, key: cle } };
  const quoi = `${LIBELLE_IMPOT[cle]} — ${mois === MOIS_EXERCICE_SUIVANT ? "exercice suivant" : MOIS_COURTS[mois - 1]}`;
  if (montant === null) {
    await prisma.budgetCampaignTaxLine.deleteMany({ where: { campaignId: campaignId!, companyId: companyId!, month: mois, key: cle } });
    await recordAudit({ actorId: user.id, action: "UPDATE", module: MODULE_AUDIT, entityType: "BUDGET", entityId: campaignId!, summary: `${quoi} : retour au calcul${calcule !== null ? ` (${fmt(calcule)})` : ""}` });
  } else {
    await prisma.budgetCampaignTaxLine.upsert({
      where,
      create: { campaignId: campaignId!, companyId: companyId!, month: mois, key: cle, amount: montant, computedAmount: calcule, reason: motif, setById: user.id },
      update: { amount: montant, computedAmount: calcule, reason: motif, setById: user.id },
    });
    const ecart = calcule !== null ? ` — calcul ${fmt(calcule)}, écart ${montant - calcule > 0 ? "+" : ""}${fmt(Math.round((montant - calcule) * 100) / 100)}` : " (saisie directe)";
    await recordAudit({
      actorId: user.id, action: "UPDATE", module: MODULE_AUDIT, entityType: "BUDGET", entityId: campaignId!, field: `impot:${cle}:${mois}`,
      oldValue: cellule ? String(cellule.retenu) : null, newValue: String(montant), summary: `${quoi} : ${fmt(montant)}${ecart}${motif ? ` · ${motif}` : ""}`,
    });
  }
  revalider();
  return { ok: true };
}); }

/** Règle le taux de TVA d'une ligne de dépense d'un pôle (vide = le défaut de sa nature). Super Admin, DG. */
export async function reglerTvaLigneDepense(formData: FormData): Promise<ActionResult> { return annulable("budget-campagne-recettes-actions:reglerTvaLigneDepense", "Régler la TVA d'une dépense prévue", async () => {
  const user = await requireUser();
  const lineId = fdStr(formData, "lineId");
  const l = lineId ? await prisma.budgetProposalLine.findUnique({ where: { id: lineId }, select: { label: true, vatRate: true, proposal: { select: { campaignId: true } } } }) : null;
  if (!l) return { ok: false, error: "Ligne introuvable." };
  const g = await garde(user, l.proposal.campaignId);
  if (!g.ok) return g.res;
  const t = lireTaux(formData, "tvaPct");
  if (t === "invalide") return { ok: false, error: "Taux de TVA admis : 0, 9 ou 19 %." };
  await prisma.budgetProposalLine.update({ where: { id: lineId! }, data: { vatRate: t } });
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: MODULE_AUDIT, entityType: "BUDGET", entityId: l.proposal.campaignId, field: "vatRate",
    oldValue: l.vatRate === null ? null : String(toNumber(l.vatRate)), newValue: t === null ? null : String(t),
    summary: `TVA de la dépense « ${l.label} » : ${t === null ? "défaut de sa nature" : `${t} %`}`,
  });
  revalider();
  return { ok: true };
}); }
