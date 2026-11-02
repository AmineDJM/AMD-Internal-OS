/**
 * OPS VAGUE 2b — MISSIONS d'événements : l'entité porteuse (résolue ici, partagée avec la
 * vague 5), l'assignation et les ordres de mission, par les actions canoniques.
 */
import { prisma } from "./erp";
import { assignMission, removeMission, requestMissionOrder, issueMissionOrder, addMissionComment } from "@/lib/actions/mission-actions";
import type { OpImpl, OpProposalDraft } from "../../types";
import { opStr } from "../../types";
import { runFd, fieldsOf } from "../../helpers";
import { resolvePerson } from "./commun";

// ─────────────── Missions (entités porteuses) ───────────────

export interface MissionParent { entityType: string; entityId: string; label: string }

export async function resolveMissionParent(kindRaw: string, labelRaw: string): Promise<MissionParent | { error: string }> {
  const q = labelRaw.trim();
  if (!q) return { error: "Précisez l'événement / congrès / sponsoring visé (champ « target »)." };
  const k = kindRaw.toLowerCase();
  const wantEvent = /[ée]v[èeé]nement|event/.test(k);
  const wantSpo = /sponsor/.test(k);
  const wantCI = /congr.s.*inter|international/.test(k);
  const wantCN = /congr.s.*nation|national/.test(k) && !wantCI;
  const hits: MissionParent[] = [];
  if (wantEvent || !k) {
    for (const e of await prisma.event.findMany({ where: { name: { contains: q, mode: "insensitive" } }, select: { id: true, name: true }, take: 4 })) {
      hits.push({ entityType: "EVENT", entityId: e.id, label: `${e.name} (événement)` });
    }
  }
  if (wantSpo || !k) {
    for (const s of await prisma.sponsoringRequest.findMany({ where: { OR: [{ reference: { equals: q, mode: "insensitive" } }, { institution: { contains: q, mode: "insensitive" } }] }, select: { id: true, reference: true, institution: true }, take: 4 })) {
      hits.push({ entityType: "SPONSORING", entityId: s.id, label: `${s.reference} — ${s.institution} (sponsoring)` });
    }
  }
  if (wantCI || !k) {
    for (const c of await prisma.congressInternational.findMany({ where: { name: { contains: q, mode: "insensitive" } }, select: { id: true, name: true }, take: 4 })) {
      hits.push({ entityType: "CONGRESS_INTERNATIONAL", entityId: c.id, label: `${c.name} (congrès international)` });
    }
  }
  if (wantCN || !k) {
    for (const c of await prisma.congressNational.findMany({ where: { name: { contains: q, mode: "insensitive" } }, select: { id: true, name: true }, take: 4 })) {
      hits.push({ entityType: "CONGRESS_NATIONAL", entityId: c.id, label: `${c.name} (congrès national)` });
    }
  }
  if (hits.length === 0) return { error: `Aucun événement / congrès / sponsoring « ${q} ».` };
  if (hits.length > 1) return { error: `Plusieurs cibles possibles : ${hits.slice(0, 6).map((h) => h.label).join(" ; ")} — préciser (champ « kind » : événement | sponsoring | congrès international | congrès national).` };
  return hits[0];
}

interface MissionHit { assignmentId: string; parent: MissionParent; personName: string }

async function resolveMissionAssignment(input: Record<string, unknown>): Promise<MissionHit | { error: string }> {
  const parent = await resolveMissionParent(opStr(input, "kind"), opStr(input, "target"));
  if ("error" in parent) return parent;
  const person = await resolvePerson(opStr(input, "person"));
  if ("error" in person) return person;
  const a = await prisma.missionAssignment.findFirst({
    where: { entityType: parent.entityType as never, entityId: parent.entityId, userId: person.id },
    select: { id: true },
  });
  if (!a) return { error: `${person.name} n'est pas assigné·e sur ${parent.label}.` };
  return { assignmentId: a.id, parent, personName: person.name };
}

export const MISSION_OPS_IMPL: Record<string, OpImpl> = {
  assign_mission: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const parent = await resolveMissionParent(opStr(input, "kind"), opStr(input, "target"));
      if ("error" in parent) return parent;
      const person = await resolvePerson(opStr(input, "person"));
      if ("error" in person) return person;
      const reference = /r[ée]f[ée]rence|d[ée]l[ée]gu[ée]/i.test(opStr(input, "role"));
      return {
        title: `Assigner ${person.name} ${reference ? "comme délégué de référence" : "comme accompagnant"} — ${parent.label}`,
        fields: fieldsOf([
          ["Sur", parent.label], ["Personne", person.name],
          ["Rôle", reference ? "Délégué de référence" : "Accompagnant"],
          ["Note", opStr(input, "note") || null],
        ]),
        args: { entityType: parent.entityType, entityId: parent.entityId, userId: person.id, role: reference ? "DELEGATE_REFERENCE" : "ACCOMPAGNANT", note: opStr(input, "note") || null },
        successMessage: `${person.name} assigné·e sur ${parent.label}.`,
        revalidate: ["/missions"],
      };
    },
    execute: (args) => runFd(assignMission, args, "L'assignation a été refusée.", { revalidate: ["/missions"] }),
  },

  remove_mission: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const hit = await resolveMissionAssignment(input);
      if ("error" in hit) return hit;
      return {
        title: `Retirer ${hit.personName} — ${hit.parent.label}`,
        fields: [{ label: "Assignation", value: `${hit.personName} sur ${hit.parent.label}` }],
        args: { id: hit.assignmentId },
        successMessage: `${hit.personName} retiré·e de ${hit.parent.label}.`,
        revalidate: ["/missions"],
      };
    },
    execute: (args) => runFd(removeMission, args, "Le retrait a été refusé.", { revalidate: ["/missions"] }),
  },

  request_mission_order: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const hit = await resolveMissionAssignment(input);
      if ("error" in hit) return hit;
      return {
        title: `Demander l'ordre de mission — ${hit.parent.label}`,
        fields: [{ label: "Assignation", value: `${hit.personName} sur ${hit.parent.label}` }],
        warnings: ["Seule la personne assignée demande SON ordre de mission — l'action refusera sinon."],
        args: { id: hit.assignmentId },
        successMessage: `Ordre de mission demandé (${hit.parent.label}).`,
        revalidate: ["/missions"],
      };
    },
    execute: (args) => runFd(requestMissionOrder, args, "La demande d'ordre de mission a été refusée.", { revalidate: ["/missions"] }),
  },

  issue_mission_order: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const hit = await resolveMissionAssignment(input);
      if ("error" in hit) return hit;
      return {
        title: `Émettre l'ordre de mission de ${hit.personName} — ${hit.parent.label}`,
        fields: [{ label: "Assignation", value: `${hit.personName} sur ${hit.parent.label}` }],
        warnings: ["Réservé aux responsables de l'entité (événement / congrès / sponsoring) — la personne assignée est notifiée."],
        args: { id: hit.assignmentId },
        successMessage: `Ordre de mission émis pour ${hit.personName}.`,
        revalidate: ["/missions"],
      };
    },
    execute: (args) => runFd(issueMissionOrder, args, "L'émission de l'ordre a été refusée.", { revalidate: ["/missions"] }),
  },

  comment_mission: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const hit = await resolveMissionAssignment(input);
      if ("error" in hit) return hit;
      const body = opStr(input, "message") || opStr(input, "note");
      if (!body) return { error: "Écrivez le message (champ « message »)." };
      return {
        title: `Message sur la mission de ${hit.personName} — ${hit.parent.label}`,
        fields: [
          { label: "Mission", value: `${hit.personName} sur ${hit.parent.label}` },
          { label: "Message", value: body },
        ],
        args: { assignmentId: hit.assignmentId, body },
        successMessage: `Message posté sur la mission de ${hit.personName}.`,
        revalidate: ["/missions"],
      };
    },
    execute: (args) => runFd(addMissionComment, args, "Le message a été refusé.", { revalidate: ["/missions"] }),
  },
};
