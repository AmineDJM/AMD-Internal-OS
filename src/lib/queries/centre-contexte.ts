import { prisma } from "@/lib/prisma";
import { toNumber } from "@/lib/utils";
import type { SessionUser } from "@/lib/rbac";
import { sansBloquer } from "@/lib/journal";
import {
  budgetAvantApres, contexteDecisionDesOrdres,
  type ApportContexte, type BriquesContexte, type BudgetDecision, type ContexteDecision, type EtapeChaine,
  type JalonLu, type OrdrePourBrique, type PieceDecision, chargerTresorerie, ENTITE_SANS, apportsChargesFixes,
} from "@/modules/finances/api";
import { lirePorteDg, piecesDesPostes } from "@/modules/ad-pro/api";
import { parentDuPoste } from "@/lib/chemins/ad-pro";
import { originesDesOrdres } from "@/lib/queries/budget-integration";
import { consommationDesCategories } from "@/lib/queries/budget";
import { faitsDesDemandes } from "@/lib/queries/demandes-tableau";
import { etatsDesBC, type EtatBC } from "@/lib/bons-de-commande/etat";
import { LIBELLE_CENTRE_BC } from "@/lib/bons-de-commande/regle";
import { etatMarketingDesBC } from "@/lib/signature-en-ligne/signer-bc";
import { marquesDesOrdres } from "@/lib/factures/connues";
import { existingSources } from "@/lib/entity-exists";
import { entityHref } from "@/lib/entity-href";
import { ENTITY_MODULE } from "@/lib/entity-access";
import { pickAutoCategory } from "@/lib/budget/auto-category";
import { natureDeLOrdreBv, LIBELLE_NATURE_BV } from "@/lib/regulatory/bv-circuit";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES BRIQUES DU CENTRE DE PAIEMENT — ce que les AUTRES métiers savent d'un ordre en attente.
 *
 * Le chargeur de la fiche (`contexteDecisionDesOrdres`, module Finances) lit ce que Finances
 * possède ; la carte des modules lui interdit de lire Ad & Pro (qui lit Finances), les bons de
 * commande, les factures connues ou le budget. Cette façade les lui APPORTE, chacune réutilisant
 * la lecture qui existe déjà — `originesDesOrdres` (le poste, la case de prise en charge),
 * `piecesDesPostes` (devis, BC, factures du poste), `etatsDesBC` + `etatMarketingDesBC` (qui a
 * signé et visé), `lirePorteDg`, `faitsDesDemandes` (secrétariat), `marquesDesOrdres`,
 * `consommationDesCategories` (le même chiffre que l'écran Budgets).
 *
 * Toutes travaillent EN LOT. Une brique qui échoue est attrapée par le chargeur, qui le dit sur la
 * fiche : le centre décide toujours, sur ce qu'il voit.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const jour = (d: Date | string): string => new Date(d).toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
const dzd = (n: number): string => Math.round(n).toLocaleString("fr-FR");

/** Où en est un BC : signé par la Direction Marketing, visé par son centre, signé par les Finances. */
function etapeDuBC(bc: EtatBC, dm: { nom: string; le: string } | null): EtapeChaine {
  const morceaux: string[] = [];
  if (dm) morceaux.push(`signé DM le ${jour(dm.le)}`);
  if (bc.porte && bc.porte.etat === "VALIDE" && !bc.porte.sansCentre) morceaux.push(`visé ${LIBELLE_CENTRE_BC[bc.porte.centre]}`);
  if (bc.porte?.sansCentre) morceaux.push("sous le seuil de visa");
  if (bc.signeLe) morceaux.push(`signé Finances le ${jour(bc.signeLe)}`);
  else morceaux.push(bc.etape === "A_SIGNER" ? "attend la signature des Finances" : bc.etape === "REFUSE" ? "refusé par son centre" : "en cours de visa");
  return {
    etape: `BC n°${bc.reference ?? bc.title}`,
    detail: `${bc.montant != null ? `${dzd(bc.montant)} DZD · ` : ""}${morceaux.join(" · ")}`,
    etat: bc.etape === "SIGNE" ? "OK" : bc.etape === "REFUSE" ? "KO" : "ATTENTE",
  };
}

/** Les étapes de plusieurs BC, en lot. */
async function etapesDesBC(ids: readonly string[]): Promise<Map<string, { etape: EtapeChaine; etat: EtatBC }>> {
  const out = new Map<string, { etape: EtapeChaine; etat: EtatBC }>();
  if (ids.length === 0) return out;
  const [etats, dms] = await Promise.all([etatsDesBC(ids), etatMarketingDesBC(ids)]);
  for (const [id, e] of etats) {
    if (e.annule) continue;
    out.set(id, { etape: etapeDuBC(e, dms[id]?.dm ?? null), etat: e });
  }
  return out;
}

// ─────────────────────────────── Ad & Pro : le poste, son BC, la porte du DG, la prise en charge ───────────────────────────────

async function apportsAdPro(ordres: readonly OrdrePourBrique[]): Promise<Map<string, ApportContexte>> {
  const out = new Map<string, ApportContexte>();
  const candidats = ordres.filter((o) => o.famille === "AD_PRO" || o.famille === "AUTRE" || o.famille === "INFO_MEDICALE");
  if (candidats.length === 0) return out;
  const origines = await originesDesOrdres(candidats);
  const posteIds = [...new Set([...origines.values()].map((o) => o.posteId).filter((x): x is string => Boolean(x)))];
  const [postes, pieces] = await Promise.all([
    posteIds.length
      ? prisma.adProItem.findMany({
          where: { id: { in: posteIds } },
          select: {
            id: true, label: true, voie: true, amountEstimated: true, amountGranted: true, orderVisaAmount: true, budgetCategoryId: true,
            status: true, decidedAt: true, decidedById: true, opsDecidedAt: true, opsDecidedById: true,
            sponsoringId: true, congressNationalId: true, congressInternationalId: true, eventId: true, otherRequestId: true,
            sponsoring: { select: { reference: true } }, congressNational: { select: { name: true } },
            congressInternational: { select: { name: true } }, event: { select: { name: true } }, otherRequest: { select: { reference: true, title: true } },
          },
        })
      : Promise.resolve([]),
    piecesDesPostes(posteIds),
  ]);
  const decideurs = [...new Set(postes.flatMap((p) => [p.decidedById, p.opsDecidedById]).filter((x): x is string => Boolean(x)))];
  const bcIds = [...pieces.values()].flatMap((p) => p.bcs.map((b) => b.id));
  const parents = [...new Map(postes.map((p) => parentDuPoste(p)).filter((x): x is NonNullable<typeof x> => Boolean(x)).map((x) => [`${x.parent}:${x.id}`, x])).values()];
  const [noms, bcs, portes] = await Promise.all([
    decideurs.length ? prisma.user.findMany({ where: { id: { in: decideurs } }, select: { id: true, name: true } }) : Promise.resolve([]),
    etapesDesBC(bcIds),
    // La porte du DG, une lecture par DEMANDE (pas par ordre) ; une demande illisible garde le reste.
    Promise.all(parents.map(async (p) => [`${p.parent}:${p.id}`, await lirePorteDg(p.parent, p.id).catch(sansBloquer("centre.contexte.porteDg", null))] as const)),
  ]);
  const nomDe = new Map(noms.map((u) => [u.id, u.name]));
  const porteDe = new Map(portes);

  for (const o of candidats) {
    const origine = origines.get(o.id);
    const poste = origine?.posteId ? postes.find((p) => p.id === origine.posteId) : undefined;
    if (!poste) {
      // UNE PRISE EN CHARGE (case d'un congrès) : l'origine se dit, la chaîne d'achat vient des BC de l'ordre.
      if (origine?.demande?.startsWith("CONGRESS_")) out.set(o.id, { origine: "Prise en charge" });
      continue;
    }
    const demande = poste.sponsoring?.reference ?? poste.otherRequest?.reference ?? poste.congressNational?.name
      ?? poste.congressInternational?.name ?? poste.event?.name ?? null;
    const chaine: EtapeChaine[] = [];
    if (poste.opsDecidedAt) {
      chaine.push({ etape: "Poste accordé par le directeur des opérations", detail: `${poste.opsDecidedById ? nomDe.get(poste.opsDecidedById) ?? "" : ""} · ${jour(poste.opsDecidedAt)}`.replace(/^ · /, ""), etat: "OK" });
    }
    chaine.push(poste.status === "APPROVED"
      ? { etape: "Poste accordé", detail: `${poste.decidedById ? `${nomDe.get(poste.decidedById) ?? "Direction"} · ` : ""}${poste.decidedAt ? jour(poste.decidedAt) : ""}${poste.amountGranted != null ? ` · ${dzd(toNumber(poste.amountGranted))} DZD` : ""}`, etat: "OK" }
      : { etape: "Poste accordé", detail: "pas encore", etat: poste.status === "REJECTED" ? "KO" : "ATTENTE" });
    const parent = parentDuPoste(poste);
    const porte = parent ? porteDe.get(`${parent.parent}:${parent.id}`) : null;
    if (porte && porte.etat !== "NON_REQUISE") {
      chaine.push({
        etape: "Porte du DG",
        detail: porte.phrase ?? (porte.decision ? `validée pour ${dzd(porte.decision.montant)} DZD` : "en attente"),
        etat: porte.etat === "VALIDEE" ? "OK" : porte.etat === "A_REVOIR" ? "KO" : "ATTENTE",
      });
    }
    const p = pieces.get(poste.id);
    for (const bc of p?.bcs ?? []) {
      const e = bcs.get(bc.id);
      if (e) chaine.push(e.etape);
    }
    const piecesLues: PieceDecision[] = [];
    const retenus = (p?.devis ?? []).filter((d) => !d.annulee && !d.nonRetenu);
    const ecartes = (p?.devis ?? []).filter((d) => !d.annulee && d.nonRetenu);
    for (const f of p?.factures ?? []) if (!f.annulee) piecesLues.push({ nom: `Facture ${f.reference ?? f.titre}${f.montant != null ? ` · ${dzd(f.montant)}` : ""}`, present: f.fichierId != null, documentId: f.fichierId });
    if ((p?.factures ?? []).filter((f) => !f.annulee).length === 0) piecesLues.push({ nom: "Facture", present: false, documentId: null });
    for (const b of p?.bcs ?? []) piecesLues.push({ nom: `BC ${b.reference ?? b.titre}${b.signeLe ? " signé" : ""}`, present: true, documentId: b.copieSignee?.documentId ?? b.fichierId });
    for (const d of retenus) piecesLues.push({ nom: `Devis retenu${ecartes.length ? ` (${ecartes.length} écarté${ecartes.length > 1 ? "s" : ""})` : ""}`, present: true, documentId: d.fichierId });

    const jalons: JalonLu[] = [];
    const devis = retenus.reduce((s, d) => s + (d.montant ?? 0), 0);
    if (devis > 0) jalons.push({ libelle: "Devis", valeur: devis });
    if (poste.amountGranted != null) jalons.push({ libelle: "Accordé", valeur: toNumber(poste.amountGranted), plafond: "ACCORDE", nomme: "Montant accordé au poste" });
    if (poste.orderVisaAmount != null) jalons.push({ libelle: "Visa", valeur: toNumber(poste.orderVisaAmount), plafond: "VISA", nomme: "Visa du centre" });
    const bcTotal = (p?.bcs ?? []).reduce((s, b) => s + (b.montant ?? 0), 0);
    if (bcTotal > 0) {
      const premier = p!.bcs[0];
      jalons.push({ libelle: "BC", valeur: bcTotal, plafond: "BC", nomme: `BC n°${premier.reference ?? premier.titre}${premier.signeLe ? " signé" : ""}` });
    }
    const factures = (p?.factures ?? []).filter((f) => !f.annulee).reduce((s, f) => s + (f.montant ?? 0), 0);
    if (factures > 0) jalons.push({ libelle: "Facture", valeur: factures });

    out.set(o.id, {
      origine: `Ad & Pro · ${poste.voie === "AGENCE" ? "poste agence" : "poste"}`,
      // L'objet reste le libellé de l'ORDRE (il nomme déjà le poste et sa demande) : c'est ce que la file et les
      // Finances lisent, et il ne doit pas changer d'un écran à l'autre.
      referenceOrigine: demande ?? undefined,
      chaine, pieces: piecesLues, jalons,
      budgetCategoryId: poste.budgetCategoryId,
    });
  }
  return out;
}

// ─────────────────────────────── Les BC attachés à l'ordre (prise en charge, secrétariat…) ───────────────────────────────

async function apportsBonsDeCommande(ordres: readonly OrdrePourBrique[]): Promise<Map<string, ApportContexte>> {
  const out = new Map<string, ApportContexte>();
  const bcs = await prisma.legalDocument.findMany({
    where: { expenseOrderId: { in: ordres.map((o) => o.id) }, kind: "PURCHASE_ORDER", status: { not: "CANCELLED" } },
    select: { id: true, expenseOrderId: true },
  });
  if (bcs.length === 0) return out;
  const etapes = await etapesDesBC(bcs.map((b) => b.id));
  for (const b of bcs) {
    const e = etapes.get(b.id);
    if (!e || !b.expenseOrderId) continue;
    const a = out.get(b.expenseOrderId) ?? { chaine: [] };
    a.chaine!.push(e.etape);
    out.set(b.expenseOrderId, a);
  }
  return out;
}

// ─────────────────────────────── Le secrétariat : l'accord du N+1, les montants de la demande ───────────────────────────────

async function apportsSecretariat(ordres: readonly OrdrePourBrique[]): Promise<Map<string, ApportContexte>> {
  const out = new Map<string, ApportContexte>();
  const siens = ordres.filter((o) => o.famille === "SECRETARIAT" && o.sourceId);
  if (siens.length === 0) return out;
  const ids = [...new Set(siens.map((o) => o.sourceId as string))];
  const [demandes, accords] = await Promise.all([
    prisma.administrativeRequest.findMany({ where: { id: { in: ids } }, select: { id: true, reference: true, title: true, fields: true, createdAt: true, requester: { select: { name: true } } } }),
    prisma.adminApproval.findMany({
      where: { requestId: { in: ids }, status: "APPROVED" },
      orderBy: { decidedAt: "desc" },
      select: { requestId: true, decidedAt: true, amount: true, decidedBy: { select: { name: true } }, validator: { select: { name: true } } },
    }),
  ]);
  const faits = await faitsDesDemandes(demandes.map((d) => ({ id: d.id, fields: d.fields })));
  for (const o of siens) {
    const d = demandes.find((x) => x.id === o.sourceId);
    if (!d) continue;
    const f = faits.get(d.id)?.faits;
    const accord = accords.find((a) => a.requestId === d.id);
    const jalons: JalonLu[] = [];
    if (f?.estime != null) jalons.push({ libelle: "Estimé", valeur: f.estime });
    if (f?.devisRetenu != null) jalons.push({ libelle: "Devis retenu", valeur: f.devisRetenu });
    if (f?.valide != null) jalons.push({ libelle: "Validé", valeur: f.valide, plafond: "ACCORDE", nomme: "Montant validé par le N+1" });
    if (f?.engage != null) jalons.push({ libelle: "BC", valeur: f.engage, plafond: "BC", nomme: "BC de la demande" });
    if (f?.facture != null) jalons.push({ libelle: "Facture", valeur: f.facture });
    out.set(o.id, {
      origine: "Secrétariat",
      referenceOrigine: d.reference,
      demandeur: d.requester?.name ?? undefined,
      demandeLe: d.createdAt,
      chaine: [accord
        ? { etape: "Accord du N+1", detail: `${accord.decidedBy?.name ?? accord.validator?.name ?? "validé"}${accord.decidedAt ? ` · ${jour(accord.decidedAt)}` : ""}${accord.amount != null ? ` · ${dzd(toNumber(accord.amount))} DZD` : ""}`, etat: "OK" }
        : { etape: "Accord du N+1", detail: "aucun accord enregistré", etat: "ATTENTE" }],
      jalons,
    });
  }
  return out;
}

// ─────────────────────────────── Regulatory : le produit d'un BV ───────────────────────────────

async function apportsRegulatory(ordres: readonly OrdrePourBrique[]): Promise<Map<string, ApportContexte>> {
  const out = new Map<string, ApportContexte>();
  const siens = ordres.filter((o) => o.famille === "REGULATORY" && o.sourceId);
  if (siens.length === 0) return out;
  const produits = await prisma.regulatoryProduct.findMany({
    where: { id: { in: [...new Set(siens.map((o) => o.sourceId as string))] } },
    select: { id: true, reference: true, dci: true, brandName: true },
  });
  for (const o of siens) {
    const p = produits.find((x) => x.id === o.sourceId);
    if (!p) continue;
    const nature = natureDeLOrdreBv({ sourceType: o.sourceType, label: o.libelle });
    const nom = p.brandName?.trim() || p.dci;
    out.set(o.id, {
      origine: `Regulatory${nature ? ` · ${LIBELLE_NATURE_BV[nature]}` : ""}`,
      referenceOrigine: p.reference,
      objet: `${o.libelle} — ${nom}${p.dci && p.dci !== nom ? ` (${p.dci})` : ""}`,
    });
  }
  return out;
}

// ─────────────────────────────── Le budget : la ligne, avant et après ───────────────────────────────

/**
 * LE DISPONIBLE DE CHAQUE LIGNE TOUCHÉE — la catégorie de l'ordre (ou de sa source), sinon celle que l'imputation
 * automatique choisirait au règlement. Une enveloppe lue une fois, sur SES catégories touchées seulement.
 */
async function budgetDesOrdres(ordres: readonly { id: string; categoryId: string | null; montant: number; sourceType: string | null }[]): Promise<Map<string, BudgetDecision>> {
  const out = new Map<string, BudgetDecision>();
  if (ordres.length === 0) return out;
  let auto: ((m: string | null) => string | null) | null = null;
  if (ordres.some((o) => !o.categoryId && o.sourceType)) {
    const [envelopes, categories] = await Promise.all([
      prisma.budgetEnvelope.findMany({ where: { isActive: true }, select: { id: true, isActive: true, modules: true, module: true, periodStart: true } }),
      prisma.budgetCategoryLine.findMany({ where: { parentId: null, envelope: { isActive: true } }, select: { id: true, envelopeId: true, module: true, parentId: true, createdAt: true } }),
    ]);
    auto = (m) => pickAutoCategory(m, envelopes, categories);
  }
  const categorieDe = new Map(ordres.map((o) => [o.id, o.categoryId ?? (auto && o.sourceType ? auto(ENTITY_MODULE[o.sourceType as keyof typeof ENTITY_MODULE] ?? null) : null)]));
  const catIds = [...new Set([...categorieDe.values()].filter((c): c is string => Boolean(c)))];
  if (catIds.length === 0) return out;
  const lignes = await prisma.budgetCategoryLine.findMany({
    where: { id: { in: catIds } },
    select: {
      id: true, name: true, allocated: true, cle: true, businessUnitId: true, parent: { select: { name: true } },
      envelope: { select: { id: true, name: true, periodStart: true, periodEnd: true, companyId: true } },
    },
  });
  const parEnveloppe = new Map<string, typeof lignes>();
  for (const l of lignes) parEnveloppe.set(l.envelope.id, [...(parEnveloppe.get(l.envelope.id) ?? []), l]);
  const lus = new Map<string, { consomme: number; engage: number }>();
  for (const [, ls] of parEnveloppe) {
    const env = ls[0].envelope;
    const c = await consommationDesCategories({ ...env, categories: ls.map((l) => ({ id: l.id, cle: l.cle, businessUnitId: l.businessUnitId })) }, env.periodStart, env.periodEnd);
    for (const l of ls) lus.set(l.id, { consomme: c.consumedByCat.get(l.id) ?? 0, engage: c.committedByCat.get(l.id) ?? 0 });
  }
  for (const o of ordres) {
    const cat = categorieDe.get(o.id);
    const l = cat ? lignes.find((x) => x.id === cat) : undefined;
    const lu = cat ? lus.get(cat) : undefined;
    if (!l || !lu) continue;
    const { avant, apres } = budgetAvantApres({ alloue: toNumber(l.allocated), consomme: lu.consomme, engage: lu.engage, montant: o.montant });
    out.set(o.id, { etat: "IMPUTE", ligne: [l.envelope.name, l.parent?.name, l.name].filter(Boolean).join(" › "), avant, apres });
  }
  return out;
}

// ─────────────────────────────── La fiche d'origine ───────────────────────────────

async function liensDesOrdres(ordres: readonly OrdrePourBrique[]): Promise<Map<string, string | null>> {
  const vivante = await existingSources(ordres.map((o) => ({ type: o.sourceType, id: o.sourceId })));
  return new Map(ordres.map((o) => [o.id, vivante(o.sourceType, o.sourceId) ? entityHref(o.sourceType, o.sourceId) : null]));
}

/** Les briques réelles — un test les remplace par les siennes (une brique en panne, par exemple). */
export const BRIQUES_DU_CENTRE: BriquesContexte = {
  apports: [
    { nom: "Ad & Pro", lire: apportsAdPro },
    { nom: "bons de commande", lire: apportsBonsDeCommande },
    { nom: "secrétariat", lire: apportsSecretariat },
    { nom: "Regulatory", lire: apportsRegulatory },
    // Les charges fixes des locaux (24/11/2026) : l'estimation face à la facture — alerte au-delà de +10 %.
    { nom: "charges fixes", lire: apportsChargesFixes },
  ],
  doublons: marquesDesOrdres,
  budget: budgetDesOrdres,
  liens: liensDesOrdres,
};

/**
 * LA FICHE DE CHAQUE ORDRE EN ATTENTE, pour l'écran du centre : le chargeur de Finances, ses briques, et la
 * trésorerie de l'entité lue UNE fois (le disponible une fois réglés les paiements déjà autorisés).
 */
export async function contexteDuCentre(ids: readonly string[], user: SessionUser, entite: string | null, briques: BriquesContexte = BRIQUES_DU_CENTRE): Promise<ContexteDecision[]> {
  if (ids.length === 0) return [];
  const societe = entite && entite !== ENTITE_SANS ? entite : null;
  const treso = await chargerTresorerie(user.id, societe).catch(sansBloquer("centre.contexte.tresorerie", null));
  // Sans compte bancaire saisi, la trésorerie n'est pas connue : on ne crie pas « insuffisante » sur un zéro.
  const disponible = treso && treso.comptes.length > 0 ? treso.disponible : null;
  return contexteDecisionDesOrdres(ids, user, { briques, disponible });
}
