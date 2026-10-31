// EN PREMIER, comme le worker : le contexte asynchrone de Next, réel hors de son serveur.
import "@/lib/async-local-storage-global";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { executerHorsRequete, personneDuGeste } from "@/lib/contexte-geste";
import type { CurrentUser } from "@/lib/session";
import { annulerGeste, type CompteRenduAnnulation } from "@/lib/effets/annulation";
import { retablirGeste } from "@/lib/effets/retablissement";
import CLASSEMENT_JSON from "@/platform/ia/capacites/classement.genere.json";
import type { LigneCliche } from "@/platform/ia/capacites/cliche";
import { DECLARATIONS_COMMUNICATIONS } from "./communications";
import { createMailEntry, editMailEntry, setMailDate, attachDriveNodeToMail } from "@/lib/actions/mail-register-actions";
import { addMailPiece, updateMailPiece } from "@/lib/actions/mail-piece-actions";
import { createMailPartner, updateMailPartner } from "@/lib/actions/mail-partner-actions";
import { createMailFolder, updateMailFolder, moveMailEntries } from "@/lib/actions/mail-folder-actions";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * K10b — CHAQUE ACTION DÉCLARÉE RÉVERSIBLE EST EXÉCUTÉE PUIS ANNULÉE CONTRE LA BASE (décision 0035), aucun `vi.mock`.
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

const couvertes = new Set<string>();

async function personneDeTest(tag: string, role = "SUPER_ADMIN"): Promise<CurrentUser> {
  const u = await prisma.user.create({ data: { name: `${tag}${role}`, email: `${tag}${role.toLowerCase()}@t.dz`, passwordHash: "x", role: role as never } });
  return (await personneDuGeste(u.id))!;
}

/** L'action telle que l'écran l'appelle — la personne rendue à `requireUser`. */
const aLEcran = <T>(moi: CurrentUser, fn: () => Promise<T>): Promise<T> => executerHorsRequete(moi, "banc-k10", fn).then((r) => r.resultat);

const fd = (o: Record<string, string | string[]>): FormData => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) for (const x of Array.isArray(v) ? v : [v]) f.append(k, x);
  return f;
};

interface Cycle<R> {
  /** L'identifiant `fichier:fonction` déclaré. */
  id: string;
  moi: CurrentUser;
  /** Joue l'action (à l'écran) — son retour est vérifié `ok`. */
  faire: () => Promise<R>;
  /** L'état observé (relu en base) — comparé avant / après / annulé / rétabli. */
  lire: () => Promise<unknown>;
  /** Le retour de l'action est-il un succès ? (défaut : `ok !== false`). */
  reussi?: (r: R) => boolean;
  /** L'issue attendue de l'annulation : complète (défaut) ou partielle assumée (compensation dite). */
  complet?: boolean;
  /** Le rétablissement est-il exigé à l'identique ? (défaut : oui). */
  retablir?: boolean;
}

async function cycle<R>(c: Cycle<R>): Promise<{ compte: CompteRenduAnnulation; avant: unknown; apres: unknown; gesteId: string }> {
  const avant = await c.lire();
  const debut = new Date();
  const r = await aLEcran(c.moi, c.faire);
  const ok = c.reussi ? c.reussi(r) : (r as { ok?: boolean } | null)?.ok !== false;
  expect(ok, `${c.id} : ${JSON.stringify(r)}`).toBe(true);
  const apres = await c.lire();
  expect(apres, `${c.id} n'a rien changé`).not.toEqual(avant);
  const g = await prisma.assistantGesteJournal.findFirstOrThrow({ where: { principalId: c.moi.id, capaciteId: c.id, creeLe: { gte: debut } }, orderBy: { creeLe: "desc" } });
  expect(g.origine).toBe("ecran");
  const compte = await annulerGeste(g.id, c.moi);
  if ("refus" in compte) throw new Error(`${c.id} : ${compte.refus}`);
  if (c.complet !== false) {
    expect(compte.complet, `${c.id} : ${JSON.stringify(compte.details)}`).toBe(true);
    expect(await c.lire(), `${c.id} : l'annulation ne rend pas l'état d'avant`).toEqual(avant);
  }
  if (c.retablir !== false) {
    const re = await retablirGeste(g.id, c.moi);
    if ("refus" in re) throw new Error(`${c.id} : ${re.refus}`);
    expect(re.complet, `${c.id} rétablir : ${JSON.stringify(re.details)}`).toBe(true);
    expect(await c.lire(), `${c.id} : le rétablissement ne rend pas l'état d'après`).toEqual(apres);
    // Et le rétabli se ré-annule (une annulation est elle-même annulable, dans les deux sens).
    const encore = await annulerGeste(g.id, c.moi);
    if ("refus" in encore) throw new Error(`${c.id} : ${encore.refus}`);
    if (c.complet !== false) expect(await c.lire()).toEqual(avant);
  }
  expect(await prisma.auditLog.count({ where: { actorId: c.moi.id, entityId: g.id, module: "ASSISTANT_IA" } })).toBeGreaterThanOrEqual(c.retablir !== false ? 3 : 1);
  couvertes.add(c.id);
  return { compte, avant, apres, gesteId: g.id };
}

/** Le ménage : les gestes et l'audit de la personne de test. */
async function nettoyer(ids: string[]): Promise<void> {
  await prisma.effetSortantDiffere.deleteMany({ where: { principalId: { in: ids } } }).catch(() => undefined);
  await prisma.assistantGesteJournal.deleteMany({ where: { principalId: { in: ids } } }).catch(() => undefined);
}

/**
 * LE CLIQUET QUI DESCEND : ce qui reste « aucune » dans le périmètre — la liste ne fait que RACCOURCIR, jusqu'à vide.
 * Une action rendue réversible en sort (et son cycle est exigé) ; une action qui y rentrerait fait échouer le test.
 */
const RESTANTES_K10B: readonly string[] = [
  "admin-request-actions:decideApproval", "admin-request-actions:finishRequest", "candidatures-site-actions:classerCandidatureSite",
  "candidatures-site-actions:rattacherCandidatureSite", "candidatures-site-actions:remettreCandidatureATrier", "care-actions:decideCareQuote",
  "custom-field-actions:modifierChampPersonnalise", "custom-field-actions:saveCustomValues", "directive-actions:publishDirective",
  "directive-actions:resendDirective", "dossier-actions:linkEmailToDossier", "fabrique-actions:emettreAvoir",
  "fabrique-actions:emettrePieceCommerciale", "fabrique-actions:reglerNumerotationPieces", "kpi-actions:reglerAffectationKpi",
  "kpi-actions:reglerFrequenceRevue", "mail-actions:connectMailbox", "mail-actions:disconnectMailbox",
  "mail-actions:sendMailAction", "medical-info-actions:requestSlipPayment", "medical-info-actions:validateDeclarationByDirection",
  "microsoft-mail-actions:disconnectMicrosoftMail", "microsoft-mail-actions:linkMessageToEntity", "microsoft-mail-actions:moveMessage",
  "microsoft-mail-actions:saveAttachmentToDrive", "microsoft-mail-actions:saveDraft", "microsoft-mail-actions:sendMessage",
  "microsoft-mail-actions:setMessageRead", "recrutement-diffusion-actions:enregistrerTexteCanal", "recrutement-diffusion-actions:envoyerOffreEmploitic",
  "recrutement-diffusion-actions:marquerCanalPublie", "recrutement-diffusion-actions:preparerPostLinkedIn", "recrutement-diffusion-actions:publierOffreSiteDuRecrutement",
  "recrutement-diffusion-actions:retirerCanal", "segmentation-actions:publierRegles", "site-web-actions:abandonnerCleSite",
  "site-web-actions:enregistrerArticle", "site-web-actions:genererCleSite", "site-web-actions:rapprocherSiteMaintenant",
  "site-web-actions:relancerEnvoiSite", "site-web-actions:verifierConnexionSite", "site-web-redaction-actions:redigerArticleAvecIA",
  "site-web-redaction-actions:redigerOffreAvecIA", "smart-mail-actions:sendMail", "smart-mail-actions:smartMailStatus",
  "supplier-portal-actions:supplierLogin", "supplier-portal-actions:supplierLogout",
];

const CLASSEMENT = CLASSEMENT_JSON as Record<string, LigneCliche>;
let moi: CurrentUser;

suite("K10b — exécuter puis annuler, action par action (décision 0035)", () => {
  beforeAll(async () => { moi = await personneDeTest(TAG); });
  afterAll(async () => {
    await nettoyer([moi.id]);
    await prisma.mailEntryPiece.deleteMany({ where: { label: { startsWith: TAG } } }).catch(() => undefined);
    await prisma.mailEntry.deleteMany({ where: { title: { startsWith: TAG } } }).catch(() => undefined);
    await prisma.mailEntryFolder.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => undefined);
    await prisma.mailPartner.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => undefined);
    await prisma.driveNode.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => undefined);
    await prisma.auditLog.deleteMany({ where: { actorId: moi.id } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: moi.id } }).catch(() => undefined);
  });

  describe("le carnet de courriers", () => {
    const pli = async (suffixe = "") => (await prisma.mailEntry.create({ data: { title: `${TAG} pli${suffixe}`, direction: "INCOMING", createdById: moi.id } })).id;
    const lirePli = (id: string) => prisma.mailEntry.findUnique({ where: { id }, select: { title: true, reference: true, notes: true, receivedAt: true, acknowledgedAt: true, folderId: true } });

    it("createMailEntry : le pli créé est retiré, puis rétabli à l'identique", async () => {
      await cycle({ id: "mail-register-actions:createMailEntry", moi,
        faire: () => createMailEntry(undefined, fd({ title: `${TAG} nouveau`, direction: "OUTGOING", reference: "R-1" })),
        lire: () => prisma.mailEntry.findMany({ where: { title: `${TAG} nouveau` }, select: { id: true, title: true, reference: true, direction: true } }) });
    });
    it("editMailEntry : les valeurs d'avant réécrites", async () => {
      const id = await pli(" édité");
      await cycle({ id: "mail-register-actions:editMailEntry", moi,
        faire: () => editMailEntry(id, undefined, fd({ title: `${TAG} pli corrigé`, direction: "INCOMING", notes: "note" })), lire: () => lirePli(id) });
    });
    it("setMailDate : la date posée est retirée", async () => {
      const id = await pli(" daté");
      await cycle({ id: "mail-register-actions:setMailDate", moi, faire: () => setMailDate({ id, field: "acknowledgedAt", value: "2026-10-30" }), lire: () => lirePli(id) });
    });
    it("attachDriveNodeToMail : le pli né du fichier du Drive est retiré, le fichier reste", async () => {
      const node = await prisma.driveNode.create({ data: { name: `${TAG} scan.pdf`, type: "FILE", ownerId: moi.id } });
      await cycle({ id: "mail-register-actions:attachDriveNodeToMail", moi, faire: () => attachDriveNodeToMail({ driveNodeId: node.id, title: `${TAG} scanné` }),
        lire: async () => ({ plis: await prisma.mailEntry.count({ where: { driveNodeId: node.id } }), fichier: await prisma.driveNode.count({ where: { id: node.id } }) }) });
    });
    it("addMailPiece / updateMailPiece : la pièce ajoutée est retirée ; la pièce corrigée retrouve son libellé", async () => {
      const id = await pli(" pièces");
      const node = await prisma.driveNode.create({ data: { name: `${TAG} annexe.pdf`, type: "FILE", ownerId: moi.id } });
      const pieces = () => prisma.mailEntryPiece.findMany({ where: { entryId: id }, select: { id: true, label: true, recipient: true }, orderBy: { label: "asc" } });
      await cycle({ id: "mail-piece-actions:addMailPiece", moi, faire: () => addMailPiece(fd({ entryId: id, driveNodeId: node.id, label: `${TAG} annexe`, recipient: "Karim" })), lire: pieces });
      const p = await prisma.mailEntryPiece.create({ data: { entryId: id, label: `${TAG} pièce`, recipient: "A", createdById: moi.id } });
      await cycle({ id: "mail-piece-actions:updateMailPiece", moi, faire: () => updateMailPiece(fd({ id: p.id, label: `${TAG} pièce corrigée`, recipient: "B" })), lire: pieces });
    });
    it("createMailPartner / updateMailPartner : créé puis retiré ; modifié puis remis", async () => {
      const partenaires = () => prisma.mailPartner.findMany({ where: { name: { startsWith: TAG } }, select: { id: true, name: true, kind: true, contact: true, isActive: true }, orderBy: { name: "asc" } });
      await cycle({ id: "mail-partner-actions:createMailPartner", moi, faire: () => createMailPartner(undefined, fd({ name: `${TAG} SARL Nouveau`, kind: "Fournisseur" })), lire: partenaires });
      const p = await prisma.mailPartner.create({ data: { name: `${TAG} SARL Ancien`, kind: "Client" } });
      await cycle({ id: "mail-partner-actions:updateMailPartner", moi, faire: () => updateMailPartner(fd({ id: p.id, name: `${TAG} SARL Ancien`, kind: "Partenaire", contact: "0550" })), lire: partenaires });
    });
    it("createMailFolder / updateMailFolder / moveMailEntries : dossier retiré ; renommage défait ; courriers remis à leur place", async () => {
      const dossiers = () => prisma.mailEntryFolder.findMany({ where: { name: { startsWith: TAG } }, select: { id: true, name: true, description: true }, orderBy: { name: "asc" } });
      await cycle({ id: "mail-folder-actions:createMailFolder", moi, faire: () => createMailFolder(undefined, fd({ name: `${TAG} Dossier neuf` })), lire: dossiers });
      const d = await prisma.mailEntryFolder.create({ data: { name: `${TAG} Dossier A` } });
      await cycle({ id: "mail-folder-actions:updateMailFolder", moi, faire: () => updateMailFolder(fd({ id: d.id, name: `${TAG} Dossier A renommé`, description: "x" })), lire: dossiers });
      const a = await pli(" à ranger 1");
      const b = await pli(" à ranger 2");
      await cycle({ id: "mail-folder-actions:moveMailEntries", moi, faire: () => moveMailEntries(fd({ entryId: [a, b], folderId: d.id })),
        lire: () => prisma.mailEntry.findMany({ where: { id: { in: [a, b] } }, select: { id: true, folderId: true }, orderBy: { id: "asc" } }) });
    });
  });

  // ── LE CLIQUET ──────────────────────────────────────────────────────────────────────────────
  it("LE CLIQUET : les actions écrivantes du périmètre K10b encore « aucune » sont exactement les restantes (la liste descend), et chaque déclaration a son cycle", () => {
    const encoreAucune = PERIMETRE_K10B.filter((id) => CLASSEMENT[id]?.annulation === "aucune" && CLASSEMENT[id]?.risque !== "R0");
    expect(encoreAucune).toEqual([...RESTANTES_K10B]);
    const sansCycle = Object.keys(DECLARATIONS_COMMUNICATIONS).filter((id) => !couvertes.has(id) && DECLARATIONS_COMMUNICATIONS[id]!.mecanisme !== "sans-effet");
    expect(sansCycle).toEqual([]);
  });
});
