import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { porteAttentionPour } from "@/platform/in-process/missions/attention";
import { journaliser } from "@/lib/missions/runtime/store";

/**
 * LA PORTE D'ATTENTION, par l'entrée réelle : un signal entre, une notification sort (ou pas),
 * le journal dit ce qui est parti, et le même fait ne se redit pas. L'e-mail est injecté : le
 * test vérifie QUAND il part, pas qu'un SMTP répond.
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `att${Date.now().toString(36)}`;
let ownerId = "";
let missionId = "";
/** Un SECOND propriétaire pour l'omnicanal : le premier a dépassé son plafond quotidien dans les tests précédents. */
let ownerCanaux = "";

suite("porte d'attention — niveaux, canaux, dédoublonnage, plafond", () => {
  beforeAll(async () => {
    const u = await prisma.user.create({ data: { name: `${TAG} PDG`, email: `${TAG}@amd.dz`, passwordHash: "x", role: "SUPER_ADMIN" }, select: { id: true } });
    ownerId = u.id;
    const u2 = await prisma.user.create({ data: { name: `${TAG} DG`, email: `${TAG}dg@amd.dz`, passwordHash: "x", role: "SUPER_ADMIN" }, select: { id: true } });
    ownerCanaux = u2.id;
    const m = await prisma.mission.create({ data: { kind: "RUNTIME", status: "RUNNING", title: `${TAG} Dossier Trastuzex`, objective: "x", goalRaw: "x", ownerId, planVersion: 1 }, select: { id: true } });
    missionId = m.id;
  }, 60_000);
  afterAll(async () => {
    await prisma.notification.deleteMany({ where: { userId: { in: [ownerId, ownerCanaux] } } }).catch(() => {});
    await prisma.mission.deleteMany({ where: { ownerId: { in: [ownerId, ownerCanaux] } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { id: { in: [ownerId, ownerCanaux] } } }).catch(() => {});
  }, 60_000);

  it("une mission terminée avec effets : INFO, notification + push, pas d'e-mail, journal NOTIFIED ; la redite est supprimée", async () => {
    const mails: string[] = [];
    const porte = porteAttentionPour({ envoyerMail: async (_o, sujet) => { mails.push(sujet); return "envoye"; } });
    const r1 = await porte.signaler({
      kind: "MISSION_COMPLETED", missionId, ownerId, titre: "", planVersion: 1,
      raison: "Les trois messages sont partis.", bilan: { faites: 4, total: 4, echouees: 0, effets: ["send_message ×3"] },
    });
    expect(r1.niveau).toBe("INFO");
    expect(r1.canaux).toEqual(["notification", "push"]);
    expect(mails).toHaveLength(0);
    const notif = await prisma.notification.findFirst({ where: { userId: ownerId }, orderBy: { createdAt: "desc" } });
    expect(notif?.title).toBe(`Mission terminée — ${TAG} Dossier Trastuzex`);
    expect(notif?.body).toContain("Actions : send_message ×3");
    expect(notif?.link).toBe(`/missions/${missionId}`);
    const journal = await prisma.missionEvent.findMany({ where: { missionId, kind: "NOTIFIED" }, select: { detail: true } });
    expect(journal).toHaveLength(1);
    expect((journal[0].detail as { niveau: string }).niveau).toBe("INFO");

    const r2 = await porte.signaler({
      kind: "MISSION_COMPLETED", missionId, ownerId, titre: "", planVersion: 1,
      raison: "Les trois messages sont partis.", bilan: { faites: 4, total: 4, echouees: 0, effets: ["send_message ×3"] },
    });
    expect(r2.supprime).toBe(true);
    expect(await prisma.notification.count({ where: { userId: ownerId } })).toBe(1);
  }, 60_000);

  it("une question au dirigeant : ARBITRAGE, notification VALIDATION_REQUIRED, e-mail tenté, jamais redemandée d'elle-même", async () => {
    const mails: { sujet: string; corps: string }[] = [];
    const porte = porteAttentionPour({ envoyerMail: async (_o, sujet, corps) => { mails.push({ sujet, corps }); return "envoye"; } });
    const r = await porte.signaler({
      kind: "QUESTION", missionId, ownerId, titre: "", planVersion: 1, stepKey: "cadrage",
      raison: "Deux fournisseurs répondent au nom « Hetero » : Hetero Labs Ltd et Hetero Biopharma.", decision: "lequel viser ?",
    });
    expect(r.niveau).toBe("ARBITRAGE");
    expect(r.canaux).toEqual(["notification", "push", "email"]);
    expect(mails[0].sujet).toMatch(/^\[Adam\] Une précision — /);
    expect(mails[0].corps).toContain("Décision demandée : lequel viser ?");
    const notif = await prisma.notification.findFirst({ where: { userId: ownerId, type: "VALIDATION_REQUIRED" } });
    expect(notif).not.toBeNull();
    const encore = await porte.signaler({ kind: "QUESTION", missionId, ownerId, titre: "", planVersion: 1, stepKey: "cadrage", raison: "Deux fournisseurs…" });
    expect(encore.supprime).toBe(true);
    expect(mails).toHaveLength(1);
  }, 60_000);

  it("sans boîte connectée, l'e-mail ne part pas et le journal le DIT ; la notification part quand même", async () => {
    const porte = porteAttentionPour({ envoyerMail: async () => "sans-boite" });
    const r = await porte.signaler({ kind: "MISSION_BLOCKED", missionId, ownerId, titre: "", planVersion: 1, raison: "Le certificat GMP est introuvable partout.", bilan: { faites: 3, total: 5, echouees: 1 } });
    expect(r.niveau).toBe("ATTENTION");
    expect(r.canaux).toEqual(["notification", "push"]);
    const j = await prisma.missionEvent.findFirst({ where: { missionId, kind: "NOTIFIED", detail: { path: ["kind"], equals: "MISSION_BLOCKED" } }, select: { detail: true } });
    expect((j?.detail as { email: string }).email).toBe("sans-boite");
  }, 60_000);

  it("au-delà du plafond quotidien, une INFO devient une ligne de JOURNAL (sans push) — jamais un arbitrage", async () => {
    const autre = await prisma.mission.create({ data: { kind: "RUNTIME", status: "RUNNING", title: `${TAG} autre`, objective: "y", goalRaw: "y", ownerId, planVersion: 1 }, select: { id: true } });
    for (let i = 0; i < 16; i += 1) {
      await journaliser(autre.id, "NOTIFIED", "INFO — test", { niveau: "INFO", cle: `plafond:${i}` });
    }
    const porte = porteAttentionPour({ envoyerMail: async () => "envoye" });
    const info = await porte.signaler({ kind: "MISSION_PARTIAL", missionId: autre.id, ownerId, titre: "", planVersion: 1, raison: "Une partie reste ouverte.", bilan: { faites: 2, total: 4, echouees: 0 } });
    expect(info.niveau).toBe("JOURNAL");
    expect(info.canaux).toEqual(["notification"]);
    const arb = await porte.signaler({ kind: "APPROVAL_REQUIRED", missionId: autre.id, ownerId, titre: "", planVersion: 1, niveauApprobation: "SENSITIVE", raison: "3 e-mails externes", stepKey: "accord" });
    expect(arb.niveau).toBe("ARBITRAGE");
    expect(arb.canaux).toContain("email");
  }, 60_000);

  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   * ADAM S'ÉCRIVAIT À LUI-MÊME.
   *
   * Le chemin e-mail écrivait `to: compte.email` — la boîte de l'ERP, à elle-même. La personne
   * ne voyait rien tant qu'elle n'ouvrait pas CETTE boîte. Sa préférence de canal portait
   * pourtant déjà l'adresse : `lireCanal` la rendait, Slack et WhatsApp la recevaient, et le
   * seul canal qui en avait besoin la jetait.
   * ═══════════════════════════════════════════════════════════════════════════════════════
   */
  it("L'E-MAIL PART LÀ OÙ LA PERSONNE A DIT QU'ON LA JOINT — la première adresse, les autres en copie", async () => {
    const m = await prisma.mission.create({ data: { kind: "RUNTIME", status: "RUNNING", title: `${TAG} Où me joindre`, objective: "x", goalRaw: "x", ownerId: ownerCanaux, planVersion: 1 }, select: { id: true } });
    const envois: { adresses: readonly string[] }[] = [];
    const porte = porteAttentionPour({
      envoyerMail: async (_o, _s, _c, adresses) => { envois.push({ adresses }); return "envoye"; },
      preferences: async () => ({
        canalPrefere: "email", destinataire: "perso@exemple.dz",
        adressesDeContact: ["perso@exemple.dz", "pro@exemple.dz"],
        heuresSilence: null, heure: 10, connecteurs: [], confidentiel: false, regles: [],
      }),
    });
    await porte.signaler({ kind: "APPROVAL_REQUIRED", missionId: m.id, ownerId: ownerCanaux, titre: "", planVersion: 1, niveauApprobation: "SENSITIVE", raison: "3 e-mails externes", stepKey: "accord" });
    expect(envois).toHaveLength(1);
    expect(envois[0].adresses).toEqual(["perso@exemple.dz", "pro@exemple.dz"]);
  }, 60_000);

  it("SANS déclaration, rien ne change : la liste est vide et l'envoi retombe sur la boîte connectée", async () => {
    const m = await prisma.mission.create({ data: { kind: "RUNTIME", status: "RUNNING", title: `${TAG} Sans adresse`, objective: "x", goalRaw: "x", ownerId: ownerCanaux, planVersion: 1 }, select: { id: true } });
    const envois: { adresses: readonly string[] }[] = [];
    const porte = porteAttentionPour({
      envoyerMail: async (_o, _s, _c, adresses) => { envois.push({ adresses }); return "envoye"; },
      preferences: async () => ({
        canalPrefere: "email", destinataire: null, adressesDeContact: [],
        heuresSilence: null, heure: 10, connecteurs: [], confidentiel: false, regles: [],
      }),
    });
    await porte.signaler({ kind: "APPROVAL_REQUIRED", missionId: m.id, ownerId: ownerCanaux, titre: "", planVersion: 1, niveauApprobation: "SENSITIVE", raison: "3 e-mails externes", stepKey: "accord" });
    expect(envois).toHaveLength(1);
    expect(envois[0].adresses).toEqual([]);
  }, 60_000);

  it("OMNICANAL (§37) : le canal préféré Slack, branché, remplace l'e-mail dès ATTENTION ; la règle est au journal ; le corps part avec le lien", async () => {
    const m = await prisma.mission.create({ data: { kind: "RUNTIME", status: "RUNNING", title: `${TAG} Dossier Slack`, objective: "x", goalRaw: "x", ownerId: ownerCanaux, planVersion: 1 }, select: { id: true } });
    const mails: string[] = []; const messages: { canal: string; texte: string; destinataire: string | null }[] = [];
    const porte = porteAttentionPour({
      envoyerMail: async (_o, sujet) => { mails.push(sujet); return "envoye"; },
      envoyerConnecteur: async (canal, _o, texte, destinataire) => { messages.push({ canal, texte, destinataire }); return "envoye"; },
      preferences: async () => ({ canalPrefere: "slack", destinataire: "#direction", adressesDeContact: [], heuresSilence: null, heure: 10, connecteurs: ["slack"], confidentiel: false, regles: ["canal : préviens-moi par Slack"] }),
    });
    const r = await porte.signaler({ kind: "MISSION_BLOCKED", missionId: m.id, ownerId: ownerCanaux, titre: "", planVersion: 1, raison: "Le certificat GMP est introuvable.", bilan: { faites: 3, total: 5, echouees: 1 } });
    expect(r.niveau).toBe("ATTENTION");
    expect(r.canaux).toEqual(["notification", "push", "slack"]);
    expect(mails).toHaveLength(0);
    expect(messages).toEqual([{ canal: "slack", destinataire: "#direction", texte: expect.stringMatching(/Bloqué — .*Dossier Slack[\s\S]*certificat GMP[\s\S]*\/missions\//) }]);
    const j = await prisma.missionEvent.findFirst({ where: { missionId: m.id, kind: "NOTIFIED" }, select: { detail: true } });
    expect(j?.detail).toMatchObject({ canaux: ["notification", "push", "slack"], connecteur: { canal: "slack", issue: "envoye" }, regles: ["canal : préviens-moi par Slack"] });
  }, 60_000);

  it("OMNICANAL : heures de silence — le push et le message sont retenus (et dits), la notification et l'e-mail restent ; un connecteur non branché est dit ; l'arbitrage passe outre", async () => {
    const m = await prisma.mission.create({ data: { kind: "RUNTIME", status: "RUNNING", title: `${TAG} Dossier Nuit`, objective: "x", goalRaw: "x", ownerId: ownerCanaux, planVersion: 1 }, select: { id: true } });
    const messages: string[] = []; const mails: string[] = [];
    const nuit = porteAttentionPour({
      envoyerMail: async (_o, sujet) => { mails.push(sujet); return "envoye"; },
      envoyerConnecteur: async (canal) => { messages.push(canal); return "envoye"; },
      preferences: async () => ({ canalPrefere: "whatsapp", destinataire: null, adressesDeContact: [], heuresSilence: { de: 22, a: 7 }, heure: 2, connecteurs: ["whatsapp"], confidentiel: false, regles: [] }),
    });
    const r = await nuit.signaler({ kind: "MISSION_PARTIAL", missionId: m.id, ownerId: ownerCanaux, titre: "", planVersion: 1, raison: "Deux envois sur trois.", bilan: { faites: 2, total: 3, echouees: 1 } });
    expect(r.niveau).toBe("INFO");
    expect(r.canaux).toEqual(["notification"]);
    expect(messages).toHaveLength(0);
    const j = await prisma.missionEvent.findFirst({ where: { missionId: m.id, kind: "NOTIFIED", detail: { path: ["kind"], equals: "MISSION_PARTIAL" } }, select: { detail: true } });
    expect(j?.detail).toMatchObject({ differe: true, heuresSilence: { de: 22, a: 7 } });

    const arb = await nuit.signaler({ kind: "QUESTION", missionId: m.id, ownerId: ownerCanaux, titre: "", planVersion: 1, stepKey: "q", raison: "Deux fournisseurs possibles.", decision: "lequel ?" });
    expect(arb.niveau).toBe("ARBITRAGE");
    expect(arb.canaux).toEqual(["notification", "push", "email", "whatsapp"]);

    const nonBranche = porteAttentionPour({
      envoyerMail: async () => "envoye", envoyerConnecteur: async () => "envoye",
      preferences: async () => ({ canalPrefere: "teams", destinataire: null, adressesDeContact: [], heuresSilence: null, heure: 10, connecteurs: [], confidentiel: false, regles: [] }),
    });
    const m2 = await prisma.mission.create({ data: { kind: "RUNTIME", status: "RUNNING", title: `${TAG} Dossier Teams`, objective: "x", goalRaw: "x", ownerId: ownerCanaux, planVersion: 1 }, select: { id: true } });
    const r2 = await nonBranche.signaler({ kind: "MISSION_FAILED", missionId: m2.id, ownerId: ownerCanaux, titre: "", planVersion: 1, raison: "Échec." });
    expect(r2.canaux).toEqual(["notification", "push", "email"]);
    const j2 = await prisma.missionEvent.findFirst({ where: { missionId: m2.id, kind: "NOTIFIED" }, select: { detail: true } });
    expect(j2?.detail).toMatchObject({ canalIndisponible: "teams" });
  }, 60_000);

  it("OMNICANAL : un signal CONFIDENTIEL garde son détail dans l'ERP et n'envoie qu'un corps neutre dehors (e-mail et connecteur)", async () => {
    const m = await prisma.mission.create({ data: { kind: "RUNTIME", status: "RUNNING", title: `${TAG} Avenant salaire`, objective: "x", goalRaw: "x", ownerId: ownerCanaux, planVersion: 1 }, select: { id: true } });
    const mails: { sujet: string; corps: string }[] = []; const messages: string[] = [];
    const porte = porteAttentionPour({
      envoyerMail: async (_o, sujet, corps) => { mails.push({ sujet, corps }); return "envoye"; },
      envoyerConnecteur: async (_c, _o, texte) => { messages.push(texte); return "envoye"; },
      preferences: async () => ({ canalPrefere: "sms", destinataire: "+213661000000", adressesDeContact: [], heuresSilence: null, heure: 10, connecteurs: ["sms"], confidentiel: false, regles: [] }),
    });
    const r = await porte.signaler({ kind: "APPROVAL_REQUIRED", missionId: m.id, ownerId: ownerCanaux, titre: "", planVersion: 1, stepKey: "accord", niveauApprobation: "SENSITIVE", raison: "Augmentation de 40 000 DZD pour Mme K.", confidentiel: true });
    expect(r.niveau).toBe("ARBITRAGE");
    expect(r.canaux).toEqual(["notification", "push", "email", "sms"]);
    expect(mails[0]!.corps).not.toMatch(/40 000|Mme K/);
    expect(mails[0]!.corps).toMatch(/confidentiel/);
    expect(mails[0]!.sujet).not.toMatch(/salaire/);
    expect(messages[0]).not.toMatch(/40 000|Mme K/);
    const notif = await prisma.notification.findFirst({ where: { userId: ownerCanaux, title: { contains: "Avenant salaire" } }, orderBy: { createdAt: "desc" } });
    expect(notif?.body).toContain("40 000 DZD");
    const j = await prisma.missionEvent.findFirst({ where: { missionId: m.id, kind: "NOTIFIED" }, select: { detail: true } });
    expect(j?.detail).toMatchObject({ confidentiel: true });
  }, 60_000);
});
