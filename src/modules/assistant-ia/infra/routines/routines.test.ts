import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/push", () => ({ sendPushToUser: async () => undefined }));

import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import { remplacerModelesPourTests } from "../generer";
import { modeleFactice } from "../testing/modele-factice";
import { executerOperationIA } from "../operations";
import { GERER_ROUTINE, PROGRAMMER_ROUTINE } from "../operations/routines";
import { outilsDeRoutine, sourcesEnFin } from "./passage";
import { changerStatut, executerRoutinesDues, supprimerRoutine } from "./service";
import { effacerJournalDe } from "../testing/journal";

/**
 * LES ROUTINES DE L'ASSISTANT IA — programmées par la personne, jamais devinées ; jouées sous ses
 * droits relus, en lecture seule ; chaque passage laisse une trace, l'état d'un passage nourrit le
 * suivant ; un droit retiré met la routine en pause, et le dit.
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__iarout_${Date.now().toString(36)}_`;
let assistante: CurrentUser;
let autre: CurrentUser;

async function compte(nom: string, role: CurrentUser["role"], ouvrir: boolean): Promise<CurrentUser> {
  const u = await prisma.user.create({ data: { name: `${TAG}${nom}`, email: `${TAG}${nom}@t.dz`, passwordHash: "x", role } });
  if (ouvrir) await prisma.userAccess.create({ data: { userId: u.id, module: "ASSISTANT_IA", canView: true, scope: "ASSIGNED" } });
  const access = await getAccess(u.id, u.role);
  return { id: u.id, name: u.name, email: u.email, role: access.role ?? u.role, secondaryRole: access.secondaryRole, access, mustChangePassword: false } as CurrentUser;
}

const BRIEFING = { titre: `${TAG}Briefing marché pharma DZ`, consigne: "Fais un briefing du marché pharmaceutique en Algérie : actualité, prix, réglementation.", frequence: "hebdomadaire", jours: ["dimanche"] };

suite("Assistant IA — routines programmées", () => {
  beforeAll(async () => {
    assistante = await compte("assistante", "DIRECTION_ASSISTANT", true);
    autre = await compte("autre", "DIRECTION_ASSISTANT", true);
  });
  afterEach(() => remplacerModelesPourTests(null));
  afterAll(async () => {
    const ids = [assistante?.id, autre?.id].filter(Boolean) as string[];
    await effacerJournalDe(ids);
    await prisma.assistantRoutine.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.assistantActionIntent.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.userAccess.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("« dimanche matin » sans heure : l'heure se DEMANDE, elle n'est jamais supposée", async () => {
    const p = await PROGRAMMER_ROUTINE.proposer(BRIEFING, assistante);
    expect("manque" in p && p.manque.join(" ")).toMatch(/à quelle heure \(heure d'Alger\)/);
  });

  it("une routine qui « envoie » ou « relance » est refusée — elle lit et rapporte", async () => {
    const p = await PROGRAMMER_ROUTINE.proposer({ ...BRIEFING, heure: "08:00", consigne: "Relance chaque valideur en retard." }, assistante);
    expect("erreur" in p && p.erreur).toMatch(/LIT et RAPPORTE/);
  });

  it("la carte dit tout — heure d'Alger, trois prochains passages — et rien n'existe avant la confirmation", async () => {
    const p = await PROGRAMMER_ROUTINE.proposer({ ...BRIEFING, heure: "8h" }, assistante);
    if (!("carte" in p)) throw new Error(JSON.stringify(p));
    expect(p.carte.fields.find((f) => f.label === "Quand")?.value).toBe("chaque dimanche à 08:00 (heure d'Alger)");
    expect(p.carte.fields.find((f) => f.label === "Prochains passages")?.value.split("\n")).toHaveLength(3);
    expect(await prisma.assistantRoutine.count({ where: { userId: assistante.id } })).toBe(0);
    const r = await executerOperationIA(assistante, { kind: "assistant_ia_op", op: PROGRAMMER_ROUTINE.nom, args: p.args });
    expect(r.ok, r.error).toBe(true);
    const routine = await prisma.assistantRoutine.findFirstOrThrow({ where: { userId: assistante.id } });
    const l = new Date(routine.prochaineLe!.getTime() + 3_600_000);
    expect([l.getUTCDay(), l.getUTCHours(), l.getUTCMinutes()]).toEqual([0, 8, 0]);
  });

  it("LIMITE : une routine n'a AUCUN outil d'écriture", async () => {
    const noms = (await outilsDeRoutine(assistante, [])).map((o) => o.def.name);
    for (const ecriture of ["create_task", "send_message", "proposer_memoire", "mes_brouillons", "programmer_routine", "gerer_routine"]) expect(noms).not.toContain(ecriture);
    expect(noms.some((n) => n.startsWith("preparer_"))).toBe(false);
    // Les gestes métier du moteur ouverts à la conversation (décision 0012) ne le sont pas à une routine.
    const { ECRITURES_DU_MOTEUR, outilsV1 } = await import("../outils-v1");
    expect(outilsV1(assistante, []).map((o) => o.def.name)).toContain("create_hr_request");
    for (const ecriture of ECRITURES_DU_MOTEUR) expect(noms).not.toContain(ecriture);
    expect(noms).toContain("web_research");
  });

  it("les sources du web s'ajoutent au rapport depuis la sortie de l'outil — jamais une adresse non https", () => {
    const sortie = JSON.stringify({ reponse: "…", sources: [{ url: "https://www.aps.dz/sante/marche", titre: "APS — marché" }, { url: "http://non-sur.example", titre: "x" }, { url: "https://www.aps.dz/sante/marche", titre: "doublon" }] });
    const fin = sourcesEnFin(["pas du JSON", sortie]);
    expect(fin).toContain("[APS — marché](https://www.aps.dz/sante/marche)");
    expect(fin).not.toContain("non-sur");
    expect(fin.match(/aps\.dz/g)).toHaveLength(1);
  });

  it("un passage dû : rapport consigné, notification, échéance avancée — puis l'état nourrit le suivant", async () => {
    const routine = await prisma.assistantRoutine.findFirstOrThrow({ where: { userId: assistante.id } });
    await prisma.assistantRoutine.update({ where: { id: routine.id }, data: { prochaineLe: new Date(Date.now() - 60_000) } });
    const faux = modeleFactice([{ texte: "## Briefing du 1er novembre\nLe marché progresse de 4 % (source : APS, 30/10)." }]);
    remplacerModelesPourTests([faux.modele as never]);
    expect((await executerRoutinesDues()).jouees).toBe(1);
    const apres = await prisma.assistantRoutine.findUniqueOrThrow({ where: { id: routine.id }, include: { passages: true } });
    expect(apres.passages).toHaveLength(1);
    expect(apres.passages[0]!.statut).toBe("SUCCES");
    expect(apres.passages[0]!.contenu).toMatch(/progresse de 4 %/);
    expect(apres.executions).toBe(1);
    expect(apres.prochaineLe!.getTime()).toBeGreaterThan(Date.now());
    expect(apres.priseLe).toBeNull();
    expect(JSON.stringify(faux.promptsRecus)).toContain("briefing du marché pharmaceutique");
    expect(await prisma.notification.count({ where: { userId: assistante.id, title: { contains: "rapport prêt" } } })).toBe(1);

    await prisma.assistantRoutine.update({ where: { id: routine.id }, data: { prochaineLe: new Date(Date.now() - 60_000) } });
    const second = modeleFactice([{ texte: "Rien de nouveau depuis le 1er novembre : j'ai revérifié l'actualité et les prix." }]);
    remplacerModelesPourTests([second.modele as never]);
    await executerRoutinesDues();
    expect(JSON.stringify(second.promptsRecus)).toContain("progresse de 4 %");
    const passages = await prisma.assistantRoutineRun.findMany({ where: { routineId: routine.id }, orderBy: { debutLe: "desc" } });
    expect(passages[0]!.statut).toBe("RIEN_DE_NOUVEAU");
  });

  it("un échec n'est jamais muet : consigné avec sa cause, notifié, compté", async () => {
    const routine = await prisma.assistantRoutine.findFirstOrThrow({ where: { userId: assistante.id } });
    await prisma.assistantRoutine.update({ where: { id: routine.id }, data: { prochaineLe: new Date(Date.now() - 60_000) } });
    remplacerModelesPourTests([modeleFactice([{ texte: "" }]).modele as never]);
    await executerRoutinesDues();
    const apres = await prisma.assistantRoutine.findUniqueOrThrow({ where: { id: routine.id } });
    expect(apres.echecsConsecutifs).toBe(1);
    expect(apres.statut).toBe("ACTIVE");
    const dernier = await prisma.assistantRoutineRun.findFirstOrThrow({ where: { routineId: routine.id }, orderBy: { debutLe: "desc" } });
    expect(dernier.statut).toBe("ECHEC");
    expect(dernier.erreur).toBeTruthy();
    expect(await prisma.notification.count({ where: { userId: assistante.id, title: { contains: "passage en échec" } } })).toBe(1);
  });

  it("LIMITE : l'assistant retiré entre deux passages → rien n'est lu, la routine passe en pause, et c'est dit", async () => {
    const routine = await prisma.assistantRoutine.findFirstOrThrow({ where: { userId: assistante.id } });
    await prisma.userAccess.deleteMany({ where: { userId: assistante.id, module: "ASSISTANT_IA" } });
    await prisma.assistantRoutine.update({ where: { id: routine.id }, data: { prochaineLe: new Date(Date.now() - 60_000) } });
    const faux = modeleFactice([{ texte: "ne doit pas être appelé" }]);
    remplacerModelesPourTests([faux.modele as never]);
    await executerRoutinesDues();
    expect(faux.promptsRecus).toHaveLength(0);
    const apres = await prisma.assistantRoutine.findUniqueOrThrow({ where: { id: routine.id } });
    expect(apres.statut).toBe("PAUSED");
    const dernier = await prisma.assistantRoutineRun.findFirstOrThrow({ where: { routineId: routine.id }, orderBy: { debutLe: "desc" } });
    expect(dernier.statut).toBe("IGNOREE");
    expect(await prisma.notification.count({ where: { userId: assistante.id, title: { contains: "passage ignoré" } } })).toBe(1);
    await prisma.userAccess.create({ data: { userId: assistante.id, module: "ASSISTANT_IA", canView: true, scope: "ASSIGNED" } });
  });

  it("LIMITE : les routines d'une personne ne se touchent pas depuis le compte d'une autre", async () => {
    const routine = await prisma.assistantRoutine.findFirstOrThrow({ where: { userId: assistante.id } });
    expect((await changerStatut(autre.id, routine.id, "ACTIVE")).ok).toBe(false);
    expect(await supprimerRoutine(autre.id, routine.id)).toBe(false);
    const p = await GERER_ROUTINE.proposer({ routine: "Briefing", action: "supprimer" }, autre);
    expect("manque" in p && p.manque[0]).toMatch(/aucune routine/);
  });

  it("reprendre une routine en pause ne rejoue pas les passages manqués", async () => {
    const p = await GERER_ROUTINE.proposer({ routine: "Briefing", action: "reprendre" }, assistante);
    if (!("carte" in p)) throw new Error(JSON.stringify(p));
    const r = await executerOperationIA(assistante, { kind: "assistant_ia_op", op: GERER_ROUTINE.nom, args: p.args });
    expect(r.ok, r.error).toBe(true);
    const apres = await prisma.assistantRoutine.findFirstOrThrow({ where: { userId: assistante.id } });
    expect(apres.statut).toBe("ACTIVE");
    expect(apres.prochaineLe!.getTime()).toBeGreaterThan(Date.now());
  });
});
