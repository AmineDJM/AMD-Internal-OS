import { prisma } from "@/lib/prisma";
import { resolveProductId } from "@/lib/products/resolve";
import { sansBloquer } from "@/lib/journal";

/**
 * LE PRODUIT D'UN DOSSIER — déduit de sa source, rien de nouveau à saisir.
 *
 * Un sponsoring, un congrès, un événement nomment leurs produits en texte libre ; un dossier de
 * matériel promotionnel les rattache au catalogue. On rend le PREMIER produit nommé (plus le
 * nombre d'autres), et son identifiant quand il se résout avec certitude — la liste renvoie alors
 * à la fiche Produits 360. Un dossier ouvert par le pharmacien n'a pas de source : pas de produit.
 */
export interface ProduitDossier {
  nom: string;
  /** L'identifiant du produit canonique, quand la mention se résout sans ambiguïté. */
  id: string | null;
  /** Combien d'autres produits la source nomme. */
  autres: number;
}

/** « Raltégravir, Darunavir / Dolutégravir » → trois mentions. Le « + » reste : il lie une association. */
export function mentionsProduits(texte: string | null | undefined): string[] {
  return (texte ?? "")
    .split(/[,;\n/]|\s+et\s+/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 1);
}

/**
 * LE PRODUIT POSÉ SUR LA DÉCLARATION (Direction, 10/2026 — `MedicalInfoDeclaration.productId`) l'emporte sur celui déduit de
 * la source : il est repris de la source à la création, puis corrigeable dans la déclaration. Une déclaration encore sans
 * produit posé mais dont la source se résout est RATTRAPÉE ici (une écriture idempotente, `productId` nul seulement) : c'est
 * ce qui fait remonter les anciennes déclarations dans Produits 360 sans script à lancer.
 */
export async function produitsDesDossiers(
  decls: readonly { id: string; sourceType: string; sourceId: string; productId?: string | null }[],
  options: { rattraper?: boolean } = {},
): Promise<Map<string, ProduitDossier>> {
  const deduits = await produitsDeduitsDesSources(decls);
  const poses = [...new Set(decls.map((d) => d.productId).filter((x): x is string => !!x))];
  const noms = poses.length
    ? new Map((await prisma.product.findMany({ where: { id: { in: poses } }, select: { id: true, canonicalName: true } })).map((p) => [p.id, p.canonicalName]))
    : new Map<string, string>();
  const out = new Map<string, ProduitDossier>();
  const aRattraper: { id: string; productId: string }[] = [];
  for (const d of decls) {
    const deduit = deduits.get(d.id);
    if (d.productId && noms.has(d.productId)) {
      out.set(d.id, { nom: noms.get(d.productId)!, id: d.productId, autres: deduit?.id === d.productId ? deduit.autres : 0 });
      continue;
    }
    if (deduit) out.set(d.id, deduit);
    if (!d.productId && deduit?.id) aRattraper.push({ id: d.id, productId: deduit.id });
  }
  if (options.rattraper !== false && aRattraper.length) {
    // Jamais bloquant : un rattrapage qui échoue laisse la lecture intacte (il se refera à la prochaine ouverture).
    await Promise.all(aRattraper.map((r) => prisma.medicalInfoDeclaration.updateMany({ where: { id: r.id, productId: null }, data: { productId: r.productId } }).catch(sansBloquer("produits.produitsDesDossiers.medicalInfoDeclaration", null))));
  }
  return out;
}

/** Le produit canonique d'une source, au moment de créer la déclaration — nul si la source n'en nomme aucun ou ne se résout pas. */
export async function produitDeLaSource(sourceType: string, sourceId: string): Promise<string | null> {
  try {
    const m = await produitsDesDossiers([{ id: "_", sourceType, sourceId }], { rattraper: false });
    return m.get("_")?.id ?? null;
  } catch {
    return null;
  }
}

async function produitsDeduitsDesSources(
  decls: readonly { id: string; sourceType: string; sourceId: string }[],
): Promise<Map<string, ProduitDossier>> {
  const ids = (t: string) => decls.filter((d) => d.sourceType === t).map((d) => d.sourceId);
  const legalIds = ids("LEGAL_DOCUMENT");

  const [sponsorings, intls, nationaux, events, autres, pieces] = await Promise.all([
    ids("SPONSORING").length
      ? prisma.sponsoringRequest.findMany({ where: { id: { in: ids("SPONSORING") } }, select: { id: true, product: true } })
      : Promise.resolve([]),
    ids("CONGRESS_INTERNATIONAL").length
      ? prisma.congressInternational.findMany({ where: { id: { in: ids("CONGRESS_INTERNATIONAL") } }, select: { id: true, products: true } })
      : Promise.resolve([]),
    ids("CONGRESS_NATIONAL").length
      ? prisma.congressNational.findMany({ where: { id: { in: ids("CONGRESS_NATIONAL") } }, select: { id: true, promotedProducts: true } })
      : Promise.resolve([]),
    ids("EVENT").length
      ? prisma.event.findMany({ where: { id: { in: ids("EVENT") } }, select: { id: true, products: true } })
      : Promise.resolve([]),
    // La demande « autre » (27/10/2026, décision #17) : son produit concerné, facultatif.
    ids("AD_PRO_OTHER").length
      ? prisma.adProOtherRequest.findMany({ where: { id: { in: ids("AD_PRO_OTHER") } }, select: { id: true, product: true } })
      : Promise.resolve([]),
    // UN PAIEMENT DE MATÉRIEL PROMOTIONNEL déclare la FACTURE : on remonte au dossier dont elle découle.
    legalIds.length
      ? prisma.legalDocument.findMany({ where: { id: { in: legalIds } }, select: { id: true, sourceType: true, sourceId: true } })
      : Promise.resolve([]),
  ]);

  const texteParSource = new Map<string, string | null>();
  for (const s of sponsorings) texteParSource.set(s.id, s.product);
  for (const c of intls) texteParSource.set(c.id, c.products);
  for (const c of nationaux) texteParSource.set(c.id, c.promotedProducts);
  for (const e of events) texteParSource.set(e.id, e.products);
  for (const o of autres) texteParSource.set(o.id, o.product);

  // Matériel promotionnel : le dossier, directement ou par sa facture.
  const promoParSource = new Map<string, string>();
  for (const id of ids("PROMO_MATERIAL")) promoParSource.set(id, id);
  for (const p of pieces) if (p.sourceType === "PROMO_MATERIAL" && p.sourceId) promoParSource.set(p.id, p.sourceId);
  const promoIds = [...new Set(promoParSource.values())];
  const articles = promoIds.length
    ? await prisma.promoRequestItem.findMany({
        where: { promoMaterialId: { in: promoIds } },
        select: { promoMaterialId: true, produits: { select: { product: { select: { id: true, canonicalName: true } } } } },
        orderBy: { position: "asc" },
      })
    : [];
  const produitsParPromo = new Map<string, { id: string; nom: string }[]>();
  for (const a of articles) {
    const liste = produitsParPromo.get(a.promoMaterialId) ?? [];
    for (const p of a.produits) if (!liste.some((x) => x.id === p.product.id)) liste.push({ id: p.product.id, nom: p.product.canonicalName });
    produitsParPromo.set(a.promoMaterialId, liste);
  }

  // Une mention se résout UNE fois, quel que soit le nombre de dossiers qui la portent.
  const cache = new Map<string, Promise<string | null>>();
  const resoudre = (m: string) => {
    const cle = m.toLowerCase();
    if (!cache.has(cle)) cache.set(cle, resolveProductId(m).catch(sansBloquer("produits.resoudre.resolveProductId", null)));
    return cache.get(cle)!;
  };

  const out = new Map<string, ProduitDossier>();
  await Promise.all(decls.map(async (d) => {
    const promo = promoParSource.get(d.sourceId);
    if (promo) {
      const liste = produitsParPromo.get(promo) ?? [];
      if (liste.length) out.set(d.id, { nom: liste[0].nom, id: liste[0].id, autres: liste.length - 1 });
      return;
    }
    const mentions = mentionsProduits(texteParSource.get(d.sourceId));
    if (mentions.length === 0) return;
    out.set(d.id, { nom: mentions[0], id: await resoudre(mentions[0]), autres: mentions.length - 1 });
  }));
  return out;
}
