import { describe, it, expect } from "vitest";
import {
  aUneEquipe, peutAnnulerDemande, peutAnnulerMouvement, peutAnnulerTransfert, peutConfirmerReception, peutCorriger, peutDemander, peutDoter,
  peutEntrerAlaMain, peutGererArticles, peutPoserOuverture, peutServirDemande, peutSortirDe, peutTransfererVers,
  peutVoirStockDe, tientLeMagasin, type FaitsStock,
} from "./stock-acces";

/**
 * QUI PEUT QUOI SUR LE STOCK PROMOTIONNEL — la matrice, rôle par rôle (§118.164).
 *
 * Les décisions de la Direction (01/10) : la directrice de la Direction Marketing tient le magasin ;
 * le Super Admin « gère ce qu'il veut » ; le délégué CONFIRME la réception ; le directeur des
 * opérations a la vue globale ET la gestion du matériel de ses équipes. Chaque ligne nomme le cas
 * qui ferait tomber l'assertion — un droit qu'on ne sait pas faire échouer n'est pas éprouvé.
 */

const tout = { voir: true, creer: true, modifier: true };
const faits = (p: Partial<FaitsStock> & { userId: string }): FaitsStock => ({
  superAdmin: false, module: tout, vueGlobale: false, gereLeMagasin: false, directeurDesOperations: false, equipe: new Set(), ...p,
});

const SA = faits({ userId: "sa", superAdmin: true, vueGlobale: true, gereLeMagasin: true });
const DM = faits({ userId: "dm", vueGlobale: true, gereLeMagasin: true });
const PM2 = faits({ userId: "pm2", vueGlobale: true });
const K1 = faits({ userId: "k1" });
const SUP = faits({ userId: "sup", equipe: new Set(["k1", "k2"]) });
const OPS = faits({ userId: "ops", vueGlobale: true, directeurDesOperations: true, equipe: new Set(["sup", "k1", "k2"]) });
const FIN = faits({ userId: "fin", module: { voir: true, creer: false, modifier: false }, vueGlobale: true });
const RETIRE = faits({ userId: "k9", module: { voir: false, creer: false, modifier: false } });

describe("Le magasin central", () => {
  it("se tient par la directrice marketing et le Super Admin — et personne d'autre", () => {
    expect([SA, DM, PM2, K1, OPS, FIN].map(tientLeMagasin)).toEqual([true, true, false, false, false, false]);
    expect(peutDoter(DM)).toBe(true);
    expect(peutDoter(PM2), "un membre de la Direction Marketing qui n'en est pas la cheffe ne dote pas").toBe(false);
    expect(peutDoter(OPS), "la vue globale ne donne pas la clé du magasin").toBe(false);
    expect(peutServirDemande(DM) && peutGererArticles(DM)).toBe(true);
    expect(peutServirDemande(PM2) || peutGererArticles(PM2)).toBe(false);
  });

  it("un compte qui a la Direction Marketing mais plus le MODULE ne tient rien", () => {
    expect(tientLeMagasin(faits({ userId: "dm2", gereLeMagasin: true, module: { voir: false, creer: false, modifier: false } }))).toBe(false);
  });
});

describe("Voir", () => {
  it("chacun voit le sien ; un délégué ne voit ni le magasin ni un collègue", () => {
    expect(peutVoirStockDe(K1, "k1")).toBe(true);
    expect(peutVoirStockDe(K1, "k2")).toBe(false);
    expect(peutVoirStockDe(K1, null)).toBe(false);
  });

  it("un superviseur voit son équipe ; la vue globale voit tout ; un module retiré ne voit rien", () => {
    expect(peutVoirStockDe(SUP, "k1")).toBe(true);
    expect(peutVoirStockDe(SUP, null)).toBe(false);
    expect(peutVoirStockDe(FIN, "k1") && peutVoirStockDe(FIN, null)).toBe(true);
    expect(peutVoirStockDe(RETIRE, "k9"), "sans le module, même son propre stock").toBe(false);
    expect(aUneEquipe(SUP) && aUneEquipe(OPS)).toBe(true);
    expect(aUneEquipe(K1)).toBe(false);
  });
});

describe("Faire sortir — la gestion des équipes est au directeur des opérations", () => {
  it("le détenteur dispose du sien ; un superviseur VOIT le stock de ses KAM, il n'en dispose pas", () => {
    expect(peutSortirDe(K1, "k1")).toBe(true);
    expect(peutSortirDe(K1, "k2")).toBe(false);
    expect(peutSortirDe(SUP, "k1")).toBe(false);
  });

  it("le directeur des opérations dispose du stock de ses équipes, pas au-delà, pas du magasin", () => {
    expect(peutSortirDe(OPS, "k1")).toBe(true);
    expect(peutSortirDe(OPS, "k3")).toBe(false);
    expect(peutSortirDe(OPS, null)).toBe(false);
  });

  it("…et le déplace DANS ses équipes, vers lui, ou au magasin — jamais hors de son périmètre", () => {
    expect(peutTransfererVers(OPS, "k1", "k2")).toBe(true);
    expect(peutTransfererVers(OPS, "k1", "ops")).toBe(true);
    expect(peutTransfererVers(OPS, "k1", null)).toBe(true);
    expect(peutTransfererVers(OPS, "k1", "k3")).toBe(false);
  });

  it("le détenteur lui-même, et le Super Admin, envoient où ils veulent", () => {
    expect(peutTransfererVers(K1, "k1", "k3")).toBe(true);
    expect(peutTransfererVers(SA, "k1", "k3")).toBe(true);
  });

  it("une demande s'annule par son auteur ; le magasin la REFUSE, avec un motif", () => {
    expect(peutAnnulerDemande(K1, "k1")).toBe(true);
    expect(peutAnnulerDemande(DM, "k1")).toBe(false);
    expect(peutAnnulerDemande(SA, "k1"), "le Super Admin refuse une demande, il ne l'efface pas sans un mot").toBe(false);
    expect(peutAnnulerDemande(RETIRE, "k9")).toBe(false);
  });

  it("un droit en LECTURE ne fait rien sortir, même de chez soi", () => {
    expect(peutSortirDe(FIN, "fin")).toBe(false);
    expect(peutDemander(FIN)).toBe(false);
    expect(peutDemander(K1)).toBe(true);
  });
});

describe("Confirmer une réception est une ATTESTATION", () => {
  it("seul celui qui reçoit confirme — pas même le Super Admin, pas le directeur des opérations", () => {
    expect(peutConfirmerReception(K1, "k1")).toBe(true);
    expect(peutConfirmerReception(SA, "k1")).toBe(false);
    expect(peutConfirmerReception(OPS, "k1")).toBe(false);
  });

  it("un retour au magasin se confirme par qui le tient", () => {
    expect(peutConfirmerReception(DM, null)).toBe(true);
    expect(peutConfirmerReception(SA, null)).toBe(true);
    expect(peutConfirmerReception(K1, null)).toBe(false);
    expect(peutConfirmerReception(PM2, null)).toBe(false);
  });

  it("annuler un transfert en route : celui qui l'a lancé, le Super Admin, le magasin pour ses dotations", () => {
    expect(peutAnnulerTransfert(K1, { initiateurId: "k1", deId: "k1" })).toBe(true);
    expect(peutAnnulerTransfert(SA, { initiateurId: "k1", deId: "k1" })).toBe(true);
    expect(peutAnnulerTransfert(DM, { initiateurId: "sa", deId: null })).toBe(true);
    expect(peutAnnulerTransfert(DM, { initiateurId: "k1", deId: "k1" })).toBe(false);
    expect(peutAnnulerTransfert(faits({ userId: "k2" }), { initiateurId: "k1", deId: "k1" }), "le destinataire refuse, il n'annule pas").toBe(false);
  });
});

describe("Ce qui crée ou efface du stock sans facture ni transfert", () => {
  it("entrée manuelle et inventaire d'ouverture : la directrice qui tient le magasin et le Super Admin (Direction, 23/11/2026)", () => {
    for (const f of [SA, DM]) expect(peutEntrerAlaMain(f) && peutPoserOuverture(f), f.userId).toBe(true);
    for (const f of [PM2, K1, OPS, FIN]) {
      expect(peutEntrerAlaMain(f) || peutPoserOuverture(f), `${f.userId} ne crée pas de stock`).toBe(false);
    }
    const dmSansCreer = faits({ userId: "dm3", gereLeMagasin: true, module: { voir: true, creer: false, modifier: true } });
    expect(peutEntrerAlaMain(dmSansCreer) || peutPoserOuverture(dmSansCreer), "tenir le magasin sans le droit « Créer » du module ne suffit pas").toBe(false);
  });

  it("annuler un mouvement : le Super Admin seul — la directrice non plus", () => {
    for (const f of [DM, PM2, K1, OPS, FIN]) expect(peutAnnulerMouvement(f), f.userId).toBe(false);
    expect(peutAnnulerMouvement(SA)).toBe(true);
  });

  it("corriger : le magasin par sa gestionnaire, le solde d'une personne par le Super Admin", () => {
    expect(peutCorriger(DM, null)).toBe(true);
    expect(peutCorriger(DM, "k1")).toBe(false);
    expect(peutCorriger(OPS, "k1"), "gérer les équipes n'est pas réécrire leurs soldes à la main").toBe(false);
    expect(peutCorriger(K1, "k1"), "laisser chacun réécrire son solde ferait du stock une déclaration").toBe(false);
    expect(peutCorriger(SA, "k1")).toBe(true);
  });
});
