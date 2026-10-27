import { indexerEtablissements, type EtablissementConnu } from "@/lib/annuaires/rattachement";
import { resolveProduct, certainMatch, type ProductCandidate } from "@/lib/products/identity";
import { cleBrute, type LigneCanonique } from "./lecture";

/**
 * RÉSOUDRE UNE LIGNE CANONIQUE — l'établissement et le produit, avec une CONFIANCE, sans jamais inventer.
 *
 *   • ÉTABLISSEMENT : mémoire d'une confirmation (99) › nom identique à UN établissement actif (97) ; homonymes ou
 *     inconnu → à revoir.
 *   • PRODUIT : mémoire (99) › référence, alias, nom ou identité complète (97) ; un rapprochement PARTIEL (« R400 »)
 *     est PROPOSÉ (60) et passe en revue ; un produit qui n'est pas au référentiel mais dont la MOLÉCULE est lue
 *     compte pour le marché (dénominateur), sans produit ; rien de lisible → à revoir.
 *   • STATUT : OK seulement si établissement, période et quantité sont sûrs ; sinon A_REVOIR, avec la raison.
 *
 * Module PUR — testé sans base.
 */

export interface Memoire { etablissements: ReadonlyMap<string, string>; produits: ReadonlyMap<string, string> }

export interface Resolution {
  institutionId: string | null;
  productId: string | null;
  confiance: number;
  statut: "OK" | "A_REVOIR";
  raisons: string[];
  /** Ce qui est proposé à la revue quand rien n'est sûr. */
  propositionProduit: { id: string; nom: string; pourquoi: string } | null;
  candidatsEtablissement: string[];
}

export function resolveur(etablissements: readonly EtablissementConnu[], produits: readonly ProductCandidate[], memoire: Memoire) {
  const trouverEtab = indexerEtablissements(etablissements);
  const nomEtab = new Map(etablissements.map((e) => [e.id, e.name]));
  return (l: LigneCanonique): Resolution => {
    const raisons: string[] = [];
    // ── Établissement ──
    let institutionId: string | null = null, confEtab = 0;
    const candidatsEtablissement: string[] = [];
    const memE = l.etablissementBrut ? memoire.etablissements.get(cleBrute(l.etablissementBrut)) : undefined;
    if (memE && nomEtab.has(memE)) { institutionId = memE; confEtab = 99; }
    else if (l.etablissementBrut) {
      const r = trouverEtab(l.etablissementBrut);
      if (r.statut === "trouve") { institutionId = r.etablissement.id; confEtab = 97; }
      else if (r.statut === "ambigu") { raisons.push(`Établissement « ${l.etablissementBrut} » : plusieurs fiches portent ce nom.`); candidatsEtablissement.push(...r.candidats.map((c) => c.id)); }
      else if (r.statut === "inactif") raisons.push(`Établissement « ${l.etablissementBrut} » désactivé dans l'annuaire.`);
      else raisons.push(`Établissement « ${l.etablissementBrut} » inconnu de l'annuaire.`);
    } else raisons.push("Établissement absent.");
    // ── Produit ──
    let productId: string | null = null, confProd = 0;
    let propositionProduit: Resolution["propositionProduit"] = null;
    const brut = [l.produitBrut, l.dosage].filter(Boolean).join(" ") || [l.molecule, l.dosage].filter(Boolean).join(" ");
    const memP = memoire.produits.get(cleBrute(l.produitBrut ?? l.molecule));
    if (memP && produits.some((p) => p.id === memP)) { productId = memP; confProd = 99; }
    else if (brut) {
      const matches = resolveProduct(brut, [...produits]);
      const sur = certainMatch(matches);
      if (sur) { productId = sur.product.id; confProd = 97; }
      else if (matches.length) {
        const p = matches[0];
        propositionProduit = { id: p.product.id, nom: p.product.canonicalName, pourquoi: p.why };
        confProd = matches.length === 1 ? 60 : 40;
        raisons.push(`Produit « ${brut} » : ${matches.length === 1 ? `rapprochement partiel avec ${p.product.canonicalName} (${p.why})` : `${matches.length} produits possibles`} — à confirmer.`);
      } else if (l.molecule) {
        confProd = 90; // un produit hors référentiel (concurrent), dont la molécule compte pour le marché
      } else raisons.push(`Produit « ${brut} » inconnu — aucun rapprochement inventé.`);
    } else raisons.push("Produit et molécule absents.");
    if (!l.periode) raisons.push("Période inconnue.");
    if (l.quantite === null) raisons.push("Quantité absente.");
    else if (l.quantite < 0) raisons.push("Quantité négative.");
    const ok = !!institutionId && !!l.periode && l.quantite !== null && l.quantite >= 0 && (productId !== null || (confProd >= 90 && !propositionProduit));
    return { institutionId, productId, confiance: Math.min(confEtab, confProd || 0), statut: ok ? "OK" : "A_REVOIR", raisons, propositionProduit, candidatsEtablissement };
  };
}

/** La clé d'un DOUBLON : même établissement, même produit (ou molécule), même période, même quantité. */
export function cleDoublon(l: { institutionId: string | null; etablissementBrut: string | null; productId: string | null; produitBrut: string | null; molecule: string | null; periodeDebut: string | null; periodeFin: string | null; quantite: number | null }): string {
  return [l.institutionId ?? `brut:${cleBrute(l.etablissementBrut)}`, l.productId ?? `brut:${cleBrute(l.produitBrut ?? l.molecule)}`, l.periodeDebut, l.periodeFin, l.quantite].join("|");
}

/** Deux périodes se CHEVAUCHENT-ELLES sans être identiques ? (un trimestre et un de ses mois : additionner compterait deux fois). */
export function chevauche(a: { debut: string; fin: string }, b: { debut: string; fin: string }): boolean {
  if (a.debut === b.debut && a.fin === b.fin) return false;
  return a.debut <= b.fin && b.debut <= a.fin;
}
