import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import type { CurrentUser } from "@/lib/session";
import type { EffectiveAccess, Module, Action } from "@/lib/rbac";
import { buildProposal, type AssistantActionPayload } from "@/lib/assistant";

/**
 * GOLDEN OPS VAGUE 7b — réunions avancées : FUSION de la fiche avec HORAIRE D'ALGER rejoué
 * (UTC+1), appel lancé sur une conversation résolue par nom, proposition de tâche du compte
 * rendu tranchée par intitulé, message du fil supprimé par extrait ; invitation d'agenda
 * (chacun pour soi) ; commentaire transverse retrouvé par extrait avec l'objet nommé.
 */

function userWith(perms: Partial<Record<Module, Action[]>>, role: CurrentUser["role"], id: string, name: string): CurrentUser {
  const modules = new Map(
    Object.entries(perms).map(([m, actions]) => [
      m as Module,
      { module: m as Module, actions: new Set(actions as Action[]), scope: "ALL" as const },
    ]),
  );
  return {
    id, name, email: `${id}@t.dz`, role,
    access: { modules, rowGrants: new Map() } as unknown as EffectiveAccess,
    mustChangePassword: false,
  };
}

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const PREFIXE = "__ops7b__";
const TAG = `${PREFIXE}${Date.now()}`;
const domainArgs = (p: { payload: unknown }) => (p.payload as Extract<AssistantActionPayload, { kind: "domain_op" }>).args;

let saId = "";
let colleagueId = "";
let meetingId = "";
let proposalId = "";
let conversationId = "";
let calendarEventId = "";
let commentId = "";
let bdProjectId = "";

const sa = () => userWith({
  MESSAGING: ["VIEW", "CREATE"],
}, "SUPER_ADMIN", saId, `${TAG} Amine`);

suite("ops vague 7b — réunions avancées, agenda, commentaires", () => {
  /**
   * LE MÉNAGE SE FAIT SUR LE PRÉFIXE STABLE, PAS SUR L'ÉTIQUETTE DE CE RUN — et AVANT de semer.
   *
   * L'étiquette porte l'horodatage du run (`__xxx__<Date.now()>`). Un ménage qui s'y accroche ne
   * peut, par construction, jamais ramasser les lignes d'un run PRÉCÉDENT : le jour où un `beforeAll`
   * expire sous la charge de la suite complète, ses lignes restent en base POUR TOUJOURS. Et elles
   * ne dorment pas — la résolution d'une cible par son nom trouve alors DEUX « Journée HTA » et
   * refuse, honnêtement, de choisir. Mesuré : sept tests rouges dans un fichier que personne n'avait
   * touché, à cause d'un événement oublié par une exécution morte des heures plus tôt.
   *
   * Balayer sur le préfixe, avant ET après, rend le fichier auto-réparant : un run qui meurt ne
   * pénalise que lui-même.
   */
  const balayer = async () => {
    await prisma.comment.deleteMany({ where: { body: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.bdProject.deleteMany({ where: { name: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.calendarInvite.deleteMany({ where: { event: { title: { startsWith: PREFIXE } } } }).catch(() => {});
    await prisma.calendarEvent.deleteMany({ where: { title: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.conversationMember.deleteMany({ where: { conversation: { title: { startsWith: PREFIXE } } } }).catch(() => {});
    await prisma.conversation.deleteMany({ where: { title: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.meetingTaskProposal.deleteMany({ where: { meeting: { title: { startsWith: PREFIXE } } } }).catch(() => {});
    await prisma.meetingMessage.deleteMany({ where: { meeting: { title: { startsWith: PREFIXE } } } }).catch(() => {});
    await prisma.meetingParticipant.deleteMany({ where: { meeting: { title: { startsWith: PREFIXE } } } }).catch(() => {});
    await prisma.meeting.deleteMany({ where: { title: { startsWith: PREFIXE } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: PREFIXE } } }).catch(() => {});
  };
  beforeAll(balayer);
  afterAll(balayer);

  beforeAll(async () => {
    const [s, c] = await Promise.all([
      prisma.user.create({ data: { name: `${TAG} Amine`, email: `${TAG}s@t.dz`, passwordHash: "x", role: "SUPER_ADMIN" } }),
      prisma.user.create({ data: { name: `${TAG} Yasmine RH`, email: `${TAG}c@t.dz`, passwordHash: "x", role: "MEDICAL_DELEGATE" } }),
    ]);
    saId = s.id; colleagueId = c.id;

    const meeting = await prisma.meeting.create({
      data: {
        title: `${TAG} Revue budget T4`, slug: `${TAG}-slug`, publicToken: `${TAG}-tok`,
        kind: "MEETING", status: "SCHEDULED", withVideo: true, inPerson: false,
        scheduledAt: new Date("2026-09-10T09:00:00Z"), // 10:00 à Alger (UTC+1)
        description: "Passer les enveloppes en revue", meetLink: "https://meet.example/budget",
        organizerId: s.id,
        participants: { create: [{ userId: c.id }] },
      },
    });
    meetingId = meeting.id;
    await prisma.meetingMessage.create({ data: { meetingId: meeting.id, authorId: s.id, body: "Le support de présentation est prêt." } });
    const proposal = await prisma.meetingTaskProposal.create({
      data: { meetingId: meeting.id, title: "Consolider les chiffres T3", assigneeId: c.id, status: "PROPOSED" },
    });
    proposalId = proposal.id;

    const conv = await prisma.conversation.create({
      data: {
        type: "GROUP", title: `${TAG} Équipe Budget`,
        members: { create: [{ userId: s.id }, { userId: c.id }] },
      },
    });
    conversationId = conv.id;

    const event = await prisma.calendarEvent.create({
      data: {
        title: `${TAG} Point trésorerie`, startAt: new Date(Date.now() + 3 * 86_400_000),
        organizer: { connect: { id: c.id } },
        invitees: { create: [{ userId: s.id, status: "INVITED" }] },
      },
    });
    calendarEventId = event.id;

    const project = await prisma.bdProject.create({ data: { name: `${TAG} Projet commenté` } });
    bdProjectId = project.id;
    const comment = await prisma.comment.create({
      data: { entityType: "BD_PROJECT", entityId: project.id, body: `${TAG} Revoir la marge du lot 2`, authorId: s.id },
    });
    commentId = comment.id;
  });


  it("update_meeting : changer le SEUL titre rejoue la description, le LIEN et l'HORAIRE en heure d'Alger (UTC 09:00 → 10:00 local)", async () => {
    const p = await buildProposal("meeting_operation", {
      op: "update_meeting", title: "Revue budget", newName: `${TAG} Revue budget T4 élargie`,
    }, sa());
    expect("error" in p).toBe(false);
    if (!("error" in p)) {
      const a = domainArgs(p);
      expect(a.id).toBe(meetingId);
      expect(a.title).toBe(`${TAG} Revue budget T4 élargie`);
      expect(a.description).toBe("Passer les enveloppes en revue");
      expect(a.meetLink).toBe("https://meet.example/budget");
      expect(a.scheduledAt).toBe("2026-09-10T10:00");
    }
  });

  it("start_call : la conversation se résout par NOM, « audio » bascule le type", async () => {
    const p = await buildProposal("meeting_operation", {
      op: "start_call", target: "Équipe Budget", mode: "audio",
    }, sa());
    expect("error" in p).toBe(false);
    if (!("error" in p)) {
      expect(domainArgs(p).conversationId).toBe(conversationId);
      expect(domainArgs(p).withVideo).toBe("");
      expect(p.warnings.join(" ")).toMatch(/SONNE/);
    }
  });

  it("accept_meeting_proposal : la proposition se désigne par INTITULÉ, l'assigné du compte rendu est montré", async () => {
    const p = await buildProposal("meeting_operation", {
      op: "accept_meeting_proposal", title: "Revue budget", label: "Consolider",
    }, sa());
    expect("error" in p).toBe(false);
    if (!("error" in p)) {
      expect(domainArgs(p).proposalId).toBe(proposalId);
      expect(p.fields.map((f) => f.value).join(" ")).toContain(`${TAG} Yasmine RH`);
    }
  });

  it("delete_meeting_message : le message du fil se désigne par EXTRAIT", async () => {
    const p = await buildProposal("meeting_operation", {
      op: "delete_meeting_message", title: "Revue budget", comment: "support de présentation",
    }, sa());
    expect("error" in p).toBe(false);
    if (!("error" in p)) expect(p.warnings.join(" ")).toMatch(/auteur ou organisateur/);
  });

  it("remove_meeting_participant : le participant se résout parmi les INSCRITS de la réunion", async () => {
    const p = await buildProposal("meeting_operation", {
      op: "remove_meeting_participant", title: "Revue budget", person: "Yasmine",
    }, sa());
    expect("error" in p).toBe(false);
    if (!("error" in p)) expect(domainArgs(p).userId).toBe(colleagueId);
  });

  it("respond_to_calendar_invite : MON invitation se résout, la réponse FR → enum", async () => {
    const p = await buildProposal("task_operation", {
      op: "respond_to_calendar_invite", label: "Point trésorerie", decision: "peut-être",
    }, sa());
    expect("error" in p).toBe(false);
    if (!("error" in p)) {
      expect(domainArgs(p).eventId).toBe(calendarEventId);
      expect(domainArgs(p).status).toBe("TENTATIVE");
      expect(p.warnings.join(" ")).toMatch(/LUI-MÊME/);
    }

    const notInvited = userWith({}, "MEDICAL_DELEGATE", colleagueId, "Yasmine");
    const denied = await buildProposal("task_operation", {
      op: "respond_to_calendar_invite", label: "Point trésorerie", decision: "accepter",
    }, notInvited);
    expect("error" in denied && denied.error).toMatch(/Aucune invitation/);
  });

  it("update_comment : le commentaire se retrouve par EXTRAIT avec l'objet commenté nommé", async () => {
    const p = await buildProposal("task_operation", {
      op: "update_comment", comment: "marge du lot 2", note: `${TAG} Revoir la marge des lots 2 et 3`,
    }, sa());
    expect("error" in p).toBe(false);
    if (!("error" in p)) {
      expect(domainArgs(p).id).toBe(commentId);
      expect(domainArgs(p).body).toBe(`${TAG} Revoir la marge des lots 2 et 3`);
      expect(p.fields.map((f) => f.value).join(" ")).toMatch(/Projet BD|BD_PROJECT/);
    }
  });

  it("delete_comment : suppression annoncée définitive et tracée", async () => {
    const p = await buildProposal("task_operation", {
      op: "delete_comment", comment: "marge du lot 2",
    }, sa());
    expect("error" in p).toBe(false);
    if (!("error" in p)) expect(p.warnings.join(" ")).toMatch(/définitive/);
  });
});
