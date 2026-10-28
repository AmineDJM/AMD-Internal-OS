import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { moleculeStem } from "@/lib/market/galenic";
import { createWithRetry, enSerie, referenceDeSerie } from "@/lib/refs";
import {
  aliasKey, certainMatch, cleDci, identityKey, nomCanonique, parseMention, resolveProduct,
  type ProductCandidate, type ProductMatch,
} from "./identity";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA RÉSOLUTION BRANCHÉE — la lecture, séparée de la décision.
 *
 * La DÉCISION (« cette mention désigne-t-elle ce produit ? ») vit dans `identity.ts`, pure et
 * éprouvée au cas près. ICI, on ne fait que CHARGER les bons candidats et appeler cette
 * décision. La séparation n'est pas une élégance : c'est ce qui permet de vérifier la règle
 * métier sans base de test, donc de la vérifier vraiment.
 *
 * ── POURQUOI ON NE CHARGE PAS TOUT LE CATALOGUE ──────────────────────────────────────────
 *
 * Un `findMany()` complet marcherait aujourd'hui et deviendrait une lecture de plusieurs
 * milliers de lignes à chaque mention de produit dans une conversation. Le pré-filtre SQL est
 * volontairement LARGE (radical de la molécule, alias exact, référence) : il ne décide de rien,
 * il réduit. C'est la fonction pure qui tranche ensuite, sur un lot borné.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const CANDIDATE_CAP = 60;

/** Le produit tel que la décision pure l'attend — même forme, chargée depuis la base. */
function toCandidate(row: {
  id: string; code: string; canonicalName: string; identityKey: string; dci: string;
  dosage: string | null; dosageUnit: string | null; form: string | null; packaging: string | null;
  aliases: { label: string }[];
}): ProductCandidate {
  return { ...row, aliases: row.aliases.map((a) => a.label) };
}

const SELECT = {
  id: true, code: true, canonicalName: true, identityKey: true, dci: true,
  dosage: true, dosageUnit: true, form: true, packaging: true,
  aliases: { select: { label: true } },
} as const;

/**
 * RÉSOUT UNE MENTION VERS UN PRODUIT. Rend TOUTES les correspondances du meilleur degré —
 * plusieurs résultats certains signifient une ambiguïté RÉELLE, que l'appelant doit poser à
 * l'humain plutôt que trancher.
 */
export async function resolveProductMention(mention: string): Promise<ProductMatch[]> {
  const brut = (mention ?? "").trim();
  if (!brut) return [];

  const cle = aliasKey(brut);
  const radical = moleculeStem(parseMention(brut).dci);
  // Le premier MOT du radical suffit à pré-filtrer : « NIVOLUMAB » pour « nivolumab 100 mg ».
  const amorce = radical.split(" ")[0] ?? "";

  const rows = await prisma.product.findMany({
    where: {
      isActive: true,
      OR: [
        { code: { equals: brut, mode: "insensitive" } },
        { aliases: { some: { key: cle } } },
        { canonicalName: { equals: brut, mode: "insensitive" } },
        ...(amorce.length >= 3 ? [{ dci: { contains: amorce.slice(0, 6), mode: "insensitive" as const } }] : []),
      ],
    },
    select: SELECT,
    take: CANDIDATE_CAP,
  });

  return resolveProduct(brut, rows.map(toCandidate));
}

/** Le produit CERTAIN, ou `null`. La forme dont une capability a besoin neuf fois sur dix. */
export async function resolveProductId(mention: string): Promise<string | null> {
  const m = certainMatch(await resolveProductMention(mention));
  return m ? m.product.id : null;
}

/** Une violation d'unicité sur CE champ — `meta.target` nomme la contrainte qui a sauté. */
export function collisionSur(e: unknown, champ: string): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002"
    && String((e.meta as { target?: unknown } | undefined)?.target ?? "").includes(champ);
}

const SELECT_REF = { id: true, code: true } as const;

/**
 * RETROUVE LE PRODUIT D'UNE CLÉ — y compris quand sa clé a été écrite par une version précédente
 * de `identityKey`.
 *
 * La clé est stockée ; la fonction qui la calcule, elle, s'améliore (§118.178 : elle fusionnait
 * des produits distincts). Un produit créé avant une amélioration porte l'ANCIENNE clé, et la
 * recherche à l'égalité ne le trouve plus : on en créerait un second pour le même médicament —
 * exactement le doublon que la clé existe pour empêcher. On relit donc les produits de la même
 * molécule, on RECALCULE leur clé depuis leur tuple stocké, et celui qui correspond reçoit la
 * clé à jour. Le tuple stocké est la vérité ; la clé n'en est qu'un index.
 */
export async function retrouverParIdentite(key: string, dci: string): Promise<{ id: string; code: string } | null> {
  const exact = await prisma.product.findUnique({ where: { identityKey: key }, select: SELECT_REF });
  if (exact) return exact;
  const amorce = (cleDci(dci).split(/[+ ]/)[0] ?? "").slice(0, 6);
  if (amorce.length < 3) return null;
  const voisins = await prisma.product.findMany({
    where: { dci: { contains: amorce, mode: "insensitive" } },
    select: { ...SELECT_REF, identityKey: true, dci: true, dosage: true, dosageUnit: true, form: true, packaging: true },
    take: 200,
  });
  const perime = voisins.find((v) => v.identityKey !== key && identityKey(v) === key);
  if (!perime) return null;
  try {
    await prisma.product.update({ where: { id: perime.id }, data: { identityKey: key } });
  } catch (e) {
    // Un autre écrivain a posé la clé à jour entre-temps : c'est SON produit qui la porte.
    if (!collisionSur(e, "identityKey")) throw e;
    return prisma.product.findUnique({ where: { identityKey: key }, select: SELECT_REF });
  }
  return { id: perime.id, code: perime.code };
}

/**
 * TROUVE OU CRÉE le produit canonique d'un tuple d'identité.
 *
 * L'unicité de `identityKey` est portée par la BASE : deux écrivains concurrents ne peuvent pas
 * créer deux fois le même produit. Le CODE, lui, se dérive du maximum existant — deux créations
 * simultanées de produits DIFFÉRENTS lisaient le même maximum, et la seconde tombait sur
 * l'unicité du code (mesuré : deux bancs de tests en parallèle, §118.178). Les créations passent
 * donc une par une dans ce processus (`enSerie`), et se réessaient entre processus
 * (`createWithRetry`) ; une collision sur la CLÉ, elle, veut dire que l'autre écrivain a créé le
 * même produit — on rend le sien, on n'en crée pas un second.
 *
 * Rend `null` quand le tuple ne produit AUCUNE clé (DCI vide) — on n'indexe pas le vide.
 * N'exige pas une identité COMPLÈTE : c'est à l'appelant d'en décider (`manquesIdentite`).
 *
 * ⚠️ Pas pour un DOSSIER : un dossier reçoit SON produit (`ensureProduitDuDossier`, un pour un) —
 * ceci rejoint le produit d'une identité existante, ce qui fusionnerait deux dossiers.
 */
export async function ensureProduct(input: {
  dci: string;
  canonicalName?: string | null;
  dosage?: string | null;
  dosageUnit?: string | null;
  form?: string | null;
  packaging?: string | null;
  /// Les valeurs de l'ERP : RETAIL (ville / officine), HOSPITAL, BOTH.
  channel?: "RETAIL" | "HOSPITAL" | "BOTH";
  companyId?: string | null;
  lifecycle?: string;
}): Promise<{ id: string; code: string; created: boolean } | null> {
  const key = identityKey(input);
  if (!key) return null;

  const existant = await retrouverParIdentite(key, input.dci);
  if (existant) return { ...existant, created: false };

  const nom = (input.canonicalName ?? "").trim() || nomCanonique(input);

  return enSerie("PRD", () => createWithRetry(async () => {
    // Relu SOUS le tour de file : un écrivain de ce processus a pu le créer pendant l'attente.
    const deja = await prisma.product.findUnique({ where: { identityKey: key }, select: SELECT_REF });
    if (deja) return { ...deja, created: false };
    const code = await nextProductCode();
    try {
      const cree = await prisma.product.create({
        data: {
          code, canonicalName: nom, identityKey: key,
          dci: input.dci.trim(),
          dosage: input.dosage ?? null, dosageUnit: input.dosageUnit ?? null,
          form: input.form ?? null, packaging: input.packaging ?? null,
          channel: input.channel ?? "BOTH",
          companyId: input.companyId ?? null,
          lifecycle: input.lifecycle ?? "STUDY",
        },
        select: SELECT_REF,
      });
      return { ...cree, created: true };
    } catch (e) {
      // Course perdue sur la CLÉ : un autre processus a créé ce produit. Le premier arrivé fait
      // foi — on ne remonte pas nos champs par-dessus les siens.
      if (collisionSur(e, "identityKey")) {
        const autre = await prisma.product.findUnique({ where: { identityKey: key }, select: SELECT_REF });
        if (autre) return { ...autre, created: false };
      }
      // Collision sur le CODE : `createWithRetry` relance avec le maximum relu.
      throw e;
    }
  }));
}

/**
 * `PRD-AAAA-NNN`, dans la même forme que les autres références de l'ERP — et par le même
 * calcul (`buildRef`, le maximum NUMÉRIQUE). L'ancien prenait le dernier code par ordre
 * ALPHABÉTIQUE : passé 999, « PRD-2026-999 » restait le plus grand, chaque création recalculait
 * « PRD-2026-1000 » déjà pris, et plus aucun produit ne se créait de l'année.
 */
export async function nextProductCode(): Promise<string> {
  const annee = new Date().getFullYear();
  return referenceDeSerie({
    modele: "Product", prefixe: "PRD", annee: annee,
    existantes: async () => (await prisma.product.findMany({ where: { code: { startsWith: `PRD-${annee}-` } }, select: { code: true } })).map((r) => r.code),
  });
}

/**
 * ENREGISTRE UN ALIAS. Rend `false` si l'alias appartient DÉJÀ à un autre produit — la base
 * l'interdit, et on préfère le dire que de le voler en silence : un alias volé fait répondre
 * sur le mauvais produit sans que personne ne comprenne pourquoi.
 */
export async function addProductAlias(
  productId: string,
  label: string,
  opts: { source?: string; createdById?: string | null } = {},
): Promise<boolean> {
  const key = aliasKey(label);
  if (!key) return false;
  const existant = await prisma.productAlias.findUnique({ where: { key }, select: { productId: true } });
  if (existant) return existant.productId === productId;
  await prisma.productAlias.create({
    data: { productId, label: label.trim(), key, source: opts.source ?? "MANUAL", createdById: opts.createdById ?? null },
  });
  return true;
}
