import type { PowerTool } from "@/platform/ia/outil";
import type { CurrentUser } from "@/lib/session";
import { assigneeRegulatoryLoad } from "@/platform/ia/lectures/regulatory-read";
import { regulatoryVisibleWhere } from "@/lib/queries/regulatory-rows";
import { prisma } from "@/lib/prisma";
import { userCan } from "@/lib/rbac";
import { toNumber } from "@/lib/utils";
import { getDepartmentPath } from "@/lib/departments";
import { ROLE_LABELS } from "@/lib/labels";
import { regulatoryExecutiveState } from "@/lib/assistant/executive-state";
import { regProgress, workflowAsSteps, hasWorkflowState, type RegWorkflowState } from "@/lib/regulatory-workflow";
import { sansBloquer } from "@/lib/journal";

/**
 * LES VUES 360° ET LES INSIGHTS ORGANISATIONNELS — comprendre une personne, un produit, un
 * fournisseur, l'organisation ou un processus EN UN APPEL, à partir des données réelles.
 *
 * Quatre règles, héritées de toute la couche exécutive :
 *   • le BACKEND calcule (âge, ancienneté, cycles, médianes) — jamais le modèle de langage ;
 *   • chaque chiffre porte sa PROVENANCE (« fiche RH — date de naissance ») ;
 *   • OBSERVÉ ≠ CONCLU : l'absence de trace ERP n'est PAS l'absence de travail — le travail
 *     hors ERP (terrain, téléphone, réunions) est invisible ici, et l'outil le DIT ;
 *   • ces vues sont des LECTURES composées des mêmes tables que les écrans — jamais une
 *     source de vérité parallèle.
 */

const EXEC = (u: CurrentUser): boolean => u.role === "SUPER_ADMIN" || u.role === "DIRECTION";

const str = (input: Record<string, unknown>, key: string): string =>
  typeof input[key] === "string" ? (input[key] as string).trim() : "";

const DAY = 86_400_000;
const ymd = (d: Date | null | undefined): string | null => (d ? d.toISOString().slice(0, 10) : null);
const dzd = (n: number): number => Math.round(n);

/** Années révolues entre deux dates (calcul calendaire exact, pas une division par 365). */
export function yearsBetween(from: Date, to: Date): number {
  let years = to.getUTCFullYear() - from.getUTCFullYear();
  const anniversaryNotReached =
    to.getUTCMonth() < from.getUTCMonth() ||
    (to.getUTCMonth() === from.getUTCMonth() && to.getUTCDate() < from.getUTCDate());
  if (anniversaryNotReached) years -= 1;
  return years;
}

/** « 3 ans et 5 mois » — l'ancienneté lisible. */
export function tenureLabel(from: Date, to: Date): string {
  const months = Math.max(0, (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth()) - (to.getUTCDate() < from.getUTCDate() ? 1 : 0));
  const y = Math.floor(months / 12);
  const m = months % 12;
  if (y === 0) return `${m} mois`;
  return m === 0 ? `${y} an${y > 1 ? "s" : ""}` : `${y} an${y > 1 ? "s" : ""} et ${m} mois`;
}

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UNE VUE 360 REND TOUJOURS LES MÊMES CLÉS (§118.20) — c'est la VALEUR qui dit l'absence.
 *
 * Les trois vues de ce fichier rendaient QUATRE formes chacune : une PHRASE quand le nom était
 * trop court, une PHRASE quand rien ne correspondait, un objet `{ambigu, candidates}` quand
 * plusieurs fiches correspondaient, et le grand objet quand une seule était trouvée. Le
 * planificateur écrit ses références AVANT de savoir laquelle il obtiendra : `{{p360.fiche}}`
 * meurt sur une homonymie, `{{p360.candidates}}` meurt quand la recherche réussit — et une
 * étape morte coûte une replanification entière.
 *
 * Les clés sont donc l'UNION, toujours présentes : le grand objet à `null` quand il n'y a rien
 * à mettre, `candidats` à vide quand il n'y a pas d'homonymie, et `precision` qui dit toujours
 * ce qui s'est passé. Le supplément — `retenu` — porte la personne ou le produit sur qui AGIR :
 * un élément quand c'est certain, liste VIDE sinon (§118.34). Collapser une liste de plusieurs
 * homonymes choisirait la cible à la place d'un humain.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
function vue360(
  cles: readonly string[],
  r: { retenu?: Record<string, unknown>[]; candidats?: Record<string, unknown>[]; precision: string } & Record<string, unknown>,
): string {
  const socle: Record<string, unknown> = {};
  for (const c of cles) socle[c] = null;
  return JSON.stringify({ ...socle, ...r, retenu: r.retenu ?? [], candidats: r.candidats ?? [], precision: r.precision });
}

const CLES_PERSONNE = ["identite", "contrat", "soldeCongesJours", "remuneration", "dossiersRegulatoryDirects", "accesSansResponsabilite", "activiteObservee", "dependance", "chargeDeTravail", "documentsRH", "lien"] as const;
const CLES_PRODUIT = ["syntheseExecutive", "fiche", "reglementaire", "stock", "activiteRecente", "commentaires", "lien"] as const;
const CLES_FOURNISSEUR = ["fournisseur", "relation", "depensesPayees", "enAttente", "legal", "derniersPaiements"] as const;

export const THREE_SIXTY_TOOLS: PowerTool[] = [
  // ───────────────────────── EMPLOYEE 360 ─────────────────────────
  {
    def: {
      name: "employee_360",
      description:
        "LA VUE COMPLÈTE d'un collaborateur en un appel (« parle-moi de Khaled ») : identité, poste, entité, département, N+1, " +
        "ÂGE et ANCIENNETÉ calculés (avec leur source), contrat (type, dates, échéance, période d'essai), congés, documents RH, " +
        "rémunération (SEULEMENT si le compte appelant détient le module RH), activité OBSERVÉE dans l'ERP (fenêtre 90 j) et " +
        "indicateurs de DÉPENDANCE (validations en attente chez lui, équipes dirigées, dossiers dont il est responsable). " +
        "L'outil distingue OBSERVÉ / NON OBSERVÉ : l'absence de trace ERP n'est pas l'absence de travail.",
      input_schema: {
        type: "object",
        properties: { name: { type: "string", description: "Nom (ou fragment) du collaborateur." } },
        required: ["name"],
      },
    },
    allowed: EXEC,
    label: "Vue 360° d'un collaborateur",
    run: async (input, user) => {
      const name = str(input, "name");
      if (name.length < 2) return vue360(CLES_PERSONNE, { precision: "Le nom du collaborateur n'a pas été donné : rien n'a été cherché." });
      const candidates = await prisma.employee.findMany({
        where: { fullName: { contains: name, mode: "insensitive" } },
        select: { id: true, fullName: true, position: true, isActive: true },
        take: 6,
      });
      if (candidates.length === 0) return vue360(CLES_PERSONNE, { precision: `Aucun employé « ${name} » dans le registre RH.` });
      if (candidates.length > 1) {
        // Plusieurs homonymes : on les NOMME, et `retenu` reste vide — désigner à la place d'un
        // humain, c'est ce que §118.34 interdit exactement.
        return vue360(CLES_PERSONNE, {
          candidats: candidates.map((c) => ({ nom: c.fullName, poste: c.position, actif: c.isActive })),
          precision: `${candidates.length} employés correspondent à « ${name} » — préciser le nom complet. Aucune fiche n'est retenue.`,
        });
      }

      const emp = await prisma.employee.findUnique({
        where: { id: candidates[0].id },
        select: {
          id: true, fullName: true, position: true, isActive: true, birthDate: true, hireDate: true,
          contractType: true, contractStart: true, contractEnd: true,
          trialStart: true, trialEnd: true, trialRenewed: true, trialRenewalEnd: true,
          leaveBalanceDays: true, notes: true, departmentId: true,
          baseSalary: true, netToPay: true, employerCost: true,
          company: { select: { shortName: true, name: true } },
          manager: { select: { fullName: true } },
          reports: { select: { fullName: true }, take: 15 },
          headOf: { select: { name: true } },
          deputyOf: { select: { name: true } },
          user: { select: { id: true, role: true } },
        },
      });
      if (!emp) return vue360(CLES_PERSONNE, { precision: `Aucun employé « ${name} » dans le registre RH.` });

      const now = new Date();

      // ÂGE et ANCIENNETÉ : calculés ICI, au backend, avec leur source — jamais par le modèle.
      const age = emp.birthDate
        ? { annees: yearsBetween(emp.birthDate, now), source: `fiche RH — date de naissance ${ymd(emp.birthDate)}` }
        : { annees: null, source: "date de naissance NON RENSEIGNÉE sur la fiche RH — âge incalculable, ne pas l'estimer" };
      const anciennete = emp.hireDate
        ? { duree: tenureLabel(emp.hireDate, now), source: `fiche RH — embauche le ${ymd(emp.hireDate)}` }
        : { duree: null, source: "date d'embauche non renseignée" };

      const contratJoursRestants = emp.contractEnd ? Math.ceil((emp.contractEnd.getTime() - now.getTime()) / DAY) : null;

      const deptPath = emp.departmentId ? await getDepartmentPath(emp.departmentId).catch(sansBloquer("three-sixty.run.getDepartmentPath", [])) : [];

      // ACTIVITÉ OBSERVÉE (90 j) + DÉPENDANCE — uniquement si un compte applicatif existe.
      const since = new Date(now.getTime() - 90 * DAY);
      const uid = emp.user?.id ?? null;
      // Le décompte Regulatory passe par LA définition canonique (responsable DÉSIGNÉ) dans le
      // PÉRIMÈTRE DE L'APPELANT : le Chief ne montre pas à quelqu'un plus que son propre écran.
      const regVisible = uid && userCan(user, "REGULATORY", "VIEW") ? await regulatoryVisibleWhere(user) : null;
      const [tasksOpen, tasksDone, tasksLate, validationsRendered, validationsWaiting, audits, lastAudit, fieldReports, regLoad, docs, tasksCritical, oldestOpenTask, topTasks, regAccessOnly] = uid
        ? await Promise.all([
            prisma.task.count({ where: { assignedToId: uid, status: { notIn: ["DONE", "CANCELLED"] } } }),
            prisma.task.count({ where: { assignedToId: uid, status: "DONE", updatedAt: { gte: since } } }),
            prisma.task.count({ where: { assignedToId: uid, status: { notIn: ["DONE", "CANCELLED"] }, dueDate: { lt: now } } }),
            prisma.validationStep.count({ where: { validatorId: uid, decidedAt: { gte: since } } }),
            prisma.validationStep.count({ where: { validatorId: uid, status: "PENDING" } }),
            prisma.auditLog.count({ where: { actorId: uid, createdAt: { gte: since } } }),
            prisma.auditLog.findFirst({ where: { actorId: uid }, orderBy: { createdAt: "desc" }, select: { createdAt: true, summary: true } }),
            prisma.fieldReport.count({ where: { delegateId: uid, createdAt: { gte: since } } }).catch(sansBloquer("three-sixty.run.fieldReport", 0)),
            regVisible ? assigneeRegulatoryLoad(uid, regVisible as Record<string, unknown>, 10) : null,
            prisma.document.findMany({ where: { entityType: "EMPLOYEE", entityId: emp.id }, select: { id: true, name: true, category: true, createdAt: true }, take: 10, orderBy: { createdAt: "desc" } }),
            prisma.task.count({ where: { assignedToId: uid, status: { notIn: ["DONE", "CANCELLED"] }, priority: "CRITICAL" } }),
            prisma.task.findFirst({ where: { assignedToId: uid, status: { notIn: ["DONE", "CANCELLED"] } }, orderBy: { createdAt: "asc" }, select: { createdAt: true } }),
            prisma.task.findMany({
              where: { assignedToId: uid, status: { notIn: ["DONE", "CANCELLED"] } },
              orderBy: [{ priority: "desc" }, { dueDate: "asc" }],
              take: 5,
              select: { title: true, dueDate: true, priority: true, createdAt: true, createdBy: { select: { name: true } } },
            }),
            regVisible
              ? prisma.regulatoryProduct.count({
                  where: {
                    AND: [
                      regVisible as never,
                      { assignedUsers: { some: { id: uid } } },
                      { responsibleId: { not: uid } },
                    ],
                  },
                })
              : null,
          ])
        : [null, null, null, null, null, null, null, null, null,
            await prisma.document.findMany({ where: { entityType: "EMPLOYEE", entityId: emp.id }, select: { id: true, name: true, category: true, createdAt: true }, take: 10, orderBy: { createdAt: "desc" } }),
            null, null, null, null];

      // RÉMUNÉRATION : la porte est LE MODULE RH du compte APPELANT — même règle que l'écran
      // et que read_payroll. Un PDG sans le module RH ne la voit pas ici non plus.
      const salaireVisible = userCan(user, "RH", "VIEW");

      return JSON.stringify({
        identite: {
          nom: emp.fullName, poste: emp.position, actif: emp.isActive,
          entite: emp.company?.shortName ?? emp.company?.name ?? null,
          departement: deptPath.length ? deptPath.map((p) => p.name).join(" › ") : null,
          responsableN1: emp.manager?.fullName ?? null,
          role: emp.user ? ROLE_LABELS[emp.user.role] ?? emp.user.role : "aucun compte applicatif",
        },
        age,
        anciennete,
        contrat: {
          type: emp.contractType ?? "non renseigné",
          du: ymd(emp.contractStart), au: ymd(emp.contractEnd) ?? "indéterminé / non renseigné",
          joursRestants: contratJoursRestants,
          periodeEssai: emp.trialStart ? { du: ymd(emp.trialStart), au: ymd(emp.trialRenewed ? emp.trialRenewalEnd : emp.trialEnd), renouvelee: emp.trialRenewed } : null,
          source: "fiche RH",
        },
        soldeCongesJours: Number(emp.leaveBalanceDays),
        remuneration: salaireVisible
          ? {
              salaireDeBaseDzd: dzd(toNumber(emp.baseSalary)),
              netAPayerDzd: emp.netToPay != null ? dzd(toNumber(emp.netToPay)) : null,
              coutEmployeurDzd: emp.employerCost != null ? dzd(toNumber(emp.employerCost)) : null,
              source: "fiche RH (relue à l'instant — jamais de mémoire)",
            }
          : "réservée aux détenteurs du module RH — votre compte ne l'a pas",
        // B. DOSSIERS DIRECTEMENT ASSIGNÉS — la définition CANONIQUE (« Chargé du dossier »),
        // dans le périmètre de l'appelant. GÉRER ≠ AVOIR ACCÈS : les deux chiffres sont
        // séparés et le second ne se présente JAMAIS comme une charge de travail.
        dossiersRegulatoryDirects: regLoad
          ? {
              definition: "dossiers dont la personne est RESPONSABLE DÉSIGNÉE — jamais le simple accès",
              total: regLoad.total, parStatut: regLoad.parStatut, enRetardSurCible: regLoad.enRetardCible,
              liste: regLoad.liste,
            }
          : (uid ? "module Regulatory non ouvert à votre compte — non consulté" : null),
        accesSansResponsabilite: regAccessOnly != null
          ? { dossiersRegulatoryAccessibles: regAccessOnly, regle: "ACCÈS ≠ GESTION — ne jamais compter ces dossiers comme gérés" }
          : null,
        // C+D. TÂCHES ASSIGNÉES (signal PRIMAIRE de travail observé) + activité ERP globale.
        activiteObservee: uid
          ? {
              fenetre: "90 derniers jours",
              tachesOuvertes: tasksOpen, tachesTerminees: tasksDone, tachesEnRetard: tasksLate,
              tachesCritiquesOuvertes: tasksCritical,
              plusAncienneTacheOuverteJours: oldestOpenTask ? Math.floor((now.getTime() - oldestOpenTask.createdAt.getTime()) / DAY) : null,
              velociteTachesParMois: tasksDone != null ? Math.round((tasksDone / 3) * 10) / 10 : null,
              tachesEnCours: (topTasks ?? []).map((t) => ({
                titre: t.title, echeance: ymd(t.dueDate), priorite: t.priority,
                ageJours: Math.floor((now.getTime() - t.createdAt.getTime()) / DAY),
                demandePar: t.createdBy?.name ?? null,
              })),
              validationsRendues: validationsRendered,
              rapportsTerrain: fieldReports,
              actionsAuJournal: audits,
              derniereTrace: lastAudit ? { le: ymd(lastAudit.createdAt), quoi: lastAudit.summary } : "aucune trace au journal",
              avertissement: "OBSERVÉ dans l'ERP uniquement — le travail hors ERP (terrain, téléphone, réunions) est INVISIBLE ici : l'absence de trace n'est pas l'absence de travail, et l'activité ERP n'est pas la performance.",
            }
          : "NON OBSERVABLE — cette personne n'a pas de compte applicatif : aucune activité ERP à mesurer (ce qui ne dit RIEN de son travail réel).",
        dependance: {
          validationsEnAttenteChezLui: validationsWaiting,
          equipesDirigees: emp.headOf.map((d) => d.name),
          adjointDe: emp.deputyOf.map((d) => d.name),
          rapportsDirects: emp.reports.map((r) => r.fullName),
          dossiersRegulatoryResponsable: regLoad?.total ?? null,
          // LE PORTEFEUILLE PRODUIT — la relation posée au lot 1b. Sans elle ici, « qui porte le
          // Nivolumab ? » se répondait depuis le produit et jamais depuis la personne, si bien
          // qu'un départ ne laissait pas voir les produits qui restaient sans porteur. Les
          // affectations CLOSES sont marquées : relancer quelqu'un sur un produit qu'il ne porte
          // plus est une erreur visible en réunion.
          // LE PORTEFEUILLE PRODUIT — la relation posée au lot 1b. Sans elle ici, « qui porte le
          // Nivolumab ? » ne se répondait que depuis le produit, jamais depuis la personne : un
          // départ ne laissait pas voir les produits qui restaient sans porteur.
          //
          // Écrit en Prisma plutôt qu'en appelant `queries/graph.ts` : ce fichier importe DÉJÀ
          // Prisma, alors qu'importer le graphe aurait ajouté un franchissement de frontière
          // (425 pour un plafond de 424) — le test l'a signalé, et il avait raison : on ne
          // traverse pas une frontière pour la commodité d'une seule arête.
          produitsPortes: uid
            ? (await prisma.productAssignment.findMany({
              where: { userId: uid },
              select: { role: true, endedAt: true, product: { select: { code: true, canonicalName: true } } },
              orderBy: { startedAt: "desc" }, take: 20,
            })).map((a) => ({
              produit: `${a.product.code} — ${a.product.canonicalName}`,
              role: a.role,
              // « PORTE » et « A PORTÉ » ne se confondent pas : relancer quelqu'un sur un
              // produit qu'il ne porte plus est une erreur visible en réunion.
              enCours: a.endedAt === null || a.endedAt > now,
            }))
            : null,
          lecture: "indicateurs FACTUELS de dépendance (personne-clé) — pas un jugement : les interpréter avec le contexte.",
        },
        chargeDeTravail: uid
          ? {
              resume: `${regLoad ? `${regLoad.total} dossier(s) Regulatory en responsabilité directe` : "Regulatory non consulté"} · ${tasksOpen ?? 0} tâche(s) ouverte(s) dont ${tasksLate ?? 0} en retard · ${validationsWaiting ?? 0} validation(s) en attente chez la personne`,
              lecture: "charge OBSERVÉE dans l'ERP — à recouper avec la réalité du terrain avant toute décision",
            }
          : null,
        documentsRH: docs.map((d) => ({ nom: d.name, categorie: d.category, depose: ymd(d.createdAt), documentId: d.id })),
        lien: `/rh/${emp.id}`,
      });
    },
  },

  // ───────────────────────── PRODUCT 360 ─────────────────────────
  {
    def: {
      name: "product_360",
      description:
        "LA VUE COMPLÈTE d'un produit du portefeuille (« où en est le Keytruda ? ») : fiche (DCI, dosage, forme, laboratoire " +
        "partenaire), statut réglementaire et étapes (faites/planifiées, prochaine étape, retards), chargé du dossier, dates " +
        "cibles, DERNIERS NIVEAUX DE STOCK par lieu, et activité récente du dossier. Accepte référence (REG-…), DCI ou nom commercial.",
      input_schema: {
        type: "object",
        properties: { product: { type: "string", description: "Référence REG-…, DCI ou nom commercial (fragment accepté)." } },
        required: ["product"],
      },
    },
    allowed: (u) => userCan(u, "REGULATORY", "VIEW"),
    label: "Vue 360° d'un produit",
    run: async (input, _user) => {
      const q = str(input, "product");
      if (q.length < 2) return vue360(CLES_PRODUIT, { precision: "Ni référence, ni DCI, ni nom commercial n'a été donné : rien n'a été cherché." });
      const candidates = await prisma.regulatoryProduct.findMany({
        where: {
          OR: [
            { reference: { equals: q, mode: "insensitive" } },
            { dci: { contains: q, mode: "insensitive" } },
            { brandName: { contains: q, mode: "insensitive" } },
          ],
        },
        select: { id: true, reference: true, dci: true, brandName: true, dosage: true, dosageUnit: true },
        take: 6,
      });
      if (candidates.length === 0) return vue360(CLES_PRODUIT, { precision: `Aucun produit « ${q} » au portefeuille (ni référence, ni DCI, ni nom commercial).` });
      if (candidates.length > 1) {
        return vue360(CLES_PRODUIT, {
          candidats: candidates.map((c) => ({ reference: c.reference, dci: c.dci, nom: c.brandName, dosage: c.dosage ? `${c.dosage} ${c.dosageUnit ?? ""}`.trim() : null })),
          precision: `${candidates.length} produits correspondent à « ${q} » — préciser (référence ou dosage). Aucun n'est retenu.`,
        });
      }

      const p = await prisma.regulatoryProduct.findUnique({
        where: { id: candidates[0].id },
        select: {
          id: true, reference: true, dci: true, brandName: true, dosage: true, dosageUnit: true,
          pharmaceuticalForm: true, packaging: true, therapeuticClass: true, partnerLab: true,
          countryOfOrigin: true, status: true, priority: true, manufacturingStatus: true,
          targetSubmissionDate: true, targetDate: true, comments: true, workflow: true,
          responsible: { select: { name: true } }, assistant: { select: { name: true } },
          company: { select: { shortName: true, name: true } },
          steps: { orderBy: { order: "asc" }, select: { type: true, status: true, plannedDate: true, actualDate: true, comment: true, missingDocs: true, responsible: true } },
        },
      });
      if (!p) return vue360(CLES_PRODUIT, { precision: `Produit « ${q} » introuvable à la relecture de sa fiche.` });

      const now = new Date();

      // LE CIRCUIT COCHÉ FAIT FOI — c'est celui que l'écran Regulatory affiche.
      //
      // Il existait deux registres pour un même fait : le JSON `workflow` (coché par l'équipe,
      // affiché à l'écran) et la table `RegulatoryStep` (un second registre que plus personne ne
      // tient). Le Chief lisait le second : d'où « Préparation dossier CTD (non démarrée) » sur un
      // dossier que l'écran montrait à 22/22. On lit désormais le circuit coché dès qu'il existe,
      // et la table ancienne seulement pour les dossiers qui n'ont jamais été cochés.
      const workflow = (p.workflow ?? null) as RegWorkflowState | null;
      const circuitTenu = hasWorkflowState(workflow);
      const progress = circuitTenu ? regProgress(workflow) : null;
      const steps = circuitTenu ? workflowAsSteps(workflow) : p.steps;

      const stepsDone = steps.filter((s) => s.status === "DONE");
      const nextStep = progress
        ? (progress.current ? steps.find((s) => s.type === progress.current!.key) ?? null : null)
        : steps.find((s) => s.status !== "DONE") ?? null;
      const lateSteps = steps.filter((s) => s.status !== "DONE" && s.plannedDate && s.plannedDate < now);

      const [snaps, audit] = await Promise.all([
        prisma.stockSnapshot.findMany({
          where: { productId: p.id },
          orderBy: { date: "desc" }, take: 60,
          select: { scope: true, date: true, quantity: true, annex: { select: { name: true } } },
        }),
        prisma.auditLog.findMany({
          where: { entityType: "REGULATORY_PRODUCT", entityId: p.id },
          orderBy: { createdAt: "desc" }, take: 5,
          select: { createdAt: true, summary: true, actor: { select: { name: true } } },
        }),
      ]);
      const seen = new Set<string>();
      const stockParLieu: { lieu: string; quantite: number; releveDu: string | null }[] = [];
      for (const s of snaps) {
        const lieu = s.scope === "PCH" ? "PCH (centrale)" : s.annex?.name ?? "Hôpital";
        if (seen.has(lieu)) continue;
        seen.add(lieu);
        stockParLieu.push({ lieu, quantite: s.quantity, releveDu: ymd(s.date) });
      }

      return JSON.stringify({
        // LA SYNTHÈSE D'ABORD — « où en est Pembro ? » reçoit d'un coup l'essentiel exécutif :
        // bloqueur, jours dans l'étape, prochaine étape, signaux. Dérivée (executive-state.ts)
        // des données déjà lues — zéro requête de plus, zéro latence ajoutée.
        syntheseExecutive: regulatoryExecutiveState({
          status: p.status, priority: p.priority,
          targetSubmissionDate: p.targetSubmissionDate, targetDate: p.targetDate,
          responsible: p.responsible?.name ?? null,
          steps,
          // L'étape que l'écran affiche — verrou de présoumission compris. Absente pour un
          // dossier jamais coché : la synthèse retombe alors sur son ancien calcul.
          ...(progress ? { currentType: progress.current?.key ?? null } : {}),
          lastActivity: audit[0] ? { at: audit[0].createdAt, summary: audit[0].summary } : null,
        }),
        fiche: {
          reference: p.reference, dci: p.dci, nomCommercial: p.brandName,
          dosage: p.dosage ? `${p.dosage} ${p.dosageUnit ?? ""}`.trim() : null,
          forme: p.pharmaceuticalForm, conditionnement: p.packaging,
          classeTherapeutique: p.therapeuticClass, laboratoirePartenaire: p.partnerLab,
          origine: p.countryOfOrigin, entite: p.company?.shortName ?? p.company?.name ?? null,
        },
        reglementaire: {
          statut: p.status, priorite: p.priority, niveauFabrication: p.manufacturingStatus,
          chargeDuDossier: p.responsible?.name ?? "non assigné",
          assistant: p.assistant?.name ?? null,
          cibleDepot: ymd(p.targetSubmissionDate), cibleEnregistrement: ymd(p.targetDate),
          etapes: { faites: progress ? progress.done : stepsDone.length, total: progress ? progress.total : steps.length },
          prochaineEtape: nextStep ? { type: nextStep.type, statut: nextStep.status, prevueLe: ymd(nextStep.plannedDate), piecesManquantes: nextStep.missingDocs } : "toutes les étapes sont faites",
          etapesEnRetard: lateSteps.map((s) => ({ type: s.type, prevueLe: ymd(s.plannedDate) })),
        },
        stock: stockParLieu.length ? { parLieu: stockParLieu, source: "derniers relevés de stock (dates indiquées — un relevé ancien peut être périmé)" } : "aucun relevé de stock pour ce produit",
        activiteRecente: audit.map((a) => ({ le: ymd(a.createdAt), quoi: a.summary, par: a.actor?.name ?? null })),
        commentaires: p.comments,
        lien: `/regulatory/${p.id}`,
      });
    },
  },

  // ───────────────────────── SUPPLIER 360 ─────────────────────────
  {
    def: {
      name: "supplier_360",
      description:
        "LA VUE COMPLÈTE d'un fournisseur / partenaire (« combien a-t-on payé à X ? », « quels contrats nous lient ? ») : " +
        "dépenses PAYÉES par année (calculées en base), règlements en attente, demandes de paiement ouvertes, documents Legal " +
        "(contrats actifs et leurs échéances, BC, factures), derniers paiements. Chercher par le nom (fragment accepté).",
      input_schema: {
        type: "object",
        properties: { name: { type: "string", description: "Nom (ou fragment) du fournisseur / partenaire." } },
        required: ["name"],
      },
    },
    allowed: EXEC,
    label: "Vue 360° d'un fournisseur",
    run: async (input, _user) => {
      const name = str(input, "name");
      if (name.length < 2) return vue360(CLES_FOURNISSEUR, { precision: "Le nom du fournisseur n'a pas été donné : rien n'a été cherché." });
      const ci = { contains: name, mode: "insensitive" as const };

      const [paidOrders, pendingOrders, openRequests, legalDocs] = await Promise.all([
        prisma.expenseOrder.findMany({
          where: { beneficiary: ci, paidDate: { not: null } },
          select: { reference: true, label: true, amount: true, paidDate: true },
          orderBy: { paidDate: "desc" }, take: 200,
        }),
        prisma.expenseOrder.findMany({
          where: { beneficiary: ci, paidDate: null, status: { not: "CANCELLED" } },
          select: { reference: true, label: true, amount: true, createdAt: true, centralStatus: true },
          orderBy: { createdAt: "asc" }, take: 15,
        }),
        prisma.paymentRequest.findMany({
          where: { payee: ci, status: { in: ["DRAFT", "SUBMITTED", "UNDER_REVIEW", "ON_HOLD", "CHANGES_REQUESTED"] } },
          select: { reference: true, title: true, amount: true, status: true, createdAt: true },
          orderBy: { createdAt: "asc" }, take: 15,
        }),
        prisma.legalDocument.findMany({
          where: { counterparty: ci },
          select: { id: true, kind: true, title: true, reference: true, amount: true, status: true, startDate: true, endDate: true },
          orderBy: { createdAt: "desc" }, take: 30,
        }),
      ]);

      if (paidOrders.length === 0 && pendingOrders.length === 0 && openRequests.length === 0 && legalDocs.length === 0) {
        return vue360(CLES_FOURNISSEUR, {
          precision: `Aucune trace de « ${name} » — ni règlement, ni demande de paiement, ni document Legal ne porte ce nom. `
            + "Vérifier l'orthographe (ou chercher via search_everything).",
        });
      }

      // Dépenses payées PAR ANNÉE — additionnées ici, en base : jamais à la main par le modèle.
      const byYear = new Map<number, { total: number; count: number }>();
      for (const o of paidOrders) {
        const y = o.paidDate!.getUTCFullYear();
        const cur = byYear.get(y) ?? { total: 0, count: 0 };
        cur.total += toNumber(o.amount); cur.count += 1;
        byYear.set(y, cur);
      }
      const contratsActifs = legalDocs.filter((d) => d.kind === "CONTRACT" && d.status === "ACTIVE");
      const first = paidOrders.at(-1)?.paidDate ?? legalDocs.at(-1)?.startDate ?? null;

      return JSON.stringify({
        fournisseur: name,
        relation: {
          premiereTrace: ymd(first),
          dernierPaiement: paidOrders[0] ? { le: ymd(paidOrders[0].paidDate), reference: paidOrders[0].reference, montantDzd: dzd(toNumber(paidOrders[0].amount)) } : null,
        },
        depensesPayees: {
          parAnnee: [...byYear.entries()].sort((a, b) => b[0] - a[0]).map(([annee, v]) => ({ annee, totalDzd: dzd(v.total), reglements: v.count })),
          plafondLecture: paidOrders.length === 200 ? "les 200 derniers règlements seulement — le total réel peut être supérieur" : undefined,
          source: "ordres de dépense PAYÉS (dates de paiement)",
        },
        enAttente: {
          reglements: pendingOrders.map((o) => ({ reference: o.reference, objet: o.label, montantDzd: dzd(toNumber(o.amount)), centre: o.centralStatus, depuis: ymd(o.createdAt) })),
          demandesDePaiement: openRequests.map((r) => ({ reference: r.reference, objet: r.title, montantDzd: dzd(toNumber(r.amount)), statut: r.status, depuis: ymd(r.createdAt) })),
        },
        legal: {
          contratsActifs: contratsActifs.map((d) => ({ titre: d.title, reference: d.reference, echeance: ymd(d.endDate), lien: `/legal/${d.id}` })),
          pieces: legalDocs.slice(0, 15).map((d) => ({ nature: d.kind, titre: d.title, reference: d.reference, montantDzd: d.amount != null ? dzd(toNumber(d.amount)) : null, statut: d.status, lien: `/legal/${d.id}` })),
        },
        derniersPaiements: paidOrders.slice(0, 10).map((o) => ({ le: ymd(o.paidDate), reference: o.reference, objet: o.label, montantDzd: dzd(toNumber(o.amount)) })),
      });
    },
  },

  // ───────────────────────── ORGANISATION ─────────────────────────
  {
    def: {
      name: "organization_insights",
      description:
        "L'ÉTAT DE L'ORGANISATION en chiffres : étendues de contrôle (qui encadre combien de personnes), départements sans " +
        "responsable ou sans adjoint (point de fragilité), CONCENTRATION des validations (chez qui s'empilent les décisions en " +
        "attente — les goulots), personnes-clés par cumul de rôles. FAITS calculés sur les données réelles — l'interprétation " +
        "appartient au lecteur.",
      input_schema: { type: "object", properties: {} },
    },
    allowed: EXEC,
    label: "Insights organisationnels",
    run: async (_input, _user) => {
      const [departments, managers, pendingByValidator, activeCount] = await Promise.all([
        prisma.department.findMany({
          select: {
            name: true, parentId: true,
            head: { select: { fullName: true } }, deputy: { select: { fullName: true } },
            _count: { select: { members: true } },
          },
          take: 100,
        }),
        prisma.employee.findMany({
          where: { isActive: true, reports: { some: {} } },
          select: { fullName: true, position: true, _count: { select: { reports: true } } },
          orderBy: { reports: { _count: "desc" } },
          take: 10,
        }),
        prisma.validationStep.groupBy({
          by: ["validatorId"],
          where: { status: "PENDING" },
          _count: { _all: true },
          orderBy: { _count: { validatorId: "desc" } },
          take: 8,
        }),
        prisma.employee.count({ where: { isActive: true } }),
      ]);

      const validatorIds = pendingByValidator.map((v) => v.validatorId);
      const validators = validatorIds.length
        ? await prisma.user.findMany({ where: { id: { in: validatorIds } }, select: { id: true, name: true } })
        : [];
      const vName = new Map(validators.map((v) => [v.id, v.name]));

      const sansResponsable = departments.filter((d) => !d.head).map((d) => d.name);
      const sansAdjoint = departments.filter((d) => d.head && !d.deputy).map((d) => d.name);

      return JSON.stringify({
        effectifActif: activeCount,
        etenduesDeControle: {
          managers: managers.map((m) => ({ nom: m.fullName, poste: m.position, rapportsDirects: m._count.reports })),
          lecture: "au-delà de ~8 rapports directs, l'encadrement se dilue ; 1 seul rapport direct interroge la structure — à juger avec le contexte.",
        },
        departements: {
          total: departments.length,
          sansResponsable,
          sansAdjoint,
          lecture: sansAdjoint.length ? "un département sans adjoint dépend d'UNE personne : fragilité en cas d'absence." : undefined,
        },
        concentrationDesValidations: {
          enAttenteParValideur: pendingByValidator.map((v) => ({ valideur: vName.get(v.validatorId) ?? v.validatorId, enAttente: v._count._all })),
          lecture: "là où les validations s'empilent, les circuits ralentissent — croiser avec process_insights pour les délais réels.",
        },
        rappel: "FAITS calculés sur l'ERP — ni jugement, ni recommandation automatique : décider reste humain.",
      });
    },
  },

  // ───────────────────────── PROCESSUS (cycle réel) ─────────────────────────
  {
    def: {
      name: "process_insights",
      description:
        "LES DÉLAIS RÉELS des circuits, calculés sur l'HISTORIQUE (180 j) : validations (création → dernière décision, moyenne et " +
        "médiane, les plus lentes avec leur référence), règlements (création → paiement), étapes réglementaires (glissement " +
        "planifié → réel), et les étapes de validation qui attendent le plus longtemps chez chaque valideur. Chaque constat " +
        "porte sa PREUVE (références, volumes) — pour trouver OÙ ça coince avant de décider quoi changer.",
      input_schema: { type: "object", properties: {} },
    },
    allowed: EXEC,
    label: "Délais réels des circuits",
    run: async (_input, _user) => {
      const since = new Date(Date.now() - 180 * DAY);

      const [valRequests, paidOrders, regSteps, slowPending] = await Promise.all([
        prisma.validationRequest.findMany({
          where: { createdAt: { gte: since }, status: { not: "PENDING" } },
          select: { reference: true, title: true, createdAt: true, steps: { select: { decidedAt: true } } },
          take: 400,
        }),
        prisma.expenseOrder.findMany({
          where: { paidDate: { gte: since } },
          select: { reference: true, label: true, createdAt: true, paidDate: true },
          take: 400,
        }),
        prisma.regulatoryStep.findMany({
          where: { status: "DONE", actualDate: { gte: since }, plannedDate: { not: null } },
          select: { type: true, plannedDate: true, actualDate: true, product: { select: { reference: true } } },
          take: 400,
        }),
        prisma.validationStep.findMany({
          where: { status: "PENDING" },
          select: { createdAt: true, validator: { select: { name: true } }, request: { select: { reference: true, title: true } } },
          orderBy: { createdAt: "asc" },
          take: 10,
        }),
      ]);

      const now = Date.now();
      const days1 = (ms: number): number => Math.round(ms / DAY * 10) / 10;

      // Validations : création → DERNIÈRE décision rendue.
      const valCycles = valRequests
        .map((r) => {
          const last = r.steps.map((s) => s.decidedAt).filter((d): d is Date => Boolean(d)).sort((a, b) => b.getTime() - a.getTime())[0];
          return last ? { reference: r.reference, titre: r.title, jours: days1(last.getTime() - r.createdAt.getTime()) } : null;
        })
        .filter((x): x is NonNullable<typeof x> => x !== null);
      const valDays = valCycles.map((c) => c.jours);

      const payCycles = paidOrders.map((o) => ({ reference: o.reference, objet: o.label, jours: days1(o.paidDate!.getTime() - o.createdAt.getTime()) }));
      const payDays = payCycles.map((c) => c.jours);

      const slippages = regSteps.map((s) => ({ etape: s.type, produit: s.product.reference, glissementJours: days1(s.actualDate!.getTime() - s.plannedDate!.getTime()) }));
      const slipDays = slippages.map((s) => s.glissementJours);

      const stats = (xs: number[]) => xs.length
        ? { volume: xs.length, moyenneJours: Math.round(xs.reduce((a, b) => a + b, 0) / xs.length * 10) / 10, medianeJours: median(xs) }
        : "aucun cas clos sur la fenêtre — pas de délai à calculer (ne pas inventer)";

      return JSON.stringify({
        fenetre: "180 derniers jours (cas CLOS uniquement — les en-cours ne faussent pas les moyennes)",
        validations: {
          cycleCreationDerniereDecision: stats(valDays),
          plusLentes: valCycles.sort((a, b) => b.jours - a.jours).slice(0, 5),
        },
        reglements: {
          cycleCreationPaiement: stats(payDays),
          plusLents: payCycles.sort((a, b) => b.jours - a.jours).slice(0, 5),
        },
        etapesReglementaires: {
          glissementPlanifieReel: stats(slipDays),
          lecture: "glissement POSITIF = fait en retard sur le planifié ; négatif = en avance.",
          piresGlissements: slippages.sort((a, b) => b.glissementJours - a.glissementJours).slice(0, 5),
        },
        enAttenteLesPlusAnciennes: slowPending.map((s) => ({
          demande: s.request.reference, titre: s.request.title,
          attendDepuisJours: days1(now - s.createdAt.getTime()),
          chez: s.validator.name,
        })),
        rappel: "Ces délais DÉCRIVENT — ils n'expliquent pas : un circuit lent peut tenir à une pièce manquante ou à une dépendance externe. Vérifier le POURQUOI (inspect_record) avant de changer quoi que ce soit.",
      });
    },
  },
];
