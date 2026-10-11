import { prisma } from "@/lib/prisma";
import { tempsEnAttente, peutTenir, estDirectionOperations, estDirectionMarketingPoste } from "@/lib/ad-pro/validation-poste";
import { canAccessEntity } from "@/lib/entity-access";
import { auNomDeQui } from "@/lib/hr/stand-in-resolve";
import { getLeavesToDecide } from "@/lib/queries/hr";
import { dedoublonner, trierConges, PREFIXE_CONGE, PREFIXE_DEMANDE_ADMIN, PREFIXE_RESTE } from "@/lib/queries/mes-decisions";
import { clausePlansADecider } from "@/lib/sfe/tournee";
import { userCan, hasGlobalView, hasRole, scopeRegulatory, scopeDirectives, type SessionUser } from "@/lib/rbac";
import { getPendingValidations } from "@/lib/queries/validations";
import { dossiersPromoAMonTour } from "@/lib/queries/promo-circuit";
import { clauseDemandesSecretariatVisibles } from "@/lib/queries/visibilite-listes";
import { libelleEtape } from "@/lib/promo-material/circuit";
import { toNumber, formatCurrency } from "@/lib/utils";
import { polesLisibles } from "@/lib/lecteurs/consulting";
import { reécriteLienNotification } from "@/lib/notifications/lien-actuel";
import type { PromoMaterialStatus } from "@prisma/client";
import { MARCHE_N1_MISSIONS } from "@/lib/queries/missions";
import { lienMission, LIEN_MISSIONS_A_VALIDER } from "@/lib/chemins/espace";
import {
  type BadgeTone, TASK_STATUS, ADMIN_REQUEST_STATUS, REGULATORY_STATUS, EXPENSE_ORDER_STATUS, CONGRESS_REQUEST_STATUS, MEDICAL_INFO_STATUS, PROMO_MATERIAL_STATUS, DIRECTIVE_STATUS, SUPPORT_STATUS, DOSSIER_STATUS,
} from "@/lib/labels";

/**
 * Les préfixes d'identité que relisent les consommateurs du centre : l'outil de file d'Adam écarte les
 * congés (il les relit à part), la boîte de décision garde congés et achats (elle n'a pas d'autre file pour eux).
 */
export { PREFIXE_CONGE, PREFIXE_DEMANDE_ADMIN };

/**
 * UN GESTE QUE CETTE PERSONNE PEUT POSER SUR CETTE LIGNE, ICI ET MAINTENANT.
 *
 * `phrase` est rédigée PAR LE SERVEUR, avec la référence exacte : c'est ce qui permet de
 * trancher depuis la conversation sans avoir à retrouver « VAL-2026-014 » à la main. Elle
 * n'exécute rien — elle entre par la porte normale (proposition → carte → action canonique).
 *
 * On ne pose une action QUE si elle est décidable maintenant : proposer « Approuver » sur une
 * étape séquentielle dont ce n'est pas encore le tour promettrait un geste que l'exécution
 * refuserait — une déception, et une perte de confiance dans tous les autres boutons.
 */
export interface ActionSuggestion {
  libelle: string;
  phrase: string;
  ton?: "primaire" | "danger";
}

export interface ActionItem {
  key: string;
  title: string;
  subtitle: string;
  module: string;
  href: string;
  kind: "validation" | "request" | "payment" | "regulatory" | "task";
  priority: string | null;
  deadline: string | null;
  /**
   * L'IDENTITÉ DE L'OBJET (« LEAVE_REQUEST:<id> », « ADMIN_REQUEST:<id> »…) — ce qui dédoublonne
   * (lot E2) : une demande assignée ET à valider, une prise en charge « À arbitrer » ET « Validation
   * préliminaire » n'est montrée qu'une fois, au premier bloc (`dedoublonner`).
   */
  objet: string;
  /**
   * DEPUIS QUAND L'ÉLÉMENT ATTEND un geste (07-05, ISO) : l'arrivée à la marche, la soumission,
   * l'escalade, le renvoi, le dépôt. `null` quand rien ne le date à coup sûr — on ne fabrique pas
   * une ancienneté (§118.16).
   */
  depuis: string | null;
  owner: string;
  statusLabel: string | null;
  statusTone: BadgeTone | null;
  /** Ce qu'on peut faire sans quitter la conversation. Absent = seul le lien reste. */
  actions?: ActionSuggestion[];
}

export interface ActionNotification {
  id: string;
  title: string;
  body: string;
  link: string;
  type: string;
  createdAt: string;
}

/** Le jour civil d'Alger d'un instant — « 01/11/2026 ». */
const jourAlger = (d: Date) => d.toLocaleDateString("fr-FR", { timeZone: "Africa/Algiers" });

/** La marche où un congé attend, dite à la personne qui signe. */
const MARCHE_CONGE: Record<string, string> = {
  MANAGER: "marche du N+1",
  HR: "marche des RH",
  DG: "marche de la direction générale",
};

/** Au-delà, une ligne le dit et mène à la liste complète (§118.60). */
const PLAFOND_DECISIONS = 40;

const resolve = (map: Record<string, { label: string; tone: BadgeTone }>, v: string) => ({
  statusLabel: map[v]?.label ?? v,
  statusTone: map[v]?.tone ?? ("neutral" as BadgeTone),
});

/**
 * Les libellés et adresses des demandes Ad & Pro à étapes, EN LOT (une requête par nature) — pour
 * la section « À arbitrer ». Une ligne introuvable (supprimée entre-temps) n'a pas de libellé et
 * n'est pas listée : on ne montre pas un lien vers rien.
 */
async function libellesAdPro(refs: readonly { type: string; id: string }[]): Promise<Map<string, { titre: string; nature: string; href: string; demandeur: string | null }>> {
  const out = new Map<string, { titre: string; nature: string; href: string; demandeur: string | null }>();
  const ids = (t: string) => refs.filter((r) => r.type === t).map((r) => r.id);
  const [spo, evt, intl, nat] = await Promise.all([
    ids("SPONSORING").length ? prisma.sponsoringRequest.findMany({ where: { id: { in: ids("SPONSORING") } }, select: { id: true, reference: true, institution: true, requesterId: true } }) : [],
    ids("EVENT").length ? prisma.event.findMany({ where: { id: { in: ids("EVENT") } }, select: { id: true, name: true, requesterId: true } }) : [],
    ids("CONGRESS_INTERNATIONAL").length ? prisma.congressInternational.findMany({ where: { id: { in: ids("CONGRESS_INTERNATIONAL") } }, select: { id: true, name: true, requesterId: true } }) : [],
    ids("CONGRESS_NATIONAL").length ? prisma.congressNational.findMany({ where: { id: { in: ids("CONGRESS_NATIONAL") } }, select: { id: true, name: true, requesterId: true } }) : [],
  ]);
  const demandeurs = [...spo, ...evt, ...intl, ...nat].map((r) => r.requesterId).filter((x): x is string => Boolean(x));
  const noms = new Map((demandeurs.length
    ? await prisma.user.findMany({ where: { id: { in: [...new Set(demandeurs)] } }, select: { id: true, name: true } })
    : []).map((u) => [u.id, u.name]));
  const nom = (id: string | null) => (id ? noms.get(id) ?? null : null);
  for (const r of spo) out.set(`SPONSORING:${r.id}`, { titre: `${r.reference} — ${r.institution}`, nature: "Sponsoring", href: `/sponsoring/${r.id}`, demandeur: nom(r.requesterId) });
  for (const r of evt) out.set(`EVENT:${r.id}`, { titre: r.name, nature: "Événement", href: `/events/${r.id}`, demandeur: nom(r.requesterId) });
  for (const r of intl) out.set(`CONGRESS_INTERNATIONAL:${r.id}`, { titre: r.name, nature: "Prise en charge internationale", href: `/congress-international/${r.id}`, demandeur: nom(r.requesterId) });
  for (const r of nat) out.set(`CONGRESS_NATIONAL:${r.id}`, { titre: r.name, nature: "Prise en charge nationale", href: `/congress-national/${r.id}`, demandeur: nom(r.requesterId) });
  return out;
}

export async function getActionCenter(user: SessionUser) {
  const now = new Date();
  const items: ActionItem[] = [];

  // 1. Mes tâches (WORKSPACE — tout le monde)
  const tasks = await prisma.task.findMany({
    where: { assignedToId: user.id, status: { in: ["TODO", "IN_PROGRESS"] } },
    orderBy: [{ dueDate: "asc" }, { priority: "desc" }],
    take: 60,
  });
  for (const t of tasks) {
    items.push({
      key: `task-${t.id}`, objet: `TASK:${t.id}`, title: t.title, subtitle: t.module ?? "", module: "Mon espace",
      // La tâche s'ouvre DANS son onglet (07/10) — « Mon espace » ne liste plus les tâches.
      href: `/mon-espace/taches?tache=${t.id}`, kind: "task", priority: t.priority,
      deadline: t.dueDate?.toISOString() ?? null, depuis: t.createdAt.toISOString(), owner: "", ...resolve(TASK_STATUS, t.status),
    });
  }

  // 2. Validations à faire — SEULEMENT celles où c'est MON tour. Une étape séquentielle en
  //    attente du validateur précédent n'est pas du travail à faire : la lister gonflait la
  //    file d'items sur lesquels aucun geste n'est possible. Elle reste visible sur l'écran
  //    /validations, section « Qui vous reviendront » — rien n'est perdu, c'est trié.
  if (userCan(user, "VALIDATIONS", "VIEW")) {
    const pending = await getPendingValidations(user.id);
    for (const v of pending) {
      if (!v.actionable) continue;
      items.push({
        key: `val-${v.stepId}`, objet: `VALIDATION_REQUEST:${v.requestId}`, title: v.title,
        // En intérim, la ligne dit pour QUI l'on tranche : signer « pour soi » une étape adressée à
        // l'absent, sans le savoir, ferait porter la décision au mauvais nom dans la tête de chacun.
        subtitle: [v.pourLeCompteDe ? `Intérim pour ${v.pourLeCompteDe}` : null, v.amount !== null ? formatCurrency(v.amount) : v.objectType].filter(Boolean).join(" · "),
        // LE LIEN MÈNE DANS LA VALIDATION, pas sur l'écran du module. Arriver sur une liste
        // pour y rechercher la ligne qu'on vient de cliquer est un pas de trop — et c'est
        // celui qu'on ne fait pas : on repart, et la validation attend un jour de plus.
        module: "Validations", href: `/validations?focus=${v.stepId}#val-${v.stepId}`, kind: "validation", priority: v.priority,
        // À SON TOUR depuis : le dépôt, la décision du rang précédent, ou la resoumission (07-05).
        deadline: v.deadline, depuis: v.depuis, owner: v.requester,
        statusLabel: "À valider",
        statusTone: "warning",
        actions: [
          { libelle: "Approuver", phrase: `Approuve la validation ${v.reference}`, ton: "primaire" as const },
          { libelle: "Refuser", phrase: `Refuse la validation ${v.reference}`, ton: "danger" as const },
        ],
      });
    }
  }

  // 2b. CE QUI ATTEND MA DÉCISION — EN PERSONNE, OU POUR L'ABSENT QUE JE REMPLACE (lot E2 — audit
  //     360°, N2, M09 ; §118.185, I18).
  //
  // Chaque file se lit avec la règle que son ACTION applique, et une seule fois :
  //   · les CONGÉS — la file de la porte (`getLeavesToDecide` → `clauseFileConges`, lot E1) : le N+1
  //     enregistré ou actuel, son intérimaire, les RH à leur marche, la direction générale. Le bloc
  //     d'intérim d'avant ne lisait que la marche du N+1 et la page relisait la file à côté : le même
  //     congé était montré deux fois, et compté une ;
  //   · les ACHATS — l'approbation EN ATTENTE, que la décision clôt. Le `validatorId` de la demande y
  //     reste APRÈS la décision : la lire laissait l'achat tranché « à traiter » chez le N+1 (N2) ;
  //   · les PLANS DE TOURNÉE — le réviseur tant que le plan est soumis, le N+2 dès qu'il est escaladé,
  //     jamais les deux (`accesAuPlan.decider`). Leur file n'existait nulle part (M09) ;
  //   · les FORMATIONS de l'absent (intérim seulement : celles du N+1 en personne vivent sur /formations).
  // Jamais mes propres demandes : aucune porte ne me les laisse trancher. Et le pouvoir n'est pas la file
  // (§118.153a) : la vue globale et le droit « Valider » d'un module tranchent partout, ils ne font pas
  // une file — la leur se lit sur l'écran de chaque module.
  const auNom = await auNomDeQui(user.id);
  const absents = auNom.absents.map((a) => a.userId);
  const signataires = [...auNom.ids];
  const pour = (nom: string | null | undefined) => `Intérim pour ${nom ?? "l'absent"}`;
  const [conges, approbations, plans] = await Promise.all([
    getLeavesToDecide(user),
    prisma.adminApproval.findMany({
      where: {
        status: "PENDING", validatorId: { in: signataires },
        request: { deletedAt: null, status: { not: "CANCELLED" }, OR: [{ requesterId: null }, { requesterId: { not: user.id } }] },
      },
      select: {
        id: true, validatorId: true, createdAt: true,
        request: { select: { id: true, title: true, reference: true, deadline: true, priority: true, requester: { select: { name: true } } } },
      },
      orderBy: { createdAt: "asc" }, take: PLAFOND_DECISIONS + 1,
    }),
    // La clause est celle de la page du plan (`clausePlansADecider`, à côté de la règle qu'elle projette).
    prisma.tourPlan.findMany({
      where: clausePlansADecider(user.id, absents),
      select: {
        id: true, status: true, reviewerId: true, escalatedToId: true, submittedAt: true, escalatedAt: true,
        periodStart: true, periodEnd: true, rep: { select: { name: true } },
      },
      orderBy: { submittedAt: "asc" }, take: PLAFOND_DECISIONS + 1,
    }),
  ]);

  // (a) LES CONGÉS — une ligne par demande, l'attente la plus ancienne d'abord. La page les rend dans
  //     leur propre bloc (la fiche, les boutons) : `conges` voyage avec les lignes (§118.5). Au-delà du
  //     plafond, une ligne le dit — elle porte l'identité d'un congé, donc la page ne la reprend pas.
  const congesParAnciennete = trierConges(conges);
  for (const c of congesParAnciennete.slice(0, PLAFOND_DECISIONS)) {
    const interim = c.pourLeCompteDe !== null;
    items.push({
      key: interim ? `interim-leave-${c.id}` : `conge-${c.id}`, objet: `${PREFIXE_CONGE}${c.id}`,
      title: `Congé — ${c.employee}`,
      subtitle: [interim ? pour(c.pourLeCompteDe) : null, `${c.days} j`, MARCHE_CONGE[c.stage] ?? null].filter(Boolean).join(" · "),
      module: "Ressources humaines", href: "/mon-espace#conges-a-signer", kind: "validation", priority: null,
      deadline: c.startDate, depuis: c.depuis, owner: c.employee, statusLabel: "À signer", statusTone: "warning",
    });
  }
  if (conges.length > PLAFOND_DECISIONS) {
    items.push({
      key: "conge-reste", objet: `${PREFIXE_CONGE}${PREFIXE_RESTE}`,
      title: `${conges.length - PLAFOND_DECISIONS} autre(s) congé(s) attendent votre signature`,
      subtitle: "Les plus anciens sont listés ci-dessus", module: "Ressources humaines", href: "/mon-espace#conges-a-signer",
      kind: "validation", priority: null, deadline: null, depuis: null, owner: "", statusLabel: "À signer", statusTone: "warning",
    });
  }

  // (b) LES ACHATS — depuis la demande de validation (l'approbation naît à ce moment-là).
  for (const a of approbations.slice(0, PLAFOND_DECISIONS)) {
    const interim = a.validatorId !== user.id;
    items.push({
      key: interim ? `interim-achat-${a.id}` : `approbation-${a.id}`, objet: `${PREFIXE_DEMANDE_ADMIN}${a.request.id}`,
      title: a.request.title,
      subtitle: [interim ? pour(auNom.nomDe(a.validatorId)) : null, a.request.reference].filter(Boolean).join(" · "),
      module: "Demandes administratives", href: `/demandes/${a.request.id}`, kind: "validation", priority: a.request.priority,
      deadline: a.request.deadline?.toISOString() ?? null, depuis: a.createdAt.toISOString(),
      owner: a.request.requester?.name ?? "", statusLabel: "À valider", statusTone: "warning",
    });
  }
  if (approbations.length > PLAFOND_DECISIONS) {
    items.push({
      key: "approbation-reste", objet: `${PREFIXE_RESTE}approbations`, title: "D'autres demandes attendent votre validation",
      subtitle: "Les plus anciennes sont listées ci-dessus", module: "Demandes administratives", href: "/demandes/approvals",
      kind: "validation", priority: null, deadline: null, depuis: null, owner: "", statusLabel: "À valider", statusTone: "warning",
    });
  }

  // (b bis) LES POSTES AD & PRO SOUMIS — à ceux qui les décident (§118.202). La porte de la décision
  // (`canAllocate`) laisse décider la vue globale ET tout rôle qui VALIDE le module de la demande ;
  // la notification ne suffit pas : un poste soumis AVANT qu'elle atteigne la bonne personne
  // (le billet hors budget d'un congrès, §118.200) restait invisible ailleurs que sur sa fiche.
  // La file lit la MÊME règle que la porte, donc elle montre aussi les demandes déjà en cours.
  {
    const PARENTS_POSTE = [
      { colonne: "sponsoringId", module: "SPONSORING", type: "SPONSORING", path: "/sponsoring" },
      { colonne: "congressNationalId", module: "CONGRESS_NATIONAL", type: "CONGRESS_NATIONAL", path: "/congress-national" },
      { colonne: "congressInternationalId", module: "CONGRESS_INTERNATIONAL", type: "CONGRESS_INTERNATIONAL", path: "/congress-international" },
      { colonne: "eventId", module: "EVENTS", type: "EVENT", path: "/events" },
    ] as const;
    // DEUX TEMPS (§118.204) : la Direction des opérations, puis la Direction Marketing (montant et
    // budget). La file ne montre à chacun que le temps qu'il TIENT — la règle de l'action
    // (`peutTenir`), avec le demandeur de la demande (on n'arbitre pas sa propre demande).
    const moi = await prisma.user.findUnique({ where: { id: user.id }, select: { role: true, secondaryRole: true } }) ?? { role: user.role };
    const tientUnTemps = moi.role === "SUPER_ADMIN" || estDirectionOperations(moi) || estDirectionMarketingPoste(moi);
    const decides = tientUnTemps ? PARENTS_POSTE.filter((p) => hasGlobalView(user.role) || userCan(user, p.module, "VIEW")) : [];
    if (decides.length > 0) {
      // PAR LOTS, filtrés au fur et à mesure (§118.60) : couper AVANT le filtre `peutTenir` faisait
      // disparaître, sans signe, les postes d'une personne derrière 160 postes attendant quelqu'un
      // d'autre. On lit jusqu'à avoir de quoi remplir la file, borné à 5 lots.
      const LOT_POSTES = PLAFOND_DECISIONS * 4;
      const lirePostes = (skip: number) => prisma.adProItem.findMany({
        where: { status: "PENDING", OR: decides.map((p) => ({ [p.colonne]: { not: null } })) },
        select: {
          id: true, label: true, amountEstimated: true, budgetKind: true, addedAfterDecision: true, submittedAt: true, createdAt: true,
          opsDecidedAt: true, status: true,
          sponsoringId: true, congressNationalId: true, congressInternationalId: true, eventId: true,
          sponsoring: { select: { requesterId: true } }, congressNational: { select: { requesterId: true } },
          congressInternational: { select: { requesterId: true } }, event: { select: { requesterId: true } },
        },
        orderBy: [{ submittedAt: "asc" }, { createdAt: "asc" }],
        take: LOT_POSTES, skip,
      });
      type PosteLu = Awaited<ReturnType<typeof lirePostes>>[number];
      const demandeurDe = (p: PosteLu) =>
        p.sponsoring?.requesterId ?? p.congressNational?.requesterId ?? p.congressInternational?.requesterId ?? p.event?.requesterId ?? null;
      const postes: PosteLu[] = [];
      let restePeutEtre = false;
      for (let lotsLus = 0; ; lotsLus += 1) {
        const lot = await lirePostes(lotsLus * LOT_POSTES);
        const ids = [...new Set(lot.map(demandeurDe).filter((x): x is string => Boolean(x)))];
        const demandeurs = new Map((ids.length
          ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, role: true, secondaryRole: true } })
          : []).map((u) => [u.id, u]));
        for (const p of lot) {
          const temps = tempsEnAttente(p);
          const rid = demandeurDe(p);
          if (temps !== null && peutTenir(temps, moi, rid ? demandeurs.get(rid) ?? null : null)) postes.push(p);
        }
        if (lot.length < LOT_POSTES) break;
        if (postes.length >= PLAFOND_DECISIONS * 2 || lotsLus >= 4) { restePeutEtre = true; break; }
      }
      const lisibles: { p: (typeof postes)[number]; parent: (typeof PARENTS_POSTE)[number]; parentId: string }[] = [];
      for (const p of postes) {
        const parent = decides.find((d) => p[d.colonne]);
        const parentId = parent ? p[parent.colonne] : null;
        if (!parent || !parentId) continue;
        // La fiche doit s'ouvrir : une ligne qui mène à une page refusée n'est pas un geste.
        if (await canAccessEntity(user, parent.type, parentId, "VIEW")) lisibles.push({ p, parent, parentId });
        if (lisibles.length >= PLAFOND_DECISIONS) break;
      }
      for (const { p, parent, parentId } of lisibles) {
        const montant = p.amountEstimated != null ? ` · ${formatCurrency(toNumber(p.amountEstimated))}` : "";
        const hors = p.budgetKind === "ADDITIONAL" ? "hors budget" : p.addedAfterDecision ? "ajouté après la décision" : null;
        items.push({
          key: `poste-${p.id}`, objet: `AD_PRO_ITEM:${p.id}`, title: p.label,
          subtitle: [hors, p.opsDecidedAt ? `validé par la Direction des opérations — montant et budget à décider${montant}` : `poste à valider${montant}`].filter(Boolean).join(" · "),
          module: "Ad & Pro", href: `${parent.path}/${parentId}`, kind: "validation", priority: null, deadline: null,
          depuis: (p.submittedAt ?? p.createdAt).toISOString(), owner: "", statusLabel: "À décider", statusTone: "warning",
        });
      }
      if ((postes.length > lisibles.length && lisibles.length >= PLAFOND_DECISIONS) || (restePeutEtre && lisibles.length >= PLAFOND_DECISIONS)) {
        items.push({
          key: "poste-reste", objet: `${PREFIXE_RESTE}postes`, title: "D'autres postes Ad & Pro attendent votre décision",
          subtitle: "Les plus anciens sont listés ci-dessus", module: "Ad & Pro", href: "/ad-pro",
          kind: "validation", priority: null, deadline: null, depuis: null, owner: "", statusLabel: "À décider", statusTone: "warning",
        });
      }
    }
  }

  // (c) LES PLANS DE TOURNÉE — depuis la soumission, ou depuis l'escalade quand le plan est chez le N+2.
  for (const p of plans.slice(0, PLAFOND_DECISIONS)) {
    const escalade = p.status === "ESCALATED";
    const decideur = escalade ? p.escalatedToId : p.reviewerId;
    const interim = decideur !== user.id;
    const arrivee = escalade ? p.escalatedAt ?? p.submittedAt : p.submittedAt;
    items.push({
      key: interim ? `interim-plan-${p.id}` : `plan-${p.id}`, objet: `TOUR_PLAN:${p.id}`,
      title: `Plan de tournée — ${p.rep.name}`,
      subtitle: [interim ? pour(auNom.nomDe(decideur)) : null, `du ${jourAlger(p.periodStart)} au ${jourAlger(p.periodEnd)}`, escalade ? "escaladé au N+2" : null]
        .filter(Boolean).join(" · "),
      module: "Promotion médicale", href: `/medical/plan-de-tournee?plan=${p.id}`, kind: "validation", priority: null,
      deadline: null, depuis: arrivee?.toISOString() ?? null, owner: p.rep.name, statusLabel: "À trancher", statusTone: "warning",
    });
  }
  if (plans.length > PLAFOND_DECISIONS) {
    items.push({
      key: "plan-reste", objet: `${PREFIXE_RESTE}plans`, title: "D'autres plans de tournée attendent votre décision",
      subtitle: "Les plus anciens sont listés ci-dessus", module: "Promotion médicale", href: "/medical/plan-de-tournee",
      kind: "validation", priority: null, deadline: null, depuis: null, owner: "", statusLabel: "À trancher", statusTone: "warning",
    });
  }

  // (d) LES FORMATIONS DE L'ABSENT — la marche du N+1, au nom de l'absent (I18).
  if (absents.length > 0) {
    const fiches = await prisma.employee.findMany({ where: { userId: { in: absents } }, select: { id: true, userId: true } });
    const ficheIds = fiches.map((f) => f.id);
    const nomDeLaFiche = new Map(fiches.map((f) => [f.id, auNom.nomDe(f.userId)]));
    const formations = ficheIds.length
      ? await prisma.training.findMany({
          where: {
            status: "PENDING", stage: "MANAGER", NOT: { requesterId: user.id },
            OR: [{ managerId: { in: ficheIds } }, { requester: { employee: { managerId: { in: ficheIds } } } }],
          },
          select: { id: true, title: true, reference: true, managerId: true, createdAt: true },
          orderBy: { createdAt: "asc" }, take: 40,
        })
      : [];
    for (const f of formations) {
      items.push({
        key: `interim-formation-${f.id}`, objet: `TRAINING:${f.id}`, title: f.title, subtitle: `${pour(f.managerId ? nomDeLaFiche.get(f.managerId) : null)} · ${f.reference}`,
        module: "Formations", href: "/formations", kind: "validation", priority: null,
        // La marche du N+1 est la première : elle attend depuis le dépôt.
        deadline: null, depuis: f.createdAt.toISOString(), owner: "", statusLabel: "À trancher", statusTone: "warning",
      });
    }
  }

  // (e) LES MISSIONS AD & PRO (Direction, 10/2026) — les ordres de mission à valider comme N+1 (une décision), et
  //     mes invitations à confirmer (un geste). Les deux se tranchent dans « Mon espace › Mes missions ».
  const [omAValider, invitationsMission] = await Promise.all([
    prisma.hrDocumentRequest.findMany({
      where: MARCHE_N1_MISSIONS(user.id),
      select: { id: true, type: true, createdAt: true, details: true, employee: { select: { fullName: true } } },
      orderBy: { createdAt: "asc" }, take: 30,
    }).catch(() => []),
    prisma.missionAssignment.findMany({
      where: { userId: user.id, archivedAt: null, response: "INVITEE" },
      select: { id: true, createdAt: true, dateDepart: true },
      orderBy: { createdAt: "asc" }, take: 30,
    }).catch(() => []),
  ]);
  for (const o of omAValider) {
    items.push({
      key: `om-n1-${o.id}`, objet: `HR_REQUEST:${o.id}`, title: `${o.type === "EXPENSE_REPORT" ? "Note de frais de mission" : "Ordre de mission"} — ${o.employee.fullName}`, subtitle: o.details ?? "",
      module: "Missions", href: LIEN_MISSIONS_A_VALIDER, kind: "validation", priority: null,
      deadline: null, depuis: o.createdAt.toISOString(), owner: "", statusLabel: "À valider (N+1)", statusTone: "warning",
    });
  }
  for (const m of invitationsMission) {
    items.push({
      key: `mission-invit-${m.id}`, objet: `MISSION_ASSIGNMENT:${m.id}`, title: "Demande de participation", subtitle: "Votre fiche, ou votre réponse",
      module: "Missions", href: lienMission(m.id), kind: "request", priority: null,
      deadline: m.dateDepart?.toISOString() ?? null, depuis: m.createdAt.toISOString(), owner: "", statusLabel: "À accepter", statusTone: "warning",
    });
  }

  // 2c. À CORRIGER — MES DEMANDES AD & PRO RENVOYÉES POUR CORRECTION (§118.186 — audit 360°, R02/R03).
  //
  // Un renvoi rend la main au DEMANDEUR : sans cette ligne, il l'apprenait par une notification qui
  // se perd, et la demande attendait — chez lui, sans qu'aucun écran ne le lui rappelle. Le statut
  // projeté (« RETURNED ») suffit à la trouver ; le dernier renvoi donne l'étape et le motif.
  const PLAFOND_A_CORRIGER = 30;
  // Un contrat de consulting RENVOYÉ est un brouillon qui porte son renvoi (audit 360°, lot C4a) — dans
  // les pôles que la personne lit : un contrat passé aux RH ne s'ouvre plus pour qui n'a pas les RH.
  const polesDuPorteur = polesLisibles((m) => userCan(user, m, "VIEW"));
  const [spoR, ciR, cnR, evR, coR, payR, recR, planR] = await Promise.all([
    prisma.sponsoringRequest.findMany({ where: { requesterId: user.id, status: "RETURNED" }, select: { id: true, reference: true, institution: true }, orderBy: { updatedAt: "asc" }, take: PLAFOND_A_CORRIGER + 1 }),
    prisma.congressInternational.findMany({ where: { requesterId: user.id, requestStatus: "RETURNED" }, select: { id: true, name: true }, orderBy: { updatedAt: "asc" }, take: PLAFOND_A_CORRIGER + 1 }),
    prisma.congressNational.findMany({ where: { requesterId: user.id, requestStatus: "RETURNED" }, select: { id: true, name: true }, orderBy: { updatedAt: "asc" }, take: PLAFOND_A_CORRIGER + 1 }),
    prisma.event.findMany({ where: { requesterId: user.id, requestStatus: "RETURNED" }, select: { id: true, name: true }, orderBy: { updatedAt: "asc" }, take: PLAFOND_A_CORRIGER + 1 }),
    polesDuPorteur.length
      ? prisma.consultingContract.findMany({
          where: { requesterId: user.id, status: "DRAFT", returnedAt: { not: null }, pole: { in: polesDuPorteur } },
          select: { id: true, reference: true, title: true, returnNote: true, returnedAt: true }, orderBy: { returnedAt: "asc" }, take: PLAFOND_A_CORRIGER + 1,
        })
      : Promise.resolve([] as { id: string; reference: string; title: string; returnNote: string | null; returnedAt: Date | null }[]),
    // Une demande de PAIEMENT renvoyée par les Finances, et une demande de RECRUTEMENT renvoyée pour
    // correction (§118.192) : deux renvois qui rendaient la main sans qu'aucun écran ne la rappelle.
    prisma.paymentRequest.findMany({
      where: { requesterId: user.id, status: "CHANGES_REQUESTED" },
      select: { id: true, reference: true, title: true }, orderBy: { updatedAt: "asc" }, take: PLAFOND_A_CORRIGER + 1,
    }),
    userCan(user, "RECRUITMENT", "VIEW")
      ? prisma.recruitmentRequest.findMany({
          where: { requesterId: user.id, stage: "RETURNED" },
          select: { id: true, reference: true, position: true, returnNote: true, returnedAt: true }, orderBy: { returnedAt: "asc" }, take: PLAFOND_A_CORRIGER + 1,
        })
      : Promise.resolve([] as { id: string; reference: string; position: string; returnNote: string | null; returnedAt: Date | null }[]),
    // UN PLAN DE TOURNÉE REJETÉ OU ROUVERT POUR RÉVISION (§118.193) : 48 h pour le resoumettre, et rien ne le
    // rappelait hors de la page du plan — c'est précisément le délai qu'on rate.
    userCan(user, "MEDICAL", "VIEW")
      ? prisma.tourPlan.findMany({
          where: { repId: user.id, status: { in: ["REJECTED", "REVISION"] } },
          select: { id: true, periodStart: true, periodEnd: true, status: true, rejectionComment: true, revisionNote: true, resubmitDueAt: true, decidedAt: true, revisionRequestedAt: true },
          orderBy: { resubmitDueAt: "asc" }, take: PLAFOND_A_CORRIGER + 1,
        })
      : Promise.resolve([] as { id: string; periodStart: Date; periodEnd: Date; status: string; rejectionComment: string | null; revisionNote: string | null; resubmitDueAt: Date | null; decidedAt: Date | null; revisionRequestedAt: Date | null }[]),
  ]);
  const aCorriger = [
    ...spoR.map((r) => ({ type: "SPONSORING", id: r.id, titre: `${r.reference} — ${r.institution}`, nature: "Sponsoring", href: `/sponsoring/${r.id}` })),
    ...ciR.map((r) => ({ type: "CONGRESS_INTERNATIONAL", id: r.id, titre: r.name, nature: "Prise en charge internationale", href: `/congress-international/${r.id}` })),
    ...cnR.map((r) => ({ type: "CONGRESS_NATIONAL", id: r.id, titre: r.name, nature: "Prise en charge nationale", href: `/congress-national/${r.id}` })),
    ...evR.map((r) => ({ type: "EVENT", id: r.id, titre: r.name, nature: "Événement", href: `/events/${r.id}` })),
  ];
  // Le renvoi d'un contrat vit SUR le contrat (`returnNote`), pas dans le journal du moteur Ad & Pro.
  const renvoisContrats = new Map(coR.map((r) => [r.id, r.returnNote]));
  aCorriger.push(...coR.map((r) => ({ type: "CONSULTING_CONTRACT", id: r.id, titre: `${r.reference} — ${r.title}`, nature: "Consulting", href: `/consulting/${r.id}` })));
  const renvoisRecrutement = new Map(recR.map((r) => [r.id, r.returnNote]));
  aCorriger.push(...payR.map((r) => ({ type: "PAYMENT_REQUEST", id: r.id, titre: `${r.reference} — ${r.title}`, nature: "Demande de paiement", href: `/validations/paiements/${r.id}` })));
  aCorriger.push(...recR.map((r) => ({ type: "RECRUITMENT_REQUEST", id: r.id, titre: `${r.reference} — ${r.position}`, nature: "Recrutement", href: `/recrutement/${r.id}` })));
  const plansACorriger = new Map(planR.map((r) => [r.id, r]));
  aCorriger.push(...planR.map((r) => ({
    type: "TOUR_PLAN", id: r.id, titre: `Plan de tournée du ${jourAlger(r.periodStart)} au ${jourAlger(r.periodEnd)}`,
    nature: "Plan de tournée", href: `/medical/plan-de-tournee?plan=${r.id}`,
  })));
  if (aCorriger.length > 0) {
    // DEPUIS LE RENVOI (07-05) : l'instant où la main est revenue au demandeur, lu là où chaque circuit
    // l'écrit — la marque du contrat ou du recrutement, la décision ou la demande de révision du plan,
    // la trace du dossier de paiement, l'événement de renvoi du moteur Ad & Pro.
    const renvoyeLe = new Map<string, Date>();
    for (const r of coR) if (r.returnedAt) renvoyeLe.set(`CONSULTING_CONTRACT:${r.id}`, r.returnedAt);
    for (const r of recR) if (r.returnedAt) renvoyeLe.set(`RECRUITMENT_REQUEST:${r.id}`, r.returnedAt);
    for (const r of planR) {
      const t = r.status === "REVISION" ? r.revisionRequestedAt : r.decidedAt;
      if (t) renvoyeLe.set(`TOUR_PLAN:${r.id}`, t);
    }
    if (payR.length > 0) {
      const retours = await prisma.paymentRequestEvent.groupBy({
        by: ["requestId"],
        where: { requestId: { in: payR.map((r) => r.id) }, kind: { in: ["CHANGES", "REQUEST_CHANGES"] } },
        _max: { at: true },
      });
      for (const r of retours) if (r._max.at) renvoyeLe.set(`PAYMENT_REQUEST:${r.requestId}`, r._max.at);
    }
    const renvois = await prisma.workflowStepEvent.findMany({
      where: { action: "RETURN", instance: { status: "RETURNED", entityId: { in: aCorriger.map((d) => d.id) } } },
      select: { stepTitle: true, note: true, createdAt: true, instance: { select: { entityId: true, entityType: true } } },
      orderBy: { createdAt: "desc" },
    });
    const dernier = new Map<string, { stepTitle: string; note: string | null }>();
    for (const r of renvois) {
      const cle = `${r.instance.entityType}:${r.instance.entityId}`;
      if (!dernier.has(cle)) {
        dernier.set(cle, r);
        renvoyeLe.set(cle, r.createdAt);
      }
    }
    const apercu = (t: string) => (t.length > 140 ? `${t.slice(0, 140)}…` : t);
    for (const d of aCorriger.slice(0, PLAFOND_A_CORRIGER)) {
      const r = dernier.get(`${d.type}:${d.id}`);
      const noteContrat = d.type === "CONSULTING_CONTRACT" ? renvoisContrats.get(d.id) ?? null
        : d.type === "RECRUITMENT_REQUEST" ? renvoisRecrutement.get(d.id) ?? null : null;
      const plan = d.type === "TOUR_PLAN" ? plansACorriger.get(d.id) ?? null : null;
      items.push({
        key: `corriger-${d.type}-${d.id}`, objet: `${d.type}:${d.id}`, title: `À corriger — ${d.titre}`,
        subtitle: r ? `${r.stepTitle}${r.note ? ` : ${apercu(r.note)}` : ""}`
          : noteContrat ? `Renvoyé pour correction : ${apercu(noteContrat)}`
            : plan ? (plan.status === "REVISION"
              ? `En révision${plan.revisionNote ? ` : ${apercu(plan.revisionNote)}` : ""} — à resoumettre.`
              : `Rejeté${plan.rejectionComment ? ` : ${apercu(plan.rejectionComment)}` : ""} — à corriger et resoumettre.`)
              : d.type === "PAYMENT_REQUEST" ? "Renvoyée par les Finances : corrigez-la, ou remplacez les pièces signalées, puis renvoyez-la." : d.nature,
        module: d.nature, href: d.href, kind: "request", priority: null,
        deadline: plan?.resubmitDueAt?.toISOString() ?? null, depuis: renvoyeLe.get(`${d.type}:${d.id}`)?.toISOString() ?? null,
        owner: "", statusLabel: "À corriger", statusTone: "warning",
      });
    }
    // Au-delà du plafond, on le DIT (§118.60) — une liste coupée se lirait comme complète.
    if (aCorriger.length > PLAFOND_A_CORRIGER || [spoR, ciR, cnR, evR, coR, payR, recR, planR].some((l) => l.length > PLAFOND_A_CORRIGER)) {
      items.push({
        key: "corriger-reste", objet: `${PREFIXE_RESTE}corriger`, title: "D'autres demandes vous attendent pour correction",
        subtitle: "Les listes « Ad & Pro », « Demandes de paiement », « Recrutement » et « Plan de tournée » les montrent toutes (état « À corriger »).",
        module: "Ad & Pro", href: "/ad-pro", kind: "request", priority: null,
        deadline: null, depuis: null, owner: "", statusLabel: "À corriger", statusTone: "warning",
      });
    }
  }

  // 3. Demandes administratives qui me sont ASSIGNÉES — à traiter jusqu'à leur fin.
  //
  // N2 (lot E2) : la VALIDATION ne se lit plus ici. `validatorId` reste posé SUR LA DEMANDE après la
  // décision, et la ligne restait « à traiter » chez le N+1 qui venait de trancher l'achat : elle vit
  // désormais sur l'approbation EN ATTENTE (bloc 2b), que la décision clôt. Une demande effacée (la
  // suppression traçable garde son statut) ne se traite plus non plus.
  if (userCan(user, "ADMIN_REQUESTS", "VIEW")) {
    const reqs = await prisma.administrativeRequest.findMany({
      where: { assignedToId: user.id, deletedAt: null, status: { notIn: ["DONE", "CANCELLED"] } },
      include: { requester: { select: { name: true } } },
      orderBy: [{ deadline: "asc" }, { createdAt: "desc" }], take: 60,
    });
    for (const r of reqs) {
      // Depuis son DÉPÔT : aucune date ne dit quand elle vous a été confiée, et la demande attend sa fin
      // depuis qu'elle existe.
      items.push({
        key: `req-${r.id}`, objet: `${PREFIXE_DEMANDE_ADMIN}${r.id}`, title: r.title, subtitle: r.reference, module: "Demandes administratives",
        href: `/demandes/${r.id}`, kind: "request", priority: r.priority,
        deadline: r.deadline?.toISOString() ?? null, depuis: r.createdAt.toISOString(), owner: r.requester?.name ?? "", ...resolve(ADMIN_REQUEST_STATUS, r.status),
      });
    }
    // LE SECRÉTARIAT VOIT AUSSI CE QUE PERSONNE N'A PRIS (audit 360°, I10). Les demandes sans
    // responsable — la valeur par défaut du formulaire, et la règle des devis Ad & Pro et promo —
    // n'étaient listées nulle part, et l'accueil de l'assistante pouvait dire « Rien ne vous
    // attend » avec dix demandes neuves au bureau. Dans SA portée (la clause du bureau).
    if (hasRole(user, "DIRECTION_ASSISTANT")) {
      const vues = new Set(reqs.map((r) => r.id));
      const libres = await prisma.administrativeRequest.findMany({
        where: { AND: [await clauseDemandesSecretariatVisibles(user), { assignedToId: null, status: "NEW", deletedAt: null }] },
        include: { requester: { select: { name: true } } },
        orderBy: [{ deadline: "asc" }, { createdAt: "asc" }], take: 60,
      });
      for (const r of libres) {
        if (vues.has(r.id)) continue;
        items.push({
          key: `req-${r.id}`, objet: `${PREFIXE_DEMANDE_ADMIN}${r.id}`, title: r.title, subtitle: `${r.reference} · à prendre en charge`, module: "Demandes administratives",
          href: `/demandes/${r.id}`, kind: "request", priority: r.priority,
          deadline: r.deadline?.toISOString() ?? null, depuis: r.createdAt.toISOString(), owner: r.requester?.name ?? "", ...resolve(ADMIN_REQUEST_STATUS, r.status),
        });
      }
    }
  }

  // 4. Paiements / ordres de dépense à régler — la file du COMPTABLE, pas de tous ceux qui
  //    ont le droit Finances. La Direction et le DG portent FINANCES: MANAGE (ils peuvent
  //    ouvrir l'écran), mais régler n'est pas leur travail quotidien : soixante ordres dans
  //    leur espace noyaient ce qui les attend vraiment. Le Super Admin, lui, voit tout.
  if (hasRole(user, "FINANCE_BUDGET_MANAGER") || user.role === "SUPER_ADMIN") {
    const orders = await prisma.expenseOrder.findMany({ where: { status: "PENDING" }, orderBy: [{ dueDate: "asc" }, { createdAt: "asc" }], take: 60 });
    for (const o of orders) {
      // Depuis l'autorisation du centre quand il y en a une — c'est elle qui le rend réglable —, sinon
      // depuis l'émission de l'ordre.
      items.push({
        key: `pay-${o.id}`, objet: `EXPENSE_ORDER:${o.id}`, title: o.label, subtitle: `${o.reference} · ${formatCurrency(toNumber(o.amount))}`,
        module: "Espace comptable", href: `/finances/paiements-a-faire?focus=${o.id}#ord-${o.id}`, kind: "payment", priority: null,
        deadline: o.dueDate?.toISOString() ?? null, depuis: (o.centralDecidedAt ?? o.createdAt).toISOString(),
        owner: o.beneficiary ?? "", ...resolve(EXPENSE_ORDER_STATUS, o.status),
      });
    }
  }

  // 5. Dossiers Regulatory à mettre à jour (les miens, non clôturés)
  if (userCan(user, "REGULATORY", "VIEW")) {
    const products = await prisma.regulatoryProduct.findMany({
      where: { AND: [scopeRegulatory(user), { OR: [{ responsibleId: user.id }, { assistantId: user.id }] }, { status: { notIn: ["CLOSED", "DECISION_OBTAINED"] } }] },
      orderBy: [{ targetDate: "asc" }, { updatedAt: "desc" }], take: 40,
    });
    for (const p of products) {
      items.push({
        key: `reg-${p.id}`, objet: `REGULATORY_PRODUCT:${p.id}`, title: p.dci, subtitle: p.reference, module: "Regulatory",
        href: `/regulatory/${p.id}`, kind: "regulatory", priority: p.priority,
        deadline: p.targetDate?.toISOString() ?? null, depuis: null, owner: "", ...resolve(REGULATORY_STATUS, p.status),
      });
    }
  }

  // 6. (Les congés à décider sont lus au bloc 2b, avec la règle de la porte — lot E2. Ce bloc listait
  //    TOUS les congés en attente, à toute marche, à quiconque pouvait MODIFIER le module RH : la
  //    direction voyait chaque congé deux fois sur « Mon espace », et les RH ceux qui attendent un N+1,
  //    qu'elles ne tranchent pas.)

  // 6a. À ARBITRER — TOUTES LES NATURES AD & PRO, LUES SUR L'ÉTAPE COURANTE (audit 360°, I11).
  //
  // L'espace de la Direction Marketing ne couvrait que les congrès, typés « demande » donc hors de
  // l'indicateur « À valider » : un sponsoring, un événement, un contrat de consulting ou une
  // « autre demande » posés sur SON étape dormaient — personne ne lui disait qu'ils l'attendaient.
  // La règle est celle du moteur (`canActOnStep`, portée RÔLE) : l'étape courante nomme les rôles
  // qui agissent, et l'on n'en invente pas d'autre. La vue globale et le Super Admin, qui passent
  // partout, ont leurs propres sections : les y verser noierait ce qui les attend vraiment.
  if (!hasGlobalView(user.role) && user.role !== "SUPER_ADMIN") {
    const dejaListes = new Set(items.map((i) => i.href));
    // LES ÉTAPES QUI NOMMENT MON RÔLE d'abord, puis les seules instances posées dessus — une
    // fenêtre « les N plus anciennes de toute la base » laissait les étapes des autres rôles
    // remplir la fenêtre et taire, en silence, ce qui m'attend (§118.60).
    const mesRoles = [user.role, user.secondaryRole].filter((r): r is NonNullable<typeof r> => Boolean(r));
    const etapes = await prisma.workflowStep.findMany({
      where: { actorScope: "ROLE", actorRoles: { hasSome: mesRoles } },
      select: { definitionId: true, slug: true, title: true },
    });
    const etapeDe = new Map(etapes.map((e) => [`${e.definitionId}:${e.slug}`, e]));
    const surMesEtapes = etapes.length
      ? { status: "IN_PROGRESS" as const, OR: etapes.map((e) => ({ definitionId: e.definitionId, currentSlug: e.slug })) }
      : null;
    const [aMoi, totalAMoi] = surMesEtapes
      ? await Promise.all([
          prisma.workflowInstance.findMany({
            where: surMesEtapes,
            select: { id: true, createdAt: true, entityType: true, entityId: true, currentSlug: true, definitionId: true },
            orderBy: { updatedAt: "asc" }, take: 40,
          }),
          prisma.workflowInstance.count({ where: surMesEtapes }),
        ])
      : [[], 0];
    const libelles = await libellesAdPro(aMoi.map((i) => ({ type: String(i.entityType), id: i.entityId })));
    const ouvrables = await Promise.all(aMoi.map((i) => canAccessEntity(user, i.entityType, i.entityId, "VIEW")));
    // DEPUIS L'ARRIVÉE À L'ÉTAPE (07-05) : le dernier MOUVEMENT de la demande — sa création (datée de la
    // demande, pas de l'instance ouverte parfois des jours plus tard), puis chaque passage d'étape (accord,
    // saut, franchissement, avis, resoumission, réouverture, appel). Un COMMENTAIRE n'en déplace aucune :
    // il ne remet pas l'ancienneté à zéro.
    const mouvements = aMoi.length
      ? await prisma.workflowStepEvent.groupBy({
          by: ["instanceId"],
          where: { instanceId: { in: aMoi.map((i) => i.id) }, action: { not: "COMMENT" } },
          _max: { createdAt: true },
        })
      : [];
    const dernierMouvement = new Map(mouvements.map((m) => [m.instanceId, m._max.createdAt]));
    aMoi.forEach((i, k) => {
      const l = libelles.get(`${i.entityType}:${i.entityId}`);
      if (!l || !ouvrables[k] || dejaListes.has(l.href)) return;
      const e = etapeDe.get(`${i.definitionId}:${i.currentSlug}`);
      // Sans aucun mouvement journalisé (la ligne de création est écrite au mieux), l'ouverture de l'instance.
      const mouvement = dernierMouvement.get(i.id) ?? null;
      items.push({
        key: `arb-${i.entityType}-${i.entityId}`, objet: `${i.entityType}:${i.entityId}`, title: l.titre, subtitle: `${l.nature} · ${e?.title ?? "à votre étape"}`,
        module: "Ad & Pro", href: l.href, kind: "validation", priority: null, deadline: null,
        depuis: (mouvement ?? i.createdAt).toISOString(), owner: l.demandeur ?? "",
        statusLabel: "À arbitrer", statusTone: "warning",
      });
    });
    // CE QUI N'EST PAS LISTÉ SE COMPTE (§118.60) : au-delà de quarante, une ligne le dit et mène à
    // la liste du pôle — une coupe muette se lirait comme « rien d'autre ne m'attend ».
    if (totalAMoi > aMoi.length) {
      items.push({
        key: "arb-reste", objet: `${PREFIXE_RESTE}arbitrer`, title: `${totalAMoi - aMoi.length} autre(s) demande(s) Ad & Pro attendent votre étape`,
        subtitle: "Les plus anciennes sont listées ci-dessus", module: "Ad & Pro", href: "/ad-pro",
        kind: "validation", priority: null, deadline: null, depuis: null, owner: "", statusLabel: "À arbitrer", statusTone: "warning",
      });
    }
    // Consulting et « autre demande » n'ont pas de circuit à étapes : ce qui les attend se lit sur
    // leur statut, et la règle de décision est celle de leur action (`peutSurLeContrat`, VALIDATE).
    // UNE COUPE SE DIT (§118.60) : on lit un de plus que ce qu'on montre ; s'il existe, une ligne
    // le dit et mène à la liste. Le compte exact demanderait la porte de chaque ligne de la base.
    const PLAFOND = 30;
    const FENETRE = PLAFOND * 2 + 1;
    const lister = async (
      candidats: { id: string; reference: string; title: string }[],
      type: "CONSULTING_CONTRACT" | "AD_PRO_OTHER",
      ligne: (c: { id: string; reference: string; title: string }) => ActionItem,
      reste: ActionItem,
    ) => {
      let montres = 0;
      for (const c of candidats) {
        const it = ligne(c);
        if (dejaListes.has(it.href) || !(await canAccessEntity(user, type, c.id, "VIEW"))) continue;
        if (montres === PLAFOND) { items.push(reste); return; }
        items.push(it);
        montres += 1;
      }
      // La fenêtre lue était pleine : au-delà, on ne SAIT pas — et l'on ne se tait pas.
      if (candidats.length === FENETRE) items.push(reste);
    };
    if (userCan(user, "CONSULTING", "VALIDATE")) {
      const contrats = await prisma.consultingContract.findMany({
        where: { status: "AWAITING_VALIDATION", pole: "AD_PRO", OR: [{ validatorId: null }, { validatorId: user.id }] },
        select: { id: true, reference: true, title: true },
        orderBy: { updatedAt: "asc" }, take: FENETRE,
      }).catch(() => []);
      // Non datés : aucun champ ne dit quand un contrat est entré en validation (07-05 — on ne l'invente pas).
      await lister(contrats, "CONSULTING_CONTRACT", (c) => ({
        key: `arb-cons-${c.id}`, objet: `CONSULTING_CONTRACT:${c.id}`, title: c.title, subtitle: `Consulting · ${c.reference}`, module: "Ad & Pro",
        href: `/consulting/${c.id}`, kind: "validation", priority: null, deadline: null, depuis: null, owner: "",
        statusLabel: "À valider", statusTone: "warning",
      }), {
        key: "arb-cons-reste", objet: `${PREFIXE_RESTE}consulting`, title: "D'autres contrats de consulting attendent votre validation", subtitle: "Les plus anciens sont listés ci-dessus",
        module: "Ad & Pro", href: "/consulting", kind: "validation", priority: null, deadline: null, depuis: null, owner: "", statusLabel: "À valider", statusTone: "warning",
      });
    }
    if (userCan(user, "AD_PRO_OTHER", "VALIDATE")) {
      const autres = await prisma.adProOtherRequest.findMany({
        where: { status: "AWAITING_DECISION" },
        select: { id: true, reference: true, title: true },
        orderBy: { updatedAt: "asc" }, take: FENETRE,
      }).catch(() => []);
      await lister(autres, "AD_PRO_OTHER", (a) => ({
        key: `arb-autre-${a.id}`, objet: `AD_PRO_OTHER:${a.id}`, title: a.title, subtitle: `Autre demande · ${a.reference}`, module: "Ad & Pro",
        href: `/ad-pro/autres/${a.id}`, kind: "validation", priority: null, deadline: null, depuis: null, owner: "",
        statusLabel: "À décider", statusTone: "warning",
      }), {
        key: "arb-autre-reste", objet: `${PREFIXE_RESTE}autres`, title: "D'autres demandes attendent votre décision", subtitle: "Les plus anciennes sont listées ci-dessus",
        module: "Ad & Pro", href: "/ad-pro", kind: "validation", priority: null, deadline: null, depuis: null, owner: "", statusLabel: "À décider", statusTone: "warning",
      });
    }
  }

  // 6b. Congrès / événements à valider (Direction) ou à analyser (Direction Marketing)
  const congressTone = (s: string): { statusLabel: string; statusTone: BadgeTone } => ({
    statusLabel: CONGRESS_REQUEST_STATUS[s]?.label ?? s,
    statusTone: CONGRESS_REQUEST_STATUS[s]?.tone ?? "warning",
  });
  for (const cfg of [
    { module: "CONGRESS_INTERNATIONAL" as const, label: "Prises en charge Internationales", href: "/congress-international" },
    { module: "CONGRESS_NATIONAL" as const, label: "Prises en charge Nationales", href: "/congress-national" },
  ]) {
    if (!userCan(user, cfg.module, "VIEW")) continue;
    const canValidate = userCan(user, cfg.module, "VALIDATE") || hasGlobalView(user.role);
    const or: { requestStatus?: unknown; productManagerId?: string }[] = [{ requestStatus: "PRELIMINARY_APPROVED", productManagerId: user.id }];
    if (canValidate) or.push({ requestStatus: { in: ["AWAITING_PRELIMINARY", "AWAITING_FINAL"] } });
    const where = { OR: or } as never;
    const list = cfg.module === "CONGRESS_INTERNATIONAL"
      ? await prisma.congressInternational.findMany({ where, orderBy: { createdAt: "desc" }, take: 30 })
      : await prisma.congressNational.findMany({ where, orderBy: { createdAt: "desc" }, take: 30 });
    for (const c of list) {
      // Même objet que la ligne « À arbitrer » du moteur : celle-ci, plus précise, passe devant (`dedoublonner`).
      items.push({
        key: `cong-${c.id}`, objet: `${cfg.module}:${c.id}`, title: c.name,
        subtitle: c.requestStatus === "PRELIMINARY_APPROVED" ? "À analyser (Direction Marketing)" : c.requestStatus === "AWAITING_FINAL" ? "Validation définitive" : "Validation préliminaire",
        module: cfg.label, href: `${cfg.href}/${c.id}`, kind: "request", priority: null,
        deadline: null, depuis: null, owner: "", ...congressTone(c.requestStatus),
      });
    }
  }

  // 6c. Information médicale — l'INSTRUCTION (à déclarer, pièces demandées, prêt à valider)
  //     est le travail du PHARMACIEN RESPONSABLE (PRIM), et de lui seul : la Direction a le
  //     droit d'agir sur le module, mais ces événements ne sont pas SA file. Elle ne reçoit
  //     que l'étape qui lui appartient — la validation finale (AWAITING_DIRECTION), même
  //     garde que l'action `validateDeclarationByDirection`. Le Super Admin voit tout.
  {
    const prim = hasRole(user, "MEDICAL_INFO_PHARMACIST") || user.role === "SUPER_ADMIN";
    const direction = hasGlobalView(user);
    const miStatuses: ("AWAITING_REVIEW" | "DOCS_REQUESTED" | "READY" | "AWAITING_DIRECTION")[] = [
      ...(prim ? (["AWAITING_REVIEW", "DOCS_REQUESTED", "READY"] as const) : []),
      ...(direction ? (["AWAITING_DIRECTION"] as const) : []),
    ];
    const decls = miStatuses.length
      ? await prisma.medicalInfoDeclaration.findMany({
          where: { status: { in: miStatuses } },
          orderBy: { createdAt: "desc" }, take: 40,
        })
      : [];
    for (const d of decls) {
      // Datée à la seule étape qu'un champ date à coup sûr : la validation du pharmacien, qui la fait
      // passer à la Direction. Les étapes d'instruction n'ont pas d'horodatage propre.
      items.push({
        key: `mi-${d.id}`, objet: `MEDICAL_INFO_DECLARATION:${d.id}`, title: d.label, subtitle: d.reference,
        module: "Information médicale", href: `/information-medicale/${d.id}`, kind: "validation", priority: null,
        deadline: null, depuis: d.status === "AWAITING_DIRECTION" ? d.pharmacistValidatedAt?.toISOString() ?? null : null,
        owner: "", ...resolve(MEDICAL_INFO_STATUS, d.status),
      });
    }
  }

  // 6d. Matériel promotionnel — étape en attente de l'acteur courant.
  //
  // (a) L'ANCIEN CIRCUIT (seize statuts) : le `status` fait foi, et SEULEMENT pour lui
  //     (`circuitState: null`). Un dossier à circuit garde son `status` de création figé pour
  //     toujours : le lire ici l'affichait « Prospection demandée — à valider » chez tous les
  //     porteurs de la validation du module, y compris après qu'ils l'avaient validé (§118.153).
  if (userCan(user, "PROMO_MATERIAL", "VIEW")) {
    const global = hasGlobalView(user.role);
    const mine = new Set<PromoMaterialStatus>();
    if (userCan(user, "PROMO_MATERIAL", "VALIDATE") || global) ["PROSPECTION_REQUESTED", "AGENCY_CHOSEN", "BC_VALIDATED", "FINAL_MATERIAL"].forEach((s) => mine.add(s as PromoMaterialStatus));
    if (user.role === "FINANCE_BUDGET_MANAGER" || global) ["BC_FINANCE_REVIEW", "PAYMENT_INITIATED", "INVOICED"].forEach((s) => mine.add(s as PromoMaterialStatus));
    if (user.role === "MEDICAL_INFO_PHARMACIST" || global) ["BC_SENT", "CONFORMITY_REVIEW"].forEach((s) => mine.add(s as PromoMaterialStatus));
    if (global) mine.add("MATERIAL_PRODUCED");
    const marketing: PromoMaterialStatus[] = ["QUOTES_UPLOADED", "PAYMENT_DONE", "VISA_OBTAINED", "BAT_PRINTING"];
    const or: { status: { in: PromoMaterialStatus[] }; requesterId?: string }[] = [];
    if (mine.size) or.push({ status: { in: [...mine] } });
    or.push(global ? { status: { in: marketing } } : { status: { in: marketing }, requesterId: user.id });
    const promos = await prisma.promoMaterial.findMany({ where: { circuitState: null, OR: or }, orderBy: { createdAt: "desc" }, take: 40 });
    for (const p of promos) {
      items.push({
        key: `pm-${p.id}`, objet: `PROMO_MATERIAL:${p.id}`, title: p.title, subtitle: p.reference,
        module: "Matériel promotionnel", href: `/promo-material/${p.id}`, kind: "validation", priority: null,
        deadline: null, depuis: null, owner: "", ...resolve(PROMO_MATERIAL_STATUS, p.status),
      });
    }
  }
  // (b) LES DOSSIERS À CIRCUIT : ceux dont c'est MON tour, selon la règle du circuit lui-même —
  //     et sans filtre par module : le N+1 et l'assistante de direction n'ont pas le module, et
  //     c'est pourtant à eux que la demande attend. Une validation va dans « Validations à
  //     faire » ; demander ou retranscrire les devis sont des gestes, qui vont dans « À traiter ».
  for (const d of await dossiersPromoAMonTour(user)) {
    items.push({
      key: `pm-${d.id}`, objet: `PROMO_MATERIAL:${d.id}`, title: d.title, subtitle: d.reference,
      module: "Matériel promotionnel", href: `/promo-material/${d.id}`,
      kind: d.tour === "VALIDATION" ? "validation" : "request", priority: null,
      deadline: null, depuis: null, owner: "", statusLabel: libelleEtape(d.etat, d.version), statusTone: "warning",
    });
  }

  // 6d. Pièces qui me sont demandées au titre de l'information médicale (tout utilisateur)
  const myDocReqs = await prisma.medicalInfoDocRequest.findMany({
    where: { targetUserId: user.id, status: "PENDING" },
    include: { declaration: { select: { id: true, reference: true } } },
    orderBy: { createdAt: "desc" }, take: 30,
  });
  for (const r of myDocReqs) {
    items.push({
      key: `midoc-${r.id}`, objet: `MEDICAL_INFO_DOC_REQUEST:${r.id}`, title: `Pièce à déposer — ${r.label}`, subtitle: r.declaration.reference,
      module: "Information médicale", href: `/information-medicale/${r.declaration.id}`, kind: "request", priority: null,
      deadline: null, depuis: r.createdAt.toISOString(), owner: "", statusLabel: "À déposer", statusTone: "warning",
    });
  }

  // 6e. Directives de la Direction qui me concernent (non clôturées)
  if (userCan(user, "DIRECTIVES", "VIEW")) {
    // Les notes adressées « aux salariés d'une entité » n'atteignent leur file d'actions que si
    // l'on sait de quelle entité la personne relève — sans cela, elles seraient reçues mais
    // absentes de « Mon travail », l'écran qui sert justement à ne rien oublier.
    const { companyIdsOf } = await import("@/lib/directives/recipients");
    const directives = await prisma.directive.findMany({
      where: { AND: [scopeDirectives(user, await companyIdsOf(user.id)), { status: { notIn: ["DONE", "ARCHIVED"] } }] },
      orderBy: [{ priority: "desc" }, { createdAt: "desc" }], take: 40,
    });
    for (const d of directives) {
      items.push({
        key: `dir-${d.id}`, objet: `DIRECTIVE:${d.id}`, title: d.title, subtitle: d.reference, module: "Directives",
        href: `/directives/${d.id}`, kind: "task", priority: d.priority,
        deadline: d.dueDate?.toISOString() ?? null, depuis: (d.publishedAt ?? d.createdAt).toISOString(), owner: "", ...resolve(DIRECTIVE_STATUS, d.status),
      });
    }
  }

  // 6f. Demandes de support qui m'attendent (destinataire / répondant)
  if (userCan(user, "SUPPORT", "VIEW")) {
    const reqs = await prisma.supportRequest.findMany({
      where: {
        status: { in: ["OPEN", "IN_PROGRESS"] },
        OR: [{ targetUserId: user.id }, { targetRole: user.role }, { assignedToId: user.id }],
      },
      include: { requester: { select: { name: true } } },
      orderBy: [{ priority: "desc" }, { createdAt: "desc" }], take: 40,
    });
    for (const r of reqs) {
      items.push({
        key: `sup-${r.id}`, objet: `SUPPORT_REQUEST:${r.id}`, title: r.subject, subtitle: r.reference, module: "Support",
        href: `/support/${r.id}`, kind: "request", priority: r.priority,
        deadline: null, depuis: r.createdAt.toISOString(), owner: r.requester?.name ?? "", ...resolve(SUPPORT_STATUS, r.status),
      });
    }
  }

  // 6g. Dossiers de suivi qui me sont confiés (responsable), actifs
  if (userCan(user, "DOSSIERS", "VIEW")) {
    const dossiers = await prisma.dossier.findMany({
      where: { assignedToId: user.id, status: { notIn: ["DONE", "ARCHIVED"] } },
      orderBy: [{ priority: "desc" }, { dueDate: "asc" }], take: 40,
    });
    for (const d of dossiers) {
      items.push({
        key: `dos-${d.id}`, objet: `DOSSIER:${d.id}`, title: d.title, subtitle: d.reference, module: "Dossiers",
        href: `/dossiers/${d.id}`, kind: "request", priority: d.priority,
        deadline: d.dueDate?.toISOString() ?? null, depuis: null, owner: "", ...resolve(DOSSIER_STATUS, d.status),
      });
    }
  }

  // 6h. Demandes de stocks à renseigner (KAM destinataire — Direction, 06/10). Le fait qui
  //     l'ouvre est d'être DESTINATAIRE d'une demande ouverte, pas un module : une seule vue par
  //     demande, qui sort d'ici à l'envoi ou à la clôture.
  const demandesStocks = await prisma.stockCountRequestRecipient.findMany({
    where: { kamId: user.id, submittedAt: null, request: { status: "OUVERTE" } },
    select: { createdAt: true, request: { select: { id: true, title: true, dueDate: true, createdBy: { select: { name: true } } } } },
    orderBy: { createdAt: "desc" }, take: 20,
  });
  for (const r of demandesStocks) {
    items.push({
      key: `stk-${r.request.id}`, objet: `STOCK_COUNT_REQUEST:${r.request.id}`, title: r.request.title, subtitle: "Demande de stocks",
      module: "Stocks", href: `/stocks/demandes/${r.request.id}`, kind: "request", priority: "HIGH",
      deadline: r.request.dueDate?.toISOString() ?? null, depuis: r.createdAt.toISOString(), owner: r.request.createdBy?.name ?? "",
      statusLabel: "À renseigner", statusTone: "warning",
    });
  }

  // 7. Notifications non lues
  let notifications: ActionNotification[] = [];
  if (userCan(user, "NOTIFICATIONS", "VIEW")) {
    const notifs = await prisma.notification.findMany({ where: { userId: user.id, isRead: false }, orderBy: { createdAt: "desc" }, take: 20 });
    notifications = notifs.map((n) => ({ id: n.id, title: n.title, body: n.body ?? "", link: reécriteLienNotification(n.link) ?? "", type: n.type, createdAt: n.createdAt.toISOString() }));
  }

  const isOverdue = (i: ActionItem) => i.deadline !== null && new Date(i.deadline) < now;
  const isUrgent = (i: ActionItem) => i.priority === "HIGH" || i.priority === "CRITICAL";

  // UNE LIGNE PAR OBJET (lot E2) — et les compteurs comptent ce qui reste, pas ce qui a été lu.
  const uniques = dedoublonner(items);
  const stats = {
    todo: uniques.length,
    urgent: uniques.filter(isUrgent).length,
    overdue: uniques.filter(isOverdue).length,
    validations: uniques.filter((i) => i.kind === "validation").length,
    unread: notifications.length,
  };

  // `conges` voyage avec les lignes : la page rend ces congés dans leur bloc (fiche, boutons) — les
  // relire là-bas en ferait une seconde lecture, qui finirait par diverger de celle-ci (§118.5).
  return { items: uniques, notifications, stats, conges };
}
