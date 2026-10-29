/**
 * L'EXÉCUTEUR DES OUTILS DE LECTURE — exécutés automatiquement pendant la boucle, ils ne
 * renvoient que des données déjà visibles par l'utilisateur (scopes RBAC).
 */

import {
  prisma, recordAudit, getMailAccount, listMessages, getMessage, userCan, accessibleModules, scopeMedicalDoctors,
  scopeRegulatory, scopeAdminRequests, type CurrentUser, getAppSettings,
} from "@/lib/assistant/coeur/erp";
import { resultatListe, resultatVide } from "@/platform/ia/lectures/empty-result";
// Les demandes Ad & Pro, le secrétariat et les circuits : par le pont (frontière Adam ↔ ERP).
import {
  WORKFLOW_CATEGORIES, CATEGORY_LABELS, SCOPE_LABELS, POWER_LABELS, ACTOR_SCOPES, WORKFLOW_POWERS,
} from "@/platform/in-process/demandes";
import { actionsForUser } from "@/lib/assistant/action-registry";
import { readWorkflowState, resolveWorkflowCategory } from "@/platform/ia/lectures/workflow-admin";
import { executePowerTool } from "@/lib/assistant/power-tools";
import { verdictEmpreinte } from "@/lib/mutations/empreinte";
import {
  ROLE_LABELS, TASK_STATUS, PRIORITY, ADMIN_REQUEST_TYPE, ADMIN_REQUEST_STATUS, MEDICAL_SECTOR, INFLUENCE_LEVEL,
  REGULATORY_STATUS, EVENT_STATUS, EVENT_TYPE, doctorDisplayName,
} from "@/lib/labels";
import { DATASETS, isExportDataset, exportDatasetToDrive } from "@/lib/assistant/exports";
import { WRITABLE_SETTINGS } from "@/lib/assistant/admin-write";
import { sansBloquer } from "@/lib/journal";
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
    case "read_workflow": {
      const cat = resolveWorkflowCategory(asStr(input, "category"));
      if (!cat) {
        return `Catégorie inconnue. Circuits configurables : ${WORKFLOW_CATEGORIES.map((c) => `${c} (${CATEGORY_LABELS[c]})`).join(", ")}. Les autres circuits de l'ERP sont codés en dur.`;
      }
      const state = await readWorkflowState(cat);
      return JSON.stringify({
        categorie: state.category,
        libelle: state.categoryLabel,
        nomDuCircuit: state.name,
        actif: state.isActive,
        etapes: state.steps ?? "Circuit PAR DÉFAUT (aucune personnalisation enregistrée) — la première sauvegarde via configure_workflow créera la définition.",
        dictionnaires: {
          portees: Object.fromEntries(ACTOR_SCOPES.map((s) => [s, SCOPE_LABELS[s]])),
          pouvoirs: Object.fromEntries(WORKFLOW_POWERS.map((p) => [p, POWER_LABELS[p]])),
          rolesValides: ROLE_LABELS,
        },
        regle: "Pour modifier : recomposer la LISTE COMPLÈTE des étapes (slugs existants conservés) et appeler configure_workflow — remplacement intégral, les demandes en cours gardent leur étape par slug.",
      });
    }
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
    case "list_my_tasks": {
      const includeDone = input.includeDone === true;
      const tasks = await prisma.task.findMany({
        where: {
          OR: [{ assignedToId: user.id }, { createdById: user.id }],
          ...(includeDone ? {} : { status: { in: ["TODO", "IN_PROGRESS"] } }),
        },
        select: { title: true, status: true, priority: true, dueDate: true, assignedTo: { select: { name: true } } },
        orderBy: [{ dueDate: "asc" }, { createdAt: "desc" }],
        take: 20,
      });
      if (tasks.length === 0) return resultatVide("Aucune tâche.");
      return JSON.stringify(tasks.map((t) => ({
        titre: t.title, statut: TASK_STATUS[t.status]?.label ?? t.status, priorite: PRIORITY[t.priority]?.label ?? t.priority,
        echeance: t.dueDate?.toISOString().slice(0, 10) ?? null, assigneA: t.assignedTo?.name ?? null,
      })));
    }
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
    case "search_products": {
      if (!userCan(user, "REGULATORY", "VIEW")) return "Accès non autorisé au module Regulatory.";
      const q = asStr(input, "query");
      // Un inventaire complet doit être possible : « donne-moi tous les produits » échouait
      // parce que la recherche s'arrêtait à 12 lignes et ne regardait que DCI / nom / référence.
      const rawLimit = Number(input.limit);
      const take = Math.min(Math.max(Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 40, 1), 300);
      const category = asStr(input, "category");
      const withoutCompany = input.withoutCompany === true;

      const like = (field: string) => ({ [field]: { contains: q, mode: "insensitive" as const } });
      const products = await prisma.regulatoryProduct.findMany({
        where: {
          AND: [
            scopeRegulatory(user),
            // La classe thérapeutique porte « oncologie », « biosimilaire », « anticorps
            // monoclonal » : sans elle, ces recherches ne remontaient rien.
            q
              ? {
                  OR: [
                    like("dci"), like("brandName"), like("reference"), like("therapeuticClass"),
                    like("pharmaceuticalForm"), like("partnerLab"), like("countryOfOrigin"),
                    { company: { is: { name: { contains: q, mode: "insensitive" } } } },
                    { company: { is: { shortName: { contains: q, mode: "insensitive" } } } },
                  ],
                }
              : {},
            category === "MEDICINE" || category === "MEDICAL_DEVICE" ? { category } : {},
            withoutCompany ? { companyId: null } : {},
          ],
        },
        select: {
          reference: true, dci: true, brandName: true, status: true, therapeuticClass: true,
          category: true, companyId: true, company: { select: { name: true, shortName: true } },
          // Le responsable et la priorité : sans eux, « un tableau de tous les dossiers avec leur
          // responsable » coûtait une fiche complète (`product_360`) PAR produit — mesuré au banc
          // des défis : sept appels et dix-sept secondes pour sept lignes.
          priority: true, responsible: { select: { name: true } },
        },
        take, orderBy: { createdAt: "desc" },
      });
      const total = await prisma.regulatoryProduct.count({ where: { AND: [scopeRegulatory(user)] } }).catch(sansBloquer("assistant.executeReadTool.regulatoryProduct", products.length));
      if (products.length === 0) {
        // Le compte du PORTEFEUILLE est conservé à part : il dit autre chose que le compte du
        // résultat, et le confondre ferait croire à 69 résultats trouvés.
        return resultatVide(
          `Aucun produit ne correspond${q ? ` à « ${q} »` : ""}. Le portefeuille compte ${total} produit(s) au total (ne pas inventer).`,
          { totalPortefeuille: total },
        );
      }
      // MÊME ENVELOPPE QUE LE CAS VIDE (§118.20) : `items` / `count` / `message` dans les deux,
      // et ce qui est propre au portefeuille à côté. Avant, les deux sorties de cette capacité
      // n'avaient pas une seule clé en commun.
      const lignes = products.map((p) => ({
          reference: p.reference, dci: p.dci, nomCommercial: p.brandName ?? null,
          classeTherapeutique: p.therapeuticClass ?? null,
          categorie: p.category,
          entite: p.company?.shortName ?? p.company?.name ?? null,
          statut: REGULATORY_STATUS[p.status]?.label ?? p.status,
          priorite: p.priority ?? null,
          responsable: p.responsible?.name ?? null,
      }));
      return resultatListe(lignes, `${lignes.length} produit(s) sur un portefeuille de ${total}.`, {
        total_portefeuille: total,
        renvoyes: lignes.length,
        tronque: lignes.length >= take,
        produits: lignes,
        // Une liste coupée qui ne le dit pas devient « les 40 produits » dans la réponse. `null`
        // et non l'absence de clé : `JSON.stringify` efface une clé indéfinie, et une clé qui
        // apparaît selon la donnée est le défaut qu'on répare ici.
        avertissement: lignes.length >= take
          ? `Liste TRONQUÉE à ${take} (portefeuille : ${total}) : pour un inventaire complet, rappeler avec un limit plus grand. Ne jamais présenter une liste tronquée comme complète.`
          : null,
      });
    }
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
