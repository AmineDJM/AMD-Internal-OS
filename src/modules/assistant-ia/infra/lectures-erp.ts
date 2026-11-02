import { prisma } from "@/lib/prisma";
import type { PowerTool } from "@/platform/ia/outil";
import type { CurrentUser } from "@/lib/session";
import { accessibleModules, scopeAdminRequests, scopeRegulatory, userCan } from "@/lib/rbac";
import { ADMIN_REQUEST_STATUS, ADMIN_REQUEST_TYPE, MODULE_LABELS, PRIORITY, REGULATORY_STATUS, TASK_STATUS } from "@/lib/labels";
import { searchEverything } from "@/lib/queries/search-everything";
import { algiersInputToUtc, getCalendarEvents, getUpcomingEvents } from "@/lib/calendar";
import { getActionCenter } from "@/lib/queries/action-center";
import { resultatVide } from "@/platform/ia/lectures/empty-result";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES LECTURES TRANSVERSES DE L'ASSISTANT IA — les siennes (lot J6, décision 0020).
 *
 * Jusqu'à J6, l'Assistant IA empruntait ces lectures au catalogue d'Adam (`executeReadTool`, `executePowerTool`) —
 * le dernier couplage de la frontière (`platform/ia/frontieres.test.ts`, `RESIDUS`). Aucune action serveur ne les
 * porte (elles lisent, et un travail de fond les appelle sans session) : ce sont donc des outils PROPRES au module,
 * qui lisent l'ERP par ses requêtes d'écran, sous la portée de la personne — les mêmes noms qu'avant, pour la
 * sélection, les règles de la consigne et la configuration des rôles.
 *
 *   • list_my_tasks, list_my_requests, my_overview — SES tâches, SES demandes administratives (portée de l'écran),
 *     son aperçu ;
 *   • search_products — le catalogue Regulatory sous `scopeRegulatory` ;
 *   • search_everything — la recherche fédérée de l'ERP (`queries/search-everything`), Drive compris ;
 *   • read_calendar — l'agenda de l'ERP, un jour, une période ou la suite ;
 *   • list_pending_decisions — ce qui attend SA décision (`queries/action-center`, congés compris).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const texte = (e: Record<string, unknown>, k: string): string => (typeof e[k] === "string" ? (e[k] as string).trim() : "");
const nombre = (e: Record<string, unknown>, k: string, defaut: number, min: number, max: number): number => {
  const n = typeof e[k] === "number" ? (e[k] as number) : Number(e[k]);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.max(Math.round(n), min), max) : defaut;
};
const ymd = (d: Date | null | undefined): string | null => (d ? d.toISOString().slice(0, 10) : null);
const libelle = (table: Record<string, unknown>, cle: string): string => {
  const v = table[cle];
  return typeof v === "string" ? v : v && typeof v === "object" && "label" in v ? String((v as { label: unknown }).label) : cle;
};
const AAAAMMJJ = /^\d{4}-\d{2}-\d{2}$/;

function outil(name: string, description: string, properties: Record<string, unknown>, label: string,
  ouvert: (u: CurrentUser) => boolean, run: PowerTool["run"]): PowerTool {
  return { def: { name, description, input_schema: { type: "object", properties } } as PowerTool["def"], allowed: ouvert, label, run };
}

export function lecturesErp(user: CurrentUser): PowerTool[] {
  const aSoi = (u: CurrentUser) => u.id === user.id;
  return [
    outil("list_my_tasks", "Liste MES tâches (assignées à moi ou créées par moi), en cours par défaut : titre, statut, priorité, échéance, assigné.",
      { includeDone: { type: "boolean", description: "Inclure les tâches terminées." } }, "Tâches consultées", aSoi,
      async (e, u) => {
        const lignes = await prisma.task.findMany({
          where: { OR: [{ assignedToId: u.id }, { createdById: u.id }], ...(e.includeDone === true ? {} : { status: { in: ["TODO", "IN_PROGRESS"] } }) },
          orderBy: [{ dueDate: "asc" }, { createdAt: "desc" }], take: 20,
          select: { id: true, title: true, status: true, priority: true, dueDate: true, assignedTo: { select: { name: true } } },
        });
        if (!lignes.length) return resultatVide("Aucune tâche.");
        return JSON.stringify(lignes.map((t) => ({
          tache: t.title, statut: libelle(TASK_STATUS, t.status), priorite: libelle(PRIORITY, t.priority), echeance: ymd(t.dueDate),
          assignee: t.assignedTo?.name ?? null, lien: `/mon-espace/taches?tache=${t.id}`,
        })));
      }),

    outil("list_my_requests", "Liste les DEMANDES ADMINISTRATIVES que je vois (les miennes, ou celles de mon périmètre) : référence, titre, type, statut, responsable.",
      {}, "Demandes consultées", aSoi,
      async (_e, u) => {
        const lignes = await prisma.administrativeRequest.findMany({
          where: scopeAdminRequests(u), orderBy: { createdAt: "desc" }, take: 12,
          select: { reference: true, title: true, type: true, status: true, assignedTo: { select: { name: true } } },
        });
        if (!lignes.length) return resultatVide("Aucune demande administrative.");
        return JSON.stringify(lignes.map((r) => ({
          ref: r.reference, demande: r.title, nature: libelle(ADMIN_REQUEST_TYPE, r.type), etat: libelle(ADMIN_REQUEST_STATUS, r.status), suivi: r.assignedTo?.name ?? null,
        })));
      }),

    outil("my_overview", "Mon APERÇU : tâches ouvertes, demandes en cours, notifications non lues, modules auxquels j'ai accès.",
      {}, "Vue d'ensemble consultée", aSoi,
      async (_e, u) => {
        const [taches, demandes, nonLues] = await Promise.all([
          prisma.task.count({ where: { assignedToId: u.id, status: { in: ["TODO", "IN_PROGRESS"] } } }),
          prisma.administrativeRequest.count({ where: { AND: [scopeAdminRequests(u), { status: { notIn: ["DONE", "CANCELLED"] } }] } }),
          prisma.notification.count({ where: { userId: u.id, isRead: false } }),
        ]);
        return JSON.stringify({ taches, demandes, nonLues, modules: accessibleModules(u).map((m) => MODULE_LABELS[m]).filter(Boolean) });
      }),

    outil("search_products", "Cherche dans le CATALOGUE Regulatory (produits et dossiers que je vois) : DCI, marque, référence, classe thérapeutique, forme, laboratoire, société. Sans `query` : l'inventaire.",
      {
        query: { type: "string", description: "Mot cherché (DCI, marque, référence, classe…)." },
        limit: { type: "number", description: "Nombre de lignes (défaut 40, max 300)." },
      }, "Catalogue consulté", (u) => aSoi(u) && userCan(u, "REGULATORY", "VIEW"),
      async (e, u) => {
        if (!userCan(u, "REGULATORY", "VIEW")) return "Le module Regulatory ne vous est pas ouvert.";
        const q = texte(e, "query");
        const contient = { contains: q, mode: "insensitive" as const };
        const champs = ["dci", "brandName", "reference", "therapeuticClass", "pharmaceuticalForm", "partnerLab", "countryOfOrigin"] as const;
        const produits = await prisma.regulatoryProduct.findMany({
          where: { AND: [scopeRegulatory(u), q ? { OR: [...champs.map((c) => ({ [c]: contient })), { company: { is: { OR: [{ name: contient }, { shortName: contient }] } } }] } : {}] },
          orderBy: { createdAt: "desc" }, take: nombre(e, "limit", 40, 1, 300),
          select: {
            id: true, reference: true, dci: true, brandName: true, status: true, priority: true, therapeuticClass: true,
            company: { select: { shortName: true, name: true } }, responsible: { select: { name: true } },
          },
        });
        if (!produits.length) return resultatVide(q ? `Aucun produit « ${q} » dans votre périmètre Regulatory.` : "Aucun produit dans votre périmètre Regulatory.");
        return JSON.stringify(produits.map((p) => ({
          id: p.id, ref: p.reference, dci: p.dci, marque: p.brandName, statut: libelle(REGULATORY_STATUS, p.status), priorite: p.priority,
          classe: p.therapeuticClass, societe: p.company?.shortName ?? p.company?.name ?? null, responsable: p.responsible?.name ?? null,
        })));
      }),

    outil("search_everything", "RECHERCHE dans TOUT l'ERP en un appel (produits, dossiers, personnes, tâches, paiements, documents Legal, courriers, factures, fournisseurs, Drive, agenda, congrès…), sous mes droits. Un terme sans résultat : réessayer avec un synonyme ou un fragment.",
      { query: { type: "string", description: "Ce qu'on cherche : un nom, une référence, un fragment." } }, "Recherche effectuée", aSoi,
      async (e, u) => {
        const q = texte(e, "query");
        if (q.length < 2) return "Donnez au moins deux caractères.";
        return JSON.stringify(await searchEverything(u, q));
      }),

    outil("read_calendar", "Lit l'AGENDA de l'ERP : `date` (AAAA-MM-JJ) pour un jour, `du` + `au` pour une période (passée ou future), rien pour les prochains événements. Heures d'Alger.",
      {
        date: { type: "string", description: "Un jour, AAAA-MM-JJ." },
        du: { type: "string", description: "Début de période, AAAA-MM-JJ (inclus)." },
        au: { type: "string", description: "Fin de période, AAAA-MM-JJ (incluse)." },
      }, "Calendrier consulté", (u) => aSoi(u) && userCan(u, "WORKSPACE", "VIEW"),
      async (e, u) => {
        const debutDe = (j: string) => (AAAAMMJJ.test(j) ? algiersInputToUtc(`${j}T00:00`) : null);
        const [date, du, au] = [texte(e, "date"), texte(e, "du"), texte(e, "au")];
        let evenements;
        if (du || au) {
          const a = debutDe(du);
          const b = debutDe(au);
          if (!a || !b) return "Période illisible : donnez `du` ET `au` (AAAA-MM-JJ).";
          if (b < a) return "Période vide : « au » précède « du ».";
          if (b.getTime() - a.getTime() > 400 * 86_400_000) return "Période trop large : 400 jours au plus.";
          evenements = await getCalendarEvents(u, a, new Date(b.getTime() + 86_400_000));
        } else if (date) {
          const a = debutDe(date);
          if (!a) return "Date illisible (AAAA-MM-JJ).";
          evenements = await getCalendarEvents(u, a, new Date(a.getTime() + 86_400_000));
        } else {
          evenements = await getUpcomingEvents(u, 8);
        }
        if (!evenements.length) return resultatVide("Aucun événement dans l'agenda de l'ERP sur cette période (une absence constatée, pas une source indisponible).");
        let minutes = 0;
        const lus = evenements.slice(0, 60).map((ev) => {
          const fin = ev.endAt ? new Date(ev.endAt).getTime() : null;
          const duree = fin && fin > new Date(ev.startAt).getTime() ? Math.round((fin - new Date(ev.startAt).getTime()) / 60_000) : null;
          if (duree && !ev.source) minutes += duree;
          return {
            quoi: ev.title, le: ev.ymd, a: ev.timeLabel || "journée entière", minutes: duree, ou: ev.location,
            par: ev.organizerName, avec: ev.invitees.map((i) => i.name), visio: ev.meetLink, lien: ev.source?.href ?? "/calendar",
          };
        });
        return JSON.stringify({ evenements: evenements.length, heuresDeReunion: Math.round((minutes / 60) * 100) / 100, detail: lus });
      }),

    outil("list_pending_decisions", "Ce qui attend MA décision ou mon action, tous modules confondus (validations, dossiers, demandes, congés à trancher…) : module, statut, échéance, lien.",
      { limit: { type: "number", description: "Nombre de lignes (défaut 25, max 60)." } }, "Validations en attente consultées", aSoi,
      async (e, u) => {
        const centre = await getActionCenter(u);
        const lignes = centre.items.slice(0, nombre(e, "limit", 25, 1, 60));
        if (!lignes.length) return resultatVide("Rien n'attend votre décision pour l'instant.");
        return JSON.stringify({
          total: centre.items.length,
          aTrancher: lignes.map((i) => ({
            objet: i.title, precision: i.subtitle, module: i.module, etat: i.statusLabel, avant: i.deadline?.slice(0, 10) ?? null, lien: i.href,
            ...(i.actions?.length ? { gestes: i.actions } : {}),
          })),
        });
      }),
  ];
}
