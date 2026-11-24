import { prisma } from "@/lib/prisma";
import { toNumber } from "@/lib/utils";
import type { SessionUser } from "@/lib/rbac";
import { getAppSettings } from "@/lib/settings";
import { sansBloquer } from "@/lib/journal";
import { ENTITY_TYPE_LABELS } from "@/lib/labels";
import { memeBeneficiaire } from "../../domaine/authorization";
import { refusSeparationDesTaches } from "../../domaine/separation";
import { deadlineNatureOf } from "../../domaine/deadline-nature";
import {
  alerteBudget, alerteTresorerie, montantCourt, montantsEtEcarts, phraseHistorique, PREMIER_PAIEMENT,
  type AlerteDecision, type BudgetDecision, type ContexteDecision, type EtapeChaine, type JalonLu, type PieceDecision,
} from "../../domaine/contexte-decision";
import { phraseFractionnement, type SignalFractionnement } from "../../domaine/fractionnement";
import { ordresAvecFacture } from "../facture-ordre";
import { approbateursEnAmontDesOrdres } from "../approbateurs-amont";
import { signauxDeFractionnement } from "./fractionnement";
import { paymentDossierHref } from "../expense-orders";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE CONTEXTE DE DÉCISION DES ORDRES EN ATTENTE — ce que la fiche du centre de paiement affiche.
 *
 * EN LOT : une poignée de requêtes pour toute la file, jamais une par ordre (§118.102b). Le module
 * lit ce qu'il possède (l'ordre, son dossier de demande de paiement, ses pièces, le fil du centre)
 * et les faits simples des circuits qui le font naître (avance, paie, remise de caisse) ; ce qui
 * vit chez un AUTRE métier — le poste Ad & Pro et son BC signé, les faits du secrétariat, les
 * factures déjà connues, le budget — arrive par des BRIQUES que l'appelant fournit
 * (`lib/queries/centre-contexte.ts`) : la carte des modules interdit à `finances` de lire
 * `ad-pro`, qui le lit déjà.
 *
 * TOLÉRANT : une origine inconnue rend le minimum (montant, bénéficiaire, demandeur, fil) ; une
 * brique qui échoue n'empêche pas l'écran — la fiche le DIT (« contexte incomplet ») au lieu de
 * se taire, et le centre décide sur ce qu'il voit.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Les grandes familles de paiements — elles décident de ce que la fiche cherche. */
export type FamilleOrdre =
  | "DEMANDE_PAIEMENT" | "AD_PRO" | "SECRETARIAT" | "PAIE" | "AVANCE" | "CAISSE" | "REGULATORY" | "INFO_MEDICALE" | "AUTRE";

const SOURCES_AD_PRO = new Set(["SPONSORING", "EVENT", "CONGRESS_NATIONAL", "CONGRESS_INTERNATIONAL", "AD_PRO_OTHER", "AD_PRO_ITEM", "PROMO_MATERIAL", "CONSULTING_CONTRACT"]);

const ORIGINE_DE_LA_FAMILLE: Record<FamilleOrdre, string> = {
  DEMANDE_PAIEMENT: "Demande de paiement",
  AD_PRO: "Ad & Pro",
  SECRETARIAT: "Secrétariat",
  PAIE: "Paie",
  AVANCE: "Avance sur salaire",
  CAISSE: "Caisse d'avance",
  REGULATORY: "Regulatory",
  INFO_MEDICALE: "Information médicale",
  AUTRE: "Paiement",
};

/** L'ordre tel que les briques le reçoivent. */
export interface OrdrePourBrique {
  id: string;
  reference: string;
  libelle: string;
  montant: number;
  famille: FamilleOrdre;
  sourceType: string | null;
  sourceId: string | null;
  budgetCategoryId: string | null;
  companyId: string | null;
}

/** Ce qu'une brique d'un autre métier ajoute à la fiche — tout est facultatif. */
export interface ApportContexte {
  origine?: string;
  referenceOrigine?: string;
  objet?: string;
  demandeur?: string;
  demandeLe?: Date;
  chaine?: EtapeChaine[];
  pieces?: PieceDecision[];
  jalons?: JalonLu[];
  alertes?: AlerteDecision[];
  /** La catégorie budgétaire portée par la source (le poste, le dossier promo) quand l'ordre n'en a pas. */
  budgetCategoryId?: string | null;
  dejaPaye?: string;
}

export interface BriquesContexte {
  /** Les apports des autres métiers, chacun nommé : une brique en panne se dit par son nom. */
  apports?: readonly { nom: string; lire: (ordres: readonly OrdrePourBrique[]) => Promise<Map<string, ApportContexte>> }[];
  /** La marque « doublon possible » (factures déjà connues) — une phrase par ordre marqué. */
  doublons?: (ids: readonly string[]) => Promise<Map<string, string>>;
  /** Le budget : la ligne, le disponible avant et après (`categoryId` nul : la brique tente l'imputation automatique). */
  budget?: (ordres: readonly { id: string; categoryId: string | null; montant: number; sourceType: string | null }[]) => Promise<Map<string, BudgetDecision>>;
  /** La fiche d'origine, quand elle existe encore et s'ouvre. */
  liens?: (ordres: readonly OrdrePourBrique[]) => Promise<Map<string, string | null>>;
}

export interface OptionsContexte {
  briques?: BriquesContexte;
  /** Le disponible en banque une fois réglés les paiements déjà autorisés (`chargerTresorerie`, lu une fois par page). */
  disponible?: number | null;
  maintenant?: Date;
}

const ANNEE_MS = 365 * 86_400_000;

const LIBELLE_PIECE: Record<string, string> = {
  INVOICE: "Facture", PURCHASE_ORDER: "Bon de commande", QUOTE: "Devis", DELIVERY_NOTE: "Bon de livraison",
  CONTRACT: "Contrat", PROOF: "Justificatif", OTHER: "Pièce",
};

const dzd = (n: number): string => `${Math.round(n).toLocaleString("fr-FR")}`;
const jour = (d: Date): string => d.toLocaleDateString("fr-FR", { day: "numeric", month: "short" });

function familleDe(o: { sourceType: string | null; payrollWire: unknown; pettyCashAllotment: unknown }): FamilleOrdre {
  if (o.payrollWire || o.sourceType === "PAYROLL") return "PAIE";
  if (o.pettyCashAllotment) return "CAISSE";
  switch (o.sourceType) {
    case "PAYMENT_REQUEST": return "DEMANDE_PAIEMENT";
    case "ADMIN_REQUEST": return "SECRETARIAT";
    case "SALARY_ADVANCE": return "AVANCE";
    case "REGULATORY_PRODUCT": return "REGULATORY";
    case "MEDICAL_INFO_DECLARATION": return "INFO_MEDICALE";
    default: return o.sourceType && SOURCES_AD_PRO.has(o.sourceType) ? "AD_PRO" : "AUTRE";
  }
}

/** Une brique qui lève ne fait pas tomber la fiche : elle rend son repli, et son nom s'ajoute aux manques. */
async function essayer<T>(nom: string, manques: string[], repli: T, f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    manques.push(nom);
    return sansBloquer(`centre.contexte.${nom}`, repli)(e);
  }
}

export async function contexteDecisionDesOrdres(
  ids: readonly string[], user: SessionUser, opts: OptionsContexte = {},
): Promise<ContexteDecision[]> {
  if (ids.length === 0) return [];
  const briques = opts.briques ?? {};
  const maintenant = opts.maintenant ?? new Date();
  const manques: string[] = [];

  const ordres = await prisma.expenseOrder.findMany({
    where: { id: { in: [...ids] } },
    select: {
      id: true, reference: true, label: true, beneficiary: true, amount: true, dueDate: true, deadlineNature: true,
      createdAt: true, sourceType: true, sourceId: true, requestedById: true, centralStatus: true, centralDecidedById: true,
      budgetCategoryId: true, companyId: true, notes: true, requiresInvoice: true, status: true,
      requestedBy: { select: { name: true } },
      centralMessages: { orderBy: { createdAt: "asc" }, select: { id: true, decision: true, body: true, createdAt: true, author: { select: { name: true } } } },
      pettyCashAllotment: { select: { id: true, period: true, departmentId: true, createdAt: true, department: { select: { name: true } }, holder: { select: { name: true } }, createdBy: { select: { name: true } } } },
      payrollWire: { select: { id: true, year: true, month: true, companyId: true, createdAt: true, createdById: true, amount: true } },
    },
  });
  if (ordres.length === 0) return [];
  const rang = new Map(ids.map((id, i) => [id, i]));
  ordres.sort((a, b) => (rang.get(a.id) ?? 0) - (rang.get(b.id) ?? 0));
  const ordreIds = ordres.map((o) => o.id);
  const sourcesDe = (type: string) => [...new Set(ordres.filter((o) => o.sourceType === type && o.sourceId).map((o) => o.sourceId as string))];

  const pourBriques: OrdrePourBrique[] = ordres.map((o) => ({
    id: o.id, reference: o.reference, libelle: o.label, montant: toNumber(o.amount), famille: familleDe(o),
    sourceType: o.sourceType, sourceId: o.sourceId, budgetCategoryId: o.budgetCategoryId, companyId: o.companyId,
  }));
  const familleDeLOrdre = new Map(pourBriques.map((o) => [o.id, o.famille]));

  // ── Ce que le module possède, et les faits simples des circuits qui le font naître ───────────
  const beneficiaires = [...new Set(ordres.map((o) => o.beneficiary?.trim()).filter((b): b is string => Boolean(b)))];
  const avances = sourcesDe("SALARY_ADVANCE");
  const paies = ordres.map((o) => o.payrollWire).filter((w): w is NonNullable<typeof w> => Boolean(w));
  const caisses = ordres.map((o) => o.pettyCashAllotment).filter((c): c is NonNullable<typeof c> => Boolean(c));
  const sourcesAvecId = ordres.filter((o) => o.sourceType && o.sourceId);

  const [dossiers, fichiersOrdre, registre, reclamees, [benefTous, benefAnnee], payesMemeSource, avancesLues, entreesPaie, reglages] = await Promise.all([
    // Le dossier de demande de paiement : la SOURCE de l'ordre, ou son compagnon (ouvert derrière lui).
    prisma.paymentRequest.findMany({
      where: { OR: [{ expenseOrderId: { in: ordreIds } }, { id: { in: sourcesDe("PAYMENT_REQUEST") } }] },
      select: {
        id: true, reference: true, expenseOrderId: true, origin: true, status: true, requesterId: true, submittedAt: true, createdAt: true,
        decidedById: true, decidedAt: true,
        pieces: { orderBy: { position: "asc" }, select: { id: true, documentId: true, kind: true, status: true, replacedBy: { select: { id: true } } } },
      },
    }),
    prisma.document.findMany({ where: { entityType: "EXPENSE_ORDER", entityId: { in: ordreIds } }, select: { id: true, name: true, entityId: true }, orderBy: { createdAt: "asc" } }),
    // Les pièces du registre (Legal) rattachées à l'ordre : la facture qu'il paie, le BC qu'il honore.
    prisma.legalDocument.findMany({
      where: { expenseOrderId: { in: ordreIds }, kind: { in: ["INVOICE", "PURCHASE_ORDER", "QUOTE"] }, status: { not: "CANCELLED" } },
      select: { id: true, kind: true, reference: true, title: true, amount: true, signedAt: true, expenseOrderId: true },
    }),
    prisma.documentRequest.findMany({
      where: { entityType: "EXPENSE_ORDER", entityId: { in: ordreIds }, status: { in: ["PENDING", "SUBMITTED"] } },
      select: { id: true, entityId: true, label: true, status: true, askedTo: { select: { name: true } } },
      orderBy: { createdAt: "asc" },
    }),
    // L'HISTORIQUE DES BÉNÉFICIAIRES : les paiements réglés, regroupés par NOM tel qu'écrit — une ligne par nom, pas par
    // paiement ; le rapprochement sans casse ni accent (`memeBeneficiaire`) se fait ensuite. « Agence Atlas Events » et
    // « AGENCE ATLAS ÉVENTS » sont le même tiers, et la base ne le sait pas.
    beneficiaires.length
      ? Promise.all([
          prisma.expenseOrder.groupBy({ by: ["beneficiary"], where: { status: "PAID", beneficiary: { not: null } }, _count: { _all: true } }),
          prisma.expenseOrder.groupBy({
            by: ["beneficiary"],
            where: { status: "PAID", beneficiary: { not: null }, OR: [{ paidDate: { gte: new Date(maintenant.getTime() - ANNEE_MS) } }, { paidDate: null, updatedAt: { gte: new Date(maintenant.getTime() - ANNEE_MS) } }] },
            _count: { _all: true }, _sum: { amount: true }, _max: { paidDate: true, updatedAt: true },
          }),
        ])
      : Promise.resolve([[], []] as const),
    // DÉJÀ PAYÉ SUR LA MÊME DEMANDE : les autres ordres réglés de la même source.
    sourcesAvecId.length
      ? prisma.expenseOrder.findMany({
          where: { status: "PAID", id: { notIn: ordreIds }, OR: sourcesAvecId.map((o) => ({ sourceType: o.sourceType!, sourceId: o.sourceId! })) },
          select: { sourceType: true, sourceId: true, amount: true, reference: true },
        })
      : Promise.resolve([]),
    avances.length
      ? prisma.salaryAdvance.findMany({
          where: { id: { in: avances } },
          select: { id: true, employeeId: true, createdAt: true, decidedAt: true, reason: true, employee: { select: { fullName: true } }, decidedBy: { select: { name: true } } },
        })
      : Promise.resolve([]),
    paies.length
      ? prisma.payrollEntry.findMany({ where: { payrollWireId: { in: paies.map((p) => p.id) } }, select: { payrollWireId: true, net: true } })
      : Promise.resolve([]),
    getAppSettings(),
  ]);

  // Les faits qui dépendent des premiers.
  const demandeurIds = [...new Set([
    ...dossiers.map((d) => d.requesterId), ...dossiers.map((d) => d.decidedById), ...paies.map((p) => p.createdById),
  ].filter((x): x is string => Boolean(x)))];
  const docPieceIds = dossiers.flatMap((d) => d.pieces.map((p) => p.documentId));
  const employes = [...new Set(avancesLues.map((a) => a.employeeId))];
  const [noms, docsPieces, fichiersRegistre, avancesPassees, paiesPrecedentes, remisesPassees] = await Promise.all([
    demandeurIds.length ? prisma.user.findMany({ where: { id: { in: demandeurIds } }, select: { id: true, name: true } }) : Promise.resolve([]),
    docPieceIds.length ? prisma.document.findMany({ where: { id: { in: docPieceIds } }, select: { id: true, name: true } }) : Promise.resolve([]),
    registre.length
      ? prisma.document.findMany({ where: { entityType: "LEGAL_DOCUMENT", entityId: { in: registre.map((r) => r.id) } }, select: { id: true, entityId: true }, orderBy: { createdAt: "asc" } })
      : Promise.resolve([]),
    employes.length
      ? prisma.salaryAdvance.findMany({
          where: { employeeId: { in: employes }, id: { notIn: avances }, createdAt: { gte: new Date(maintenant.getTime() - ANNEE_MS) }, status: { notIn: ["REJECTED", "CANCELLED"] } },
          select: { employeeId: true, amount: true },
        })
      : Promise.resolve([]),
    paies.length
      ? prisma.payrollWire.findMany({
          where: { OR: paies.map((p) => ({ companyId: p.companyId, year: p.month === 1 ? p.year - 1 : p.year, month: p.month === 1 ? 12 : p.month - 1 })) },
          select: { companyId: true, year: true, month: true, amount: true },
        })
      : Promise.resolve([]),
    caisses.length
      ? prisma.pettyCashAllotment.findMany({
          where: { departmentId: { in: caisses.map((c) => c.departmentId) }, id: { notIn: caisses.map((c) => c.id) }, createdAt: { gte: new Date(maintenant.getTime() - ANNEE_MS) } },
          select: { departmentId: true, amount: true },
        })
      : Promise.resolve([]),
  ]);
  const nomDe = new Map(noms.map((u) => [u.id, u.name]));
  const nomDoc = new Map(docsPieces.map((d) => [d.id, d.name]));
  const fichierDuRegistre = new Map<string, string>();
  for (const f of fichiersRegistre) if (!fichierDuRegistre.has(f.entityId)) fichierDuRegistre.set(f.entityId, f.id);

  // ── Les briques des autres métiers — chacune peut manquer ou tomber sans emporter la fiche ───
  // Les GARDE-FOUS (24/11/2026) : qui a approuvé en amont (séparation des tâches) et le signal « possible fractionnement ».
  const garde = (o: { id: string; sourceType: string | null; sourceId: string | null }) => ({ id: o.id, sourceType: o.sourceType, sourceId: o.sourceId });
  const [apportsLus, doublons, liens, factures, enAmont, fractionnements] = await Promise.all([
    Promise.all((briques.apports ?? []).map((b) => essayer(b.nom, manques, new Map<string, ApportContexte>(), () => b.lire(pourBriques)))),
    briques.doublons ? essayer("doublons", manques, new Map<string, string>(), () => briques.doublons!(ordreIds)) : Promise.resolve(new Map<string, string>()),
    briques.liens ? essayer("liens", manques, new Map<string, string | null>(), () => briques.liens!(pourBriques)) : Promise.resolve(new Map<string, string | null>()),
    essayer("factures", manques, null as Set<string> | null, () => ordresAvecFacture(ordres.map((o) => ({ id: o.id, sourceType: o.sourceType, sourceId: o.sourceId })))),
    essayer("approbations en amont", manques, new Map<string, string[]>(), () => approbateursEnAmontDesOrdres(ordres.map(garde))),
    essayer("fractionnement", manques, new Map<string, SignalFractionnement>(), () => signauxDeFractionnement(ordreIds)),
  ]);
  const apportDe = (id: string): ApportContexte => {
    const out: ApportContexte = {};
    for (const m of apportsLus) {
      const a = m.get(id);
      if (!a) continue;
      // Les listes s'ajoutent, les valeurs simples : la première brique qui les donne.
      out.chaine = [...(out.chaine ?? []), ...(a.chaine ?? [])];
      out.pieces = [...(out.pieces ?? []), ...(a.pieces ?? [])];
      out.alertes = [...(out.alertes ?? []), ...(a.alertes ?? [])];
      if (a.jalons && !out.jalons) out.jalons = a.jalons;
      for (const k of ["origine", "referenceOrigine", "objet", "demandeur", "demandeLe", "budgetCategoryId", "dejaPaye"] as const) {
        if (a[k] !== undefined && out[k] === undefined) (out as Record<string, unknown>)[k] = a[k];
      }
    }
    return out;
  };

  // LE BUDGET : la catégorie de l'ordre, sinon celle de sa source ; paie, caisse et avance sur salaire n'en ont pas.
  const horsBudget = (f: FamilleOrdre) => f === "PAIE" || f === "CAISSE" || f === "AVANCE";
  const budgets = briques.budget
    ? await essayer("budget", manques, null as Map<string, BudgetDecision> | null, () => briques.budget!(
        pourBriques.filter((o) => !horsBudget(o.famille)).map((o) => ({
          id: o.id, categoryId: o.budgetCategoryId ?? apportDe(o.id).budgetCategoryId ?? null, montant: o.montant, sourceType: o.sourceType,
        })),
      ))
    : null;

  const fiches = ordres.map((o): ContexteDecision => {
    const famille = familleDeLOrdre.get(o.id) ?? "AUTRE";
    const apport = apportDe(o.id);
    const montant = toNumber(o.amount);
    const alertes: AlerteDecision[] = [];
    const chaine: EtapeChaine[] = [];
    const pieces: PieceDecision[] = [];
    const jalons: JalonLu[] = [];
    let referenceOrigine: string | null = apport.referenceOrigine ?? null;
    let demandeur: string | null = apport.demandeur ?? o.requestedBy?.name ?? null;
    let demandeLe: Date = apport.demandeLe ?? o.createdAt;
    let dejaPaye: string | null = apport.dejaPaye ?? null;

    // ── Le dossier de demande de paiement (source ou compagnon) ──────────────────────────────
    const dossier = dossiers.find((d) => d.id === o.sourceId && o.sourceType === "PAYMENT_REQUEST")
      ?? dossiers.find((d) => d.expenseOrderId === o.id) ?? null;
    if (dossier && famille === "DEMANDE_PAIEMENT") {
      referenceOrigine ??= dossier.reference;
      demandeur = nomDe.get(dossier.requesterId) ?? demandeur;
      demandeLe = dossier.submittedAt ?? dossier.createdAt;
      chaine.push(dossier.decidedAt && dossier.decidedById
        ? { etape: "Bon à payer des Finances", detail: `${nomDe.get(dossier.decidedById) ?? "Finances"} · ${jour(dossier.decidedAt)}`, etat: "OK" }
        : { etape: "Bon à payer des Finances", detail: "non donné", etat: "ATTENTE" });
    }
    if (dossier) {
      // Les pièces EN VIGUEUR : une pièce remplacée ne justifie plus rien.
      for (const p of dossier.pieces) {
        if (p.replacedBy) continue;
        const nom = nomDoc.get(p.documentId);
        pieces.push({ nom: `${LIBELLE_PIECE[p.kind] ?? "Pièce"}${p.status === "REJECTED" ? " (refusée)" : ""}`, present: p.status !== "REJECTED", documentId: p.documentId, fichier: nom ?? null });
      }
    }
    for (const f of fichiersOrdre.filter((f) => f.entityId === o.id)) pieces.push({ nom: "Pièce jointe à l'ordre", present: true, documentId: f.id, fichier: f.name });

    // ── Les pièces du registre attachées à l'ordre : BC (plafond) et facture(s) ───────────────
    const siennes = registre.filter((r) => r.expenseOrderId === o.id);
    const bcs = siennes.filter((r) => r.kind === "PURCHASE_ORDER");
    const facturesDuRegistre = siennes.filter((r) => r.kind === "INVOICE");
    for (const r of siennes) {
      const libelle = r.kind === "INVOICE" ? "Facture" : r.kind === "PURCHASE_ORDER" ? "BC" : "Devis";
      pieces.push({ nom: `${libelle} ${r.reference ?? r.title}${r.amount != null ? ` · ${dzd(toNumber(r.amount))}` : ""}`, present: true, documentId: fichierDuRegistre.get(r.id) ?? null });
    }
    if (!apport.jalons) {
      for (const bc of bcs) {
        if (bc.amount == null) continue;
        jalons.push({ libelle: `BC ${bc.reference ?? ""}`.trim(), valeur: toNumber(bc.amount), plafond: "BC", nomme: `BC n°${bc.reference ?? bc.title}${bc.signedAt ? " signé" : ""}` });
      }
      const ttc = facturesDuRegistre.map((f) => (f.amount != null ? toNumber(f.amount) : null)).filter((x): x is number => x != null);
      if (ttc.length) jalons.push({ libelle: "Facture", valeur: ttc.reduce((s, x) => s + x, 0) });
    }
    if (bcs.length) {
      for (const bc of bcs) chaine.push({ etape: `BC n°${bc.reference ?? bc.title}`, detail: bc.signedAt ? `signé le ${jour(bc.signedAt)}` : "non signé", etat: bc.signedAt ? "OK" : "ATTENTE" });
    } else if (famille === "DEMANDE_PAIEMENT" && !(apport.chaine ?? []).some((c) => c.etape.startsWith("BC"))) {
      chaine.push({ etape: "Bon de commande", detail: "aucun — demande sans BC", etat: "ATTENTE" });
    }

    // ── Les familles dont le module connaît les faits ───────────────────────────────────────
    let historique: string | null = null;
    if (famille === "AVANCE") {
      const a = avancesLues.find((x) => x.id === o.sourceId);
      if (a) {
        demandeur = a.employee.fullName;
        demandeLe = a.createdAt;
        chaine.push({ etape: "Avance accordée par les RH", detail: a.decidedAt ? `${a.decidedBy?.name ?? "RH"} · ${jour(a.decidedAt)}` : "décision non datée", etat: a.decidedAt ? "OK" : "ATTENTE" });
        const passees = avancesPassees.filter((p) => p.employeeId === a.employeeId);
        historique = passees.length
          ? `${passees.length} autre${passees.length > 1 ? "s" : ""} avance${passees.length > 1 ? "s" : ""} en 12 mois, ${montantCourt(passees.reduce((s, p) => s + toNumber(p.amount), 0))}`
          : "1re avance en 12 mois";
      }
    }
    if (famille === "PAIE" && o.payrollWire) {
      const w = o.payrollWire;
      const nets = entreesPaie.filter((e) => e.payrollWireId === w.id);
      const somme = nets.reduce((s, e) => s + toNumber(e.net), 0);
      referenceOrigine ??= `Paie ${String(w.month).padStart(2, "0")}/${w.year}`;
      if (w.createdById) demandeur = nomDe.get(w.createdById) ?? demandeur;
      demandeLe = w.createdAt;
      chaine.push({ etape: "Paie calculée et envoyée", detail: `RH · ${jour(w.createdAt)} · ${nets.length} salaire${nets.length > 1 ? "s" : ""}`, etat: nets.length ? "OK" : "ATTENTE" });
      const ecart = Math.round((montant - somme) * 100) / 100;
      chaine.push({ etape: "Somme déclarée = somme des nets", detail: `écart ${dzd(Math.abs(ecart))} DZD`, etat: Math.abs(ecart) <= 1 ? "OK" : "KO" });
      if (Math.abs(ecart) > 1 && nets.length) {
        alertes.push({ titre: "Paie : somme ≠ nets", detail: `virement ${dzd(montant)} DZD, somme des nets ${dzd(somme)} DZD`, niveau: "BLOQUANT" });
      }
      const avant = paiesPrecedentes.find((p) => p.companyId === w.companyId && (w.month === 1 ? p.year === w.year - 1 && p.month === 12 : p.year === w.year && p.month === w.month - 1));
      if (avant && !apport.jalons) jalons.push({ libelle: "Mois précédent", valeur: toNumber(avant.amount) });
      historique = avant ? `mois précédent : ${montantCourt(toNumber(avant.amount))}` : "premier virement de paie connu";
      dejaPaye ??= "Aucun autre virement de paie ce mois";
    }
    if (famille === "CAISSE" && o.pettyCashAllotment) {
      const c = o.pettyCashAllotment;
      referenceOrigine ??= `Caisse ${c.department.name} · ${c.period}`;
      demandeur = c.createdBy?.name ?? demandeur;
      demandeLe = c.createdAt;
      chaine.push({ etape: "Remise inscrite par les RH", detail: `détentrice : ${c.holder?.name ?? "non désignée"}`, etat: "OK" });
      const passees = remisesPassees.filter((r) => r.departmentId === c.departmentId);
      historique = passees.length ? `${passees.length} remise${passees.length > 1 ? "s" : ""} en 12 mois, ${montantCourt(passees.reduce((s, r) => s + toNumber(r.amount), 0))}` : "1re remise en 12 mois";
    }

    // ── L'historique du bénéficiaire (un tiers, pas un salarié ni une caisse) ───────────────
    const tiers = famille !== "PAIE" && famille !== "CAISSE" && famille !== "AVANCE";
    if (tiers && o.beneficiary?.trim()) {
      const jamais = !benefTous.some((g) => memeBeneficiaire(g.beneficiary, o.beneficiary));
      const annee = benefAnnee.filter((g) => memeBeneficiaire(g.beneficiary, o.beneficiary));
      const derniers = annee.map((g) => g._max.paidDate ?? g._max.updatedAt).filter((d): d is Date => Boolean(d));
      historique = phraseHistorique({
        nombre: annee.reduce((s, g) => s + g._count._all, 0),
        total: annee.reduce((s, g) => s + toNumber(g._sum.amount ?? 0), 0),
        dernier: derniers.length ? new Date(Math.max(...derniers.map((d) => d.getTime()))) : null,
      });
      if (jamais) alertes.push({ titre: "Bénéficiaire nouveau", detail: "aucun paiement passé à ce nom", niveau: "ATTENTION" });
    }

    // ── Les alertes ─────────────────────────────────────────────────────────────────────────
    const doublon = doublons.get(o.id);
    if (doublon) alertes.unshift({ titre: "Doublon possible", detail: doublon, niveau: "BLOQUANT" });
    if (o.requiresInvoice && factures && !factures.has(o.id)) {
      alertes.push({ titre: "Sans facture", detail: "la facture est exigée avant le règlement et n'est pas jointe", niveau: "BLOQUANT" });
      pieces.push({ nom: "Facture", present: false, documentId: null });
    }
    const refusAutoriser = refusSeparationDesTaches("AUTORISER", { ...o, approbateursEnAmont: enAmont.get(o.id) ?? [] }, user.id, reglages.separationTachesPaiement, user.role === "SUPER_ADMIN");
    if (refusAutoriser) alertes.push({ titre: o.requestedById === user.id ? "Demandeur = décideur" : "Approbateur = décideur", detail: refusAutoriser, niveau: "BLOQUANT" });
    const fractionnement = fractionnements.get(o.id);
    if (fractionnement) alertes.push({ titre: "Possible fractionnement", detail: phraseFractionnement(fractionnement), niveau: "ATTENTION" });
    const revision = [...o.centralMessages].reverse().find((m) => !m.decision && /autorisation est à redonner/.test(m.body));
    if (revision) alertes.push({ titre: "Ordre révisé", detail: revision.body, niveau: "ATTENTION" });
    alertes.push(...(apport.alertes ?? []));
    const { montants, alertes: ecarts } = montantsEtEcarts(montant, apport.jalons ?? jalons);
    alertes.push(...ecarts);

    const budget: BudgetDecision = horsBudget(famille)
      ? {
          etat: "HORS_ENVELOPPE",
          phrase: famille === "PAIE" ? "Hors enveloppe : la masse salariale s'impute par service"
            : famille === "AVANCE" ? "Hors budget : une avance sur salaire n'est pas une charge, elle est reprise sur la paie"
              : "Hors budget : une remise de caisse n'est pas une dépense, ses achats s'imputent un à un",
        }
      : budgets?.get(o.id) ?? (budgets ? { etat: "NON_IMPUTE" } : { etat: "INCONNU" });
    const depasse = alerteBudget(budget);
    if (depasse) alertes.push(depasse);
    const treso = alerteTresorerie(montant, opts.disponible ?? null);
    if (treso) alertes.push(treso);
    if (manques.length) {
      alertes.push({ titre: "Contexte incomplet", detail: `lecture impossible pour le moment : ${[...new Set(manques)].join(", ")} — décidez pièces en main`, niveau: "ATTENTION" });
    }

    // ── Déjà payé sur la même demande ───────────────────────────────────────────────────────
    if (dejaPaye == null) {
      const memes = payesMemeSource.filter((p) => p.sourceType === o.sourceType && p.sourceId === o.sourceId && o.sourceId);
      dejaPaye = memes.length
        ? `${memes.length} paiement${memes.length > 1 ? "s" : ""} déjà réglé${memes.length > 1 ? "s" : ""} : ${montantCourt(memes.reduce((s, p) => s + toNumber(p.amount), 0))} (${memes.map((m) => m.reference).join(", ")})`
        : historique === PREMIER_PAIEMENT ? "Rien d'autre — 1er paiement" : "Rien d'autre sur cette demande";
    }

    // Les pièces : une seule ligne par fichier, les apports d'abord (ils portent la chaîne d'achat).
    const vues = new Set<string>();
    const toutes = [...(apport.pieces ?? []), ...pieces].filter((p) => {
      if (!p.documentId) return true;
      if (vues.has(p.documentId)) return false;
      vues.add(p.documentId);
      return true;
    });

    return {
      id: o.id,
      reference: [o.reference, referenceOrigine].filter(Boolean).join(" · "),
      origine: apport.origine ?? (famille === "AUTRE" && o.sourceType ? ENTITY_TYPE_LABELS[o.sourceType] ?? ORIGINE_DE_LA_FAMILLE.AUTRE : ORIGINE_DE_LA_FAMILLE[famille]),
      objet: apport.objet ?? o.label,
      beneficiaire: o.beneficiary,
      historique,
      montant,
      echeance: o.dueDate?.toISOString() ?? null,
      echeanceFixe: deadlineNatureOf(o.deadlineNature) === "FIXED",
      demandeur,
      demandeLe: demandeLe.toISOString(),
      alertes,
      chaine: [...(apport.chaine ?? []), ...chaine],
      pieces: toutes,
      montants,
      budget,
      dejaPaye,
      centralStatus: o.centralStatus,
      estLeDemandeur: o.requestedById === user.id,
      refusAutoriser,
      dossierHref: dossier ? paymentDossierHref(dossier.id) : null,
      origineHref: liens.get(o.id) ?? null,
      fil: o.centralMessages.map((m) => ({ id: m.id, auteur: m.author?.name ?? null, decision: m.decision, texte: m.body, le: m.createdAt.toISOString() })),
      piecesReclamees: reclamees.filter((r) => r.entityId === o.id).map((r) => ({ id: r.id, libelle: r.label, a: r.askedTo?.name ?? null, deposee: r.status === "SUBMITTED" })),
      note: o.notes?.trim() || null,
    };
  });

  // LE NOM DU FICHIER de chaque pièce ouvrable : c'est lui qui dit à l'aperçu comment la rendre (PDF, Word, image…).
  const sansNom = [...new Set(fiches.flatMap((f) => f.pieces.filter((p) => p.documentId && !p.fichier).map((p) => p.documentId as string)))];
  const nomsFichiers = sansNom.length
    ? new Map((await prisma.document.findMany({ where: { id: { in: sansNom } }, select: { id: true, name: true } })).map((d) => [d.id, d.name] as const))
    : new Map<string, string>();
  for (const f of fiches) for (const p of f.pieces) if (p.documentId && !p.fichier) p.fichier = nomsFichiers.get(p.documentId) ?? null;
  return fiches;
}

/** L'HISTORIQUE DU CENTRE (menu ⋯ « Déjà décidés ») — une ligne légère par ordre décidé, le plus récent d'abord. */
export async function historiqueDuCentre(ids: readonly string[]) {
  if (ids.length === 0) return [];
  const rows = await prisma.expenseOrder.findMany({
    where: { id: { in: [...ids] } },
    orderBy: [{ centralDecidedAt: "desc" }, { createdAt: "desc" }],
    select: { id: true, reference: true, label: true, beneficiary: true, amount: true, centralStatus: true, centralDecidedAt: true, centralDecidedById: true },
  });
  const deciders = [...new Set(rows.map((r) => r.centralDecidedById).filter((x): x is string => Boolean(x)))];
  const noms = new Map(deciders.length ? (await prisma.user.findMany({ where: { id: { in: deciders } }, select: { id: true, name: true } })).map((u) => [u.id, u.name] as const) : []);
  return rows.map((r) => ({
    id: r.id, reference: r.reference, objet: r.label, beneficiaire: r.beneficiary, montant: toNumber(r.amount),
    centralStatus: r.centralStatus, decideLe: r.centralDecidedAt?.toISOString() ?? null,
    decideur: r.centralDecidedById ? noms.get(r.centralDecidedById) ?? null : null,
  }));
}

export type LigneHistoriqueCentre = Awaited<ReturnType<typeof historiqueDuCentre>>[number];
