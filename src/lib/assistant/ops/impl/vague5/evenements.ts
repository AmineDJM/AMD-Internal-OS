/**
 * OPS VAGUE 5a — ÉVÉNEMENTS : fiche en FUSION intégrale, circuit de prise en charge,
 * inscriptions. Par les actions canoniques.
 */
import { prisma } from "./erp";
import { updateEvent, deleteEvent, submitEventForApproval, addRegistration, setRegistrationStatus, deleteRegistration } from "@/modules/ad-pro/actions-evenements";
import { apercuSuppression } from "@/platform/in-process/capacites";
import type { OpImpl, OpProposalDraft } from "../../types";
import { opStr } from "../../types";
import { runFd, fieldsOf, resolveOne, isoDate } from "../../helpers";
import { matchLabel, fold } from "../../impl-regulatory";
import { resolvePerson } from "./commun";

const day = (d: Date | null | undefined): string | null => (d ? d.toISOString().slice(0, 10) : null);
const numStr = (v: unknown): string | null => (v == null ? null : String(Number(v)));

// ─────────────────────────── EVENTS ───────────────────────────

const resolveEvent = (raw: string) =>
  resolveOne(raw, "l'événement (champ « target » — son nom)",
    (q) => prisma.event.findMany({ where: { name: { contains: q, mode: "insensitive" } }, select: { id: true, name: true, status: true }, orderBy: { createdAt: "desc" }, take: 6 }),
    (e) => e.name);

const EVENT_TYPE_FR: [string, string][] = [
  ["CONGRESS", "Congrès"], ["SEMINAR", "Séminaire"], ["ROUND_TABLE", "Table ronde"],
  ["HOSPITAL_STAFF", "Staff hospitalier"], ["SYMPOSIUM", "Symposium"], ["WEBINAR", "Webinaire"],
  ["TRAINING", "Formation"], ["SCIENTIFIC_DAY", "Journée scientifique"], ["OTHER", "Autre"],
];
const EVENT_SCOPE_FR: [string, string][] = [["NATIONAL", "National"], ["INTERNATIONAL", "International"]];
const EVENT_FORMAT_FR: [string, string][] = [["PRESENTIAL", "Présentiel"], ["WEBINAR", "Webinaire (en ligne)"], ["HYBRID", "Hybride"]];
// LES ÉVÉNEMENTS SONT EXTERNES (Direction, 27/10) : ni « En préparation », ni « Inscriptions ouvertes », ni « Complet »,
// ni liste d'attente — Adam ne les propose plus, comme l'écran (`events/externe.ts`). Les valeurs restent en base.
const EVENT_STATUS_FR: [string, string][] = [
  ["DRAFT", "Brouillon"], ["AWAITING_VALIDATION", "En attente de validation"], ["VALIDATED", "Validé"],
  ["COMPLETED", "Terminé"], ["CANCELLED", "Annulé"],
];
const REG_STATUS_FR: [string, string][] = [
  ["REGISTERED", "Inscrit"], ["CONFIRMED", "Confirmé"],
  ["REJECTED", "Refusé"], ["PRESENT", "Présent"], ["ABSENT", "Absent"], ["CANCELLED", "Annulé"],
];
const REG_ROLE_FR: [string, string][] = [
  ["DOCTOR", "Médecin"], ["PROFESSOR", "Professeur"], ["HEAD_OF_SERVICE", "Chef de service"],
  ["PHARMACIST", "Pharmacien"], ["OTHER", "Autre"],
];

function enumIn(raw: string, entries: [string, string][]): string | null | { error: string } {
  const q = raw.trim();
  if (!q) return null;
  return matchLabel(q, entries);
}

interface RegistrationHit { id: string; name: string }

async function resolveRegistration(eventId: string, eventName: string, raw: string): Promise<RegistrationHit | { error: string }> {
  const q = fold(raw);
  if (!q) return { error: "Précisez le participant (champ « person » — son nom)." };
  const rows = await prisma.eventRegistration.findMany({
    where: { eventId }, select: { id: true, firstName: true, lastName: true, status: true }, take: 200,
  });
  const label = (r: (typeof rows)[number]) => `${r.firstName} ${r.lastName}`;
  const hits = rows.filter((r) => fold(label(r)).includes(q) || q.includes(fold(r.lastName)));
  if (hits.length === 1) return { id: hits[0].id, name: label(hits[0]) };
  if (hits.length === 0) return { error: `Aucun participant « ${raw} » sur ${eventName}.` };
  return { error: `Plusieurs participants correspondent : ${hits.slice(0, 6).map(label).join(", ")} — préciser.` };
}

export const EVENT_OPS_IMPL: Record<string, OpImpl> = {
  update_event: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const hit = await resolveEvent(opStr(input, "target") || opStr(input, "name"));
      if ("error" in hit) return hit;
      const e = await prisma.event.findUnique({ where: { id: hit.id } });
      if (!e) return { error: "Événement introuvable." };
      const type = enumIn(opStr(input, "eventType"), EVENT_TYPE_FR);
      if (type && typeof type === "object") return type;
      const scope = enumIn(opStr(input, "scope"), EVENT_SCOPE_FR);
      if (scope && typeof scope === "object") return scope;
      const format = enumIn(opStr(input, "format"), EVENT_FORMAT_FR);
      if (format && typeof format === "object") return format;
      const status = enumIn(opStr(input, "status"), EVENT_STATUS_FR);
      if (status && typeof status === "object") return status;
      // FUSION : l'action REMPLACE la fiche entière (enums absents retombent sur des défauts,
      // textes absents s'effacent) — tout l'existant est relu et rejoué.
      const changes: string[] = [];
      const pick = (key: string, current: string | null, label: string): string | null => {
        const v = opStr(input, key);
        if (v) { changes.push(label); return v; }
        return current;
      };
      const name = pick("newName", e.name, "nom") ?? e.name;
      const location = pick("location", e.location, "lieu");
      const city = pick("city", e.city, "ville");
      const country = pick("country", e.country, "pays");
      const specialty = pick("specialty", e.specialty, "spécialité");
      const products = pick("products", e.products, "produits");
      const description = pick("notes", e.description, "description");
      const startDate = isoDate(opStr(input, "startDate")) ? (changes.push("début"), isoDate(opStr(input, "startDate"))) : day(e.startDate);
      const endDate = isoDate(opStr(input, "endDate")) ? (changes.push("fin"), isoDate(opStr(input, "endDate"))) : day(e.endDate);
      const budget = opStr(input, "amount") ? (changes.push("budget estimé"), opStr(input, "amount")) : numStr(e.estimatedBudget);
      if (type && type !== e.type) changes.push("type");
      if (scope && scope !== e.scope) changes.push("portée");
      if (format && format !== e.format) changes.push("format");
      if (status && status !== e.status) changes.push(`statut → ${EVENT_STATUS_FR.find(([c]) => c === status)?.[1] ?? status}`);
      if (changes.length === 0) return { error: "Rien à changer : donnez newName, eventType, scope, format, status, startDate, endDate, location, city, country, specialty, products, amount (budget) ou notes." };
      return {
        title: `Modifier l'événement « ${e.name} »`,
        fields: [
          { label: "Événement", value: e.name },
          { label: "Modifications", value: changes.join(" · ") },
          { label: "Le reste", value: "rejoué à l'identique (type, statut, dates, responsable compris)" },
        ],
        args: {
          id: hit.id, name,
          type: (type as string | null) ?? e.type, scope: (scope as string | null) ?? e.scope,
          format: (format as string | null) ?? e.format, status: (status as string | null) ?? e.status,
          startDate, endDate, location, city, country, specialty, products, description,
          estimatedBudget: budget, meetingLink: e.meetingLink, responsibleId: e.responsibleId,
        },
        successMessage: `Événement « ${name} » mis à jour (${changes.join(", ")}).`,
        link: `/events/${hit.id}`, revalidate: ["/events"],
      };
    },
    execute: (args) => runFd(updateEvent, args, "La modification de l'événement a été refusée.", { revalidate: ["/events"] }),
  },

  delete_event: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const hit = await resolveEvent(opStr(input, "target") || opStr(input, "name"));
      if ("error" in hit) return hit;
      // LE MÊME APERÇU QUE LA FENÊTRE DE L'ÉCRAN (§118.162) : ce qui part avec l'événement (sa
      // déclaration d'information médicale, son circuit, ses postes, ses inscriptions…) et ce qui
      // l'interdit. La carte disait « aucun retour possible » et ne comptait que les inscriptions :
      // deux phrases fausses — la suppression est réversible, et elle emporte bien plus.
      const apercu = await apercuSuppression("EVENT", hit.id);
      if (apercu.refus) return { error: apercu.refus };
      return {
        title: `SUPPRIMER l'événement « ${hit.name} »`,
        fields: [
          { label: "Événement", value: hit.name },
          { label: "Part aussi", value: apercu.emporte.length ? apercu.emporte.join(", ") : "rien d'autre" },
        ],
        warnings: ["L'événement et tout ce qui en dépend disparaissent de tous les écrans. Réversible : le Super Admin peut tout restaurer depuis la corbeille."],
        confirmText: hit.name,
        args: { id: hit.id },
        successMessage: `Événement « ${hit.name} » supprimé.`,
        revalidate: ["/events"],
      };
    },
    execute: (args) => runFd(deleteEvent, args, "La suppression de l'événement a été refusée.", { revalidate: ["/events"] }),
  },

  submit_event_for_approval: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const hit = await resolveEvent(opStr(input, "target") || opStr(input, "name"));
      if ("error" in hit) return hit;
      let pmId: string | null = null; let pmName: string | null = null;
      if (opStr(input, "person")) {
        const pm = await resolvePerson(opStr(input, "person"), "le référent Direction Marketing (champ « person »)");
        if ("error" in pm) return pm;
        pmId = pm.id; pmName = pm.name;
      }
      return {
        title: `Soumettre « ${hit.name} » au circuit de prise en charge`,
        fields: fieldsOf([
          ["Événement", hit.name],
          ["Référent Direction Marketing", pmName],
        ]),
        warnings: ["Même circuit que les congrès : National Sales (préliminaire) → analyse Direction Marketing → décision Direction — le routage saute les étapes au niveau du demandeur."],
        args: { id: hit.id, productManagerId: pmId },
        successMessage: `« ${hit.name} » soumis au circuit de prise en charge.`,
        link: `/events/${hit.id}`, revalidate: ["/events"],
      };
    },
    execute: (args) => runFd(submitEventForApproval, args, "La soumission a été refusée.", { revalidate: ["/events"] }),
  },

  add_registration: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const hit = await resolveEvent(opStr(input, "target") || opStr(input, "name"));
      if ("error" in hit) return hit;
      const full = opStr(input, "person").trim();
      if (!full) return { error: "Précisez la personne (champ « person » — prénom et nom)." };
      const parts = full.split(/\s+/);
      const firstName = parts.length > 1 ? parts[0] : full;
      const lastName = parts.length > 1 ? parts.slice(1).join(" ") : full;
      const role = enumIn(opStr(input, "role"), REG_ROLE_FR);
      if (role && typeof role === "object") return role;
      const status = enumIn(opStr(input, "status"), REG_STATUS_FR);
      if (status && typeof status === "object") return status;
      return {
        title: `Inscrire ${full} à « ${hit.name} »`,
        fields: fieldsOf([
          ["Événement", hit.name], ["Participant", full],
          ["Rôle", role ? REG_ROLE_FR.find(([c]) => c === role)?.[1] ?? null : null],
          ["Statut", status ? REG_STATUS_FR.find(([c]) => c === status)?.[1] ?? null : "Confirmé (défaut)"],
          ["Spécialité", opStr(input, "specialty") || null],
          ["Établissement", opStr(input, "institution") || null],
        ]),
        args: {
          eventId: hit.id, firstName, lastName,
          specialty: opStr(input, "specialty") || null, institution: opStr(input, "institution") || null,
          city: opStr(input, "city") || null, email: opStr(input, "email") || null, phone: opStr(input, "phone") || null,
          role: (role as string | null), status: (status as string | null), comment: opStr(input, "notes") || null,
        },
        successMessage: `${full} inscrit·e à « ${hit.name} ».`,
        revalidate: ["/events"],
      };
    },
    execute: (args) => runFd(addRegistration, args, "L'inscription a été refusée.", { revalidate: ["/events"] }),
  },

  set_registration_status: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const hit = await resolveEvent(opStr(input, "target") || opStr(input, "name"));
      if ("error" in hit) return hit;
      const reg = await resolveRegistration(hit.id, hit.name, opStr(input, "person"));
      if ("error" in reg) return reg;
      const status = enumIn(opStr(input, "status"), REG_STATUS_FR);
      if (!status) return { error: "Précisez le statut (champ « status ») : inscrit, confirmé, refusé, présent, absent, annulé." };
      if (typeof status === "object") return status;
      return {
        title: `${reg.name} → ${REG_STATUS_FR.find(([c]) => c === status)?.[1] ?? status} (${hit.name})`,
        fields: [
          { label: "Participant", value: `${reg.name} — ${hit.name}` },
          { label: "Statut", value: REG_STATUS_FR.find(([c]) => c === status)?.[1] ?? status },
        ],
        args: { id: reg.id, status },
        successMessage: `${reg.name} marqué·e « ${REG_STATUS_FR.find(([c]) => c === status)?.[1] ?? status} ».`,
        revalidate: ["/events"],
      };
    },
    execute: (args) => runFd(setRegistrationStatus, args, "Le changement de statut a été refusé.", { revalidate: ["/events"] }),
  },

  delete_registration: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const hit = await resolveEvent(opStr(input, "target") || opStr(input, "name"));
      if ("error" in hit) return hit;
      const reg = await resolveRegistration(hit.id, hit.name, opStr(input, "person"));
      if ("error" in reg) return reg;
      return {
        title: `Retirer ${reg.name} de « ${hit.name} »`,
        fields: [{ label: "Participant", value: `${reg.name} — ${hit.name}` }],
        warnings: ["L'inscription est supprimée (pas seulement annulée)."],
        args: { id: reg.id },
        successMessage: `${reg.name} retiré·e de « ${hit.name} ».`,
        revalidate: ["/events"],
      };
    },
    execute: (args) => runFd(deleteRegistration, args, "Le retrait de l'inscription a été refusé.", { revalidate: ["/events"] }),
  },
};
