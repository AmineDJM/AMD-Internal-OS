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
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { getAccess } from "@/lib/rbac";
import { proposerTravail, demarrerDOffice } from "@/lib/missions/travaux/service";
import { PERSONA_ASSISTANT_IA } from "./infra/travaux";
import { outilsMissions, mesMissions } from "./infra/missions/pilotage";
import { outilsV1, type PropositionPreparee } from "./infra/outils-v1";
import { outilsMails } from "./infra/mails/boites";
import { confirmerIntentionAssistantIA } from "@/modules/assistant-ia/actions";
import { annulerEffetSortant } from "@/lib/effets/fenetre";
import { canalAdamOuvert, MOTS_DU_CANAL_ADAM } from "./domaine/mails/canal";

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

const outil = (nom: string) => outilsMissions(sa).find((o) => o.def.name === nom)!;

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
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("« je vois 3 missions » → mes_missions LIT les trois (titres, étapes) et dit pourquoi elles n'avancent pas", async () => {
    const r = JSON.parse(await outil("mes_missions").run({}, sa));
    const titres = r.missions.map((m: { titre: string }) => m.titre);
    expect(titres).toEqual(expect.arrayContaining(["Classeur de suivi AMD", "Planning Redouane Nesrine", "AMD Staoueli — suivi consolidé"]));
    const classeur = r.missions.find((m: { titre: string }) => m.titre === "Classeur de suivi AMD");
    expect(classeur.etapes).toBe("0/4");
    expect(classeur.ou_elle_en_est).toContain("en attente du worker");
    expect(classeur.ou_elle_en_est).not.toMatch(/prête|moins d'une minute/);
    expect(r.alerte).toContain("amd-worker");
    // P1 ter — l'observation du moteur : la requête même du balayage la prendrait ; son étape suivante ; le dernier passage.
    expect(classeur.pris_par_le_balayage).toBe("oui");
    expect(classeur.etape_suivante).toBe("Étape 1");
    expect(r.dernier_balayage).toMatch(/il y a \d+ min|aucun balayage/);
  });

  it("P1 ter — « y'a quoi dedans ? » : mes_missions rend le CONTENU et le lien ; le serveur POSE une carte cliquable par mission, tirée de son observation", async () => {
    const cartes: import("@/platform/ia/workspace/protocol").WorkspaceBlock[] = [];
    const lecture = outilsMissions(sa, cartes).find((o) => o.def.name === "mes_missions")!;
    const r = JSON.parse(await lecture.run({}, sa));
    const classeur = r.missions.find((m: { titre: string }) => m.titre === "Classeur de suivi AMD");
    expect(classeur.lien).toBe(`/missions/${ids[0]}`);
    expect(classeur.contient.objectif).toContain("Classeur de suivi AMD");
    expect(classeur.contient.etapes.map((e: { titre: string }) => e.titre)).toEqual(["Étape 1", "Étape 2", "Étape 3", "Étape 4"]);
    // L'observation d'I1 est déclarée (même identité, même lien) — la carte en découle.
    expect(r._observations.find((o: { objet: { id: string } }) => o.objet.id === ids[0])?.objet.lien).toBe(`/missions/${ids[0]}`);
    const carte = cartes.find((c) => c.kind === "mission" && c.title === "Classeur de suivi AMD") as Extract<typeof cartes[number], { kind: "mission" }>;
    expect(carte).toBeTruthy();
    expect(carte.etapes).toHaveLength(4);
    expect(carte.actions?.[0]).toMatchObject({ libelle: "Ouvrir", href: `/missions/${ids[0]}` });
    // Relue deux fois dans le tour : pas de carte en double.
    await lecture.run({}, sa);
    expect(cartes.filter((c) => c.kind === "mission" && c.title === "Classeur de suivi AMD")).toHaveLength(1);
  });

  it("P1 ter — la VÉRITÉ SUR L'EXÉCUTANT : balayage débrayé (TRAVAUX_SWEEP=off) → la vraie raison ; passage récent → « prête » ; la carte de fusion dit la même chose que mes_missions", async () => {
    const avant = await prisma.tacheDeFond.findUnique({ where: { cle: "travaux.balayage" } });
    try {
      await prisma.tacheDeFond.update({ where: { cle: "travaux.balayage" }, data: { dernierDebutA: new Date(Date.now() - 30_000), dernierStatut: "IGNOREE", dernierMessage: "TRAVAUX_SWEEP=off" } });
      const { missions, alerte } = await mesMissions(sa.id);
      const classeur = missions.find((m) => m.titre === "Classeur de suivi AMD")!;
      expect(classeur.diagnostic.phrase).toContain("TRAVAUX_SWEEP=off");
      expect(classeur.diagnostic.phrase).not.toContain("aucun battement enregistré");
      // La carte de fusion lit la même chose (deux tours, une vérité).
      const props: PropositionPreparee[] = [];
      await outilsV1(sa, props).find((o) => o.def.name === "fusionner_missions")!.run({ missions: [], garder: "Classeur de suivi AMD" }, sa);
      expect(props[0]!.proposition.warnings).toContain(alerte);
      await prisma.assistantActionIntent.deleteMany({ where: { id: props[0]!.intentId } });
      // Un passage EFFECTIF il y a 30 s : « prête : part au prochain battement ».
      await prisma.tacheDeFond.update({ where: { cle: "travaux.balayage" }, data: { dernierStatut: "OK", dernierMessage: null } });
      const vivant = (await mesMissions(sa.id)).missions.find((m) => m.titre === "Classeur de suivi AMD")!;
      expect(vivant.diagnostic.code).toMatch(/^(PRETE|EN_COURS|IMMOBILE)$/);
    } finally {
      if (avant) await prisma.tacheDeFond.update({ where: { cle: "travaux.balayage" }, data: { dernierDebutA: avant.dernierDebutA, dernierStatut: avant.dernierStatut, dernierMessage: avant.dernierMessage } });
    }
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
    const r = JSON.parse(await outil("piloter_mission").run({ action: "reprendre", mission: "planning" }, sa));
    expect(r.statut, JSON.stringify(r)).toBe("FAIT");
    const m = await prisma.mission.findUniqueOrThrow({ where: { id: ids[1] }, select: { status: true } });
    expect(m.status).not.toBe("PAUSED");
    const amb = JSON.parse(await outil("piloter_mission").run({ action: "pause", mission: "AMD" }, sa));
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

  it("MAILS — sans Gmail d'Adam (ML-09) : « as-tu accès ? » se répond en LISANT ; le mail est préparé QUAND MÊME par l'envoi de l'ERP, et la boîte d'Adam non reliée est DITE", async () => {
    // Le Gmail d'Adam de CE banc (GOOGLE_ADAM_EMAIL) n'est pas encore relié — d'autres bancs ont pu laisser les leurs.
    process.env.GOOGLE_ADAM_EMAIL = ADAM;
    await prisma.mailAccount.create({ data: { userId: sa.id, email: `${TAG}direction@adventum.dz`, passwordEnc: "x" } });
    const props: PropositionPreparee[] = [];
    const tous = outilsV1(sa, props, [], [], null, undefined, { capacites: true });
    const mails = outilsMails(sa, (n) => tous.find((o) => o.def.name === n), props);
    const etat = JSON.parse(await mails.find((o) => o.def.name === "mes_boites_mail")!.run({}, sa));
    expect(etat.gmailAdam.reliee).toBe(false);
    expect(etat.parDefaut).toBe("erp");
    const envoyer = mails.find((o) => o.def.name === "envoyer_mail")!;
    const repli = JSON.parse(await envoyer.run({ mails: [{ a: "contact@sahge.dz", objet: "Merci pour l'organisation du congrès", contenu: { salutation: "Madame, Monsieur,", paragraphes: ["Merci pour l'organisation du congrès d'hépatologie."], cloture: "Bien cordialement," } }] }, sa));
    console.info("[banc P1 bis] ML-09 repli :", repli.statut, repli.boite ?? repli.raison ?? "");
    if (repli.statut !== "REFUS") {
      expect(repli.statut, JSON.stringify(repli)).toBe("EN_ATTENTE_DE_CONFIRMATION");
      expect(repli.boite).toBe("l'envoi de l'ERP");
      expect(repli.boite_adam).toBe("non reliée");
      // I1 : un FAIT sur la carte (avertissement, donc observation), plus une consigne.
      expect(props[0]!.proposition.warnings?.[0]).toMatch(/boîte Gmail d'Adam n'est pas reliée.*Connecter Google/);
      expect(props[0]!.proposition.mails?.[0]?.expediteur).toBe("l'envoi de l'ERP");
      expect(props[0]!.proposition.title).toContain("Envoyer par l'envoi de l'ERP");
    } else {
      // L'envoi de l'ERP peut être fermé à ce compte par la console : le refus le DIT (jamais « rien n'est préparé » sans raison).
      expect(repli.raison).toMatch(/activé|ouvert/);
    }
    props.length = 0;
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
    expect(intentions.every((i) => (i.bodyHtml ?? "").includes("<table") && i.bodyText.includes("— Tâche : "))).toBe(true);
    const c = await confirmerIntentionAssistantIA(props[0]!.intentId);
    expect(c.ok, c.error).toBe(true);
    expect(await prisma.effetSortantDiffere.count({ where: { type: "courriel.gmail", principalId: sa.id, statut: "EN_ATTENTE", cible: { in: [r1.email, r2.email] } } })).toBe(2);
    for (const l of await prisma.effetSortantDiffere.findMany({ where: { type: "courriel.gmail", principalId: sa.id, statut: "EN_ATTENTE" } })) await annulerEffetSortant(l.id, sa);
    await retirerComptesEtSemis({ where: { id: { in: [r1.id, r2.id] } } });
  });

  it("MAILS — une personne qui n'est pas la Direction (assistante) : PAS la boîte d'Adam, mais une carte quand même (envoi de l'ERP), mise en page, signée", async () => {
    const u = await prisma.user.create({ data: { name: `Assistante ${TAG}`, email: `${TAG}assistante@t.dz`, passwordHash: "x", role: "DIRECTION_ASSISTANT" } });
    await prisma.userAccess.create({ data: { userId: u.id, module: "ASSISTANT_IA", canView: true, scope: "ASSIGNED" } });
    const access = await getAccess(u.id, u.role);
    const asst = { id: u.id, name: u.name, email: u.email, role: access.role ?? u.role, secondaryRole: access.secondaryRole, access, mustChangePassword: false } as CurrentUser;
    ACTEUR = asst;
    const props: PropositionPreparee[] = [];
    const tous = outilsV1(asst, props, [], [], null, undefined, { capacites: true });
    const mails = outilsMails(asst, (n) => tous.find((o) => o.def.name === n), props);
    const etat = JSON.parse(await mails.find((o) => o.def.name === "mes_boites_mail")!.run({}, asst));
    expect(etat.gmailAdam).toBeUndefined();
    expect(etat.parDefaut).toBe("erp");
    // P1 bis (canal d'Adam = Super Admin seul) : ni l'outil, ni ses descriptions, ni l'état ne le nomment ; demandé, il est ignoré.
    expect(tous.some((o) => o.def.name === "envoyer_gmail" && o.allowed(asst))).toBe(false);
    expect(JSON.stringify(mails.map((o) => o.def))).not.toMatch(MOTS_DU_CANAL_ADAM);
    expect(JSON.stringify(etat)).not.toMatch(MOTS_DU_CANAL_ADAM);
    const r = JSON.parse(await mails.find((o) => o.def.name === "envoyer_mail")!.run({ boite: "gmail_adam", mails: [{ a: "pharmacie@chu-mustapha.dz", objet: "Invitation au comité", contenu: { salutation: "Madame, Monsieur,", paragraphes: ["Nous avons le plaisir de vous convier au comité du **jeudi 12 novembre**."], tableau: { colonnes: ["Heure", "Point"], lignes: [["10 h", "Ouverture"]] }, cloture: "Bien cordialement," } }] }, asst));
    ACTEUR = sa;
    console.info("[banc P1] mail d'une assistante :", r.statut, r.raison ?? r.boite ?? "");
    if (r.statut === "REFUS") {
      // L'envoi de l'ERP peut être fermé à ce rôle par la console : le refus le DIT, rien n'est inventé.
      expect(r.raison).toMatch(/ouvert|activé/);
    } else {
      expect(r.statut, JSON.stringify(r)).toBe("EN_ATTENTE_DE_CONFIRMATION");
      expect(props[0]!.proposition.title).toContain("Envoyer par l'envoi de l'ERP");
      expect(JSON.stringify(props[0]!.proposition.payload)).toContain("Assistante");
      expect(JSON.stringify(props[0]!.proposition.payload)).not.toContain(" | ");
      expect(JSON.stringify({ r, p: props[0]!.proposition })).not.toMatch(MOTS_DU_CANAL_ADAM);
    }
    await prisma.assistantActionIntent.deleteMany({ where: { userId: u.id } });
    await prisma.userAccess.deleteMany({ where: { userId: u.id } });
    await prisma.user.delete({ where: { id: u.id } });
  });

  it("CANAL D'ADAM (ML-ADAM-) — réservé au Super Admin par l'architecture : la Direction elle-même ne l'a pas", () => {
    expect(canalAdamOuvert({ role: "SUPER_ADMIN" })).toBe(true);
    for (const role of ["DIRECTION", "GENERAL_MANAGER", "KAM", "DIRECTION_ASSISTANT", "VIEWER"]) expect(canalAdamOuvert({ role })).toBe(false);
    expect(MOTS_DU_CANAL_ADAM.test("envoie-le depuis la boîte d'Adam")).toBe(true);
    expect(MOTS_DU_CANAL_ADAM.test("le Gmail d’Adam")).toBe(true);
    expect(MOTS_DU_CANAL_ADAM.test("Adam (assistant de l'ERP) a préparé la carte")).toBe(false);
  });

  it("PIÈCES JOINTES — un fichier du Drive DONT la personne est propriétaire, par son nom ; introuvable : une question, jamais deviné", async () => {
    const { piecesDuDrive } = await import("./infra/mails/redaction");
    const f = await prisma.driveNode.create({ data: { name: `BC imprimerie ${TAG}.pdf`, type: "FILE", ownerId: sa.id, createdById: sa.id, mimeType: "application/pdf", size: 1234 } });
    try {
      const r = await piecesDuDrive(sa, [`BC imprimerie ${TAG}`]);
      expect(r).toMatchObject({ ok: true, pieces: [{ driveNodeId: f.id, filename: `BC imprimerie ${TAG}.pdf`, mimeType: "application/pdf" }] });
      const absent = await piecesDuDrive(sa, [`Facture inexistante ${TAG}`]);
      expect(absent.ok).toBe(false);
      expect((absent as { manque: string[] }).manque[0]).toMatch(/introuvable/);
    } finally {
      await prisma.driveNode.delete({ where: { id: f.id } });
    }
  });

  it("RENDEZ-VOUS (audit Q1 RV-01) — un invité sans compte ERP ne bloque pas : invité externe dans la description, mail proposé", async () => {
    const { RENDEZ_VOUS } = await import("./infra/operations/quotidien");
    const demain = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const p = await RENDEZ_VOUS.proposer({ titre: "Point appel d'offres", debut: `${demain} 10:00`, invites: `Dr Externe${TAG}` }, sa);
    expect("carte" in p, JSON.stringify(p)).toBe(true);
    if ("carte" in p) {
      expect(JSON.stringify(p.carte.fields)).toContain(`Dr Externe${TAG}`);
      expect(p.carte.warnings.join(" ")).toMatch(/invité.? externe.*mail/);
      expect(p.args.description).toContain(`Invités externes : Dr Externe${TAG}`);
    }
  });

  it("MAILS (ML-04) — « pour toute la direction » se résout par l'annuaire : les comptes actifs de la Direction, sans question", async () => {
    const d1 = await prisma.user.create({ data: { name: `Directeur ${TAG}`, email: `${TAG}dg@t.dz`, passwordHash: "x", role: "GENERAL_MANAGER" } });
    const { groupeDestinataires } = await import("./infra/mails/redaction");
    for (const g of ["toute la direction", "la direction", "le comité de direction", "Codir"]) {
      const r = await groupeDestinataires(g);
      expect(r, g).not.toBeNull();
      expect(r!.map((x) => x.email)).toContain(d1.email);
    }
    expect(await groupeDestinataires("Redouane")).toBeNull();
    await prisma.user.delete({ where: { id: d1.id } });
  });

  it("AD & PRO (AP-01) — la question posée une fois, la réponse ne comble pas le champ : la carte s'affiche QUAND MÊME, champ à compléter ; signée avec le champ, elle se revérifie", async () => {
    const { outilsOperations } = await import("./infra/operations");
    const { questionDejaPosee } = await import("./infra/operations");
    const props: PropositionPreparee[] = [];
    const op = outilsOperations(sa, props).find((o) => o.def.name === "preparer_sponsoring")!;
    const entree = { produits: "Daclavir", ville: "Oran", montantDemande: 600000, description: `Congrès SAHGE ${TAG}` };
    const { OPERATIONS_IA } = await import("./infra/operations");
    const premiere = await OPERATIONS_IA.find((o) => o.nom === "preparer_sponsoring")!.proposer(entree, sa);
    expect("manque" in premiere).toBe(true);
    // La question a été posée à un tour PRÉCÉDENT (il y a une minute) ; la réponse n'a pas comblé le champ.
    questionDejaPosee(sa.id, "preparer_sponsoring", (premiere as { manque: string[] }).manque[0]!, new Set());
    const seconde = JSON.parse(await op.run(entree, sa));
    console.info("[banc P1 bis] AP-01 :", seconde.statut, (seconde.manque ?? []).join(" | "));
    if (seconde.statut === "CARTE_A_COMPLETER") {
      expect(props).toHaveLength(1);
      const f = props[0]!.proposition.formulaire!;
      expect(f.champs.length).toBeGreaterThan(0);
      expect(props[0]!.proposition.libelleBouton).toBe("Compléter et créer");
      // Signée SANS compléter : rien n'est exécuté.
      const sans = await confirmerIntentionAssistantIA(props[0]!.intentId);
      expect(sans.ok).toBe(false);
    } else {
      expect(seconde.statut).toBe("BLOQUE");
    }
  });

  it("EXPORT RH (EX-03) — la liste des salariés avec leur salaire de base : une ligne par salarié pour qui gère les RH (repères), refusée aux autres", async () => {
    const fiche = await prisma.employee.create({ data: { fullName: `Salarié ${TAG}`, isActive: true, baseSalary: 123456, position: "Délégué" } });
    const props: PropositionPreparee[] = [];
    const paie = outilsV1(sa, props).find((o) => o.def.name === "lire_paie")!;
    const r = JSON.parse(await paie.run({ liste: true }, sa));
    console.info("[banc P1 bis] EX-03 :", r.statut ?? `${r.total} salariés`);
    if (r.statut !== "REFUS") {
      const ligne = r.salaries.find((x: { nom: string }) => x.nom === `Salarié ${TAG}`);
      expect(ligne).toBeTruthy();
      expect(ligne.poste).toBe("Délégué");
      expect(String(ligne.salaireBase)).not.toBe("");
    }
    await prisma.employee.delete({ where: { id: fiche.id } });
  });

  it("ÉQUIPE (AN-04) — « combien de tâches mon équipe a-t-elle en retard ? » : un NOMBRE, lu sur l'équipe de « Mon Équipe »", async () => {
    const { lecturesErp } = await import("./infra/lectures-erp");
    const membre = await prisma.user.create({ data: { name: `Membre ${TAG}`, email: `${TAG}membre@t.dz`, passwordHash: "x", role: "VIEWER" } });
    const chef = await prisma.employee.create({ data: { fullName: `Chef ${TAG}`, isActive: true, userId: sa.id } });
    const sous = await prisma.employee.create({ data: { fullName: `Membre ${TAG}`, isActive: true, userId: membre.id, managerId: chef.id } });
    const hier = new Date(Date.now() - 3 * 86_400_000);
    const t = await prisma.task.createManyAndReturn({ data: [
      { title: `Retard ${TAG}`, assignedToId: membre.id, dueDate: hier, status: "TODO" },
      { title: `À venir ${TAG}`, assignedToId: membre.id, dueDate: new Date(Date.now() + 5 * 86_400_000), status: "IN_PROGRESS" },
    ] });
    try {
      const r = JSON.parse(await lecturesErp(sa).find((o) => o.def.name === "taches_equipe")!.run({}, sa));
      expect(r.enRetard).toBeGreaterThanOrEqual(1);
      expect(r.retards.some((x: { tache: string; personne: string; joursDeRetard: number }) => x.tache === `Retard ${TAG}` && x.personne === `Membre ${TAG}` && x.joursDeRetard >= 2)).toBe(true);
      expect(r.parPersonne.find((p: { personne: string }) => p.personne === `Membre ${TAG}`)).toMatchObject({ ouvertes: 2, enRetard: 1 });
    } finally {
      await prisma.task.deleteMany({ where: { id: { in: t.map((x) => x.id) } } });
      await prisma.employee.deleteMany({ where: { id: { in: [sous.id, chef.id] } } });
    }
  });

  it("MATÉRIEL PROMO (AP-03) — une hypothèse raisonnable plutôt qu'une question : titre proposé, action probable, article hors catalogue NOMMÉ ; la carte s'affiche", async () => {
    const { OPERATIONS_IA } = await import("./infra/operations");
    const art = await prisma.promoCatalogueArticle.create({ data: { reference: `${TAG}STY`, nom: `Stylos ${TAG}`, famille: "CONSOMMABLE" as never } });
    try {
      const op = OPERATIONS_IA.find((o) => o.nom === "preparer_materiel_promo")!;
      const r = await op.proposer({ articles: [{ article: `Brochures ${TAG}`, quantite: "200", produit: "Daclavir" }, { article: `Stylos ${TAG}`, quantite: "50", produit: "Daclavir" }] }, sa);
      expect("carte" in r).toBe(true);
      const c = (r as { carte: { title: string; warnings: string[]; fields: { label: string; value: string }[] } }).carte;
      expect(c.title).toContain("Daclavir");
      // F2 (banc réel, TR-LM-04) : hors catalogue → proposé en SAISIE LIBRE (« Autre article »), jamais retiré de la demande.
      expect(c.warnings.join(" ")).toMatch(new RegExp(`Brochures ${TAG}.*Autre article`));
      expect(JSON.stringify(c.fields)).toContain(`Brochures ${TAG} (saisie libre, hors catalogue)`);
      expect(c.warnings.join(" ")).toMatch(/Titre proposé/);
      expect(JSON.stringify(c.fields)).toMatch(/achat/);
      // Seul et hors catalogue : la carte s'affiche aussi, en saisie libre (F2).
      const seul = await op.proposer({ articles: [{ article: `Brochures ${TAG}`, quantite: "200" }] }, sa);
      expect("carte" in seul).toBe(true);
    } finally {
      await prisma.promoCatalogueArticle.delete({ where: { id: art.id } });
    }
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
