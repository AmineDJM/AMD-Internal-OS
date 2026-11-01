// EN PREMIER, comme le worker : le contexte asynchrone de Next, réel hors de son serveur.
import "@/lib/async-local-storage-global";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/session";
import { couvertes, nettoyer, personneDeTest } from "./banc";
import { CAS_INTERNES } from "./cas-internes";
import { CAS_ENVOIS } from "./cas-envois";
import { CAS_DECISIONS } from "./cas-decisions";
import CLASSEMENT_JSON from "@/platform/ia/capacites/classement.genere.json";
import type { LigneCliche } from "@/platform/ia/capacites/cliche";
import { DECLARATIONS_COMMUNICATIONS } from "@/lib/effets/declarations/communications";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * K10b — CHAQUE ACTION DÉCLARÉE RÉVERSIBLE EST EXÉCUTÉE PUIS ANNULÉE CONTRE LA BASE (décision 0040), aucun `vi.mock`.
 *
 * `cycle` joue l'action de l'ÉCRAN (la vraie fonction, sous la personne, hors requête), retrouve son geste au journal,
 * l'ANNULE et vérifie que l'état relu est celui d'avant, puis le RÉTABLIT (état d'après), le RÉ-ANNULE, et compte
 * l'audit des gestes. LE CLIQUET : les actions écrivantes du périmètre K10b ne sont plus « aucune », et chaque
 * déclaration a son cycle ici.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__k10b__${Date.now()}`;

/** LE PÉRIMÈTRE K10b — les actions écrivantes classées « aucune » au 31/10/2026 (classement 2008b9a9). */
const PERIMETRE_K10B = [
  "admin-request-actions:decideApproval", "admin-request-actions:finishRequest", "candidatures-site-actions:classerCandidatureSite",
  "candidatures-site-actions:rattacherCandidatureSite", "candidatures-site-actions:remettreCandidatureATrier", "care-actions:decideCareQuote",
  "custom-field-actions:modifierChampPersonnalise", "custom-field-actions:saveCustomValues", "directive-actions:publishDirective",
  "directive-actions:resendDirective", "dossier-actions:linkEmailToDossier", "fabrique-actions:emettreAvoir", "fabrique-actions:emettrePieceCommerciale",
  "fabrique-actions:reglerNumerotationPieces", "kpi-actions:reglerAffectationKpi", "kpi-actions:reglerFrequenceRevue", "mail-actions:connectMailbox",
  "mail-actions:disconnectMailbox", "mail-actions:sendMailAction", "mail-folder-actions:createMailFolder", "mail-folder-actions:moveMailEntries",
  "mail-folder-actions:updateMailFolder", "mail-partner-actions:createMailPartner", "mail-partner-actions:updateMailPartner", "mail-piece-actions:addMailPiece",
  "mail-piece-actions:updateMailPiece", "mail-register-actions:attachDriveNodeToMail", "mail-register-actions:createMailEntry", "mail-register-actions:editMailEntry",
  "mail-register-actions:setMailDate", "medical-info-actions:requestSlipPayment", "medical-info-actions:validateDeclarationByDirection",
  "microsoft-mail-actions:disconnectMicrosoftMail", "microsoft-mail-actions:linkMessageToEntity", "microsoft-mail-actions:moveMessage",
  "microsoft-mail-actions:saveAttachmentToDrive", "microsoft-mail-actions:saveDraft", "microsoft-mail-actions:sendMessage", "microsoft-mail-actions:setMessageRead",
  "recrutement-diffusion-actions:enregistrerTexteCanal", "recrutement-diffusion-actions:envoyerOffreEmploitic", "recrutement-diffusion-actions:marquerCanalPublie",
  "recrutement-diffusion-actions:preparerPostLinkedIn", "recrutement-diffusion-actions:publierOffreSiteDuRecrutement", "recrutement-diffusion-actions:retirerCanal",
  "segmentation-actions:publierRegles", "site-web-actions:abandonnerCleSite", "site-web-actions:enregistrerArticle", "site-web-actions:genererCleSite",
  "site-web-actions:rapprocherSiteMaintenant", "site-web-actions:relancerEnvoiSite", "site-web-actions:verifierConnexionSite",
  "site-web-redaction-actions:redigerArticleAvecIA", "site-web-redaction-actions:redigerOffreAvecIA", "smart-mail-actions:sendMail",
  "smart-mail-actions:smartMailStatus", "supplier-portal-actions:supplierLogin", "supplier-portal-actions:supplierLogout",
] as const;

/**
 * LE CLIQUET QUI DESCEND : ce qui reste « aucune » dans le périmètre — la liste ne fait que RACCOURCIR. Elle est vide :
 * une action du périmètre qui redeviendrait « aucune » fait échouer le test.
 */
const RESTANTES_K10B: readonly string[] = [];

const CLASSEMENT = CLASSEMENT_JSON as Record<string, LigneCliche>;
let moi: CurrentUser;

suite("K10b — exécuter puis annuler, action par action (décision 0040)", () => {
  beforeAll(async () => { moi = await personneDeTest(TAG); });
  afterAll(async () => {
    await nettoyer([moi.id]);
    for (const c of [...CAS_INTERNES, ...CAS_ENVOIS, ...CAS_DECISIONS]) await c.nettoyer?.(TAG);
    await prisma.mailEntryPiece.deleteMany({ where: { label: { startsWith: TAG } } }).catch(() => undefined);
    await prisma.mailEntry.deleteMany({ where: { title: { startsWith: TAG } } }).catch(() => undefined);
    await prisma.mailEntryFolder.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => undefined);
    await prisma.mailPartner.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => undefined);
    await prisma.driveNode.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => undefined);
    await prisma.auditLog.deleteMany({ where: { actorId: moi.id } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: moi.id } }).catch(() => undefined);
  });

  for (const [famille, cas] of [["internes", CAS_INTERNES], ["envois", CAS_ENVOIS], ["décisions et pièces", CAS_DECISIONS]] as const) {
    describe(famille, () => {
      for (const c of cas) it(`${c.id} — ${c.titre}`, () => c.jouer(moi, TAG), 60_000);
    });
  }

  // ── LE CLIQUET ──────────────────────────────────────────────────────────────────────────────
  it("LE CLIQUET : les actions écrivantes du périmètre K10b encore « aucune » sont exactement les restantes (la liste descend), et chaque déclaration a son cycle", () => {
    const encoreAucune = PERIMETRE_K10B.filter((id) => CLASSEMENT[id]?.annulation === "aucune" && CLASSEMENT[id]?.risque !== "R0");
    expect(encoreAucune).toEqual([...RESTANTES_K10B]);
    // Chaque déclaration a son cas (le cycle exécuter → annuler → rétablir → ré-annuler l'a couverte) ; « sans-effet »
    // (rien n'est écrit) n'a rien à défaire, et le dit.
    const sansCas = Object.keys(DECLARATIONS_COMMUNICATIONS).filter((id) => DECLARATIONS_COMMUNICATIONS[id]!.mecanisme !== "sans-effet"
      && ![...CAS_INTERNES, ...CAS_ENVOIS, ...CAS_DECISIONS].some((c) => c.id === id));
    expect(sansCas).toEqual([]);
    // Un cas joué en entier a couvert son action (le test du cas échoue sinon) : aucun cas ne prétend couvrir sans cycle.
    if (!process.env.VITEST_FILTRE) for (const c of [...CAS_INTERNES, ...CAS_ENVOIS, ...CAS_DECISIONS]) expect(couvertes.has(c.id) || c.id.startsWith("supplier-portal"), c.id).toBe(true);
  });
});
