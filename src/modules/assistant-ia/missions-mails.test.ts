import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LOT P1 (décision 0047) — LE SCÉNARIO DE LA DIRECTION (02/11), contre la base :
 *
 *   • trois missions vivantes (« classeur de suivi AMD », « planning Redouane / Nesrine », et la TROISIÈME lancée à tort) ;
 *   • « je vois 3 missions » → `mes_missions` les LIT (titres, états, ce qui bloque) — personne ne demande leurs titres ;
 *   • « fusionne-les » → la carte `fusionner_missions` liste ce qui sera arrêté ; confirmée, UNE seule reste vivante,
 *     les deux autres sont ARRÊTÉES (sous-missions comprises), et « reprendre » défait l'arrêt ;
 *   • sans exécutant, une mission prête dit « en attente du worker » ;
 *   • mails : la carte « Envoyer » nomme la boîte (SMTP de l'ERP, Gmail d'Adam), SANS ressaisie en R3 réversible ; le
 *     mail par le Gmail d'Adam entre dans la fenêtre d'annulation et s'y annule (rien ne part).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/push", () => ({ sendPushToUser: async () => undefined }));
let ACTEUR: unknown = null;
vi.mock("@/lib/session", async (original) => ({ ...(await original<typeof import("@/lib/session")>()), requireUser: async () => ACTEUR, getCurrentUser: async () => ACTEUR }));

import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import { proposerTravail, demarrerDOffice } from "@/lib/missions/travaux/service";
import { PERSONA_ASSISTANT_IA } from "./infra/travaux";
import { outilsMissions, mesMissions } from "./infra/missions/pilotage";
import { outilsV1, type PropositionPreparee } from "./infra/outils-v1";
import { outilsMails } from "./infra/mails/boites";
import { confirmerIntentionAssistantIA } from "@/modules/assistant-ia/actions";
import { annulerEffetSortant } from "@/lib/effets/fenetre";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__p1_${Date.now().toString(36)}_`;
const ADAM = `${TAG}adam@adventum-pharma.com`.toLowerCase();
const ADAM_AVANT = process.env.GOOGLE_ADAM_EMAIL;
let sa: CurrentUser;

async function compte(nom: string): Promise<CurrentUser> {
  const u = await prisma.user.create({ data: { name: `${nom} ${TAG}`, email: `${TAG}${nom}@t.dz`, passwordHash: "x", role: "SUPER_ADMIN" } });
  const access = await getAccess(u.id, u.role);
  return { id: u.id, name: u.name, email: u.email, role: access.role ?? u.role, secondaryRole: access.secondaryRole, access, mustChangePassword: false } as CurrentUser;
}

async function lancer(titre: string, etapes = 4): Promise<string> {
  const plan = {
    titre, objectif: `Objectif : ${titre}`,
    etapes: Array.from({ length: etapes }, (_, i) => ({ cle: `e${i}`, type: i === etapes - 1 ? "LIVRABLE" : "ANALYSE", titre: `Étape ${i + 1}`, consigne: "Une phrase.", ...(i === etapes - 1 ? { format: "md" } : {}), ...(i ? { apres: [`e${i - 1}`] } : {}) })),
  };
  const r = await proposerTravail(sa.id, PERSONA_ASSISTANT_IA, plan, { origine: "banc-p1" });
  if (!r.ok) throw new Error(r.fautes.join(" "));
  const d = await demarrerDOffice(r.travailId, sa.id, PERSONA_ASSISTANT_IA);
  if (!d.ok) throw new Error(d.erreur);
  return r.travailId;
}

const outil = (nom: string, echoues = new Set<string>()) => outilsMissions(sa, echoues).find((o) => o.def.name === nom)!;

suite("P1 — l'assistant pilote vraiment ses missions et ses mails", () => {
  let ids: string[] = [];
  let baux: Awaited<ReturnType<typeof prisma.tacheDeFond.findMany>> = [];
  beforeAll(async () => {
    sa = await compte("Direction");
    ACTEUR = sa;
    ids = [await lancer("Classeur de suivi AMD"), await lancer("Planning Redouane Nesrine", 2), await lancer("AMD Staoueli — suivi consolidé")];
    // Une sous-mission sous la troisième : arrêtée avec elle.
    const r = await proposerTravail(sa.id, PERSONA_ASSISTANT_IA, { titre: "Sous-tâche Staoueli", objectif: "x", etapes: [{ cle: "a", type: "LIVRABLE", titre: "A", consigne: "x", format: "md" }] }, { parentId: ids[2] });
    if (r.ok) { await demarrerDOffice(r.travailId, sa.id, PERSONA_ASSISTANT_IA); ids.push(r.travailId); }
    // Aucun exécutant : le balayage des travaux n'a pas conduit depuis 20 min (les lignes d'avant sont rendues en fin de banc).
    baux = await prisma.tacheDeFond.findMany({ where: { OR: [{ cle: "travaux.balayage" }, { executeur: "worker" }] } });
    await prisma.tacheDeFond.upsert({
      where: { cle: "travaux.balayage" }, create: { cle: "travaux.balayage", executeur: "web", dernierDebutA: new Date(Date.now() - 20 * 60_000), dernierStatut: "OK" },
      update: { executeur: "web", dernierDebutA: new Date(Date.now() - 20 * 60_000), dernierStatut: "OK" },
    });
    await prisma.tacheDeFond.updateMany({ where: { executeur: "worker" }, data: { dernierDebutA: new Date(Date.now() - 60 * 60_000) } });
  });
  afterAll(async () => {
    if (ADAM_AVANT === undefined) delete process.env.GOOGLE_ADAM_EMAIL; else process.env.GOOGLE_ADAM_EMAIL = ADAM_AVANT;
    if (!baux.some((b) => b.cle === "travaux.balayage")) await prisma.tacheDeFond.deleteMany({ where: { cle: "travaux.balayage" } }).catch(() => {});
    for (const b of baux) await prisma.tacheDeFond.update({ where: { cle: b.cle }, data: { executeur: b.executeur, dernierDebutA: b.dernierDebutA, dernierStatut: b.dernierStatut } }).catch(() => {});
    await prisma.effetSortantDiffere.deleteMany({ where: { principalId: sa?.id } }).catch(() => {});
    await prisma.outboundMailIntent.deleteMany({ where: { connection: { userId: sa?.id } } }).catch(() => {});
    await prisma.googleConnection.deleteMany({ where: { userId: sa?.id } }).catch(() => {});
    await prisma.mailAccount.deleteMany({ where: { userId: sa?.id } }).catch(() => {});
    await prisma.mission.deleteMany({ where: { principalId: sa?.id } }).catch(() => {});
    await prisma.assistantActionIntent.deleteMany({ where: { userId: sa?.id } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("« je vois 3 missions » → mes_missions LIT les trois (titres, étapes) et dit pourquoi elles n'avancent pas", async () => {
    const r = JSON.parse(await outil("mes_missions").run({}, sa));
    const titres = r.missions.map((m: { titre: string }) => m.titre);
    expect(titres).toEqual(expect.arrayContaining(["Classeur de suivi AMD", "Planning Redouane Nesrine", "AMD Staoueli — suivi consolidé"]));
    const classeur = r.missions.find((m: { titre: string }) => m.titre === "Classeur de suivi AMD");
    expect(classeur.etapes).toBe("0/4");
    expect(classeur.ou_elle_en_est).toContain("en attente du worker");
    expect(r.alerte).toContain("amd-worker");
  });

  it("« fusionne-les » → une CARTE qui liste ce qui sera arrêté ; rien n'est fait avant la confirmation", async () => {
    const props: PropositionPreparee[] = [];
    const op = outilsV1(sa, props).find((o) => o.def.name === "fusionner_missions")!;
    const sortie = JSON.parse(await op.run({ missions: [], garder: "Classeur de suivi AMD", titre: "AMD — suivi unique Redouane & Nesrine" }, sa));
    expect(sortie.statut).toBe("EN_ATTENTE_DE_CONFIRMATION");
    const champs = JSON.stringify(props[0]!.proposition.fields);
    expect(champs).toContain("Planning Redouane Nesrine");
    expect(champs).toContain("AMD Staoueli — suivi consolidé");
    expect(props[0]!.proposition.libelleBouton).toBe("Fusionner");
    expect((await mesMissions(sa.id)).missions.filter((m) => !m.parentId)).toHaveLength(3);

    const c = await confirmerIntentionAssistantIA(props[0]!.intentId);
    expect(c.ok, c.error).toBe(true);
    const apres = await mesMissions(sa.id, { toutes: true });
    const vivantes = apres.missions.filter((m) => m.etat !== "ARRETE" && m.etat !== "ANNULE");
    expect(vivantes.map((m) => m.titre)).toEqual(["AMD — suivi unique Redouane & Nesrine"]);
    const arretees = apres.missions.filter((m) => m.etat === "ARRETE");
    expect(arretees.map((m) => m.titre).sort()).toEqual(["AMD Staoueli — suivi consolidé", "Planning Redouane Nesrine", "Sous-tâche Staoueli"].sort());
    expect(arretees.find((m) => m.titre === "Planning Redouane Nesrine")!.diagnostic.phrase).toContain("fusionnée dans « AMD — suivi unique Redouane & Nesrine »");
  });

  it("l'arrêt se DÉFAIT : « reprends le planning » relance la mission arrêtée ; une désignation ambiguë nomme les candidates", async () => {
    const echoues = new Set<string>();
    const r = JSON.parse(await outil("piloter_mission", echoues).run({ action: "reprendre", mission: "planning" }, sa));
    expect(r.statut, JSON.stringify(r)).toBe("FAIT");
    const m = await prisma.mission.findUniqueOrThrow({ where: { id: ids[1] }, select: { status: true } });
    expect(m.status).not.toBe("PAUSED");
    const amb = JSON.parse(await outil("piloter_mission", echoues).run({ action: "pause", mission: "AMD" }, sa));
    expect(["AMBIGU", "FAIT"]).toContain(amb.statut);
    // Renommer, puis arrêter pour de bon par l'écrit — réversible lui aussi.
    const ren = JSON.parse(await outil("piloter_mission").run({ action: "renommer", mission: ids[1], titre: "Planning — repris" }, sa));
    expect(ren.statut).toBe("FAIT");
    const st = JSON.parse(await outil("piloter_mission").run({ action: "arreter", mission: ids[1] }, sa));
    expect(st.statut).toBe("FAIT");
    expect((await prisma.mission.findUniqueOrThrow({ where: { id: ids[1] }, select: { title: true, pausedReason: true } }))).toMatchObject({ title: "Planning — repris", pausedReason: expect.stringContaining("ARRETE") });
  });

  it("FUSION — opération de domaine tout ou rien : un travail fini dans la liste → refusée, rien n'a changé", async () => {
    const { fusionnerTravaux } = await import("@/lib/missions/travaux/service");
    const fini = await lancer("Déjà fini", 2);
    await prisma.mission.update({ where: { id: fini }, data: { status: "COMPLETED" } });
    const avant = await prisma.mission.findMany({ where: { principalId: sa.id }, select: { id: true, status: true, title: true }, orderBy: { id: "asc" } });
    const r = await fusionnerTravaux(sa.id, { resteId: ids[0], arreter: [ids[1], fini], titre: "Ne doit pas rester", motif: "ARRETE — fusionnée dans « x »" });
    expect(r.ok).toBe(false);
    expect(await prisma.mission.findMany({ where: { principalId: sa.id }, select: { id: true, status: true, title: true }, orderBy: { id: "asc" } })).toEqual(avant);
  });

  it("MAILS — sans Gmail d'Adam : « as-tu accès ? » se répond en LISANT, et RIEN ne part par une autre boîte sans qu'on le demande", async () => {
    // Le Gmail d'Adam de CE banc (GOOGLE_ADAM_EMAIL) n'est pas encore relié — d'autres bancs ont pu laisser les leurs.
    process.env.GOOGLE_ADAM_EMAIL = ADAM;
    await prisma.mailAccount.create({ data: { userId: sa.id, email: `${TAG}direction@adventum.dz`, passwordEnc: "x" } });
    const props: PropositionPreparee[] = [];
    const tous = outilsV1(sa, props, [], [], null, undefined, { capacites: true });
    const mails = outilsMails(sa, (n) => tous.find((o) => o.def.name === n), props);
    const etat = JSON.parse(await mails.find((o) => o.def.name === "mes_boites_mail")!.run({}, sa));
    expect(etat.gmailAdam.reliee).toBe(false);
    expect(etat.parDefaut).toBeNull();
    const envoyer = mails.find((o) => o.def.name === "envoyer_mail")!;
    const refus = JSON.parse(await envoyer.run({ mails: [{ a: "redouane@adventum.dz", objet: "Planning AMD", contenu: { salutation: "Bonjour,", paragraphes: ["Bonjour."], cloture: "Bien cordialement," } }] }, sa));
    expect(refus.statut).toBe("REFUS");
    expect(refus.raison).toContain("Gmail d'Adam");
    expect(props).toHaveLength(0);
    // Demandée EXPLICITEMENT, la boîte SMTP de la personne : carte « Envoyer », sans ressaisie (R3 réversible).
    const r = JSON.parse(await envoyer.run({ ...{ mails: [{ a: "redouane@adventum.dz", objet: "Planning AMD", contenu: { salutation: "Bonjour,", paragraphes: ["Voici ton planning."], cloture: "Bien cordialement," } }] }, boite: "smtp" }, sa));
    expect(r.statut, JSON.stringify(r)).toBe("EN_ATTENTE_DE_CONFIRMATION");
    expect(props[0]!.proposition.title).toContain("Envoyer par ta boîte SMTP");
    expect(props[0]!.proposition.libelleBouton).toBe("Envoyer");
    expect(props[0]!.proposition.confirmText).toBeUndefined();
    expect(props[0]!.proposition.level).toBe("SENSITIVE");
  });

  it("MAILS — par le Gmail d'Adam, MÊME MACHINE que son écran : intention préparée → approuvée par qui confirme → fenêtre → annulée (CANCELLED), rétablie (APPROVED)", async () => {
    const { retablirEffetSortant } = await import("@/lib/effets/fenetre");
    await prisma.googleConnection.create({ data: { userId: sa.id, address: ADAM, status: "connected", grantedScopes: "https://www.googleapis.com/auth/gmail.modify" } });
    const props: PropositionPreparee[] = [];
    const tous = outilsV1(sa, props, [], [], null, undefined, { capacites: true });
    const mails = outilsMails(sa, (n) => tous.find((o) => o.def.name === n), props);
    const etat = JSON.parse(await mails.find((o) => o.def.name === "mes_boites_mail")!.run({}, sa));
    expect(etat.gmailAdam).toMatchObject({ reliee: true, envoi: true, adresse: ADAM });
    expect(etat.parDefaut).toBe("gmail_adam");
    const r = JSON.parse(await mails.find((o) => o.def.name === "envoyer_mail")!.run({ mails: [{ a: "nesrine@adventum.dz", objet: "Planning AMD", contenu: { salutation: "Bonjour,", paragraphes: ["Ton planning suit."], cloture: "Bien cordialement," } }] }, sa));
    expect(r.statut, JSON.stringify(r)).toBe("EN_ATTENTE_DE_CONFIRMATION");
    expect(props[0]!.proposition.title).toContain("Gmail d'Adam");
    expect(props[0]!.proposition.confirmText).toBeUndefined();
    const intention = await prisma.outboundMailIntent.findFirstOrThrow({ where: { subject: "Planning AMD", recipients: { has: "nesrine@adventum.dz" } }, orderBy: { createdAt: "desc" } });
    expect(["AWAITING_APPROVAL", "APPROVED", "DRAFT"]).toContain(intention.status);
    expect(intention.approvedById).toBeNull();

    const c = await confirmerIntentionAssistantIA(props[0]!.intentId);
    expect(c.ok, c.error).toBe(true);
    expect(await prisma.outboundMailIntent.findUniqueOrThrow({ where: { id: intention.id } })).toMatchObject({ status: "APPROVED", approvedById: sa.id, sentAt: null });
    const ligne = await prisma.effetSortantDiffere.findFirstOrThrow({ where: { type: "courriel.gmail", principalId: sa.id }, orderBy: { creeLe: "desc" } });
    expect(ligne.statut).toBe("EN_ATTENTE");
    expect(ligne.charge).toEqual({ outboundId: intention.id });
    const a = await annulerEffetSortant(ligne.id, sa);
    expect(a.ok, JSON.stringify(a)).toBe(true);
    expect((await prisma.effetSortantDiffere.findUniqueOrThrow({ where: { id: ligne.id } })).statut).toBe("ANNULE");
    expect((await prisma.outboundMailIntent.findUniqueOrThrow({ where: { id: intention.id } })).status).toBe("CANCELLED");
    const re = await retablirEffetSortant(ligne.id, sa);
    expect(re.ok, JSON.stringify(re)).toBe(true);
    expect((await prisma.outboundMailIntent.findUniqueOrThrow({ where: { id: intention.id } })).status).toBe("APPROVED");
    await annulerEffetSortant(ligne.id, sa);
  });

  it("MAILS — SCÉNARIO DE LA DIRECTION : « envoie un mail à Redouane et Nesrine avec leur planning » → DEUX beaux mails, UNE carte, ZÉRO question", async () => {
    const r1 = await prisma.user.create({ data: { name: `Redouane Banc${TAG}`, email: `${TAG}redouane@adventum.dz`, passwordHash: "x", role: "VIEWER" } });
    const r2 = await prisma.user.create({ data: { name: `Nesrine Banc${TAG}`, email: `${TAG}nesrine@adventum.dz`, passwordHash: "x", role: "VIEWER" } });
    const props: PropositionPreparee[] = [];
    const tous = outilsV1(sa, props, [], [], null, undefined, { capacites: true });
    const mails = outilsMails(sa, (n) => tous.find((o) => o.def.name === n), props);
    const planning = (prenom: string, taches: string[][]) => ({
      salutation: `Bonjour ${prenom},`,
      paragraphes: ["Voici ton planning du 2 au 8 novembre pour le suivi AMD Staoueli.", "Le point d'étape est fixé au **jeudi 5 novembre à 10 h**."],
      tableau: { colonnes: ["Date", "Tâche"], lignes: taches },
      cloture: "Bonne semaine,",
    });
    const r = JSON.parse(await mails.find((o) => o.def.name === "envoyer_mail")!.run({ mails: [
      { a: `Redouane Banc${TAG}`, objet: "Ton planning AMD — semaine du 2 novembre", contenu: planning("Redouane", [["Lun. 2/11", "Relevé sur site"], ["Mer. 4/11", "Devis fournisseurs"]]) },
      { a: `Nesrine Banc${TAG}`, objet: "Ton planning AMD — semaine du 2 novembre", contenu: planning("Nesrine", [["Mar. 3/11", "Mise à jour du classeur"], ["Ven. 6/11", "Synthèse pour la Direction"]]) },
    ] }, sa));
    // ZÉRO QUESTION : pas d'« INCOMPLET », la carte est là, et une seule.
    expect(r.statut, JSON.stringify(r)).toBe("EN_ATTENTE_DE_CONFIRMATION");
    expect(props).toHaveLength(1);
    const carte = props[0]!.proposition as { title: string; libelleBouton?: string; apercus?: { titre: string; html: string }[] };
    expect(carte.title).toContain("Envoyer 2 mails par le Gmail d'Adam");
    expect(carte.libelleBouton).toBe("Envoyer les 2 mails");
    expect(carte.apercus).toHaveLength(2);
    expect(carte.apercus![0]!.html).toContain("Bonjour Redouane,");
    expect(carte.apercus![1]!.html).toContain("Bonjour Nesrine,");
    expect(carte.apercus![0]!.html).toContain("<strong>jeudi 5 novembre à 10 h</strong>");
    expect(carte.apercus![0]!.html).toMatch(/<th[^>]*>Date<\/th>/);
    // Les destinataires viennent de l'annuaire ; chaque intention d'Adam porte le RENDU (html) et sa version texte.
    const intentions = await prisma.outboundMailIntent.findMany({ where: { recipients: { hasSome: [r1.email, r2.email] } }, select: { recipients: true, bodyHtml: true, bodyText: true } });
    expect(intentions).toHaveLength(2);
    expect(intentions.every((i) => (i.bodyHtml ?? "").includes("<table") && i.bodyText.includes("Date | Tâche"))).toBe(true);
    const c = await confirmerIntentionAssistantIA(props[0]!.intentId);
    expect(c.ok, c.error).toBe(true);
    expect(await prisma.effetSortantDiffere.count({ where: { type: "courriel.gmail", principalId: sa.id, statut: "EN_ATTENTE", cible: { in: [r1.email, r2.email] } } })).toBe(2);
    for (const l of await prisma.effetSortantDiffere.findMany({ where: { type: "courriel.gmail", principalId: sa.id, statut: "EN_ATTENTE" } })) await annulerEffetSortant(l.id, sa);
    await prisma.user.deleteMany({ where: { id: { in: [r1.id, r2.id] } } });
  });

  it("MAILS — un nom introuvable : UNE question, aucune carte", async () => {
    const props: PropositionPreparee[] = [];
    const tous = outilsV1(sa, props, [], [], null, undefined, { capacites: true });
    const mails = outilsMails(sa, (n) => tous.find((o) => o.def.name === n), props);
    const r = JSON.parse(await mails.find((o) => o.def.name === "envoyer_mail")!.run({ mails: [{ a: `Personne Inconnue${TAG}`, objet: "x", contenu: { salutation: "Bonjour,", paragraphes: ["x"], cloture: "A+" } }] }, sa));
    expect(r.statut).toBe("INCOMPLET");
    expect(r.manque).toHaveLength(1);
    expect(props).toHaveLength(0);
  });

  it("MAILS — un brouillon demandé reste un brouillon d'Adam (DRAFT) : rien ne part", async () => {
    const props: PropositionPreparee[] = [];
    const tous = outilsV1(sa, props, [], [], null, undefined, { capacites: true });
    const mails = outilsMails(sa, (n) => tous.find((o) => o.def.name === n), props);
    const r = JSON.parse(await mails.find((o) => o.def.name === "envoyer_mail")!.run({ ...{ mails: [{ a: "redouane@adventum.dz", objet: "Brouillon AMD", contenu: { salutation: "Bonjour,", paragraphes: ["À relire."], cloture: "Bien cordialement," } }] }, brouillon: true }, sa));
    expect(r.statut, JSON.stringify(r)).toBe("EN_ATTENTE_DE_CONFIRMATION");
    expect(props[0]!.proposition.libelleBouton).toBe("Enregistrer le brouillon");
    const c = await confirmerIntentionAssistantIA(props[0]!.intentId);
    expect(c.ok, c.error).toBe(true);
    expect((await prisma.outboundMailIntent.findFirstOrThrow({ where: { subject: "Brouillon AMD" } })).status).toBe("DRAFT");
    expect(await prisma.effetSortantDiffere.count({ where: { type: "courriel.gmail", principalId: sa.id, statut: "EN_ATTENTE" } })).toBe(0);
  });
});
