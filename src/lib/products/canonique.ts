import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { createWithRetry, enSerie } from "@/lib/refs";
import { identityKey, manquesIdentite, type ProductIdentity, type TraitIdentite } from "./identity";
import { collisionSur, nextProductCode } from "./resolve";
import {
  cleProduitDuDossier, identiteFusionnee, planProduitDuDossier, type IdentiteProduit,
} from "./produit-du-dossier";
import { sansBloquer } from "@/lib/journal";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * PRODUIT = DOSSIER RÉGLEMENTAIRE (Direction, 07/10 puis 08/10 : « un seul catalogue de produits »).
 *
 * ── CE QUI A CHANGÉ ──────────────────────────────────────────────────────────────────────
 *
 * L'ancien catalogue (§118.178) ne rattachait un dossier à un produit que sur son identité
 * COMPLÈTE, et faisait rejoindre le même produit à deux dossiers de même identité. Résultat à
 * l'écran : deux mondes — « 69 rattachés, 76 incomplets, non rattachés », un écran de
 * rattachement, des produits de BU qu'on ne pouvait pas rapporter en visite. La Direction l'a
 * refusé : chaque dossier EST un produit, d'office.
 *
 * Désormais (`produit-du-dossier.ts` pour la règle, pure et éprouvée ; ici la lecture et l'écriture) :
 *   - chaque dossier non verrouillé reçoit SON produit, à sa création et à chaque modification
 *     (`ensureProduitDuDossier`), et l'existant au démarrage du serveur (`assurerProduitsDesDossiers`) ;
 *   - un dossier ne rejoint JAMAIS le produit d'un autre ; une identité incomplète est une
 *     indication sur la fiche, pas un blocage ;
 *   - un produit déjà partagé par plusieurs dossiers n'est pas scindé d'office : le bilan le liste.
 *
 * ── LES PROFILS HÉRITIERS ────────────────────────────────────────────────────────────────
 *
 * Un produit de BU ou de BD rattaché à ce dossier et sans produit (ou avec l'ANCIEN produit du
 * dossier) le tenait du dossier : il le suit. Celui qu'une personne a lié à un AUTRE produit garde
 * son lien — on ne défait pas une décision humaine par effet de bord.
 *
 * Ce module ne vérifie AUCUN droit : il est appelé par des actions qui ont déjà vérifié le leur, et
 * par le démarrage du serveur. Il ne lit ni n'écrit la session.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Le tuple d'identité d'un dossier — la forme du menu des dossiers, telle quelle. */
export function tupleDuDossier(d: { dci: string; dosage: string | null; dosageUnit: string | null; pharmaceuticalForm: string | null; packaging: string | null }): ProductIdentity {
  return { dci: d.dci, dosage: d.dosage, dosageUnit: d.dosageUnit, form: d.pharmaceuticalForm, packaging: d.packaging };
}

/**
 * LE CYCLE DE VIE QUE LES DOSSIERS PROUVENT. Une décision OBTENUE prouve un enregistrement ;
 * tout le reste — présoumission, dépôt, attente ANPP — décrit un produit à l'étude. Le dérivé ne
 * touche jamais « commercialisé » ni « arrêté » : ce sont des décisions humaines, qu'aucun statut
 * de dossier ne contredit.
 */
export function cycleDeVieDerive(statuts: readonly string[], actuel: string): string {
  if (actuel !== "STUDY" && actuel !== "REGISTERED") return actuel;
  return statuts.includes("DECISION_OBTAINED") ? "REGISTERED" : "STUDY";
}

/** Recalcule le cycle de vie d'un produit d'après TOUS ses dossiers. */
export async function synchroniserCycleDeVie(productId: string): Promise<void> {
  const p = await prisma.product.findUnique({
    where: { id: productId },
    select: { lifecycle: true, regulatoryProfiles: { select: { status: true } } },
  });
  if (!p) return;
  const voulu = cycleDeVieDerive(p.regulatoryProfiles.map((d) => d.status), p.lifecycle);
  if (voulu !== p.lifecycle) await prisma.product.update({ where: { id: productId }, data: { lifecycle: voulu } });
}

/**
 * LES PROFILS QUI HÉRITAIENT DU PRODUIT DU DOSSIER LE SUIVENT — ceux sans produit, et ceux qui
 * portaient l'ANCIEN produit du dossier. Rend le nombre de profils déplacés.
 */
export async function suivreLeDossier(dossierId: string, ancien: string | null, nouveau: string): Promise<number> {
  const heritiers = {
    regulatoryProductId: dossierId,
    OR: [{ productId: null }, ...(ancien && ancien !== nouveau ? [{ productId: ancien }] : [])],
  };
  const [promo, bd] = await Promise.all([
    prisma.promoProduct.updateMany({ where: heritiers, data: { productId: nouveau } }),
    prisma.bdProduct.updateMany({ where: heritiers, data: { productId: nouveau } }),
  ]);
  return promo.count + bd.count;
}

// ─────────────────────────── Un dossier, son produit ───────────────────────────

/** Ce qu'est devenu le produit d'un dossier. `manques` = l'indication de la fiche (vide si l'identité est complète). */
export type ProduitDuDossier =
  | { etat: "CREE" | "MIS_A_JOUR" | "DEJA"; produitId: string; code: string; manques: TraitIdentite[]; profilsSuivis: number }
  /** Produit partagé avec d'autres dossiers (ancien catalogue) — laissé tel quel, listé au bilan. */
  | { etat: "PARTAGE"; produitId: string; code: string; manques: TraitIdentite[]; profilsSuivis: number; autresDossiers: number }
  /** Le dossier s'écartait du produit qu'il partageait : il a reçu le sien. */
  | { etat: "SEPARE"; produitId: string; code: string; manques: TraitIdentite[]; profilsSuivis: number; ancienProduitId: string }
  /** Dossier verrouillé (pipeline confidentiel) sans produit : il recevra le sien à l'ouverture du cadenas. */
  | { etat: "VERROUILLE" }
  | { etat: "INTROUVABLE" };

const SELECT_DOSSIER = {
  id: true, reference: true, dci: true, dosage: true, dosageUnit: true, pharmaceuticalForm: true,
  packaging: true, channel: true, companyId: true, status: true, productId: true, isLocked: true,
  canonicalProduct: {
    select: {
      id: true, code: true, identityKey: true, canonicalName: true,
      dci: true, dosage: true, dosageUnit: true, form: true, packaging: true,
      _count: { select: { regulatoryProfiles: true } },
    },
  },
} as const;

/** Le produit qui porte déjà la clé d'identité COMPLÈTE de ce tuple — `null` si personne (ou incomplet). */
async function porteurDeLaCle(t: ProductIdentity): Promise<string | null> {
  if (manquesIdentite(t).length > 0) return null;
  const cle = identityKey(t);
  if (!cle) return null;
  return (await prisma.product.findUnique({ where: { identityKey: cle }, select: { id: true } }))?.id ?? null;
}

/**
 * CRÉE le produit d'un dossier — un code `PRD-AAAA-NNN` par la numérotation de l'ERP, les créations
 * en série dans ce processus (`enSerie`), réessayées entre processus (`createWithRetry`). La clé est
 * RECALCULÉE à chaque essai : si un autre écrivain vient de prendre la clé d'identité, ce produit
 * prend la clé suffixée du dossier — il ne rejoint jamais le produit d'un autre dossier.
 * Rend `null` si, entre-temps, le dossier a reçu un produit (l'appelant relit).
 */
async function creerProduitDuDossier(
  d: { id: string; reference: string; channel: "RETAIL" | "HOSPITAL" | "BOTH"; companyId: string | null; status: string; productId: string | null },
  identite: IdentiteProduit,
  nom: string,
): Promise<{ id: string; code: string } | null> {
  return enSerie("PRD", () => createWithRetry(async () => {
    // Relu SOUS le tour de file : un écrivain de ce processus a pu poser le produit pendant l'attente.
    const encore = await prisma.regulatoryProduct.findUnique({ where: { id: d.id }, select: { productId: true } });
    if (!encore || encore.productId !== d.productId) return null;
    const cle = cleProduitDuDossier(d.id, identite, await porteurDeLaCle(identite));
    const code = await nextProductCode();
    return prisma.product.create({
      data: {
        code, canonicalName: nom, identityKey: cle,
        dci: identite.dci || d.reference,
        dosage: identite.dosage, dosageUnit: identite.dosageUnit, form: identite.form, packaging: identite.packaging,
        channel: d.channel, companyId: d.companyId,
        lifecycle: d.status === "DECISION_OBTAINED" ? "REGISTERED" : "STUDY",
      },
      select: { id: true, code: true },
    });
  }));
}

/**
 * ASSURE LE PRODUIT D'UN DOSSIER — appelé à la création et à chaque modification du dossier, à
 * l'ouverture du cadenas, à l'ajout d'un produit de BU depuis son dossier, et par le bilan de
 * démarrage. Idempotent : rappelé sur un dossier déjà juste, il rend `DEJA` sans rien écrire
 * (hors profils orphelins à rattacher).
 */
export async function ensureProduitDuDossier(dossierId: string, opts: { acteurId?: string | null } = {}, essai = 0): Promise<ProduitDuDossier> {
  const d = await prisma.regulatoryProduct.findUnique({ where: { id: dossierId }, select: SELECT_DOSSIER });
  if (!d) return { etat: "INTROUVABLE" };
  // Un dossier du pipeline n'entre pas au catalogue tant qu'il est verrouillé : son produit
  // révélerait le projet (recherche, résolution des mentions). Il le reçoit au déverrouillage.
  if (!d.productId && d.isLocked) return { etat: "VERROUILLE" };

  const tuple = tupleDuDossier(d);
  const manques = manquesIdentite(tuple);
  const actuel = d.canonicalProduct;
  const produit = actuel ? { ...actuel, autresDossiers: Math.max(0, actuel._count.regulatoryProfiles - 1) } : null;
  const retenue = identiteFusionnee(tuple, produit);
  const plan = planProduitDuDossier({
    dossier: { id: d.id, reference: d.reference, identite: tuple },
    produit,
    porteurDeLaCle: await porteurDeLaCle(retenue),
  });
  const acteurId = opts.acteurId ?? null;

  if (plan.action === "CREER" || plan.action === "SEPARER") {
    const cree = await creerProduitDuDossier(d, plan.identite, plan.nom);
    if (!cree) {
      // Le dossier a reçu un produit pendant l'attente : on relit (une fois) au lieu d'en créer un second.
      return essai < 2 ? ensureProduitDuDossier(dossierId, opts, essai + 1) : { etat: "INTROUVABLE" };
    }
    const pose = await prisma.regulatoryProduct.updateMany({ where: { id: d.id, productId: d.productId }, data: { productId: cree.id } });
    if (pose.count === 0) {
      // Course perdue entre PROCESSUS : l'autre a posé le sien. Le nôtre, que rien ne référence encore, s'efface.
      await prisma.product.delete({ where: { id: cree.id } }).catch(sansBloquer("canonique.ensureProduitDuDossier.product"));
      return essai < 2 ? ensureProduitDuDossier(dossierId, opts, essai + 1) : { etat: "INTROUVABLE" };
    }
    const ancien = plan.action === "SEPARER" ? plan.ancienProduitId : null;
    const profilsSuivis = await suivreLeDossier(d.id, ancien, cree.id);
    await synchroniserCycleDeVie(cree.id);
    if (ancien) await synchroniserCycleDeVie(ancien);
    await recordAudit({
      actorId: acteurId, action: "CREATE", module: "Regulatory", entityType: "PRODUCT", entityId: cree.id,
      summary: ancien
        ? `Produit ${cree.code} créé pour le dossier ${d.reference} — son identité s'écarte du produit qu'il partageait (${actuel?.code ?? "?"})`
        : `Produit ${cree.code} créé pour le dossier ${d.reference} — ${plan.nom}`,
    });
    return ancien
      ? { etat: "SEPARE", produitId: cree.id, code: cree.code, manques, profilsSuivis, ancienProduitId: ancien }
      : { etat: "CREE", produitId: cree.id, code: cree.code, manques, profilsSuivis };
  }

  // Le dossier a un produit (plan DEJA, PARTAGE ou METTRE_A_JOUR).
  const p = actuel!;
  if (plan.action === "METTRE_A_JOUR") {
    const data = { ...plan.changements };
    try {
      await prisma.product.update({ where: { id: p.id }, data });
    } catch (e) {
      // Un autre écrivain a pris la clé d'identité entre-temps : ce produit prend la clé suffixée du dossier.
      if (!collisionSur(e, "identityKey") || !data.identityKey) throw e;
      data.identityKey = cleProduitDuDossier(d.id, retenue, "autre", p.id);
      await prisma.product.update({ where: { id: p.id }, data });
    }
    const champs = Object.keys(data).filter((k) => k !== "identityKey" && k !== "canonicalName");
    if (champs.length || data.canonicalName) {
      await recordAudit({
        actorId: acteurId, action: "UPDATE", module: "Regulatory", entityType: "PRODUCT", entityId: p.id,
        summary: `Produit ${p.code} mis à jour d'après le dossier ${d.reference}${data.canonicalName ? ` — ${data.canonicalName}` : ""}`,
      });
    }
  }
  const profilsSuivis = await suivreLeDossier(d.id, null, p.id);
  await synchroniserCycleDeVie(p.id);
  if (plan.action === "PARTAGE") {
    return { etat: "PARTAGE", produitId: p.id, code: p.code, manques, profilsSuivis, autresDossiers: plan.autresDossiers };
  }
  return { etat: plan.action === "METTRE_A_JOUR" ? "MIS_A_JOUR" : "DEJA", produitId: p.id, code: p.code, manques, profilsSuivis };
}

// ─────────────────────────── L'existant : le bilan du catalogue ───────────────────────────

export interface ProduitPartage { id: string; code: string; nom: string; dossiers: string[] }

export interface BilanProduitsDesDossiers {
  /** Dossiers non verrouillés passés en revue. */
  dossiers: number;
  crees: number;
  misAJour: number;
  deja: number;
  separes: number;
  /** Dossiers dont l'identité est incomplète — l'indication « à compléter » de leur fiche. */
  aCompleter: number;
  profilsSuivis: number;
  erreurs: number;
  /** Produits portés par PLUSIEURS dossiers (héritage de l'ancien catalogue) — non scindés d'office. */
  produitsPartages: ProduitPartage[];
  /** Produits de BU ou de BD sans dossier : seule une personne sait à quel dossier les rapprocher. */
  aRapprocher: number;
}

/** Les produits que plusieurs dossiers se partagent encore — ce que le bilan nomme. */
export async function produitsPartagesParPlusieursDossiers(): Promise<ProduitPartage[]> {
  const groupes = await prisma.regulatoryProduct.groupBy({
    by: ["productId"],
    where: { productId: { not: null } },
    _count: { _all: true },
    having: { productId: { _count: { gt: 1 } } },
  });
  const ids = groupes.map((g) => g.productId).filter((x): x is string => Boolean(x));
  if (!ids.length) return [];
  const produits = await prisma.product.findMany({
    where: { id: { in: ids } },
    select: { id: true, code: true, canonicalName: true, regulatoryProfiles: { select: { reference: true }, orderBy: { reference: "asc" } } },
    orderBy: { code: "asc" },
  });
  return produits.map((p) => ({ id: p.id, code: p.code, nom: p.canonicalName, dossiers: p.regulatoryProfiles.map((r) => r.reference) }));
}

/**
 * DONNE SON PRODUIT À CHAQUE DOSSIER NON VERROUILLÉ — et dit ce qui reste. Idempotent : rejoué, il
 * ne fait que ce qui reste à faire. Lancé une fois au démarrage du serveur (`scheduled.ts`) et à la
 * demande du Super Admin (Produits 360 › ⋯). Un incident sur un dossier ne bloque pas les autres.
 */
export async function assurerProduitsDesDossiers(opts: {
  acteurId?: string | null;
  /** Borner à ces dossiers — pour un banc qui partage la base avec d'autres (§118.132). */
  perimetre?: { dossierIds: string[] };
} = {}): Promise<BilanProduitsDesDossiers> {
  const borne = opts.perimetre?.dossierIds ?? null;
  const bilan: BilanProduitsDesDossiers = {
    dossiers: 0, crees: 0, misAJour: 0, deja: 0, separes: 0, aCompleter: 0, profilsSuivis: 0, erreurs: 0,
    produitsPartages: [], aRapprocher: 0,
  };
  const dossiers = await prisma.regulatoryProduct.findMany({
    where: { isLocked: false, ...(borne ? { id: { in: borne } } : {}) },
    select: { id: true, reference: true },
    orderBy: { reference: "asc" },
  });
  bilan.dossiers = dossiers.length;
  for (const d of dossiers) {
    try {
      const r = await ensureProduitDuDossier(d.id, { acteurId: opts.acteurId ?? null });
      if (r.etat === "VERROUILLE" || r.etat === "INTROUVABLE") continue;
      if (r.etat === "CREE") bilan.crees++;
      else if (r.etat === "MIS_A_JOUR") bilan.misAJour++;
      else if (r.etat === "SEPARE") bilan.separes++;
      else bilan.deja++;
      if (r.manques.length) bilan.aCompleter++;
      bilan.profilsSuivis += r.profilsSuivis;
    } catch (e) {
      bilan.erreurs++;
      console.error(`[produits] produit du dossier ${d.reference} non assuré`, e);
    }
  }
  const partages = await produitsPartagesParPlusieursDossiers();
  const references = new Set(dossiers.map((d) => d.reference));
  bilan.produitsPartages = borne ? partages.filter((p) => p.dossiers.some((r) => references.has(r))) : partages;
  if (!borne) {
    const [promo, bd] = await Promise.all([
      prisma.promoProduct.count({ where: { isActive: true, regulatoryProductId: null, productId: null } }),
      prisma.bdProduct.count({ where: { regulatoryProductId: null } }),
    ]);
    bilan.aRapprocher = promo + bd;
  }
  if (bilan.crees || bilan.misAJour || bilan.separes || bilan.profilsSuivis) {
    await recordAudit({
      actorId: opts.acteurId ?? null, action: "UPDATE", module: "Regulatory",
      summary: `Catalogue produits — ${bilan.crees} produit(s) créé(s) pour leur dossier, ${bilan.misAJour} mis à jour, `
        + `${bilan.separes} séparé(s), ${bilan.profilsSuivis} produit(s) BU/BD rattaché(s) ; ${bilan.produitsPartages.length} produit(s) partagé(s) par plusieurs dossiers`,
    });
  }
  return bilan;
}

/** La ligne du journal du serveur — les chiffres, et les produits partagés nommés. */
export function ligneDeBilan(b: BilanProduitsDesDossiers): string {
  const partages = b.produitsPartages.length
    ? ` ; partagés par plusieurs dossiers (non scindés) : ${b.produitsPartages.map((p) => `${p.code} [${p.dossiers.join(", ")}]`).join(" · ")}`
    : "";
  return `[produits] ${b.dossiers} dossier(s) : ${b.crees} produit(s) créé(s), ${b.misAJour} mis à jour, ${b.separes} séparé(s), `
    + `${b.deja} déjà justes, ${b.aCompleter} à compléter, ${b.profilsSuivis} produit(s) BU/BD rattaché(s), ${b.erreurs} erreur(s), `
    + `${b.aRapprocher} produit(s) BU/BD sans dossier${partages}`;
}

let bilanDeDemarrageLance = false;

/** Une fois par processus, au premier passage du planificateur : l'existant rejoint la règle. */
export async function assurerProduitsDesDossiersAuDemarrage(): Promise<void> {
  if (bilanDeDemarrageLance) return;
  bilanDeDemarrageLance = true;
  try {
    console.info(ligneDeBilan(await assurerProduitsDesDossiers()));
  } catch (e) {
    // Base indisponible au démarrage : le passage suivant du planificateur réessaiera.
    bilanDeDemarrageLance = false;
    throw e;
  }
}
