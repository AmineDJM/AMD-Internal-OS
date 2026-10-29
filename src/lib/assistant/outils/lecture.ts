/**
 * L'EXÉCUTEUR DES OUTILS DE LECTURE — exécutés automatiquement pendant la boucle, ils ne
 * renvoient que des données déjà visibles par l'utilisateur (scopes RBAC).
 */

import {
  prisma, recordAudit, getMailAccount, listMessages, getMessage, userCan, accessibleModules, scopeMedicalDoctors,
  scopeAdminRequests, type CurrentUser, getAppSettings,
} from "@/lib/assistant/coeur/erp";
import { resultatVide } from "@/platform/ia/lectures/empty-result";
import { actionsForUser } from "@/lib/assistant/action-registry";
import { executePowerTool } from "@/lib/assistant/power-tools";
// Les lectures partagées avec l'Assistant IA (`read_workflow`, `list_my_tasks`, `search_products`) vivent au socle.
import { executerLecturePartagee } from "@/platform/ia/outils/partages";
import { verdictEmpreinte } from "@/lib/mutations/empreinte";
import {
  ROLE_LABELS, ADMIN_REQUEST_TYPE, ADMIN_REQUEST_STATUS, MEDICAL_SECTOR, INFLUENCE_LEVEL,
  EVENT_STATUS, EVENT_TYPE, doctorDisplayName,
} from "@/lib/labels";
import { DATASETS, isExportDataset, exportDatasetToDrive } from "@/lib/assistant/exports";
import { WRITABLE_SETTINGS } from "@/lib/assistant/admin-write";
import { MODULE_FR } from "@/lib/assistant/outils/catalogue-lecture";
import { asStr, asNum, findPeople } from "@/platform/ia/outils/arguments";

// ───────────────────────────── Exécuteurs d'outils de lecture ─────────────────────────────

export async function executeReadTool(name: string, input: Record<string, unknown>, user: CurrentUser, demande?: string): Promise<string> {
  /**
   * ── L'EMPREINTE VAUT AUSSI POUR LES OUTILS QU'ON EXÉCUTE SANS CARTE ───────────────────
   *
   * `artifact_edit` n'est pas une écriture ERP : il modifie le document OUVERT, la retouche est
   * réversible d'un `annuler`, et c'est pourquoi il part sans confirmation. Mais « change la
   * cellule B12 » suivi de `xlsx.supprimer_ligne` détruit douze cellules sur une demande qui en
   * visait une — la même faute que « retire son e-mail » suivi de la suppression de la personne
   * (§104.7 le dit déjà pour les documents : modifier le mauvais paragraphe en annonçant que
   * c'est fait est le défaut le plus coûteux de tout ce système).
   *
   * `demande` est OPTIONNEL, et c'est délibéré : les appelants qui n'ont pas de phrase humaine
   * (une étape de mission, une compétence, une situation) passent `undefined`, la règle est
   * muette, et rien ne change pour eux.
   */
  if (demande) {
    const emp = verdictEmpreinte(demande, name, undefined, input);
    if (!emp.ok) return JSON.stringify({ fait: false, refus: emp.refus });
  }

  // Outils de POUVOIR (budget, finances, RH, file de décisions) : le droit est revérifié
  // à l'exécution — la liste envoyée au modèle est une suggestion, pas une autorisation.
  const power = await executePowerTool(name, input, user);
  if (power !== null) return power;

  switch (name) {
    case "search_people": {
      const people = await findPeople(asStr(input, "query"));
      if (people.length === 0) return resultatVide("Aucun collègue trouvé pour cette recherche.");
      return JSON.stringify(people.map((p) => ({ id: p.id, nom: p.name, fonction: p.title, departement: p.department, role: ROLE_LABELS[p.role] ?? p.role })));
    }
    case "read_workflow":
      return executerLecturePartagee(name, input, user);
    case "find_available_actions": {
      // Le REGISTRE réel filtré par les droits — jamais une liste inventée. Chaque entrée dit
      // le bouton d'écran, l'outil à appeler, le risque et la sémantique (effet, réversibilité).
      const moduleQuery = asStr(input, "module");
      const actions = actionsForUser(user, moduleQuery || undefined);
      if (actions.length === 0) {
        return JSON.stringify({
          actionsNatives: [],
          note: `Aucune action native ${moduleQuery ? `du module « ${moduleQuery} » ` : ""}ouverte à ce compte dans le registre. Les replis restent disponibles : create_task (déléguer un travail), create_admin_request (dernier recours), send_message.`,
        });
      }
      return JSON.stringify({
        actionsNatives: actions.map((a) => ({
          bouton: a.uiLabel, module: a.module,
          outil: a.toolOp ? `${a.toolName} (op « ${a.toolOp} »)` : a.toolName,
          risque: a.risk,
          semantique: a.summary, ...(a.gateNote ? { ouverture: a.gateNote } : {}),
        })),
        regle: "Si l'une de ces actions correspond à l'intention, l'utiliser — JAMAIS une demande générique à la place d'un bouton métier existant.",
      });
    }
    case "my_overview": {
      const [openTasks, openRequests, unread] = await Promise.all([
        prisma.task.count({ where: { assignedToId: user.id, status: { in: ["TODO", "IN_PROGRESS"] } } }),
        prisma.administrativeRequest.count({ where: { AND: [scopeAdminRequests(user), { status: { notIn: ["DONE", "CANCELLED"] } }] } }),
        prisma.notification.count({ where: { userId: user.id, isRead: false } }),
      ]);
      const mods = accessibleModules(user).map((m) => MODULE_FR[m]).filter(Boolean);
      return JSON.stringify({ tachesOuvertes: openTasks, demandesEnCours: openRequests, notificationsNonLues: unread, modulesAccessibles: mods });
    }
    case "list_my_tasks":
      return executerLecturePartagee(name, input, user);
    case "list_my_requests": {
      const reqs = await prisma.administrativeRequest.findMany({
        where: scopeAdminRequests(user),
        select: { reference: true, title: true, type: true, status: true, assignedTo: { select: { name: true } } },
        orderBy: { createdAt: "desc" },
        take: 12,
      });
      if (reqs.length === 0) return resultatVide("Aucune demande administrative.");
      return JSON.stringify(reqs.map((r) => ({
        reference: r.reference, titre: r.title, type: ADMIN_REQUEST_TYPE[r.type] ?? r.type,
        statut: ADMIN_REQUEST_STATUS[r.status]?.label ?? r.status, responsable: r.assignedTo?.name ?? null,
      })));
    }
    case "search_doctors": {
      if (!userCan(user, "MEDICAL", "VIEW")) return "Accès non autorisé au module Annuaire.";
      const q = asStr(input, "query");
      const doctors = await prisma.medicalDoctor.findMany({
        where: {
          AND: [
            scopeMedicalDoctors(user),
            q ? { OR: [{ name: { contains: q, mode: "insensitive" } }, { specialty: { contains: q, mode: "insensitive" } }, { institution: { contains: q, mode: "insensitive" } }] } : {},
          ],
        },
        select: { name: true, title: true, specialty: true, sector: true, institution: true, city: true, influenceLevel: true },
        take: 12, orderBy: { name: "asc" },
      });
      if (doctors.length === 0) return resultatVide("Aucun médecin trouvé (ne pas inventer : signaler à l'utilisateur que le médecin est introuvable dans son périmètre).");
      return JSON.stringify(doctors.map((d) => ({
        nom: doctorDisplayName(d), specialite: d.specialty ?? null, secteur: MEDICAL_SECTOR[d.sector]?.label ?? d.sector,
        etablissement: d.institution ?? null, ville: d.city ?? null, influence: INFLUENCE_LEVEL[d.influenceLevel]?.label ?? d.influenceLevel,
      })));
    }
    case "search_products":
      return executerLecturePartagee(name, input, user);
    case "search_events": {
      if (!userCan(user, "EVENTS", "VIEW")) return "Accès non autorisé au module Events.";
      const q = asStr(input, "query");
      const events = await prisma.event.findMany({
        where: q ? { OR: [{ name: { contains: q, mode: "insensitive" } }, { city: { contains: q, mode: "insensitive" } }] } : {},
        select: { name: true, type: true, status: true, startDate: true, city: true, _count: { select: { registrations: true } } },
        take: 12, orderBy: { startDate: "desc" },
      });
      if (events.length === 0) return resultatVide("Aucun événement trouvé.");
      return JSON.stringify(events.map((e) => ({
        nom: e.name, type: EVENT_TYPE[e.type] ?? e.type, statut: EVENT_STATUS[e.status]?.label ?? e.status,
        date: e.startDate?.toISOString().slice(0, 10) ?? null, ville: e.city ?? null, inscrits: e._count.registrations,
      })));
    }
    case "list_emails": {
      const account = await getMailAccount(user.id);
      if (!account) return "Aucune boîte mail connectée. L'utilisateur peut connecter sa boîte dans le module Courrier.";
      const limit = Math.min(typeof input.limit === "number" ? input.limit : 15, 30);
      try {
        const msgs = await listMessages(account, "INBOX", limit);
        if (msgs.length === 0) return "Boîte de réception vide.";
        return JSON.stringify(msgs.map((m) => ({
          uid: m.uid, de: m.from || m.fromAddr, adresse: m.fromAddr, objet: m.subject,
          date: m.date ? m.date.slice(0, 16).replace("T", " ") : null, lu: m.seen,
        })));
      } catch (e) {
        return `Impossible de lire la boîte mail : ${(e as Error)?.message ?? "erreur de connexion"}.`;
      }
    }
    case "read_email": {
      const account = await getMailAccount(user.id);
      if (!account) return "Aucune boîte mail connectée.";
      const uid = typeof input.uid === "number" ? input.uid : Number(asStr(input, "uid"));
      if (!Number.isFinite(uid)) return "uid manquant ou invalide (l'obtenir d'abord via list_emails).";
      try {
        const msg = await getMessage(account, "INBOX", uid);
        if (!msg) return "E-mail introuvable.";
        const content = (msg.text || (msg.html ? msg.html.replace(/<[^>]+>/g, " ") : "") || "").replace(/\s+/g, " ").trim().slice(0, 4000);
        return JSON.stringify({
          de: msg.from || msg.fromAddr, adresse: msg.fromAddr, a: msg.to, objet: msg.subject,
          date: msg.date, contenu: content, piecesJointes: msg.attachments.map((a) => a.filename),
        });
      } catch (e) {
        return `Impossible de lire l'e-mail : ${(e as Error)?.message ?? "erreur de connexion"}.`;
      }
    }
    case "list_accounts": {
      if (user.role !== "SUPER_ADMIN") return "Accès réservé au Super Admin.";
      const q = asStr(input, "query");
      const [users, openTasks, openReqs] = await Promise.all([
        prisma.user.findMany({
          where: q ? { OR: [{ name: { contains: q, mode: "insensitive" } }, { title: { contains: q, mode: "insensitive" } }] } : {},
          select: { id: true, name: true, role: true, title: true, isActive: true },
          orderBy: { name: "asc" }, take: 100,
        }),
        prisma.task.groupBy({ by: ["assignedToId"], where: { status: { in: ["TODO", "IN_PROGRESS"] } }, _count: true }),
        prisma.administrativeRequest.groupBy({ by: ["assignedToId"], where: { status: { notIn: ["DONE", "CANCELLED"] } }, _count: true }),
      ]);
      const taskMap = new Map(openTasks.map((t) => [t.assignedToId, t._count]));
      const reqMap = new Map(openReqs.map((r) => [r.assignedToId, r._count]));
      if (users.length === 0) return resultatVide("Aucun compte trouvé.");
      return JSON.stringify(users.map((u) => ({
        nom: u.name, fonction: u.title ?? (ROLE_LABELS[u.role] ?? u.role), role: ROLE_LABELS[u.role] ?? u.role,
        actif: u.isActive, tachesOuvertes: taskMap.get(u.id) ?? 0, demandesACharge: reqMap.get(u.id) ?? 0,
      })));
    }
    case "read_platform_settings": {
      if (user.role !== "SUPER_ADMIN") return "Accès réservé au Super Admin.";
      const s = await getAppSettings();
      // On rend les LIBELLÉS en plus des codes : sans eux, le modèle propose « HEAD_OF_REGULATORY »
      // à un humain qui a dit « le responsable réglementaire », et la carte de confirmation
      // devient illisible.
      return JSON.stringify({
        reglages: s,
        libellesRoles: ROLE_LABELS,
        modifiables: WRITABLE_SETTINGS.map((w) => ({ cle: w.key, libelle: w.label, type: w.kind, apropos: w.hint })),
      });
    }
    case "export_excel": {
      const dataset = asStr(input, "dataset");
      if (!isExportDataset(dataset)) {
        return `Jeu de données inconnu. Disponibles : ${Object.keys(DATASETS).join(", ")}.`;
      }
      const r = await exportDatasetToDrive(user, dataset, { limit: asNum(input, "limit") ?? undefined });
      if (!r.ok) return r.error ?? "Export impossible.";
      await recordAudit({
        actorId: user.id, action: "EXPORT", module: "Assistant IA",
        summary: `Export « ${DATASETS[dataset].label} » (${r.count} ligne(s)) via l'assistant → Drive / ${r.filename}`,
      });
      return JSON.stringify({
        fichier: r.filename, lignes: r.count,
        emplacement: "Drive personnel, dossier « Exports IA »",
        lien: `/drive/${r.nodeId}`,
      });
    }
    default:
      return `Outil inconnu : ${name}.`;
  }
}
