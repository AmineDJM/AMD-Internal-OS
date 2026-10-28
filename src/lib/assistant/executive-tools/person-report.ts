import type { PowerTool } from "@/lib/assistant/power-tools";
import { prisma } from "./dependances";
import { ROLE_LABELS } from "@/lib/labels";
import { geste } from "@/lib/assistant/workspace/emit";
import { EXEC, str, fr } from "./commun";

/**
 * OUTILS EXÉCUTIFS — le BILAN FACTUEL du travail d'une personne (`person_report`).
 *
 * Morceau de `EXECUTIVE_TOOLS` (`../executive-tools.ts`), recomposé dans l'ordre d'origine : l'ordre
 * des outils fait partie du prompt de l'IA.
 */
export const OUTILS_PERSON_REPORT: PowerTool[] = [
  {
    def: {
      name: "person_report",
      description:
        "Le BILAN FACTUEL du travail d'une personne : tâches (ouvertes, terminées, en retard), demandes déposées, validations rendues, " +
        "activité récente. FAITS et MÉTRIQUES seulement — jamais de jugement : la conclusion appartient au lecteur. " +
        "À utiliser pour « fais-moi un bilan du travail de X », « qui est en retard sur quoi ? ».",
      input_schema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Nom (ou fragment) de la personne." },
          months: { type: "number", description: "Fenêtre en mois (défaut 3)." },
        },
        required: ["name"],
      },
    },
    allowed: EXEC,
    label: "Bilan d'une personne",
    run: async (input, user) => {
      void user;
      const name = str(input, "name");
      if (name.length < 2) return "Donnez le nom de la personne.";
      const months = Math.min(12, Math.max(1, Number(input.months) || 3));
      const since = new Date(Date.now() - months * 30 * 86_400_000);

      const person = await prisma.user.findFirst({
        where: { name: { contains: name, mode: "insensitive" }, isActive: true },
        select: { id: true, name: true, role: true },
      });
      if (!person) {
        // §118.20 : un plan qui référence `personne` ne meurt pas parce que le nom est inconnu.
        return JSON.stringify({
          personne: null, retenu: [], candidats: [],
          precision: `Aucun compte actif ne porte le nom « ${name} ».`,
        });
      }

      const now = new Date();
      const [emp, tasksOpen, tasksDone, tasksLate, requests, validationsDecided, auditCount, lastAudit] = await Promise.all([
        prisma.employee.findFirst({
          where: { userId: person.id },
          select: { fullName: true, position: true, departmentRef: { select: { name: true } }, manager: { select: { fullName: true } } },
        }),
        prisma.task.count({ where: { assignedToId: person.id, status: { notIn: ["DONE", "CANCELLED"] } } }),
        prisma.task.count({ where: { assignedToId: person.id, status: "DONE", updatedAt: { gte: since } } }),
        prisma.task.findMany({
          where: { assignedToId: person.id, status: { notIn: ["DONE", "CANCELLED"] }, dueDate: { lt: now } },
          // LA PREUVE VOYAGE AVEC LE RETARD. Sans elle, « en retard » est vrai au sens du champ
          // `status` et faux au sens de l'entreprise — le contrat de la consultante AVAIT été
          // déposé, personne n'avait coché la tâche, et Adam a annoncé un retard qui n'en était
          // pas un. Le rapprochement est fait en amont par le registre d'événements ; ici, on se
          // contente de ne pas le perdre en route.
          select: { title: true, dueDate: true, evidenceAt: true, evidenceNote: true },
          orderBy: { dueDate: "asc" }, take: 10,
        }),
        prisma.administrativeRequest.count({ where: { requesterId: person.id, createdAt: { gte: since } } }),
        prisma.validationStep.count({ where: { validatorId: person.id, decidedAt: { gte: since } } }),
        prisma.auditLog.count({ where: { actorId: person.id, createdAt: { gte: since } } }),
        prisma.auditLog.findFirst({ where: { actorId: person.id }, orderBy: { createdAt: "desc" }, select: { createdAt: true, summary: true } }),
      ]);

      return JSON.stringify({
        personne: person.name,
        role: ROLE_LABELS[person.role] ?? person.role,
        poste: emp?.position ?? null,
        departement: emp?.departmentRef?.name ?? null,
        responsable: emp?.manager?.fullName ?? null,
        fenetre: `${months} mois`,
        faits: {
          tachesOuvertes: tasksOpen,
          tachesTermineesSurLaFenetre: tasksDone,
          tachesEnRetard: tasksLate.map((t) => ({
            titre: t.title,
            echeance: t.dueDate ? fr(t.dueDate) : null,
            // Renseigné SEULEMENT quand une preuve existe : un champ à `null` partout habituerait
            // le modèle à l'ignorer, et il ne le lirait plus le jour où il compte.
            ...(t.evidenceAt
              ? {
                  geste_deja_accompli: {
                    le: fr(t.evidenceAt),
                    quoi: t.evidenceNote,
                    aDire:
                      "La tâche est encore marquée à faire, MAIS le geste attendu a été accompli. "
                      + "Dire les DEUX : le statut n'a pas été mis à jour. Ne pas annoncer un retard sec.",
                  },
                }
              : {}),
          })),
          demandesDeposees: requests,
          validationsRendues: validationsDecided,
          actionsAuJournal: auditCount,
          derniereActivite: lastAudit ? { le: fr(lastAudit.createdAt), quoi: lastAudit.summary } : "aucune trace au journal",
        },
        rappel: "Faits et métriques uniquement — les retards peuvent tenir à des dépendances externes : vérifier avant de conclure.",
      });
    },
  },
];
