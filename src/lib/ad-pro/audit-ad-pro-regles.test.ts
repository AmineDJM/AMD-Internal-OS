import { devisMisAPart, type DevisAComparer } from "@/lib/ad-pro/devis-poste";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { etapesDuPoste, etatDuPaiement, phrasePaiementBloque, prochainPas, type FaitsPoste, type RegardPoste } from "@/lib/ad-pro/poste-etapes";
import { beneficiaireDuPaiement } from "@/lib/ad-pro/bc-poste";
import { droitsValidation, peutTenir, opsFranchiALaSoumission } from "@/lib/ad-pro/validation-poste";
import { depassementDevisRetenus } from "@/lib/ad-pro/voyageurs";
import { plafondDesDevis, refusDepassement, totauxValides, type LigneDevisPoste } from "@/lib/ad-pro/devis-poste";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * AUDIT AD & PRO (14/10/2026) — les règles PURES que l'audit a éprouvées : l'état réel d'un paiement sur la carte d'un
 * poste, le bénéficiaire de l'ordre de dépense, « on n'arbitre pas sa propre demande », et les constats laissés
 * documentés (`it.fails`) pour les chantiers en cours ailleurs. Chaque cas nomme ce qui le ferait tomber.
 * Rapport : `docs/audits/audit-ad-pro-2026-10-14.md`.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const pret = (p: Partial<FaitsPoste> = {}): FaitsPoste => ({
  kind: "STAND", status: "APPROVED", amountEstimated: null, amountGranted: 120_000, budgetCategoryId: "cat", orderStage: "ISSUED",
  expenseOrderId: "ordre", expenseOrderStatus: "PENDING", lignesStock: 0, opsDecidedAt: "2026-10-01", bc: "SIGNE", factures: 1, ...p,
});
const DEMANDEUR: RegardPoste = { canEdit: true, canAllocate: false, canViserBC: false, canEmettre: false, fige: false, operationDecidee: true };
const paiement = (f: FaitsPoste) => etapesDuPoste(f).find((e) => e.cle === "PAIEMENT")?.etat;

describe("A. LE PAIEMENT D'UN POSTE se lit sur l'ordre ET sur le centre de paiement", () => {
  it("en cours au centre : « Paiement en cours » ; réglé : fait, rien n'est attendu", () => {
    expect(etatDuPaiement(pret())).toBe("EN_COURS");
    expect(prochainPas(pret(), DEMANDEUR).attente).toBe("Paiement en cours — chez le centre de paiement.");
    expect(paiement(pret({ expenseOrderStatus: "PAID" }))).toBe("FAIT");
    expect(prochainPas(pret({ expenseOrderStatus: "PAID" }), DEMANDEUR)).toEqual({ geste: null, attente: null });
  });

  it("REFUSÉ par le centre : la carte ne dit plus « en cours » — elle dit le refus et le geste qui libère le poste", () => {
    // Ce qui le ferait tomber : ne pas lire `centralStatus` (l'ordre refusé reste PENDING côté Finances).
    const f = pret({ expenseOrderCentral: "REFUSED" });
    expect(etatDuPaiement(f)).toBe("REFUSE");
    expect(paiement(f)).toBe("REFUSE");
    expect(prochainPas(f, DEMANDEUR).attente).toMatch(/refusé par le centre de paiement : « Annuler la demande de paiement » libère le poste/);
  });

  it("ANNULÉ ailleurs (facture annulée dans Legal) : la carte le dit, avec le geste qui libère le poste", () => {
    const f = pret({ expenseOrderStatus: "CANCELLED" });
    expect(etatDuPaiement(f)).toBe("ANNULE");
    expect(paiement(f)).toBe("REFUSE");
    expect(prochainPas(f, DEMANDEUR).attente).toMatch(/a été annulé .* libère le poste/);
  });

  it("la phrase nomme l'ordre quand on le connaît ; aucune phrase pour un paiement qui suit son cours", () => {
    expect(phrasePaiementBloque("REFUSE", "OD-2026-0042")).toMatch(/^L'ordre OD-2026-0042 a été refusé/);
    expect(phrasePaiementBloque("EN_COURS", "OD-1")).toBeNull();
    expect(phrasePaiementBloque("PAYE")).toBeNull();
    expect(etatDuPaiement({ expenseOrderId: null, expenseOrderStatus: null })).toBe("AUCUN");
  });

  it("POINTS D'APPEL : la carte propose « Annuler la demande de paiement » au DEMANDEUR (l'action l'accepte de lui) et pour un ordre déjà annulé", () => {
    const src = readFileSync(join(process.cwd(), "src/components/ad-pro/items-panel.tsx"), "utf8");
    expect(src).toContain('["PENDING", "REVISION_REQUESTED", "CANCELLED"]');
    expect(src).toContain("ordreAnnulable && (regard.canEmettre || regard.canEdit)");
    const action = readFileSync(join(process.cwd(), "src/lib/actions/ad-pro-item-actions.ts"), "utf8");
    expect(action, "l'action accepte le demandeur (canEditItems) : la carte ne doit pas le lui cacher").toMatch(/!isFinance && !canAllocate\(user, owner\.parent\) && !canEditItems\(user, owner\.parent\)/);
  });
});

describe("B. À QUI PART L'ARGENT — le fournisseur des factures, pas le nom de l'opération", () => {
  it("les factures nomment UN fournisseur : c'est lui, même si le poste n'a pas de prestataire saisi", () => {
    expect(beneficiaireDuPaiement(["Hôtel El Djazair"], null, "Congrès de Sétif")).toBe("Hôtel El Djazair");
    expect(beneficiaireDuPaiement(["Hôtel El Djazair", " hotel el djazair "], "", "Congrès de Sétif"), "casse, accents et espaces mis à part").toBe("Hôtel El Djazair");
  });

  it("des fournisseurs différents, ou une facture sans fournisseur : le prestataire du poste, sinon le bénéficiaire de l'opération (comme avant)", () => {
    expect(beneficiaireDuPaiement(["Hôtel A", "Traiteur B"], "Agence C", "Congrès")).toBe("Agence C");
    expect(beneficiaireDuPaiement(["Hôtel A", null], null, "Congrès")).toBe("Congrès");
    expect(beneficiaireDuPaiement([], "  ", "Congrès"), "un prestataire fait d'espaces n'est pas un prestataire").toBe("Congrès");
  });
});

describe("C. ON N'ARBITRE PAS SA PROPRE DEMANDE — par la personne, pas seulement par le rôle", () => {
  const dual = { id: "u1", role: "DIRECTION", secondaryRole: "PRODUCT_MANAGER" };
  it("une personne Direction des opérations ET Direction Marketing : son premier temps est franchi d'office, mais elle ne tient PAS le second sur SA demande", () => {
    expect(opsFranchiALaSoumission(dual)).toBe(true);
    expect(peutTenir("MARKETING", dual, dual)).toBe(false);
    expect(droitsValidation(dual, dual)).toEqual({ operations: false, marketing: false });
  });

  it("la même personne tranche la demande d'un AUTRE ; une autre Direction des opérations tranche la sienne ; le Super Admin supplée", () => {
    const autre = { id: "u2", role: "PRODUCT_MANAGER" };
    expect(peutTenir("MARKETING", dual, autre), "demande d'une autre personne de la Direction Marketing : la Direction des opérations tranche").toBe(true);
    expect(peutTenir("MARKETING", { id: "u3", role: "DIRECTION" }, dual)).toBe(true);
    expect(peutTenir("MARKETING", { id: "u1", role: "SUPER_ADMIN" }, { ...dual, id: "u1" })).toBe(true);
  });

  it("sans identifiant (appelant d'avant), la règle par rôle est inchangée", () => {
    expect(peutTenir("MARKETING", { role: "DIRECTION" }, { role: "PRODUCT_MANAGER" })).toBe(true);
    expect(peutTenir("OPERATIONS", { role: "PRODUCT_MANAGER" }, null)).toBe(false);
  });
});

describe("D. CONSTATS DOCUMENTÉS — défauts réels laissés à leur chantier (voir le rapport)", () => {
  /**
   * CONSTAT H-07 (chantier « comptage des pro forma dupliquées », autre branche) : la MÊME pro forma de 117 250 DZD,
   * déposée une fois par voyageur (cinq copies du même fichier), est comptée cinq fois — 586 250 DZD — et le poste de
   * billetterie se dit « au-delà de l'accordé ». Quand le correctif est fusionné, ce cas PASSE : retirer `.fails`.
   */
  // H-07 CORRIGÉ par le chantier « BC en un clic » : la même pièce déposée pour cinq voyageurs ne compte qu'une fois
  // (`devisMisAPart` — mêmes lignes ET même fichier). `depassementDevisRetenus` ne reçoit que des montants : deux billets
  // au même prix restent deux commandes, c'est en amont que les copies sont écartées. Banc de flux : `bc-meme-piece-flow`.
  it("H-07 — cinq copies d'une pro forma de 117 250 DZD ne comptent qu'une fois", () => {
    const lignes = [{ reference: "Billet Alger → Constantine", quantity: 1, unitPrice: 117_250 }];
    const copies: DevisAComparer[] = [1, 2, 3, 4, 5].map((i) => ({
      pieceId: `p${i}`, nom: "Facture pro forma — SPO-2026-001", annule: false, empreintes: ["sha-pro-forma"],
      reference: "SPO-2026-001", fournisseur: "Genius Travel", lignes, aUnBc: false, nbValidees: 1, voyageur: null,
    }));
    const misAPart = devisMisAPart(copies);
    expect(misAPart.size, "quatre copies écartées").toBe(4);
    const comptees = copies.filter((d) => !misAPart.has(d.pieceId)).map(() => 117_250);
    expect(comptees.reduce((a, b) => a + b, 0)).toBe(117_250);
    expect(depassementDevisRetenus(comptees, 124_750), "sous l'accordé de 124 750 DZD").toBeNull();
  });

  /**
   * CONSTAT M-03 — DEUX PLAFONDS POUR LE MÊME MONTANT ACCORDÉ. La génération refuse un BC dont le TTC dépasse l'accordé
   * (`refusDepassement` : « le montant accordé s'entend TTC »), mais « Modifier le BC » (`modifierBcDuPoste`) et la
   * validation d'un aperçu CORRIGÉ (`traiterLeBCDuPoste`) ne comparent que le HORS-TAXE. Un BC de 440 000 HT à 19 %
   * (523 600 TTC) passe donc la modification pour 450 000 accordés, alors que la génération l'aurait refusé.
   */
  // M-03 CORRIGÉ (Direction, 14/10/2026 — aperçu obligatoire et ultra complet) : la génération, la correction de l'aperçu, sa
  // validation et « Modifier le BC » lisent UN plafond TTC (`plafondDesDevis` → `refusDepassement`, via `refusPlafondDuPoste`) :
  // le TTC que la fabrique compose pour le BC corrigé prend la place des lignes de son devis. Le flux est éprouvé de bout en bout
  // par `bc-apercu-complet-flow.test.ts` ; le cas ci-dessous protège la règle et son branchement.
  it("M-03 — modifier un BC applique le MÊME plafond que le générer (TTC ≤ accordé)", () => {
    const lignes: LigneDevisPoste[] = [{ id: "l", position: 0, reference: "Location salle", unit: null, quantity: 1, unitPrice: 440_000, lue: null, aVerifier: null, validatedItemId: "p", bcId: null }];
    const t = totauxValides({ tvaRate: 19, extraTaxLabel: null, extraTaxRate: null, announcedTotal: null }, lignes, "p");
    const generation = refusDepassement(t.ttc, 450_000, t.ht, true);
    expect(generation, "la génération refuse").not.toBeNull();
    // Le BC MODIFIÉ (440 000 HT, 523 600 TTC) à la place d'un devis de 300 000 HT : le même refus, mot pour mot.
    const p = plafondDesDevis(
      [{ pieceId: "d", annule: false, miseAPart: null, nbValidees: 1, totalValideHt: 300_000, totalValideTtc: 357_000, entete: { tvaRate: 19 } }],
      new Map([["d", { ht: t.ht, ttc: t.ttc }]]),
    );
    expect(refusDepassement(p.ttc, 450_000, p.ht, p.tvaIndiquee)).toBe(generation);
    const action = readFileSync(join(process.cwd(), "src/lib/actions/ad-pro-item-actions.ts"), "utf8");
    const modifier = action.slice(action.indexOf("export async function modifierBcDuPoste"), action.indexOf("// ───────────────────────────── Matériel promotionnel"));
    expect(modifier, "la modification lit la même règle que la génération").toMatch(/refusPlafondDuPoste\(/);
    expect(modifier, "plus de plafond comparé au seul hors-taxe").not.toMatch(/hors taxes, au-delà de l'accordé/);
    const traiter = action.slice(action.indexOf("async function traiterLeBCDuPoste"), action.indexOf("// ═══════════════ L'APERÇU DU BC"));
    expect(traiter, "la génération et la validation lisent la même règle").toMatch(/refusPlafondDuPoste\(/);
    expect(traiter).not.toMatch(/totalHtDesLignes\(/);
  });

  /**
   * CONSTAT M-04 — « MODIFIER LE BC » DEPUIS LE POSTE NE TOUCHE NI AU FOURNISSEUR, NI À LA TVA, NI AUX CONDITIONS. L'action
   * `modifierBcDuPoste` ne lit que les lignes, l'objet, les notes, l'adresse et le délai de livraison, le contact ; la
   * fabrique (`ModificationsDocument`) accepte pourtant `tiers` (adresse, e-mail, NIF, RC du fournisseur), `tvaDefaut`,
   * `modePaiement`, `conditionsPaiement`, `livraison.date`, `referenceAmont`. Chantier « BC modifiables de A à Z » (autre
   * branche, éditeur commun) : quand l'éditeur enverra ces champs, l'action devra les lire, sinon ils seront ignorés.
   */
  // M-04 CORRIGÉ par le chantier « BC modifiables de A à Z » : `modifierBcDuPoste` lit tout par `lireModificationsDuBc`
  // (le même formulaire que la composition). Le cas protège désormais la correction.
  it("M-04 — modifierBcDuPoste lit le fournisseur, la TVA, le mode et les conditions de paiement", () => {
    const action = readFileSync(join(process.cwd(), "src/lib/actions/ad-pro-item-actions.ts"), "utf8");
    const modifier = action.slice(action.indexOf("export async function modifierBcDuPoste"), action.indexOf("// ───────────────────────────── Matériel promotionnel"));
    expect(modifier).toContain("lireModificationsDuBc(");
    // UNE SEULE LECTURE du formulaire du composeur (Direction, 14/10/2026) : la révision, l'aperçu du poste et celui du
    // secrétariat lisent `lireSaisieDuComposeur`.
    const debut = action.indexOf("function lireModificationsDuBc");
    expect(action.slice(debut, action.indexOf("\n}\n", debut))).toContain("lireSaisieDuComposeur(");
    const lecteur = readFileSync(join(process.cwd(), "src/lib/bons-de-commande/saisie-composeur.ts"), "utf8");
    for (const champ of ["tiersNom", "tiersEmail", "tiersAdresse", "tvaDefaut", "modePaiement", "conditionsPaiement", "livraisonAdresse", "livraisonDate", "ligneUnite", "letterheadId", "signataireNom", "mentions"]) {
      expect(lecteur, champ).toContain(`"${champ}"`);
    }
  });
});
