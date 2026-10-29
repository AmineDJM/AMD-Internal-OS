import { describe, expect, it } from "vitest";
import {
  FENETRE_DISCRETE_MS, porteDuDemandeur, estDiscrete, refusDeModification, changementsDeLaDemande,
  suitLaDemandeDeBcDuPoste, refusDemandeDeBcDuPoste, type DemandeVueParSonDemandeur, type ContenuDemande,
} from "./porte-demandeur";
import { TITRE_BC_A_ETABLIR } from "@/modules/ad-pro/partage";

/**
 * UNE DEMANDE AU SECRÉTARIAT NE SE FIGE PAS À LA TRENTE ET UNIÈME MINUTE (§118.187, audit R08) — chaque
 * branche avec son cas, et la minute qui fait basculer, nommée (le temps est un paramètre obligatoire).
 */

const T0 = new Date("2026-10-03T08:00:00Z");
const demande = (over: Partial<DemandeVueParSonDemandeur> = {}): DemandeVueParSonDemandeur => ({
  requesterId: "moi", status: "NEW", createdAt: T0, processingStartedAt: null, ...over,
});
const apres = (ms: number) => T0.getTime() + ms;

describe("porteDuDemandeur — qui, et dans quel mode", () => {
  it("le demandeur, sur une demande neuve de moins de trente minutes : DISCRET", () => {
    expect(porteDuDemandeur(demande(), "moi", apres(FENETRE_DISCRETE_MS))).toEqual({ ok: true, discret: true });
  });

  it("la minute d'après : toujours ouverte, mais PRÉVENUE — l'encart ne disparaît plus", () => {
    expect(porteDuDemandeur(demande(), "moi", apres(FENETRE_DISCRETE_MS + 1))).toEqual({ ok: true, discret: false });
  });

  it("commencée par l'assistante, même à la deuxième minute : prévenue", () => {
    expect(porteDuDemandeur(demande({ processingStartedAt: T0 }), "moi", apres(60_000))).toEqual({ ok: true, discret: false });
    expect(estDiscrete(demande({ status: "IN_PROGRESS" }), apres(60_000))).toBe(false);
  });

  it("en attente de validation, de paiement, bloquée : ouverte et prévenue — jamais figée", () => {
    for (const status of ["AWAITING_VALIDATION", "AWAITING_PAYMENT", "AWAITING_DOCUMENT", "AWAITING_EXTERNAL", "BLOCKED", "IN_PROGRESS"] as const) {
      expect(porteDuDemandeur(demande({ status }), "moi", apres(3_600_000)), status).toEqual({ ok: true, discret: false });
    }
  });

  it("TERMINÉE : refusée, et le refus nomme le remède (une nouvelle demande, ou la discussion)", () => {
    const r = porteDuDemandeur(demande({ status: "DONE" }), "moi", apres(1000));
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.raison).toMatch(/nouvelle demande en citant sa référence/);
  });

  it("ANNULÉE : refusée", () => {
    expect(porteDuDemandeur(demande({ status: "CANCELLED" }), "moi", apres(1000))).toEqual({ ok: false, raison: "Cette demande est déjà annulée." });
  });

  it("quelqu'un d'autre que le demandeur : refusé, même l'assistante, même dans la fenêtre", () => {
    const r = porteDuDemandeur(demande(), "assistante", apres(1000));
    expect(r.ok).toBe(false);
    expect(porteDuDemandeur(demande({ requesterId: null }), "moi", apres(1000)).ok, "une demande sans demandeur n'a personne pour la retirer").toBe(false);
  });
});

describe("refusDeModification — ce qui ferme la CORRECTION, pas l'annulation", () => {
  it("une validation en cours ferme la correction, et le dit avant le paiement", () => {
    expect(refusDeModification({ validationEnCours: true, paiementEmis: true })).toMatch(/validation est en cours/);
  });
  it("un paiement émis ferme la correction, et nomme l'annulation comme issue", () => {
    expect(refusDeModification({ validationEnCours: false, paiementEmis: true })).toMatch(/annulez la demande/);
  });
  it("rien de tout cela : ouverte", () => {
    expect(refusDeModification({ validationEnCours: false, paiementEmis: false })).toBeNull();
  });
});

describe("changementsDeLaDemande — ce que l'assistante lira", () => {
  const base: ContenuDemande = { title: "Billet Alger–Oran", description: "Aller simple", priority: "MEDIUM", deadline: "2026-10-10", fields: { villeArrivee: "Oran" } };

  it("rien n'a changé (espaces mis à part) : rien à dire", () => {
    expect(changementsDeLaDemande(base, { ...base, title: " Billet Alger–Oran " }, {})).toEqual([]);
  });

  it("chaque changement se nomme dans les mots de l'écran — un champ inconnu par sa clé, jamais tu", () => {
    const dit = changementsDeLaDemande(
      base,
      { ...base, deadline: "2026-10-12", priority: "HIGH", fields: { villeArrivee: "Constantine", nouveau: "x" } },
      { villeArrivee: "Ville d'arrivée" },
    );
    expect(dit).toEqual(["la priorité", "l'échéance", "« nouveau »", "« Ville d'arrivée »"]);
  });

  it("un champ VIDÉ est un changement", () => {
    expect(changementsDeLaDemande(base, { ...base, description: null }, {})).toEqual(["la description"]);
  });
});

describe("la demande « BC à établir » suit son poste", () => {
  it("reconnue par son lien ET sa forme — l'un sans l'autre ne suffit pas", () => {
    expect(suitLaDemandeDeBcDuPoste({ linkedEntityType: "AD_PRO_ITEM", type: "OTHER", title: `${TITRE_BC_A_ETABLIR} — Traiteur` })).toBe(true);
    expect(suitLaDemandeDeBcDuPoste({ linkedEntityType: "AD_PRO_ITEM", type: "QUOTE", title: "Devis — Traiteur" }), "un devis de poste se gère ici").toBe(false);
    expect(suitLaDemandeDeBcDuPoste({ linkedEntityType: null, type: "OTHER", title: `${TITRE_BC_A_ETABLIR} — à la main` }), "sans poste, rien à suivre").toBe(false);
  });
  it("le refus nomme le geste du poste qui la met à jour ou la ferme", () => {
    expect(refusDemandeDeBcDuPoste("corriger")).toMatch(/« Modifier la demande de BC »/);
    expect(refusDemandeDeBcDuPoste("annuler")).toMatch(/« Annuler la demande de BC »/);
  });
});
