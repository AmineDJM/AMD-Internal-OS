import { describe, it, expect } from "vitest";
import {
  declareStage, canRequestDecision, canFileWithAuthorities, canValidateEvent,
  declareMessage, declareStageLabel, isDeclareIntent, DECLARE_INTENT_LABEL,
  type DeclareInput,
} from "./declare-decision";

const input = (o: Partial<DeclareInput> = {}): DeclareInput => ({
  validationId: null, validationStatus: null, intent: null, ...o,
});
const ACCORDEE_DECLARE = input({ validationId: "v1", validationStatus: "APPROVED", intent: "DECLARE" });
const ACCORDEE_SKIP = input({ validationId: "v1", validationStatus: "APPROVED", intent: "SKIP" });
const RIEN = { authorityRef: null };
const DEPOSE = { authorityRef: "MIP-2026-0912" };

describe("l'état de la décision", () => {
  it("rien de demandé = à demander", () => {
    expect(declareStage(input())).toBe("A_DEMANDER");
  });

  it("suit la demande de validation, état par état", () => {
    expect(declareStage(input({ validationId: "v1", validationStatus: "PENDING" }))).toBe("EN_VALIDATION");
    expect(declareStage(input({ validationId: "v1", validationStatus: "CHANGES_REQUESTED" }))).toBe("A_REVOIR");
    expect(declareStage(input({ validationId: "v1", validationStatus: "REJECTED" }))).toBe("REFUSEE");
    expect(declareStage(input({ validationId: "v1", validationStatus: "APPROVED" }))).toBe("ACCORDEE");
  });

  it("un état inconnu ne déverrouille rien — il reste « en validation »", () => {
    expect(declareStage(input({ validationId: "v1", validationStatus: "ÉTAT_INCONNU" }))).toBe("EN_VALIDATION");
  });

  it("LA REPRISE : un dossier instruit avant que cette marche existe est réputé accordé", () => {
    // Le renvoyer à « décision à demander » lui ferait refaire signer une question tranchée il y
    // a des mois — parfois sur un dossier déjà déposé au ministère.
    const repris = input({ grantedAt: new Date("2026-05-01"), intent: "DECLARE" });
    expect(declareStage(repris)).toBe("ACCORDEE");
    expect(canFileWithAuthorities(repris)).toBe(true);
    expect(canRequestDecision(repris)).toBe(false);
  });
});

describe("(re)soumettre sa lecture", () => {
  it("UN REFUS ROUVRE LA PORTE — le validateur a dit ce qu'il attendait", () => {
    expect(canRequestDecision(input({ validationId: "v1", validationStatus: "REJECTED" }))).toBe(true);
  });

  it("« à revoir » SE RESOUMET ici — la demande de validation n'a aucun geste de reprise (audit 360°, I9)", () => {
    // La règle d'avant (« ne se redemande pas ») laissait le dossier mort au premier « Modification » :
    // le retrait est refusé dès qu'un validateur s'est prononcé. L'unicité tient autrement : la
    // resoumission CLÔT la précédente (`clorePrecedente`, écriture conditionnelle).
    expect(canRequestDecision(input({ validationId: "v1", validationStatus: "CHANGES_REQUESTED" }))).toBe(true);
  });

  it("une demande ANNULÉE ou SUPPRIMÉE n'est plus une demande : le dossier n'est pas « en validation » à vie", () => {
    expect(declareStage(input({ validationId: "v1", validationStatus: "CANCELLED" }))).toBe("A_DEMANDER");
    expect(canRequestDecision(input({ validationId: "v1", validationStatus: "CANCELLED" }))).toBe(true);
    // Le témoin : un statut inconnu reste « en validation » — on ne rouvre pas sur ce qu'on ne lit pas.
    expect(declareStage(input({ validationId: "v1", validationStatus: "PENDING" }))).toBe("EN_VALIDATION");
  });

  it("ni en cours, ni une fois accordée", () => {
    expect(canRequestDecision(input({ validationId: "v1", validationStatus: "PENDING" }))).toBe(false);
    expect(canRequestDecision(ACCORDEE_DECLARE)).toBe(false);
  });

  it("les deux lectures sont légitimes, et nommées", () => {
    expect(isDeclareIntent("DECLARE")).toBe(true);
    expect(isDeclareIntent("SKIP")).toBe(true);
    expect(isDeclareIntent("PEUT_ÊTRE")).toBe(false);
    expect(DECLARE_INTENT_LABEL.SKIP).toMatch(/sans déclaration/i);
  });
});

describe("le dépôt à l'ANPP", () => {
  it("FERMÉ TANT QUE LA LECTURE N'EST PAS ACCORDÉE", () => {
    expect(canFileWithAuthorities(input({ intent: "DECLARE" }))).toBe(false);
    expect(canFileWithAuthorities(input({ validationId: "v1", validationStatus: "PENDING", intent: "DECLARE" }))).toBe(false);
  });

  it("ouvert quand elle l'est, et que la lecture était « à déclarer »", () => {
    expect(canFileWithAuthorities(ACCORDEE_DECLARE)).toBe(true);
  });

  it("FERMÉ SUR UNE LECTURE « SANS DÉCLARATION » — il n'y a rien à déposer", () => {
    expect(canFileWithAuthorities(ACCORDEE_SKIP)).toBe(false);
  });
});

describe("valider le dossier", () => {
  it("IMPOSSIBLE SANS DÉCISION — ce serait trancher tout seul la question qu'on vient d'ouvrir", () => {
    expect(canValidateEvent(input({ intent: "DECLARE" }), DEPOSE)).toBe(false);
    expect(canValidateEvent(input({ validationId: "v1", validationStatus: "PENDING", intent: "SKIP" }), RIEN)).toBe(false);
  });

  it("« à déclarer » exige le DÉPÔT — la référence ANPP", () => {
    expect(canValidateEvent(ACCORDEE_DECLARE, RIEN)).toBe(false);
    expect(canValidateEvent(ACCORDEE_DECLARE, { authorityRef: "   " })).toBe(false);
    expect(canValidateEvent(ACCORDEE_DECLARE, DEPOSE)).toBe(true);
  });

  it("« sans déclaration » se valide DIRECTEMENT : il n'y a rien à déposer", () => {
    expect(canValidateEvent(ACCORDEE_SKIP, RIEN)).toBe(true);
  });
});

describe("ce que l'écran dit", () => {
  it("nomme le geste attendu à chaque étape", () => {
    expect(declareMessage(input(), RIEN)).toMatch(/à l'ANPP/);
    expect(declareMessage(input({ validationId: "v1", validationStatus: "PENDING" }), RIEN)).toMatch(/rien à faire/i);
    // Le message disait « reprenez-la là-bas » : un geste qui n'existait pas (audit 360°, I9).
    expect(declareMessage(input({ validationId: "v1", validationStatus: "CHANGES_REQUESTED" }), RIEN)).toMatch(/soumettez-la de nouveau ici/i);
    expect(declareMessage(input({ validationId: "v1", validationStatus: "CHANGES_REQUESTED" }), RIEN)).not.toMatch(/là-bas/i);
    expect(declareMessage(input({ validationId: "v1", validationStatus: "REJECTED" }), RIEN)).toMatch(/refusée/i);
  });

  it("SÉPARE LES DEUX LECTURES ACCORDÉES — l'une demande un dépôt, l'autre non", () => {
    expect(declareMessage(ACCORDEE_DECLARE, RIEN)).toMatch(/faites le nécessaire/i);
    expect(declareMessage(ACCORDEE_DECLARE, DEPOSE)).toMatch(/enregistré/i);
    expect(declareMessage(ACCORDEE_SKIP, RIEN)).toMatch(/ne se déclare pas/i);
  });

  it("chaque étape porte un libellé lisible", () => {
    expect(declareStageLabel("A_DEMANDER")).toMatch(/à demander/i);
    expect(declareStageLabel("ACCORDEE")).toMatch(/accordée/i);
  });
});
