import { describe, expect, it } from "vitest";
import { totauxTaxes, totauxDeLaSelection, type DevisLu } from "@/lib/promo-material/devis";
import { breakdown, type ItemAmounts } from "./postes";
import { montantDeLaDemande } from "./montant-demande";
import { nuitsDe } from "./hebergements";
import { lireRepartition } from "./repartition";
import { bilanCloture } from "./cloture-sponsoring";
import { plafondDesDevis } from "./devis-poste";
import { versDzd, montantPosteGroupe } from "./prise-en-charge/fiches";
import { engagementDuPoste } from "@/lib/budget/engage";
import { disponible } from "@/lib/budget/marketing-vue";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LOT V1 — « LES SOMMES DES CALCULS SONT BONNES » (Direction, 03/11/2026).
 *
 * Chaque montant qu'Ad & Pro calcule (HT / TVA / taxe / TTC d'un devis, sélection sur plusieurs devis,
 * plafond des devis, ventilation des postes, montant de la demande, nuitées, répartition d'un sponsoring
 * indirect, total de clôture, conversion USD → DZD, poste de groupe, engagé, disponible) est REFAIT ici
 * par un calcul INDÉPENDANT : centimes ENTIERS, arrondi explicite, aucune fonction du code relue. Un écart
 * d'un centime = un défaut. Tirages pseudo-aléatoires à graine fixe : le même banc à chaque passage.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

// Générateur déterministe (mulberry32) : rejouable, sans dépendance.
function graine(s: number) {
  return () => {
    s |= 0; s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const alea = graine(20261103);
const entre = (a: number, b: number) => a + Math.floor(alea() * (b - a + 1));
/** Un montant DZD à centimes, donné en CENTIMES entiers (la vérité du banc). */
const centimesAuHasard = (max = 300_000_000) => entre(1, max);
const enDzd = (c: number) => c / 100;
/** Arrondi d'un rationnel positif p/q au centime, demi vers le haut — en entiers. */
const arrondiDiv = (p: number, q: number) => Math.floor((2 * p + q) / (2 * q));

describe("Lot V1 — HT / TVA / taxe / TTC d'un devis (indépendant, centimes entiers)", () => {
  it("500 devis tirés au hasard : chaque total au centime", () => {
    for (let k = 0; k < 500; k++) {
      const tva = [0, 9, 19][entre(0, 2)];
      const taxe = alea() < 0.3 ? [1, 2, 7][entre(0, 2)] : null;
      const lignes = Array.from({ length: entre(1, 8) }, () => ({ q: entre(1, 500), puC: centimesAuHasard(5_000_000) }));
      // Calcul indépendant : ligne HT = q × pu en centimes (exact), TVA et taxe arrondies au centime sur le HT.
      const htC = lignes.reduce((s, l) => s + l.q * l.puC, 0);
      const tvaC = arrondiDiv(htC * tva, 100);
      const taxeC = taxe ? arrondiDiv(htC * taxe, 100) : 0;
      const t = totauxTaxes({ tvaRate: tva, extraTaxRate: taxe }, lignes.map((l) => ({ quantity: l.q, unitPrice: enDzd(l.puC) })));
      expect(Math.round(t.ht * 100), `HT devis ${k}`).toBe(htC);
      expect(Math.round(t.tva * 100), `TVA devis ${k}`).toBe(tvaC);
      expect(Math.round(t.taxe * 100), `taxe devis ${k}`).toBe(taxeC);
      expect(Math.round(t.ttc * 100), `TTC devis ${k}`).toBe(htC + tvaC + taxeC);
      // Et le TTC est bien ÉGAL à HT + TVA + taxe tel qu'affiché (aucun centime fantôme à l'écran).
      expect(Math.round((t.ht + t.tva + t.taxe) * 100)).toBe(Math.round(t.ttc * 100));
    }
  });

  it("la sélection sur plusieurs devis garde la TVA de chacun (un devis exonéré n'est pas taxé à 19 %)", () => {
    for (let k = 0; k < 200; k++) {
      const devis: DevisLu[] = Array.from({ length: entre(1, 4) }, (_, i) => ({
        id: `d${i}`, supplierId: null, supplierName: "", reference: null, tvaRate: [0, 9, 19][entre(0, 2)],
        extraTaxLabel: null, extraTaxRate: null, announcedTotal: null, documentId: null,
        lines: Array.from({ length: entre(1, 5) }, (_, j) => ({
          id: `l${j}`, position: j, reference: `L${j}`, unit: null, quantity: entre(1, 50), unitPrice: enDzd(centimesAuHasard(2_000_000)), selected: alea() < 0.7,
        })),
      }));
      let ttcC = 0;
      for (const d of devis) {
        const ht = d.lines.filter((l) => l.selected).reduce((s, l) => s + l.quantity * Math.round(l.unitPrice * 100), 0);
        ttcC += ht + arrondiDiv(ht * (d.tvaRate ?? 0), 100);
      }
      expect(Math.round(totauxDeLaSelection(devis).ttc * 100), `sélection ${k}`).toBe(ttcC);
    }
  });

  it("le plafond des devis d'un poste : somme exacte des totaux validés qui comptent (annulés et mis à part exclus)", () => {
    for (let k = 0; k < 200; k++) {
      const devis = Array.from({ length: entre(1, 5) }, (_, i) => ({
        pieceId: `p${i}`, annule: alea() < 0.2, miseAPart: alea() < 0.1 ? { motif: "COPIE" as const, de: "x", phrase: "copie" } : null, nbValidees: 1,
        totalValideHt: enDzd(centimesAuHasard()), totalValideTtc: enDzd(centimesAuHasard()), entete: { tvaRate: 19 },
      }));
      const compte = devis.filter((d) => !d.annule && !d.miseAPart);
      const htC = compte.reduce((s, d) => s + Math.round(d.totalValideHt * 100), 0);
      const ttcC = compte.reduce((s, d) => s + Math.round(d.totalValideTtc * 100), 0);
      const p = plafondDesDevis(devis);
      expect(Math.round(p.ht * 100)).toBe(htC);
      expect(Math.round(p.ttc * 100)).toBe(ttcC);
      expect(p.ttc).toBe(ttcC / 100);
    }
  });
});

describe("Lot V1 — les postes et le montant de la demande", () => {
  it("la ventilation (affecté, rallonge, en attente, reste, dépassement) : au centime, refusés exclus", () => {
    const statuts = ["DRAFT", "PENDING", "APPROVED", "REJECTED", "REVISION"] as const;
    for (let k = 0; k < 500; k++) {
      const postes = Array.from({ length: entre(1, 9) }, () => {
        const status = statuts[entre(0, 4)];
        const estC = centimesAuHasard();
        const grC = status === "APPROVED" || (status === "REVISION" && alea() < 0.5) ? centimesAuHasard() : null;
        return { status, budgetKind: alea() < 0.3 ? "ADDITIONAL" as const : "INCLUDED" as const, estC, grC };
      });
      const enveloppeC = alea() < 0.2 ? null : centimesAuHasard(1_000_000_000);
      const items: ItemAmounts[] = postes.map((p) => ({ status: p.status, budgetKind: p.budgetKind, amountEstimated: enDzd(p.estC), amountGranted: p.grC == null ? null : enDzd(p.grC) }));
      const b = breakdown(items, enveloppeC == null ? null : enDzd(enveloppeC));
      const vivants = postes.filter((p) => p.status !== "REJECTED");
      const estime = vivants.reduce((s, p) => s + p.estC, 0);
      const affecte = vivants.filter((p) => p.budgetKind !== "ADDITIONAL").reduce((s, p) => s + (p.grC ?? 0), 0);
      const rallonge = vivants.filter((p) => p.budgetKind === "ADDITIONAL").reduce((s, p) => s + (p.grC ?? p.estC), 0);
      const attente = vivants.filter((p) => p.status === "PENDING" || p.status === "REVISION").reduce((s, p) => s + (p.grC ?? p.estC), 0);
      expect(b.estimatedDzd).toBe(estime / 100);
      expect(b.allocatedDzd).toBe(affecte / 100);
      expect(b.additionalDzd).toBe(rallonge / 100);
      expect(b.pendingDzd).toBe(attente / 100);
      expect(b.totalRequestedDzd).toBe((affecte + rallonge) / 100);
      if (enveloppeC != null) {
        expect(b.unallocatedDzd).toBe(Math.max(0, enveloppeC - affecte) / 100);
        expect(b.overrunDzd).toBe(Math.max(0, affecte - enveloppeC) / 100);
      }
    }
  });

  it("montant de la demande = base du circuit + rallonges accordées, au centime", () => {
    for (let k = 0; k < 500; k++) {
      const baseC = centimesAuHasard(1_000_000_000);
      const postes = Array.from({ length: entre(0, 6) }, () => ({
        budgetKind: alea() < 0.5 ? "ADDITIONAL" : "INCLUDED", status: alea() < 0.7 ? "APPROVED" : "PENDING", grC: centimesAuHasard(),
      }));
      const attendu = baseC + postes.filter((p) => p.budgetKind === "ADDITIONAL" && p.status === "APPROVED").reduce((s, p) => s + p.grC, 0);
      const m = montantDeLaDemande(enDzd(baseC), postes.map((p) => ({ budgetKind: p.budgetKind, status: p.status, amountGranted: enDzd(p.grC) })));
      expect(m, `demande ${k}`).toBe(attendu / 100);
    }
  });

  it("la répartition d'un sponsoring indirect : total = somme des natures, au centime", () => {
    for (let k = 0; k < 300; k++) {
      const lignes = Array.from({ length: entre(1, 6) }, () => ({ kind: ["PRINTING", "ACCOMMODATION", "TICKETING", "CATERING"][entre(0, 3)], c: centimesAuHasard() }));
      const r = lireRepartition(JSON.stringify(lignes.map((l) => ({ kind: l.kind, montant: (l.c / 100).toFixed(2).replace(".", ",") }))));
      if (!r.ok) throw new Error(r.error);
      expect(r.total).toBe(lignes.reduce((s, l) => s + l.c, 0) / 100);
    }
  });

  it("le total de clôture d'un sponsoring = somme des postes accordés (le stock n'a pas de montant)", () => {
    for (let k = 0; k < 300; k++) {
      const postes = Array.from({ length: entre(1, 8) }, (_, i) => ({
        id: `p${i}`, label: `P${i}`, status: alea() < 0.8 ? "APPROVED" : "REJECTED", kind: "PRINTING", amountGranted: enDzd(centimesAuHasard()), budgetCategoryId: "c", lignesStock: [],
      }));
      const b = bilanCloture("PRE_VALIDATED", postes as never);
      const attendu = postes.filter((p) => p.status === "APPROVED").reduce((s, p) => s + Math.round(p.amountGranted * 100), 0);
      expect(b.total).toBe(attendu / 100);
    }
  });
});

describe("Lot V1 — hôtellerie, prise en charge, budget", () => {
  it("les nuitées = jours calendaires entre arrivée et départ (y compris passage à l'heure d'été)", () => {
    const jour = (s: string) => new Date(`${s}T00:00:00.000Z`);
    const cas: [string, string, number][] = [
      ["2026-11-10", "2026-11-13", 3], ["2026-03-28", "2026-04-02", 5], ["2026-10-24", "2026-10-26", 2],
      ["2026-12-30", "2027-01-02", 3], ["2028-02-28", "2028-03-01", 2], ["2026-11-10", "2026-11-10", 0],
    ];
    for (const [a, d, n] of cas) expect(nuitsDe({ dateArrivee: jour(a), dateDepart: jour(d) }), `${a} → ${d}`).toBe(n);
    // Nuitées × prix par nuit : le calcul que l'assistante refait pour une réservation.
    for (let k = 0; k < 200; k++) {
      const debut = Date.UTC(2026, 0, 1) + entre(0, 700) * 86_400_000;
      const nuits = entre(0, 20);
      const prixC = centimesAuHasard(8_000_000);
      const n = nuitsDe({ dateArrivee: new Date(debut), dateDepart: new Date(debut + nuits * 86_400_000) });
      expect(n).toBe(nuits);
      expect(Math.round(n! * enDzd(prixC) * 100)).toBe(nuits * prixC);
    }
  });

  it("conversion USD → DZD au taux de la demande, et poste de groupe = unitaire × personnes, au centime", () => {
    for (let k = 0; k < 300; k++) {
      const usdC = centimesAuHasard(5_000_000);
      const taux = [240, 241.5, 238.75][entre(0, 2)];
      const tauxMilliemes = Math.round(taux * 1000);
      expect(versDzd(enDzd(usdC), "USD", taux)).toBe(arrondiDiv(usdC * tauxMilliemes, 1000) / 100);
      const unitC = centimesAuHasard(10_000_000);
      const n = entre(0, 30);
      const personnes = Array.from({ length: n }, (_, i) => ({ id: `b${i}`, status: "APPROVED" as never }));
      expect(montantPosteGroupe({ excludedBeneficiaryIds: [], unitAmountDzd: enDzd(unitC), status: "PENDING" as never }, personnes)).toBe((unitC * n) / 100);
    }
  });

  it("engagé d'un poste et disponible du budget (enveloppe − payé − engagé)", () => {
    for (let k = 0; k < 300; k++) {
      const bc = centimesAuHasard(), paye = entre(0, bc), enAttente = alea() < 0.5 ? 0 : centimesAuHasard();
      const e = engagementDuPoste({ bc: enDzd(bc), paye: enDzd(paye), enAttente: enDzd(enAttente) });
      expect(Math.round(e * 100)).toBe(Math.max(enAttente, bc - paye));
      const total = centimesAuHasard(5_000_000_000);
      expect(Math.round(disponible(enDzd(total), enDzd(paye), enDzd(bc)) * 100)).toBe(total - paye - bc);
    }
  });
});
