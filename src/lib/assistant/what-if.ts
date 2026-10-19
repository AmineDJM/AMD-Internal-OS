import type { PowerTool } from "@/lib/assistant/power-tools";
import type { CurrentUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { ORDRE_NON_ANNULE } from "@/lib/payments/authorization";
import { userCan } from "@/lib/rbac";
import { platformScope } from "@/lib/company";
import { toNumber, formatMontant } from "@/lib/utils";
import { getComptaData } from "@/lib/queries/compta";
import { getActionCenter } from "@/lib/queries/action-center";
import { alertesExecutivesChaudes, fraicheurDeLecture } from "@/lib/assistant/hot-alerts";
import type { ExecutiveAlert } from "@/lib/assistant/proactive";
import { FINISHED_REG_STATUSES } from "@/lib/regulatory/stage";

/**
 * SIMULATION, ÉTAT DE L'ENTREPRISE, ATTENTION DU PDG — trois lectures de pilotage.
 *
 * La règle des SCÉNARIOS est absolue : JAMAIS MUTATIFS. `simulate_scenario` lit l'état réel,
 * calcule des ESTIMATIONS avec des HYPOTHÈSES DITES, et n'écrit RIEN — simulation ≠ production,
 * isolation totale. Chaque résultat s'annonce comme simulation, liste ses hypothèses et sa date
 * de lecture, et refuse la fausse précision (pas de centime prédictif, des ordres de grandeur).
 *
 * `company_state` compose l'état consolidé par DROIT (la section RH exige le module RH, la
 * section finances le module Finances). `ceo_attention` trie ce qui mérite l'attention en
 * trois bacs — DOIT DÉCIDER / DEVRAIT SAVOIR / SURVEILLER — peu d'éléments, bien choisis.
 */

const EXEC = (u: CurrentUser): boolean => u.role === "SUPER_ADMIN" || u.role === "DIRECTION";

const str = (input: Record<string, unknown>, key: string): string =>
  typeof input[key] === "string" ? (input[key] as string).trim() : "";

const num = (input: Record<string, unknown>, key: string): number | null => {
  const v = input[key];
  const n = typeof v === "number" ? v : Number(String(v ?? "").replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
};

const dzd = (n: number): number => Math.round(n * 100) / 100;
const kdzd = (n: number): string => `${formatMontant(n)} DZD`;

/** Masse salariale MENSUELLE estimée : somme des coûts employeur actifs (repli : brut, puis base). */
async function monthlyPayroll(): Promise<{ totalDzd: number; headcount: number; sansCout: number }> {
  const rows = await prisma.employee.findMany({
    where: { isActive: true },
    select: { employerCost: true, grossSalary: true, baseSalary: true },
  });
  let total = 0;
  let sansCout = 0;
  for (const e of rows) {
    if (e.employerCost != null) total += toNumber(e.employerCost);
    else if (e.grossSalary != null) { total += toNumber(e.grossSalary); sansCout += 1; }
    else { total += toNumber(e.baseSalary); sansCout += 1; }
  }
  return { totalDzd: total, headcount: rows.length, sansCout };
}

export const WHAT_IF_TOOLS: PowerTool[] = [
  {
    def: {
      name: "simulate_scenario",
      description:
        "SIMULE un scénario SANS RIEN MODIFIER (« et si on augmentait X de 20 % ? », « que se passe-t-il si Y part ? », " +
        "« et si on recrutait 2 délégués ? », « où va la trésorerie ? »). Kinds : " +
        "SALARY_CHANGE (employee_name + new_base_salary — impact mensuel/annuel et sur la masse), " +
        "DEPARTURE (employee_name — ce que le départ expose : validations, tâches, équipes, dossiers, coût libéré), " +
        "HEADCOUNT_CHANGE (monthly_cost + count — impact d'un recrutement sur la masse), " +
        "CASH_TREND (months — tendance recettes/dépenses passée projetée, avec sa marge d'erreur). " +
        "SORTIE = ESTIMATIONS avec hypothèses DITES et confiance (FAIBLE/MODÉRÉE) — jamais de fausse précision, AUCUNE écriture.",
      input_schema: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["SALARY_CHANGE", "DEPARTURE", "HEADCOUNT_CHANGE", "CASH_TREND"], description: "Le scénario." },
          employee_name: { type: "string", description: "SALARY_CHANGE / DEPARTURE : la personne." },
          new_base_salary: { type: "number", description: "SALARY_CHANGE : nouveau salaire de BASE mensuel (DZD)." },
          monthly_cost: { type: "number", description: "HEADCOUNT_CHANGE : coût employeur mensuel estimé d'UNE recrue (DZD)." },
          count: { type: "number", description: "HEADCOUNT_CHANGE : nombre de recrues (défaut 1)." },
          months: { type: "number", description: "CASH_TREND : fenêtre d'historique en mois (défaut 6, max 12)." },
        },
        required: ["kind"],
      },
    },
    allowed: EXEC,
    label: "Scénario simulé (lecture seule)",
    run: async (input, user) => {
      const kind = str(input, "kind");
      const now = new Date();
      const stamp = now.toISOString().slice(0, 10);
      const SIM = `SIMULATION du ${stamp} — fondée sur l'état ACTUEL des données, AUCUNE écriture effectuée.`;

      if (kind === "SALARY_CHANGE" || kind === "DEPARTURE" || kind === "HEADCOUNT_CHANGE") {
        // Ces scénarios manipulent des rémunérations : la porte est LE MODULE RH, comme l'écran.
        if (!userCan(user, "RH", "VIEW")) return "Ce scénario lit des rémunérations : il exige le module RH, que votre compte n'a pas.";
      }

      if (kind === "SALARY_CHANGE") {
        const name = str(input, "employee_name");
        const newBase = num(input, "new_base_salary");
        if (!name || newBase == null || newBase <= 0) return "Donner `employee_name` et `new_base_salary` (DZD, mensuel).";
        const emp = await prisma.employee.findFirst({
          where: { fullName: { contains: name, mode: "insensitive" }, isActive: true },
          select: { fullName: true, baseSalary: true, employerCost: true, grossSalary: true },
        });
        if (!emp) return `Aucun employé actif « ${name} ».`;
        const currentBase = toNumber(emp.baseSalary);
        if (currentBase <= 0) return `${emp.fullName} n'a pas de salaire de base renseigné — impossible de simuler sans la donnée réelle.`;
        const currentCost = emp.employerCost != null ? toNumber(emp.employerCost) : toNumber(emp.grossSalary ?? emp.baseSalary);
        // HYPOTHÈSE CENTRALE : les charges suivent proportionnellement le salaire de base.
        const ratio = currentCost / currentBase;
        const newCost = newBase * ratio;
        const payroll = await monthlyPayroll();
        return JSON.stringify({
          simulation: SIM,
          scenario: `${emp.fullName} : salaire de base ${kdzd(currentBase)} → ${kdzd(newBase)} (${Math.round(((newBase - currentBase) / currentBase) * 1000) / 10} %)`,
          estimation: {
            surcoutEmployeurMensuelDzd: dzd(newCost - currentCost),
            surcoutEmployeurAnnuelDzd: dzd((newCost - currentCost) * 12),
            masseSalarialeMensuelle: { avantDzd: dzd(payroll.totalDzd), apresDzd: dzd(payroll.totalDzd - currentCost + newCost) },
          },
          hypotheses: [
            `Les charges patronales restent proportionnelles au salaire de base (ratio actuel ${Math.round(ratio * 100) / 100} conservé) — ESTIMATION, pas un calcul de paie.`,
            payroll.sansCout > 0 ? `${payroll.sansCout} fiche(s) sans coût employeur : brut ou base utilisés en repli dans la masse.` : "Masse calculée sur les coûts employeur des fiches actives.",
          ],
          confiance: "MODÉRÉE — l'ordre de grandeur est fiable, le montant exact dépend du barème réel (IRG, SS).",
          rappel: "Pour AGIR : update_salary (carte de confirmation CRITIQUE) — cette simulation n'a rien modifié.",
        });
      }

      if (kind === "DEPARTURE") {
        const name = str(input, "employee_name");
        if (!name) return "Donner `employee_name`.";
        const emp = await prisma.employee.findFirst({
          where: { fullName: { contains: name, mode: "insensitive" }, isActive: true },
          select: {
            id: true, fullName: true, position: true, employerCost: true, grossSalary: true, baseSalary: true,
            headOf: { select: { name: true } }, reports: { select: { fullName: true }, take: 15 },
            user: { select: { id: true } },
          },
        });
        if (!emp) return `Aucun employé actif « ${name} ».`;
        const uid = emp.user?.id ?? null;
        const [pendingValidations, openTasks, regProducts] = uid
          ? await Promise.all([
              prisma.validationStep.count({ where: { validatorId: uid, status: "PENDING" } }),
              prisma.task.count({ where: { assignedToId: uid, status: { notIn: ["DONE", "CANCELLED"] } } }),
              prisma.regulatoryProduct.count({ where: { responsibleId: uid } }),
            ])
          : [0, 0, 0];
        const cost = emp.employerCost != null ? toNumber(emp.employerCost) : toNumber(emp.grossSalary ?? emp.baseSalary);
        return JSON.stringify({
          simulation: SIM,
          scenario: `Départ de ${emp.fullName} (${emp.position ?? "poste non renseigné"})`,
          exposition: {
            validationsEnAttenteChezLui: pendingValidations,
            tachesOuvertesAReassigner: openTasks,
            dossiersRegulatoryDontIlEstResponsable: regProducts,
            equipesQuIlDirige: emp.headOf.map((d) => d.name),
            rapportsDirectsARerattacher: emp.reports.map((r) => r.fullName),
            observabilite: uid ? "compté sur son compte applicatif" : "AUCUN compte applicatif : l'exposition ERP est invisible ici (pas forcément nulle)",
          },
          estimation: { coutEmployeurLibereAnnuelDzd: dzd(cost * 12) },
          hypotheses: [
            "Le coût libéré suppose un NON-remplacement — un remplacement l'annule (et coûte le recrutement).",
            "L'exposition ne mesure que l'ERP : le savoir informel (relations, historique) part avec la personne et n'est pas chiffrable ici.",
          ],
          confiance: "MODÉRÉE sur les compteurs (exacts au moment T), FAIBLE sur toute conséquence organisationnelle.",
          rappel: "Simulation pure : rien n'a été réassigné, aucune fiche modifiée.",
        });
      }

      if (kind === "HEADCOUNT_CHANGE") {
        const cost = num(input, "monthly_cost");
        const count = Math.max(1, Math.min(50, Math.round(num(input, "count") ?? 1)));
        if (cost == null || cost <= 0) return "Donner `monthly_cost` (coût employeur mensuel estimé d'une recrue, en DZD).";
        const payroll = await monthlyPayroll();
        const delta = cost * count;
        return JSON.stringify({
          simulation: SIM,
          scenario: `Recrutement de ${count} personne(s) à ~${kdzd(cost)}/mois de coût employeur chacune`,
          estimation: {
            surcoutMensuelDzd: dzd(delta),
            surcoutAnnuelDzd: dzd(delta * 12),
            masseSalarialeMensuelle: {
              avantDzd: dzd(payroll.totalDzd),
              apresDzd: dzd(payroll.totalDzd + delta),
              haussePct: payroll.totalDzd > 0 ? Math.round((delta / payroll.totalDzd) * 1000) / 10 : null,
            },
            effectif: { avant: payroll.headcount, apres: payroll.headcount + count },
          },
          hypotheses: [
            "Le coût mensuel fourni est une hypothèse d'entrée — le coût réel dépend du salaire négocié et du barème de charges.",
            "Hors coûts d'entrée (recrutement, matériel, formation) — non modélisés ici.",
          ],
          confiance: "MODÉRÉE — arithmétique exacte sur une hypothèse déclarée.",
          rappel: "Pour AGIR : une demande de recrutement suit le circuit habituel — rien n'a été créé.",
        });
      }

      if (kind === "CASH_TREND") {
        if (!userCan(user, "FINANCES", "VIEW")) return "Ce scénario lit la trésorerie : il exige le module Finances, que votre compte n'a pas.";
        const months = Math.max(3, Math.min(12, Math.round(num(input, "months") ?? 6)));
        const scope = await platformScope(user.id);
        const since = new Date(now.getFullYear(), now.getMonth() - months, 1);
        const txs = await prisma.financeTransaction.findMany({
          where: { AND: [scope, { status: "SETTLED", date: { gte: since } }] },
          select: { direction: true, amount: true, date: true },
          take: 4000,
        });
        const byMonth = new Map<string, { in: number; out: number }>();
        for (const t of txs) {
          const key = `${t.date.getFullYear()}-${String(t.date.getMonth() + 1).padStart(2, "0")}`;
          const cur = byMonth.get(key) ?? { in: 0, out: 0 };
          if (t.direction === "IN") cur.in += toNumber(t.amount); else cur.out += toNumber(t.amount);
          byMonth.set(key, cur);
        }
        const rows = [...byMonth.entries()].sort((a, b) => a[0].localeCompare(b[0]))
          .map(([mois, v]) => ({ mois, recettesDzd: dzd(v.in), depensesDzd: dzd(v.out), resultatDzd: dzd(v.in - v.out) }));
        if (rows.length < 3) {
          return `DONNÉES INSUFFISANTES : ${rows.length} mois de transactions réglées sur la fenêtre — aucune tendance sérieuse ne se projette sur si peu. Je préfère le dire que d'inventer une courbe.`;
        }
        const nets = rows.map((r) => r.resultatDzd);
        const avg = nets.reduce((a, b) => a + b, 0) / nets.length;
        const spread = Math.max(...nets) - Math.min(...nets);
        const compta = await getComptaData(user.id);
        return JSON.stringify({
          simulation: SIM,
          historique: rows,
          tendance: {
            resultatMensuelMoyenDzd: dzd(avg),
            projection3MoisDzd: { basse: dzd((avg - spread / 2) * 3), centrale: dzd(avg * 3), haute: dzd((avg + spread / 2) * 3) },
            aEncaisserAujourdHuiDzd: dzd(compta.aEncaisser),
            aReglerAujourdHuiDzd: dzd(compta.aReglerOrders),
          },
          hypotheses: [
            `Projection NAÏVE : moyenne des ${rows.length} derniers mois prolongée, fourchette = amplitude observée — aucun modèle saisonnier.`,
            "Transactions RÉGLÉES uniquement : un gros encaissement attendu peut tout changer (il est listé « à encaisser », pas projeté).",
          ],
          confiance: spread > Math.abs(avg) * 2 ? "FAIBLE — les mois sont très dispersés, la moyenne dit peu" : "MODÉRÉE — tendance indicative, pas une prévision",
          rappel: "Lecture seule — aucune écriture, aucun engagement.",
        });
      }

      return "Kind inconnu — SALARY_CHANGE, DEPARTURE, HEADCOUNT_CHANGE ou CASH_TREND.";
    },
  },

  {
    def: {
      name: "company_state",
      description:
        "L'ÉTAT CONSOLIDÉ de l'entreprise en un appel — le « jumeau » de pilotage : effectif et masse salariale (si module RH), " +
        "trésorerie du mois (si module Finances), paiements au centre, validations en attente, tâches en retard, stocks " +
        "critiques, dossiers Regulatory actifs, et les signaux d'alerte majeurs. Chaque section porte sa source ; une section " +
        "fermée à vos droits est dite fermée, jamais devinée.",
      input_schema: { type: "object", properties: {} },
    },
    allowed: EXEC,
    label: "État consolidé de l'entreprise",
    run: async (_input, user) => {
      // Les signaux passent par l'ÉTAT CHAUD (fabric F5) : précalculés au battement, invalidés
      // par les faits métier, et la FRAÎCHEUR se dit au lieu de laisser croire au temps réel.
      const [payroll, centreAwaiting, validationsPending, tasksLate, regActive, lectureAlertes] = await Promise.all([
        userCan(user, "RH", "VIEW") ? monthlyPayroll() : Promise.resolve(null),
        prisma.expenseOrder.count({ where: { centralStatus: "AWAITING", ...ORDRE_NON_ANNULE } }),
        prisma.validationRequest.count({ where: { status: "PENDING" } }),
        prisma.task.count({ where: { status: { in: ["TODO", "IN_PROGRESS"] }, dueDate: { lt: new Date() } } }),
        prisma.regulatoryProduct.count({ where: { status: { notIn: [...FINISHED_REG_STATUSES] } } }),
        alertesExecutivesChaudes(user).catch(() => null),
      ]);
      const alerts: ExecutiveAlert[] = lectureAlertes?.valeur ?? [];
      const compta = userCan(user, "FINANCES", "VIEW") ? await getComptaData(user.id).catch(() => null) : null;
      const critical = alerts.filter((a) => a.criticite === "CRITICAL");
      const important = alerts.filter((a) => a.criticite === "IMPORTANT");

      return JSON.stringify({
        litLe: new Date().toISOString().slice(0, 16).replace("T", " "),
        effectifEtMasse: payroll
          ? { effectifActif: payroll.headcount, masseSalarialeMensuelleDzd: dzd(payroll.totalDzd), source: "fiches employé actives (coût employeur ; brut/base en repli)" }
          : "section fermée — exige le module RH",
        tresorerie: compta
          ? {
              recettesDuMoisDzd: dzd(compta.recettesMois), depensesDuMoisDzd: dzd(compta.depensesMois),
              resultatDuMoisDzd: dzd(compta.resultatMois), aEncaisserDzd: dzd(compta.aEncaisser), aReglerDzd: dzd(compta.aReglerOrders),
              source: "transactions finances + ordres de dépense (entité en cours)",
            }
          : "section fermée — exige le module Finances",
        circuits: {
          paiementsEnAttenteAuCentre: centreAwaiting,
          validationsEnAttente: validationsPending,
          tachesEnRetard: tasksLate,
          dossiersRegulatoryOuverts: regActive,
        },
        signaux: {
          critiques: critical.length, importants: important.length,
          premiers: [...critical, ...important].slice(0, 5).map((a) => ({ titre: a.titre, detail: a.detail, lien: a.lien })),
          source: "détecteurs proactifs (executive_alerts pour le détail complet)",
          fraicheur: lectureAlertes ? fraicheurDeLecture(lectureAlertes) : "signaux indisponibles (détecteurs en échec)",
        },
        rappel: "Vue COMPOSÉE des mêmes tables que les écrans — jamais une seconde source de vérité : au moindre doute, ouvrir le module.",
      });
    },
  },

  {
    def: {
      name: "ceo_attention",
      description:
        "TRIE ce qui mérite VOTRE attention en trois bacs — DOIT DÉCIDER (bloqué sans vous), DEVRAIT SAVOIR (signaux critiques " +
        "et importants), SURVEILLER (à l'œil, rien à faire) — peu d'éléments, bien choisis, chacun avec son lien. " +
        "À utiliser pour « sur quoi dois-je me concentrer ? », « qu'est-ce qui m'attend ce matin ? ».",
      input_schema: { type: "object", properties: {} },
    },
    allowed: EXEC,
    label: "Tri de l'attention",
    run: async (_input, user) => {
      const [center, lectureAlertes, overdueCommitments] = await Promise.all([
        getActionCenter(user),
        alertesExecutivesChaudes(user).catch(() => null),
        prisma.executiveCommitment.count({ where: { ownerId: user.id, status: "OPEN", dueAt: { lt: new Date() } } }),
      ]);
      const alerts: ExecutiveAlert[] = lectureAlertes?.valeur ?? [];
      const doitDecider = center.items.slice(0, 6).map((i) => ({
        quoi: i.title, detail: i.subtitle, module: i.module, echeance: i.deadline?.slice(0, 10) ?? null, lien: i.href,
      }));
      const devraitSavoir = alerts.filter((a) => a.criticite === "CRITICAL" || a.criticite === "IMPORTANT").slice(0, 6)
        .map((a) => ({ quoi: a.titre, detail: a.detail, criticite: a.criticite, lien: a.lien }));
      const surveiller = alerts.filter((a) => a.criticite === "WATCH").slice(0, 5)
        .map((a) => ({ quoi: a.titre, detail: a.detail, lien: a.lien }));

      return JSON.stringify({
        doitDecider: { total: center.items.length, premiers: doitDecider, principe: "bloqué tant que VOUS n'avez pas tranché" },
        devraitSavoir: {
          total: alerts.filter((a) => a.criticite === "CRITICAL" || a.criticite === "IMPORTANT").length,
          premiers: devraitSavoir,
          engagementsEnRetard: overdueCommitments || undefined,
        },
        surveiller: { total: alerts.filter((a) => a.criticite === "WATCH").length, premiers: surveiller },
        fraicheur: lectureAlertes ? fraicheurDeLecture(lectureAlertes) : "signaux indisponibles (détecteurs en échec)",
        principe: "PEU d'éléments, bien choisis — le reste existe dans les modules, pas dans votre matinée. Rien ici n'a déclenché d'action.",
      });
    },
  },
];
