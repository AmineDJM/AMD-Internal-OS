// EN PREMIER, comme le worker : le contexte asynchrone de Next, réel hors de son serveur.
import "@/lib/async-local-storage-global";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { retirerNoeudsDriveEtContenu } from "@/lib/actions/internes/menage-de-banc";
import type { CurrentUser } from "@/lib/session";
import { couvertes, nettoyer, outilsDeTest, personneDeTest } from "./banc";
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

/** LE MÉNAGE D'UN PASSAGE — tout ce que ses cas ont créé sous son étiquette. */
async function menage(tag: string, personnes: string[]): Promise<void> {
  await nettoyer(personnes);
  for (const c of [...CAS_INTERNES, ...CAS_ENVOIS, ...CAS_DECISIONS]) await c.nettoyer?.(tag);
  await prisma.mailEntryPiece.deleteMany({ where: { label: { startsWith: tag } } }).catch(() => undefined);
  await prisma.mailEntry.deleteMany({ where: { title: { startsWith: tag } } }).catch(() => undefined);
  await prisma.mailEntryFolder.deleteMany({ where: { name: { startsWith: tag } } }).catch(() => undefined);
  await prisma.mailPartner.deleteMany({ where: { name: { startsWith: tag } } }).catch(() => undefined);
  await retirerNoeudsDriveEtContenu({ where: { name: { startsWith: tag } } }).catch(() => undefined);
  await prisma.auditLog.deleteMany({ where: { actorId: { in: personnes } } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: personnes } } }).catch(() => undefined);
}

/**
 * LES RESTES D'UN PASSAGE INTERROMPU (F1, 02/11/2026). `afterAll` ne tourne pas quand le processus est tué : ses articles
 * et offres PUBLIÉS « __k10b__<horodatage> … » restaient en base, et le rapprochement du site les comptait chez les autres
 * bancs (`site-web/publication.test.ts` : « absent du site », repoussé). En tête de suite, chaque étiquette de plus de
 * DEUX HEURES est ménagée comme son propre passage l'aurait fait — jamais une étiquette récente : un autre passage du
 * fichier peut tourner à côté (la suite entière dure une vingtaine de minutes).
 */
async function menagerLesRestes(): Promise<void> {
  const avant = Date.now() - 2 * 3_600_000;
  const prefixe = { startsWith: "__k10b__" };
  const [personnes, articles, offres] = await Promise.all([
    prisma.user.findMany({ where: { name: prefixe }, select: { id: true, name: true } }),
    prisma.blogArticle.findMany({ where: { title: prefixe }, select: { title: true } }),
    prisma.jobPosting.findMany({ where: { title: prefixe }, select: { title: true } }),
  ]);
  const etiquette = (t: string): string | null => {
    const m = /^__k10b__(\d{13})/.exec(t);
    return m && Number(m[1]) < avant ? `__k10b__${m[1]}` : null;
  };
  const restes = new Set([...personnes.map((p) => p.name), ...articles.map((a) => a.title), ...offres.map((o) => o.title)].map(etiquette).filter((t): t is string => t !== null));
  for (const tag of restes) await menage(tag, personnes.filter((p) => p.name.startsWith(tag)).map((p) => p.id));
}

suite("K10b — exécuter puis annuler, action par action (décision 0040)", () => {
  beforeAll(async () => {
    await menagerLesRestes();
    moi = await personneDeTest(TAG);
    // Les écritures sensibles des fixtures vivent ICI, dans le test (voir `outilsDeTest`).
    outilsDeTest.payerOrdre = async (ordreId, parId) => {
      await prisma.expenseOrder.update({ where: { id: ordreId }, data: { status: "PAID", paidDate: new Date(), paidById: parId } });
    };
    outilsDeTest.identiteLegale = async (companyId, tag) => {
      await prisma.companyLegalIdentity.create({
        data: {
          companyId, legalName: `${tag} Pharma SARL`, legalForm: "SARL", shareCapital: "10 000 000 DZD", rcNumber: "16/00-1234567B21", nif: "001916012345678",
          nis: "001916012345690", taxArticle: "16012345678", headOffice: "12 rue des Frères Bouadou, Alger", phone: "+213 21 00 00 00", email: "contact@t.dz",
          bankName: "BNA", bankAgency: "Hydra", rib: "001 00123 0123456789 45", managerName: "Amine Djouamai", managerTitle: "Gérant",
        },
      });
    };
  });
  afterAll(async () => { await menage(TAG, [moi.id]); });

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
    // Le portail fournisseur n'a pas de session ERP : ses deux gestes, l'un l'inverse de l'autre, ont leur test dédié
    // (`portail-fournisseur.test.ts`, la session observée par un faux `supplier-auth`).
    const DEDIES = new Set(["supplier-portal-actions:supplierLogin", "supplier-portal-actions:supplierLogout"]);
    const sansCas = Object.keys(DECLARATIONS_COMMUNICATIONS).filter((id) => DECLARATIONS_COMMUNICATIONS[id]!.mecanisme !== "sans-effet"
      && !DEDIES.has(id) && ![...CAS_INTERNES, ...CAS_ENVOIS, ...CAS_DECISIONS].some((c) => c.id === id));
    expect(sansCas).toEqual([]);
    // Un cas joué en entier a couvert son action (le test du cas échoue sinon) : aucun cas ne prétend couvrir sans cycle.
    if (!process.env.VITEST_FILTRE) for (const c of [...CAS_INTERNES, ...CAS_ENVOIS, ...CAS_DECISIONS]) expect(couvertes.has(c.id), c.id).toBe(true);
  });
});
