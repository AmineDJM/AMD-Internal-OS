import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import cliche from "@/platform/ia/capacites/classement.genere.json";
import { DECLARATIONS_METIERS as ANNULATIONS_DECLAREES } from "./declarations/metiers";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE CLIQUET DU PÉRIMÈTRE K10c — les actions écrivantes qu'on classait « aucune » au 31/10/2026 (2008b9a9), hors
 * argent (K10a) et communications/suppressions (K10b) : Ad & Pro, congrès, RH avances, juridique, promo,
 * réservations, validations, réglages de l'Assistant IA, diffusion de masse.
 *
 * Pour chacune, trois faits tenus ensemble — jamais l'un sans les autres :
 *   1. le cliché du registre ne la classe plus « aucune » (déclarée dans `annulations-declarees.ts`) ;
 *   2. son corps est enveloppé par `actionReversible("<id>", …)` : au clic, elle entre au journal des effets ;
 *   3. un banc l'EXÉCUTE puis l'ANNULE contre la base (`reversibles-*.test.ts`).
 * La liste des actions écrivantes encore « aucune » de ce périmètre doit être VIDE.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const PERIMETRE = [
  "ad-pro-item-actions:annulerOrdrePoste", "ad-pro-item-actions:deleteAdProItem", "ad-pro-item-actions:demanderPaiementPoste",
  "assistant-ia-actions:reglerMaReponseVocale", "assistant-ia-conversations-actions:reglerMaConversationPrivee",
  "assistant-ia-proactivite-actions:reglerConsoleProactivite", "assistant-ia-proactivite-actions:reglerMaVeille",
  "assistant-ia-proactivite-actions:reglerMonVeilleur", "assistant-ia-travaux-actions:reglerMaPreferenceDOffice",
  "assistant-ia-travaux-actions:reglerPrioriteMonTravail", "budget-pole-actions:imputerBv",
  "congress-request-actions:finalDecision", "congress-request-actions:updateGrantedBudget",
  "hr-actions:cancelAdvance", "hr-actions:decideAdvance", "hr-actions:requestAdvance",
  "legal-actions:cancelLegalDocument", "legal-actions:createLegalDocument", "legal-actions:sendLegalInvoiceToSettlement", "legal-actions:updateLegalDocument",
  "lieux-actions:reglerDoubleEcritureLieux", "natures-moyens-generaux-actions:classerDepensesNonClassees", "notification-actions:sendBroadcast",
  "onlyoffice-diagnostic-actions:testerEditeurOffice", "organisation-actions:reglerDoubleEcritureOrganisations", "process-intelligence-actions:reglerDelaiEtape",
  "promo-budget-actions:imputerBudgetMaterielPromo", "promo-execution-actions:annulerFacturePromo", "promo-execution-actions:demanderPaiementFacturePromo",
  "promo-material-actions:cancelPromoMaterial", "promo-material-actions:initiatePayment", "promo-material-actions:settle",
  "regulatory-actions:requestBV", "relance-paiement-actions:relancerPaiement",
  "reservation-fiche-actions:deposerBillet", "reservation-fiche-actions:envoyerFiche", "reservation-fiche-actions:envoyerFichesPretes",
  "reservation-fiche-actions:joindreDevisAgence", "reservation-fiche-actions:prendreFiche", "reservation-fiche-actions:relancerFiche",
  "reservation-fiche-actions:retirerFiche", "reservation-fiche-actions:signalerManque", "validation-actions:decideValidation",
] as const;

const RACINE = path.resolve(__dirname, "../../..");
function fichiers(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) fichiers(p, out);
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}
const tous = fichiers(path.join(RACINE, "src"));
const sources = tous.filter((f) => !/\.test\.tsx?$/.test(f)).map((f) => fs.readFileSync(f, "utf8")).join("\n");
const bancs = tous.filter((f) => /\/effets\/reversibles-[a-z-]+\.test\.ts$/.test(f) && !f.endsWith("reversibles-metiers.test.ts")).map((f) => fs.readFileSync(f, "utf8")).join("\n");
const classement = cliche as Record<string, { risque: string; annulation: string }>;

describe("K10c — le cliquet : plus aucune action écrivante « aucune » dans le périmètre", () => {
  it("le cliché ne classe plus « aucune » une seule action du périmètre", () => {
    const restent = PERIMETRE.filter((id) => !classement[id] || classement[id].annulation === "aucune");
    expect(restent).toEqual([]);
  });

  it("chaque action du périmètre est déclarée, et chaque déclaration est une action du contrat", () => {
    for (const id of PERIMETRE) expect(ANNULATIONS_DECLAREES[id], id).toBeTruthy();
    for (const id of Object.keys(ANNULATIONS_DECLAREES)) expect(classement[id], `${id} : déclarée mais absente du contrat`).toBeTruthy();
  });

  it("chaque action déclarée entre au journal des effets au clic (`actionReversible`)", () => {
    const nues = Object.keys(ANNULATIONS_DECLAREES).filter((id) => !sources.includes(`actionReversible("${id}"`));
    expect(nues).toEqual([]);
  });

  it("chaque action déclarée est EXÉCUTÉE puis ANNULÉE par un banc contre la base", () => {
    const sansBanc = Object.keys(ANNULATIONS_DECLAREES).filter((id) => !new RegExp(`\\b${id.split(":")[1]}\\(`).test(bancs));
    expect(sansBanc).toEqual([]);
  });
});
