import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { sansBloquer } from "@/lib/journal";
import { jourAlger, lotDeSignaux, type LigneSignal, type Producteur, type SourceSignal } from "../domaine/signaux";
import { FENETRE_DECISION_JOURS, cleProposition, verdictProposition, type Verdict } from "../domaine/propositions";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * ÉCRIRE DANS LES SIGNAUX DATÉS — les trois écrivains du module.
 *
 *   • `ecrireSignaux` — des MESURES (statut CONSTATE) : un upsert par (source, nature, cle, jour), donc un rejeu le même
 *     jour réécrit la même ligne et le lendemain en ajoute une ; rien ne s'efface jamais.
 *   • `noterProposition` — une IA vient de PROPOSER : la proposition est gardée (statut PROPOSE), qu'elle soit retenue
 *     ou non. Créée une fois : rejouée le même jour, elle rend la même ligne.
 *   • `noterDecision` — le GESTE humain qui suit : ce qui a été retenu, par qui, quand, et le verdict.
 *
 * AUCUN NE BLOQUE LE GESTE MÉTIER : un échec d'écriture du journal est journalisé (`sansBloquer`) et l'appelant continue
 * — on n'empêche pas une personne d'enregistrer sa dépense parce que la mémoire de l'IA est en panne.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const json = (v: unknown): Prisma.InputJsonValue => (v ?? {}) as Prisma.InputJsonValue;

function donnees(l: LigneSignal) {
  return {
    producteur: l.producteur ?? "regle",
    companyId: l.companyId ?? null, buId: l.buId ?? null, wilayaCode: l.wilayaCode ?? null, productId: l.productId ?? null,
    doctorId: l.doctorId ?? null, budgetEnvelopeId: l.budgetEnvelopeId ?? null, entiteType: l.entiteType ?? null, entiteId: l.entiteId ?? null,
    valeur: l.valeur ?? null, unite: l.unite ?? null, gravite: l.gravite ?? null, charge: json(l.charge),
  };
}

/** Écrit (ou réécrit pour le jour) un lot de mesures. Rend le nombre de lignes écrites. Lève sur une panne de base. */
export async function ecrireSignaux(lignes: readonly LigneSignal[]): Promise<number> {
  let n = 0;
  for (const l of lotDeSignaux(lignes)) {
    const d = donnees(l);
    await prisma.signalDate.upsert({
      where: { source_nature_cle_jour: { source: l.source, nature: l.nature, cle: l.cle, jour: l.jour } },
      create: { jour: l.jour, source: l.source, nature: l.nature, cle: l.cle, statut: "CONSTATE", ...d },
      update: d,
    });
    n += 1;
  }
  return n;
}

/** La même chose, sans jamais lever : pour un écran qui calcule (Voix du terrain, Produits 360) et ne doit pas casser. */
export async function ecrireSignauxSansBloquer(lignes: readonly LigneSignal[], evenement: string): Promise<number> {
  return ecrireSignaux(lignes).catch(sansBloquer(`pilotage.${evenement}`, 0));
}

export interface PropositionANoter {
  /** La fonction d'IA (son code `AiFeature`). */
  source: SourceSignal;
  /** Ce qui est proposé : « definitions », « cibles », « justification », « natures », « postes », « champs_contrat »… */
  nature: string;
  /** La personne pour qui l'IA a proposé — celle dont le geste suivant tranchera. */
  auteurId: string;
  /** Ce sur quoi porte la proposition, quand cela existe déjà (une ligne de budget, une demande RH, une demande Ad & Pro). */
  cible?: { type: string; id: string } | null;
  propose: unknown;
  producteur: Producteur;
  companyId?: string | null;
  /** Le contexte utile à la relecture (modèle, note) — jamais une donnée du coffre. */
  contexte?: Record<string, unknown>;
  maintenant?: Date;
}

/** GARDER UNE PROPOSITION. Rend l'identifiant de la ligne, ou `null` si le journal n'a pas pu l'écrire (journalisé). */
export async function noterProposition(p: PropositionANoter): Promise<string | null> {
  try {
    const jour = jourAlger(p.maintenant ?? new Date());
    const cle = cleProposition(p.auteurId, p.cible ?? null, p.propose);
    const ou = { source_nature_cle_jour: { source: p.source, nature: p.nature, cle, jour } };
    // `skipDuplicates` plutôt qu'un P2002 rattrapé : la même proposition rejouée le même jour rend la ligne existante.
    await prisma.signalDate.createMany({
      data: [{
        jour, source: p.source, nature: p.nature, cle, statut: "PROPOSE", producteur: p.producteur, auteurId: p.auteurId,
        companyId: p.companyId ?? null, entiteType: p.cible?.type ?? null, entiteId: p.cible?.id ?? null,
        charge: json({ propose: p.propose, ...(p.contexte ?? {}) }),
      }],
      skipDuplicates: true,
    });
    return (await prisma.signalDate.findUnique({ where: ou, select: { id: true } }))?.id ?? null;
  } catch (e) {
    return sansBloquer(`pilotage.noterProposition.${p.source}.${p.nature}`, null)(e);
  }
}

export interface DecisionANoter {
  source: SourceSignal;
  nature: string;
  /** L'auteur de la proposition — le geste se rattache à SA dernière proposition ouverte. */
  auteurId: string;
  cible?: { type: string; id: string } | null;
  /** Ce que l'humain a retenu (`null` : rien — la proposition est écartée). */
  retenu: unknown;
  decideurId: string;
  /**
   * « remplacer » : le geste dit tout ce qui est retenu (un formulaire enregistré).
   * « ajouter » : le geste retient UN élément de plus (un poste ajouté après l'autre) — la liste retenue s'allonge.
   */
  mode?: "remplacer" | "ajouter";
  /** La fenêtre de rattachement, en heures (par défaut `FENETRE_DECISION_JOURS`) — plus courte quand la cible est vague. */
  fenetreHeures?: number;
  maintenant?: Date;
}

/**
 * NOTER LA DÉCISION HUMAINE sur la dernière proposition ouverte de la même personne, sur la même cible, dans la fenêtre
 * (`FENETRE_DECISION_JOURS`). Aucune proposition ouverte : rien n'est écrit (le geste n'en suivait pas). Rend le verdict,
 * ou `null`. Ne lève jamais.
 */
export async function noterDecision(d: DecisionANoter): Promise<Verdict | null> {
  try {
    const maintenant = d.maintenant ?? new Date();
    const ajouter = d.mode === "ajouter";
    const p = await prisma.signalDate.findFirst({
      where: {
        source: d.source, nature: d.nature, auteurId: d.auteurId,
        statut: { in: ajouter ? ["PROPOSE", "ACCEPTE", "MODIFIE"] : ["PROPOSE"] },
        entiteType: d.cible?.type ?? null, entiteId: d.cible?.id ?? null,
        creeLe: { gte: new Date(maintenant.getTime() - (d.fenetreHeures ?? FENETRE_DECISION_JOURS * 24) * 3_600_000) },
      },
      orderBy: { creeLe: "desc" },
      select: { id: true, charge: true, retenu: true, statut: true, majLe: true },
    });
    if (!p) return null;
    const charge = (p.charge && typeof p.charge === "object" && !Array.isArray(p.charge) ? p.charge : {}) as Record<string, unknown>;
    const retenu = ajouter
      ? [...(Array.isArray(p.retenu) ? p.retenu : []), ...(Array.isArray(d.retenu) ? d.retenu : [d.retenu])]
      : d.retenu;
    const v = verdictProposition(charge.propose, retenu);
    // LA TRANSITION SOUS CONDITION (§118.151) : deux gestes simultanés ne tranchent pas deux fois la même proposition.
    const r = await prisma.signalDate.updateMany({
      where: { id: p.id, statut: p.statut, majLe: p.majLe },
      data: { statut: v.verdict, retenu: retenu === null || retenu === undefined ? Prisma.DbNull : json(retenu), decideParId: d.decideurId, decideLe: maintenant, charge: json({ ...charge, verdict: v }) },
    });
    return r.count ? v.verdict : null;
  } catch (e) {
    return sansBloquer(`pilotage.noterDecision.${d.source}.${d.nature}`, null)(e);
  }
}
