import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UNE CARTE DEVIENT UNE CONVERSATION — et se CONFIRME À L'ORAL (lot K4, décision 0038). Vraie base, faux modèle.
 *
 * On tient : la voix reçoit un résumé oral (pas les champs bruts), propose les facultatifs, récapitule et demande
 * « tu confirmes ? » ; un « oui » n'est entendu qu'APRÈS cette question et sur les mots de la personne ; sans « oui »
 * (ou avec un « oui » répété, sans parole neuve) rien ne s'exécute ; une carte renforcée : la voix relit l'élément clé, un oui suffit (K9) ;
 * une correction dite repasse les contrôles de la correction écrite ; la confirmation orale est au journal avec la
 * transcription ; la carte reste confirmable au bouton (idempotence).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/push", () => ({ sendPushToUser: async () => undefined }));
// L'action de l'écran lit les en-têtes de SA requête ; la route de délégation en a une, le banc non.
// L'action de l'écran relit SA session (la route de délégation tourne dans la requête de la personne).
let ACTEUR: unknown = null;
vi.mock("@/lib/session", async (original) => ({ ...(await original<typeof import("@/lib/session")>()), requireUser: async () => ACTEUR, getCurrentUser: async () => ACTEUR }));
vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined, getAll: () => [] }) }));

import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import { remplacerLecteurInterrupteurIaPourTests } from "@/lib/ai-settings";
import { remplacerModelesPourTests } from "../generer";
import { modeleFactice } from "../testing/modele-factice";
import { effacerJournalDe } from "../testing/journal";
import { outilsV1 } from "../outils-v1";
import { accesAssistantIa } from "../role-config";
import { confirmerCarte } from "../confirmation";
import { deleguerALaVoix as deleguerTravail } from "./temps-reel";
import { enregistrerSessionVoix, suivreTravailVocal } from "./oral";
import { estNonExplicite, estOuiExplicite, estRienAAjouter, etapeOrale, recitDeCarte, texteOral, type CarteOrale } from "../../domaine/terrain/voix-orale";

/**
 * K9 (décision 0039) : la délégation rend AUSSITÔT un travail, suivi jusqu'au résultat. Ce banc garde ses scénarios K4
 * en suivant le travail jusqu'au bout — ce que fait le navigateur.
 */
const SESSIONS = new Map<string, string>();
async function deleguerALaVoix(u: CurrentUser, demande: string, _conversation: null, parole: string | null) {
  if (!SESSIONS.has(u.id)) { SESSIONS.set(u.id, `live_k4_${u.id}`); await enregistrerSessionVoix(u.id, `live_k4_${u.id}`, null); }
  const session = SESSIONS.get(u.id)!;
  const r = await deleguerTravail(u, demande, { session, parole });
  if (!r.travail) return r;
  for (let i = 0; i < 200; i++) {
    const s = await suivreTravailVocal(u, session, r.travail);
    if (s.etat === "pret") return s;
    if (s.etat === "echec") return { pourVoix: s.pourVoix };
    await new Promise((x) => setTimeout(x, 50));
  }
  throw new Error("travail jamais terminé");
}

const reponse = (message: string) => ({ texte: JSON.stringify({ message, components: [] }) });

/** F2 : ce que la voix reçoit, les deux canaux — le texte DIT et la consigne silencieuse. */
const tout = (r: { pourVoix: string; consigne?: string }) => [r.pourVoix, r.consigne].filter(Boolean).join(" ");

describe("les mots de la personne (pur)", () => {
  it("un « oui » explicite, sans réserve", () => {
    for (const p of ["Oui", "oui, je confirme", "Ouais vas-y", "Je confirme.", "C'est bon, envoie", "d'accord", "OK"]) expect(estOuiExplicite(p), p).toBe(true);
    for (const p of ["oui mais change la date", "non", "attends", "pas encore", "mets plutôt 200 000", "", "peut-être"]) expect(estOuiExplicite(p), p).toBe(false);
  });
  it("un « non » net ; « rien à ajouter »", () => {
    expect(estNonExplicite("non, annule")).toBe(true);
    expect(estNonExplicite("laisse tomber")).toBe(true);
    expect(estNonExplicite("non mais mets plutôt vendredi")).toBe(false);
    expect(estRienAAjouter("non c'est tout")).toBe(true);
    expect(estRienAAjouter("rien d'autre")).toBe(true);
    expect(estRienAAjouter("ajoute un budget de 50 000")).toBe(false);
  });
  it("le texte pour la voix : un résumé à dire avec ses mots, une question à la fois, jamais d'identifiant technique", () => {
    const c: CarteOrale = {
      titre: "Demande de sponsoring — Association Cardio", champs: [{ label: "Institution", value: "Association Cardio" }, { label: "Médecin", value: "cmvx1234567890abcdefghijk" }, { label: "Suggéré", value: "150 000 DZD" }],
      facultatifs: ["Description", "Appréciation personnelle", "Autres pièces"], manquants: [], elementCle: null,
    };
    expect(recitDeCarte(c)).not.toContain("cmvx");
    expect(recitDeCarte(c)).toContain("150 000 DZD");
    expect(etapeOrale(c, false)).toBe("FACULTATIFS");
    expect(texteOral(c, "FACULTATIFS")).toMatch(/Ne demande PAS encore de confirmer/);
    expect(texteOral(c, "FACULTATIFS")).toContain("« Description »");
    expect(texteOral(c, "FACULTATIFS")).toContain("ne lis pas une liste");
    expect(etapeOrale(c, true)).toBe("QUESTION");
    expect(texteOral(c, "QUESTION")).toContain("Tu confirmes ?");
    // K9 : la VOIX relit l'élément clé ; aucun mot imposé à la personne.
    expect(texteOral({ ...c, elementCle: "150000" }, "QUESTION")).toContain("RELIS clairement « 150000 »");
    expect(etapeOrale({ ...c, manquants: ["la date"] }, true)).toBe("MANQUANTS");
  });
});

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

suite("la carte à l'oral, contre la base", () => {
  const TAG = `__iavoixorale_${Date.now().toString(36)}_`;
  const cleAvant = process.env.OPENAI_API_KEY;
  let kam: CurrentUser;
  let direction: CurrentUser;
  const compte = async (role: string, nom: string): Promise<CurrentUser> => {
    const u = await prisma.user.create({ data: { name: `${TAG}${nom}`, email: `${TAG}${nom}@t.dz`, passwordHash: "x", role: role as never } });
    await prisma.userAccess.create({ data: { userId: u.id, module: "ASSISTANT_IA", canView: true, scope: "ASSIGNED" } });
    const access = await getAccess(u.id, u.role);
    return { id: u.id, name: u.name, email: u.email, role: access.role ?? u.role, secondaryRole: access.secondaryRole, access, mustChangePassword: false } as CurrentUser;
  };
  const compteRendu = () => modeleFactice([
    { appel: { outil: "terrain_compte_rendu", entree: { medecin: "Dr Inconnu", synthese: "Visite du Dr Inconnu : intéressé par Cardiovex." } } },
    reponse("J'ai préparé le compte rendu de ta visite chez le Dr Inconnu."),
  ]).modele as never;
  const derniereCarte = async (u: CurrentUser) => prisma.assistantActionIntent.findFirst({ where: { userId: u.id }, orderBy: { proposedAt: "desc" }, select: { id: true, status: true, events: true, level: true, confirmText: true } });

  beforeAll(async () => {
    process.env.OPENAI_API_KEY = "cle-de-banc";
    remplacerLecteurInterrupteurIaPourTests(async () => false);
    kam = await compte("MEDICAL_DELEGATE", "kam");
    direction = await compte("SUPER_ADMIN", "direction");
    ACTEUR = kam;
  });
  afterEach(() => remplacerModelesPourTests(null));
  afterAll(async () => {
    if (cleAvant === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = cleAvant;
    remplacerLecteurInterrupteurIaPourTests(null);
    const ids = [kam?.id, direction?.id].filter(Boolean) as string[];
    await effacerJournalDe(ids);
    await prisma.fieldReport.deleteMany({ where: { delegateId: { in: ids } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } }).catch(() => {});
    await prisma.assistantActionIntent.deleteMany({ where: { userId: { in: ids } } });
    await prisma.assistantIaFil.deleteMany({ where: { userId: { in: ids } } });
    await prisma.assistantIaVoixTravail.deleteMany({ where: { userId: { in: ids } } });
    await prisma.assistantIaVoixSession.deleteMany({ where: { userId: { in: ids } } });
    await prisma.userAccess.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } });
  });

  it("de la carte à l'exécution : résumé, facultatifs, récit, « tu confirmes ? » ; sans oui rien ; oui → fait, au journal", async () => {
    remplacerModelesPourTests([compteRendu()]);
    const a = await deleguerALaVoix(kam, "prépare le compte rendu de ma visite chez le docteur Inconnu", null, "prépare le compte rendu de ma visite chez le docteur Inconnu");
    expect(a.carte?.intentId).toBeTruthy();
    // Un résumé à dire, et les facultatifs proposés — pas encore de confirmation demandée.
    expect(tout(a)).toContain("ne lis pas une liste");
    // F2 (TR-VX-02) : la manière (« ne lis pas une liste », « Ne demande PAS ») est une CONSIGNE — jamais dite.
    expect(a.pourVoix).not.toMatch(/ne lis pas une liste|Ne demande PAS|Dis-le/);
    expect(a.consigne).toContain("ne lis pas une liste");
    expect(tout(a)).toMatch(/Ne demande PAS encore de confirmer|Tu confirmes \?/);
    const id = a.carte!.intentId;

    // « non, c'est tout » aux facultatifs : le récit et la question, SANS appel de modèle.
    if (/Ne demande PAS encore/.test(tout(a))) {
      remplacerModelesPourTests([]);
      const b = await deleguerALaVoix(kam, "non c'est tout", null, "non c'est tout");
      expect(tout(b)).toContain("Tu confirmes ?");
    }
    // Un « oui » RÉPÉTÉ (aucune parole neuve) n'est pas entendu.
    remplacerModelesPourTests([modeleFactice([reponse("Tu veux confirmer ?")]).modele as never]);
    await deleguerALaVoix(kam, "non c'est tout", null, "");
    expect((await derniereCarte(kam))?.status).toBe("PROPOSED");
    // Une parole qui n'est pas un oui : rien ne s'exécute.
    const c = await deleguerALaVoix(kam, "euh je sais pas", null, "euh je sais pas");
    expect(tout(c)).not.toMatch(/C'est fait/);
    expect(await prisma.fieldReport.count({ where: { delegateId: kam.id } })).toBe(0);

    // Le récit est reposé (l'assistant a répondu) : la question est de nouveau la dernière étape.
    const etat = await derniereCarte(kam);
    expect(JSON.stringify(etat?.events)).toContain("QUESTION");
    // « oui, je confirme » : la garde du bouton exécute.
    remplacerModelesPourTests([]);
    const d = await deleguerALaVoix(kam, "oui je confirme", null, "oui, je confirme");
    expect(tout(d)).toMatch(/C'est fait/);
    expect((await prisma.assistantActionIntent.findUnique({ where: { id }, select: { status: true } }))?.status).toBe("EXECUTED");
    expect(await prisma.fieldReport.count({ where: { delegateId: kam.id } })).toBe(1);
    const audit = await prisma.auditLog.findFirst({ where: { actorId: kam.id, summary: { contains: "confirmée à l'oral" } }, select: { summary: true } });
    expect(audit?.summary).toContain("oui, je confirme");
    // Le bouton, ensuite : idempotent — le même reçu, rien de plus.
    expect((await confirmerCarte(kam, id)).ok).toBe(true);
    expect(await prisma.fieldReport.count({ where: { delegateId: kam.id } })).toBe(1);
  });

  it("une carte RENFORCÉE (R3/R4) : la voix relit l'élément clé, puis un oui sans réserve exécute (K9 : pas de mot imposé)", async () => {
    remplacerModelesPourTests([compteRendu()]);
    const a = await deleguerALaVoix(kam, "un autre compte rendu", null, "un autre compte rendu");
    const id = a.carte!.intentId;
    // La carte devient CRITIQUE (comme une capacité R3/R4) : l'élément clé est le montant.
    await prisma.assistantActionIntent.update({ where: { id }, data: { level: "CRITICAL", confirmText: "150000" } });
    remplacerModelesPourTests([]);
    const q = /Ne demande PAS encore/.test(tout(a)) ? await deleguerALaVoix(kam, "non rien", null, "non rien") : a;
    if (/Ne demande PAS encore/.test(tout(a))) expect(tout(q)).toContain("RELIS clairement « 150000 »");
    const flou = await deleguerALaVoix(kam, "oui mais cent mille", null, "oui mais cent mille");
    expect(tout(flou)).not.toMatch(/C'est fait/);
    const avec = await deleguerALaVoix(kam, "vas-y", null, "vas-y");
    expect(tout(avec)).toMatch(/C'est fait/);
    expect((await prisma.assistantActionIntent.findUnique({ where: { id }, select: { status: true } }))?.status).toBe("EXECUTED");
  });

  it("un « oui » AVANT la question de confirmation n'est pas une confirmation", async () => {
    remplacerModelesPourTests([compteRendu()]);
    const a = await deleguerALaVoix(kam, "prépare un compte rendu", null, "prépare un compte rendu");
    const id = a.carte!.intentId;
    // On remet la carte à l'étape des facultatifs (la question n'a pas été posée).
    const i = await prisma.assistantActionIntent.findUnique({ where: { id }, select: { events: true } });
    await prisma.assistantActionIntent.update({ where: { id }, data: { events: (i!.events as { etape?: string }[]).filter((e) => e.etape !== "QUESTION") as object[] } });
    remplacerModelesPourTests([modeleFactice([reponse("D'accord, autre chose ?")]).modele as never]);
    const r = await deleguerALaVoix(kam, "oui", null, "oui");
    expect(tout(r)).not.toMatch(/C'est fait/);
    expect((await prisma.assistantActionIntent.findUnique({ where: { id }, select: { status: true } }))?.status).toBe("PROPOSED");
  });

  it("« non » à la question : rien n'est fait, la carte reste au bouton ; la voix n'en reparle plus", async () => {
    remplacerModelesPourTests([compteRendu()]);
    const a = await deleguerALaVoix(kam, "encore un compte rendu", null, "encore un compte rendu");
    remplacerModelesPourTests([]);
    // (La carte hérite des facultatifs déjà proposés pour la précédente : elle peut arriver directement à la question.)
    if (/Ne demande PAS encore/.test(tout(a))) await deleguerALaVoix(kam, "non c'est tout", null, "non c'est tout");
    const r = await deleguerALaVoix(kam, "non annule", null, "non, annule");
    expect(tout(r)).toContain("rien n'est envoyé");
    expect((await prisma.assistantActionIntent.findUnique({ where: { id: a.carte!.intentId }, select: { status: true } }))?.status).toBe("PROPOSED");
  });

  it("une correction DITE repasse les contrôles de la correction écrite (corriger_carte → corrigerCarteCapacite)", async () => {
    const acces = await accesAssistantIa(direction);
    const props: never[] = [];
    const outils = outilsV1(direction, props, [], [], null, acces, { capacites: true });
    const creer = outils.find((o) => o.def.name === "task__createTask")!;
    const corriger = outils.find((o) => o.def.name === "corriger_carte")!;
    expect(corriger).toBeTruthy();
    const s = JSON.parse(await creer.run({ title: `${TAG} tâche orale` }, direction));
    expect(s.statut).toBe("EN_ATTENTE_DE_CONFIRMATION");
    // Une valeur hors contrat (priorité inconnue) : refusée, la carte inchangée.
    const mauvais = JSON.parse(await corriger.run({ champs: { priority: "ENORME" } }, direction));
    expect(mauvais.statut).toBe("REFUS");
    const i0 = await prisma.assistantActionIntent.findFirst({ where: { userId: direction.id }, orderBy: { proposedAt: "desc" }, select: { payload: true } });
    expect(JSON.stringify(i0?.payload)).not.toContain("ENORME");
    // Une précision valide : la carte est réécrite, la correction au journal de l'intention.
    const bon = JSON.parse(await corriger.run({ champs: { priority: "HIGH", description: "Dite à la voix" } }, direction));
    expect(bon.statut).toBe("EN_ATTENTE_DE_CONFIRMATION");
    const i1 = await prisma.assistantActionIntent.findFirst({ where: { userId: direction.id }, orderBy: { proposedAt: "desc" }, select: { payload: true, events: true, status: true } });
    expect(JSON.stringify(i1?.payload)).toContain("HIGH");
    expect(JSON.stringify(i1?.events)).toContain("CORRECTED");
    expect(i1?.status).toBe("PROPOSED");
  });
});
