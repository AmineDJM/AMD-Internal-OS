"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { userCan, hasGlobalView } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { standInForUserIds } from "@/lib/hr/stand-in-resolve";
import { recordAudit } from "@/lib/audit";
import { getManagerOfUser } from "@/lib/departments";
import { notifyUser } from "@/lib/notify";
import { fdStr, fdDate, type ActionResult } from "@/lib/actions/types";
import {
  bloquantsDeSoumission, echeanceDeSoumission, escaladeDuPlan, estGranularite,
  estJourOuvrePourTournee, gestesPossibles, limiteResoumission, periodeDe, retraitInterditApresRevision, reviseurDuPlan,
  type Granularite, type StatutPlan, accesAuPlan,
} from "@/lib/sfe/tournee";
import { lireReglageTournee } from "@/lib/sfe/tournee-reglage";
import { loadPanelPlanifiable } from "@/lib/queries/tour-schedule";
import { MODULE_AUDIT_VISITE } from "@/lib/medical/module-visite";

/**
 * LE PLAN DE TOURNÉE — écriture, soumission, escalade, décision.
 *
 * ── CE QUI EST ICI, ET CE QUI N'Y EST PAS ───────────────────────────────────────────────────
 *
 * Toutes les RÈGLES (période, échéance, qui valide, ce qui bloque une soumission, les 48 h)
 * vivent dans le module PUR `lib/sfe/tournee.ts` — ce fichier ne fait que les appeler, charger
 * ce qu'il faut, et écrire. C'est ce qui permet de tester les règles sans base, et d'exercer
 * les écritures par leur VRAI point d'entrée.
 *
 * ── LES VISITES SONT DES `MedicalVisit` ─────────────────────────────────────────────────────
 *
 * Une visite planifiée est une `MedicalVisit` au statut `PLANNED` rattachée au plan. C'est
 * l'objet canonique de l'ERP : lui donner une table jumelle aurait fait deux dénominateurs pour
 * « visitées / planifiées », et deux dénominateurs divergent toujours (§118.5, §118.51).
 */

const MODULE = "MEDICAL" as const;
const PATH_TOURNEE = "/medical/plan-de-tournee";
const PATH_JOURNEE = "/medical/ma-journee";

/**
 * UN GESTE À LA FOIS SUR UN PLAN (§118.193 — audit 360°, R13). Chaque écriture d'état exige l'état qu'elle a
 * LU : deux décisions croisées (valider et rejeter, valider et escalader), une soumission pendant une
 * modification de la grille, deux enregistrements de la grille dans deux onglets — la seconde écriture
 * écrasait la première en silence, et un plan validé pouvait l'être sur une grille que personne n'avait vue.
 */
const DEJA_CHANGE = "Ce plan vient de changer — un autre geste est passé avant le vôtre : rouvrez-le pour voir où il en est.";
class EtatChange extends Error {}

/**
 * QUI PEUT ÉCRIRE LE PLAN DE CE KAM : lui-même, le superviseur de sa BU, ou une vue globale.
 *
 * `canEditRep` (lib/sfe) répond déjà à « ai-je la main sur ce KAM ? » et c'est elle qui décide —
 * en écrire une seconde ici donnerait deux réponses à la même question (§118.5). Elle est
 * chargée par import dynamique : `lib/sfe` tire le paramétrage SFE, dont ce fichier n'a pas
 * besoin sur le chemin de refus.
 */
async function peutEcrirePourLeKam(user: Awaited<ReturnType<typeof requireUser>>, repId: string): Promise<boolean> {
  if (repId === user.id) return true;
  const { canEditRep } = await import("@/lib/sfe");
  return canEditRep(user, repId);
}

/**
 * OUVRIR (ou retrouver) LE PLAN d'un KAM pour la période qui contient `date`.
 *
 * Idempotent : rappeler l'action rend le MÊME plan. C'est ce qui permet à l'écran d'ouvrir la
 * planification sans se demander si le plan existe — et ce qui empêche deux plans concurrents
 * pour la même période, que la contrainte d'unicité refuserait de toute façon.
 */
export async function ouvrirPlanTournee(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, MODULE, "CREATE")) return { ok: false, error: "Non autorisé." };
  const repId = fdStr(formData, "repId") || user.id;
  if (!(await peutEcrirePourLeKam(user, repId))) {
    return { ok: false, error: "Ce KAM n'est pas dans votre périmètre — seul lui, le superviseur de sa BU ou la Direction peuvent écrire son plan." };
  }
  // LE RÉGLAGE VIENT DU LECTEUR UNIQUE (`sfe/tournee-reglage`) : la page du plan et le tableau de
  // bord de la Direction lisent le même — trois lectures du même JSON finissaient par lire trois
  // réglages (§118.5).
  const reglage = await lireReglageTournee();
  const granularite = ((): Granularite => {
    const g = fdStr(formData, "granularity");
    return g && estGranularite(g) ? g : reglage.granularite;
  })();
  const dans = fdDate(formData, "date") ?? new Date();
  const { debut, fin } = periodeDe(granularite, dans);

  const existant = await prisma.tourPlan.findUnique({
    where: { repId_periodStart_periodEnd: { repId, periodStart: debut, periodEnd: fin } },
    select: { id: true },
  });
  if (existant) return { ok: true, id: existant.id };

  const cree = await prisma.tourPlan.create({
    data: {
      repId, periodStart: debut, periodEnd: fin, granularity: granularite,
      // L'ÉCHÉANCE EST FIGÉE À LA CRÉATION : recalculée à la lecture, un changement de réglage
      // rendrait « en retard » un plan écrit sous une autre règle (§118.107).
      submissionDueAt: echeanceDeSoumission(debut, reglage.joursAvant),
      createdById: user.id,
    },
    select: { id: true },
  });
  revalidatePath(PATH_TOURNEE);
  return { ok: true, id: cree.id };
}

/**
 * PLANIFIER LES VISITES d'un plan — la sélection JOUR × MÉDECIN, envoyée COMPLÈTE.
 *
 * Le formulaire porte des entrées `visite` de la forme `AAAA-MM-JJ|<doctorId>` : l'écran coche
 * un médecin sous un jour, et c'est exactement cette paire qui fait une visite. La sélection
 * REMPLACE la précédente — décocher retire.
 *
 * ── CE QUI EST PRÉSERVÉ, ET POURQUOI ───────────────────────────────────────────────────────
 *
 * Une visite DÉJÀ RAPPORTÉE (statut hors `PLANNED`) n'est jamais supprimée par une
 * replanification : elle a eu lieu, et la retirer effacerait un fait au profit d'une intention.
 * C'est la même règle que les acquis d'un plan de mission (§118.33 / §118.67b) : ce qui a
 * produit un effet ne se rejoue pas et ne s'annule pas d'un trait de plume.
 */
export async function planifierVisites(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, MODULE, "CREATE")) return { ok: false, error: "Non autorisé." };
  const planId = fdStr(formData, "planId");
  if (!planId) return { ok: false, error: "Plan introuvable." };
  const plan = await prisma.tourPlan.findUnique({
    where: { id: planId },
    select: { id: true, repId: true, status: true, periodStart: true, periodEnd: true, updatedAt: true, revisionCount: true },
  });
  if (!plan) return { ok: false, error: "Plan introuvable." };
  if (!(await peutEcrirePourLeKam(user, plan.repId))) return { ok: false, error: "Ce plan n'est pas dans votre périmètre." };
  if (!gestesPossibles(plan.status as StatutPlan).modifiable) {
    // LE REFUS NOMME LE GESTE QUI EXISTE (§118.30) : un plan validé se RÉVISE, il ne se réécrit pas sous les pieds du KAM.
    return {
      ok: false,
      error: plan.status === "APPROVED"
        ? "Ce plan est validé : il ne se modifie pas en direct — sa tournée a commencé. « Demander une révision » le rouvre, motif à l'appui : il repassera en validation, et ce qui a déjà eu lieu restera."
        : "Ce plan attend la décision de son validateur : il ne se modifie qu'une fois rejeté, ou validé puis rouvert en révision.",
    };
  }

  // ── LES PAIRES JOUR × MÉDECIN ─────────────────────────────────────────────────────────────
  const brut = [...new Set(formData.getAll("visite").map(String).filter(Boolean))];
  const paires: { jour: Date; doctorId: string }[] = [];
  const illisibles: string[] = [];
  for (const p of brut) {
    const [j, doctorId] = p.split("|");
    const d = j ? new Date(`${j}T09:00:00`) : null;
    if (!doctorId || !d || Number.isNaN(d.getTime())) { illisibles.push(p); continue; }
    paires.push({ jour: d, doctorId });
  }
  // ON NE DEVINE PAS une paire qu'on ne lit pas : la taire ferait un plan amputé qui a l'air
  // complet (§118.71 — une valeur non résolue ne doit jamais DISPARAÎTRE).
  if (illisibles.length > 0) {
    return { ok: false, error: `${illisibles.length} sélection(s) illisibles (« ${illisibles[0]} ») — rechargez l'écran.` };
  }

  // Les praticiens sont VÉRIFIÉS : un identifiant périmé partirait en violation de clé étrangère.
  const doctorIds = [...new Set(paires.map((p) => p.doctorId))];
  const praticiens = doctorIds.length
    ? await prisma.medicalDoctor.findMany({ where: { id: { in: doctorIds } }, select: { id: true } })
    : [];
  if (praticiens.length !== doctorIds.length) {
    return { ok: false, error: `${doctorIds.length - praticiens.length} praticien(s) sélectionné(s) n'existent plus — rechargez l'écran.` };
  }

  const dansLaPeriode = (d: Date) => d >= plan.periodStart && d <= plan.periodEnd;
  const horsPeriode = paires.filter((p) => !dansLaPeriode(p.jour));
  if (horsPeriode.length > 0) {
    return { ok: false, error: `${horsPeriode.length} visite(s) tombent hors de la période du plan.` };
  }

  const existantes = await prisma.medicalVisit.findMany({
    where: { tourPlanId: plan.id },
    select: { id: true, date: true, doctorId: true, status: true },
  });
  const cle = (d: Date, doctorId: string | null) =>
    `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}|${doctorId ?? ""}`;
  const voulues = new Set(paires.map((p) => cle(p.jour, p.doctorId)));
  const deja = new Map(existantes.map((v) => [cle(v.date, v.doctorId), v]));

  // CE QUI PART : les visites encore `PLANNED` que la nouvelle sélection ne contient plus.
  // Une visite rapportée reste, quoi qu'il arrive.
  const aRetirer = existantes.filter((v) => v.status === "PLANNED" && !voulues.has(cle(v.date, v.doctorId)));
  const aCreer = paires.filter((p) => !deja.has(cle(p.jour, p.doctorId)));

  // UNE RÉVISION ROUVRE L'AVENIR, PAS LE PASSÉ (§118.193). Sur un plan déjà validé, une visite dont l'heure est
  // passée ne se retire pas : elle se rapporte, ou se dit reportée ou annulée — la retirer effacerait une visite
  // perdue du taux « visitées / planifiées ».
  const maintenant = new Date();
  const passees = aRetirer.filter((v) => retraitInterditApresRevision(v, plan.revisionCount > 0, maintenant));
  if (passees.length > 0) {
    return {
      ok: false,
      error: `${passees.length} visite(s) déjà passée(s) ne se retirent pas d'un plan validé : elles se rapportent, ou se disent reportées ou annulées, depuis « Ma journée » dans leurs 48 h — passé ce délai, elles restent comptées comme non rapportées. La révision ne change que l'avenir de la tournée.`,
    };
  }

  // LE PANEL DU KAM, ET LUI SEUL (§118.172). L'écran ne propose que les praticiens de ses secteurs
  // et ceux qui lui sont rattachés ; l'action relit la MÊME liste (`loadPanelPlanifiable`) — deux
  // lectures du territoire finiraient par répondre différemment (§118.5). Sans elle, une requête
  // forgée planifiait n'importe quel praticien de l'annuaire, et le N+1 aurait validé une tournée
  // que la couverture de la BU n'autorise pas : le découpage par service n'aurait tenu qu'à l'écran.
  // Seul ce qu'on AJOUTE est vérifié : une visite déjà planifiée dont le praticien a quitté le
  // panel depuis (secteur redécoupé, praticien réaffecté) reste — la refuser bloquerait toute
  // retouche du plan pour un fait que le KAM n'a pas causé (§118.27).
  const nouveaux = [...new Set(aCreer.map((p) => p.doctorId))];
  if (nouveaux.length > 0) {
    const panel = new Set((await loadPanelPlanifiable(plan.repId)).map((d) => d.id));
    const hors = nouveaux.filter((id) => !panel.has(id));
    if (hors.length > 0) {
      return {
        ok: false,
        error: `${hors.length} praticien(s) hors du panel de ce KAM — ni rattachés à lui, ni couverts par l'un de ses secteurs. La couverture se règle dans Business Units.`,
      };
    }
  }

  try {
    await prisma.$transaction(async (tx) => {
      // LE PLAN QU'ON A LU, ET LUI SEUL : une soumission passée entre-temps, ou un autre enregistrement de la
      // grille (un second onglet), et cette sélection n'est plus celle que l'on croit remplacer.
      const encore = await tx.tourPlan.updateMany({
        where: { id: plan.id, status: plan.status, updatedAt: plan.updatedAt },
        // C'est CE changement d'`updatedAt` qui fait perdre l'autre onglet. Prisma le pose aussi de lui-même sur
        // un `updateMany` (mesuré : un `updateMany` qui ne réécrit que le statut change `updatedAt`) — la valeur
        // explicite dit l'intention, et la garde ne dépend pas de ce comportement de bibliothèque.
        data: { updatedAt: maintenant },
      });
      if (encore.count === 0) throw new EtatChange();
      // « Une visite rapportée reste, quoi qu'il arrive » — y compris celle rapportée PENDANT cet enregistrement,
      // dans un autre onglet : le retrait n'emporte que ce qui est encore planifié, et tout ou rien.
      if (aRetirer.length > 0) {
        const retirees = await tx.medicalVisit.deleteMany({ where: { id: { in: aRetirer.map((v) => v.id) }, status: "PLANNED" } });
        if (retirees.count !== aRetirer.length) throw new EtatChange();
      }
      if (aCreer.length > 0) {
        await tx.medicalVisit.createMany({
          data: aCreer.map((p) => ({
            date: p.jour, doctorId: p.doctorId, delegateId: plan.repId,
            status: "PLANNED" as const, origin: "PLAN" as const,
            tourPlanId: plan.id, createdById: user.id,
          })),
        });
      }
    });
  } catch (e) {
    if (e instanceof EtatChange) return { ok: false, error: DEJA_CHANGE };
    throw e;
  }

  await recordAudit({
    actorId: user.id, action: "UPDATE", module: MODULE_AUDIT_VISITE,
    entityType: "TOUR_PLAN", entityId: plan.id,
    summary: `Plan de tournée — ${paires.length} visite(s) planifiée(s) (+${aCreer.length} / −${aRetirer.length})`,
  });
  revalidatePath(PATH_TOURNEE);
  revalidatePath(PATH_JOURNEE);
  return { ok: true, id: plan.id };
}

/**
 * SOUMETTRE LE PLAN AU N+1.
 *
 * Le validateur est résolu ICI et FIGÉ : une promotion entre la soumission et la décision ne
 * doit pas changer qui décide (§118.107). Quand personne ne surplombe le KAM, le refus le DIT
 * avec le geste — désigner un superviseur sur la BU — au lieu de laisser un plan sans issue.
 */
/**
 * LE CIRCUIT DU PLAN PRÉVIENT CHAQUE PERSONNE DONT C'EST LE TOUR (§118.184). Il n'envoyait aucune
 * notification : le validateur n'apprenait pas qu'un plan l'attendait, le N+2 qu'on lui escaladait, et
 * le KAM qu'on avait rejeté son plan — alors que ses 48 h pour resoumettre couraient déjà.
 */
function lienDuPlan(planId: string): string {
  return `${PATH_TOURNEE}?plan=${planId}`;
}
function periodeLisible(debut: Date, fin: Date): string {
  const f = (d: Date) => d.toLocaleDateString("fr-FR", { timeZone: "Africa/Algiers" });
  return `${f(debut)} → ${f(fin)}`;
}

export async function soumettrePlanTournee(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, MODULE, "CREATE")) return { ok: false, error: "Non autorisé." };
  const planId = fdStr(formData, "planId");
  if (!planId) return { ok: false, error: "Plan introuvable." };
  const plan = await prisma.tourPlan.findUnique({
    where: { id: planId },
    select: {
      id: true, repId: true, status: true, periodStart: true, periodEnd: true, revisionNote: true,
      rep: { select: { name: true } },
      visits: { select: { id: true, date: true } },
    },
  });
  if (!plan) return { ok: false, error: "Plan introuvable." };
  if (!(await peutEcrirePourLeKam(user, plan.repId))) return { ok: false, error: "Ce plan n'est pas dans votre périmètre." };

  const bloquants = bloquantsDeSoumission({
    statut: plan.status as StatutPlan,
    nbVisites: plan.visits.length,
    nbHorsJoursOuvres: plan.visits.filter((v) => !estJourOuvrePourTournee(v.date)).length,
    nbHorsPeriode: plan.visits.filter((v) => v.date < plan.periodStart || v.date > plan.periodEnd).length,
  });
  // TOUS LES BLOQUANTS EN UNE FOIS : un refus par défaut ferait ressaisir un plan de quarante
  // visites autant de fois qu'il a de problèmes (§118.18).
  if (bloquants.length > 0) return { ok: false, error: bloquants.join(" ") };

  const profil = await prisma.salesRepProfile.findUnique({
    where: { repId: plan.repId },
    select: { businessUnit: { select: { supervisorId: true, name: true } } },
  });
  const managerRh = await getManagerOfUser(plan.repId);
  const reviseur = reviseurDuPlan({
    repId: plan.repId,
    superviseurBuId: profil?.businessUnit?.supervisorId ?? null,
    managerRhId: managerRh?.userId ?? null,
  });
  if (!reviseur) {
    return {
      ok: false,
      error: "Aucun validateur : ce KAM n'a ni superviseur sur sa BU ni N+1 à l'organigramme. "
        + "Désignez le superviseur de sa Business Unit (Business Units) — c'est lui qui valide un plan de tournée.",
    };
  }

  // L'ÉTAT LU, ET LUI SEUL (§118.193) : une grille enregistrée ou une décision passée entre-temps, et l'on
  // soumettrait autre chose que ce que la vérification ci-dessus a compté.
  const soumis = await prisma.tourPlan.updateMany({
    where: { id: plan.id, status: plan.status },
    data: {
      status: "SUBMITTED", submittedAt: new Date(), reviewerId: reviseur.id,
      // La décision précédente s'efface : ce qui repart en validation n'est plus rejeté. Le MOTIF d'une
      // révision, lui, reste jusqu'à la décision : c'est ce que le validateur doit lire pour juger.
      rejectionComment: null, resubmitDueAt: null, decidedAt: null, decidedById: null,
      escalatedToId: null, escalatedAt: null,
    },
  });
  if (soumis.count === 0) return { ok: false, error: DEJA_CHANGE };
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: MODULE_AUDIT_VISITE,
    entityType: "TOUR_PLAN", entityId: plan.id,
    summary: `Plan de tournée soumis à validation (${plan.visits.length} visite(s))`,
  });
  await notifyUser({
    userId: reviseur.id, type: "MEDICAL_TOUR",
    title: `Plan de tournée à valider — ${plan.rep.name}`,
    body: `${plan.revisionNote ? `Plan validé, révisé : « ${plan.revisionNote} ». ` : ""}${plan.visits.length} visite(s) du ${periodeLisible(plan.periodStart, plan.periodEnd)}. Validez-le, rejetez-le avec vos commentaires, ou demandez l'avis de votre N+1.`,
    link: lienDuPlan(plan.id),
  });
  revalidatePath(PATH_TOURNEE);
  return { ok: true, id: plan.id };
}

/**
 * LE N+1 DEMANDE UNE VALIDATION À SON PROPRE N+1.
 *
 * La demande le prévoit explicitement. On n'escalade QU'UNE FOIS : un plan déjà chez le N+2 ne
 * remonte pas au N+3 — une chaîne sans fin ferait un plan que personne ne tranche.
 */
export async function escaladerPlanTournee(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const planId = fdStr(formData, "planId");
  if (!planId) return { ok: false, error: "Plan introuvable." };
  const plan = await prisma.tourPlan.findUnique({
    where: { id: planId },
    select: {
      id: true, repId: true, status: true, reviewerId: true, escalatedToId: true, periodStart: true, periodEnd: true,
      rep: { select: { name: true } },
    },
  });
  if (!plan) return { ok: false, error: "Plan introuvable." };
  if (!gestesPossibles(plan.status as StatutPlan).escaladable) {
    return { ok: false, error: `Un plan « ${plan.status} » ne s'escalade pas — on ne remonte qu'une fois, et un plan déjà escaladé attend la décision du N+2.` };
  }
  // L'ESCALADE EST PERSONNELLE : c'est le réviseur DÉSIGNÉ qui se dessaisit, pas quiconque a le module.
  // Une vue globale passe, parce qu'elle porte déjà la décision. La règle est celle de l'écran (§118.184).
  const acces = accesAuPlan({
    userId: user.id, vueGlobale: hasGlobalView(user), repId: plan.repId,
    reviewerId: plan.reviewerId, escalatedToId: plan.escalatedToId, statut: plan.status as StatutPlan, chaineDuKam: [],
    agitPour: await standInForUserIds(user.id),
  });
  if (!acces.escalader) {
    return { ok: false, error: "Seul le validateur désigné peut demander une validation à son N+1." };
  }
  const managerDuReviseur = plan.reviewerId ? await getManagerOfUser(plan.reviewerId) : null;
  const cible = escaladeDuPlan({
    repId: plan.repId,
    reviseurId: plan.reviewerId ?? user.id,
    managerDuReviseurId: managerDuReviseur?.userId ?? null,
  });
  if (!cible) {
    return {
      ok: false,
      error: "Aucun N+2 à qui escalader : votre organigramme ne place personne au-dessus de vous pour ce plan. "
        + "Tranchez-le, ou faites compléter l'organigramme (Ressources humaines › Organigramme).",
    };
  }
  const escalade = await prisma.tourPlan.updateMany({
    where: { id: plan.id, status: "SUBMITTED", reviewerId: plan.reviewerId, escalatedToId: null },
    data: { status: "ESCALATED", escalatedToId: cible, escalatedAt: new Date() },
  });
  if (escalade.count === 0) return { ok: false, error: DEJA_CHANGE };
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: MODULE_AUDIT_VISITE,
    entityType: "TOUR_PLAN", entityId: plan.id, summary: "Plan de tournée escaladé au N+2",
  });
  await notifyUser({
    userId: cible, type: "MEDICAL_TOUR",
    title: `Plan de tournée escaladé — ${plan.rep.name}`,
    body: `Le validateur vous demande de trancher le plan du ${periodeLisible(plan.periodStart, plan.periodEnd)}.`,
    link: lienDuPlan(plan.id),
  });
  revalidatePath(PATH_TOURNEE);
  return { ok: true, id: plan.id };
}

/**
 * DÉCIDER — valider, ou rejeter AVEC des commentaires de rectification.
 *
 * Un rejet sans motif ne se corrige pas, il se subit : le commentaire est OBLIGATOIRE, et le
 * KAM a 48 h pour resoumettre corrigé (`resubmitDueAt`, écrit ici plutôt que déduit à la lecture
 * — la date du rejet est la seule qui fasse foi).
 */
export async function deciderPlanTournee(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const planId = fdStr(formData, "planId");
  const decision = fdStr(formData, "decision");
  if (!planId) return { ok: false, error: "Plan introuvable." };
  if (decision !== "APPROVE" && decision !== "REJECT") return { ok: false, error: "Décision illisible (attendu : valider ou rejeter)." };
  const plan = await prisma.tourPlan.findUnique({
    where: { id: planId },
    select: {
      id: true, repId: true, status: true, reviewerId: true, escalatedToId: true, periodStart: true, periodEnd: true,
    },
  });
  if (!plan) return { ok: false, error: "Plan introuvable." };
  if (!gestesPossibles(plan.status as StatutPlan).decidable) {
    return { ok: false, error: `Un plan « ${plan.status} » ne se décide pas — il n'est pas (ou plus) en attente de validation.` };
  }
  // QUI TRANCHE : le réviseur tant que le plan est chez lui, le N+2 dès qu'il est escaladé — jamais les
  // deux, jamais le KAM sur son propre plan. La règle est celle de l'écran (§118.184).
  const acces = accesAuPlan({
    userId: user.id, vueGlobale: hasGlobalView(user), repId: plan.repId,
    reviewerId: plan.reviewerId, escalatedToId: plan.escalatedToId, statut: plan.status as StatutPlan, chaineDuKam: [],
    agitPour: await standInForUserIds(user.id),
  });
  if (!acces.decider) {
    return { ok: false, error: "Seule la personne à qui ce plan est soumis peut le trancher." };
  }

  const commentaire = fdStr(formData, "comment");
  // `=== null`, jamais `!commentaire` : la dérivation des contrats lit une négation comme une obligation, et un
  // plan ne se validerait plus sans commentaire depuis le chemin générique (§118.138).
  if (decision === "REJECT" && commentaire === null) {
    return { ok: false, error: "Un rejet sans commentaire de rectification ne se corrige pas — dites ce qui doit changer." };
  }

  const maintenant = new Date();
  // QUI TRANCHE A ÉTÉ LU AVEC L'ÉTAT : une escalade passée entre-temps donne la main au N+2, et la décision du
  // validateur arriverait sur un plan qui n'est plus chez lui. La révision se clôt avec la décision.
  const finRevision = { revisionNote: null, revisionRequestedAt: null, revisionRequestedById: null };
  const decide = await prisma.tourPlan.updateMany({
    where: { id: plan.id, status: plan.status, reviewerId: plan.reviewerId, escalatedToId: plan.escalatedToId },
    data: decision === "APPROVE"
      ? { status: "APPROVED", decidedAt: maintenant, decidedById: user.id, rejectionComment: null, resubmitDueAt: null, ...finRevision }
      : { status: "REJECTED", decidedAt: maintenant, decidedById: user.id, rejectionComment: commentaire, resubmitDueAt: limiteResoumission(maintenant), ...finRevision },
  });
  if (decide.count === 0) return { ok: false, error: DEJA_CHANGE };
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: MODULE_AUDIT_VISITE,
    entityType: "TOUR_PLAN", entityId: plan.id,
    summary: decision === "APPROVE" ? "Plan de tournée VALIDÉ" : "Plan de tournée REJETÉ (48 h pour resoumettre)",
  });
  const limite = decision === "REJECT" ? limiteResoumission(maintenant) : null;
  await notifyUser({
    userId: plan.repId, type: "MEDICAL_TOUR",
    title: decision === "APPROVE" ? "Votre plan de tournée est validé" : "Votre plan de tournée est rejeté — à corriger",
    body: decision === "APPROVE"
      ? `Plan du ${periodeLisible(plan.periodStart, plan.periodEnd)} : vos visites sont dans votre emploi du temps.`
      : `${commentaire}\n\nÀ resoumettre avant le ${limite!.toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short", timeZone: "Africa/Algiers" })}.`,
    link: lienDuPlan(plan.id),
  });
  revalidatePath(PATH_TOURNEE);
  revalidatePath(PATH_JOURNEE);
  return { ok: true, id: plan.id };
}

/**
 * DEMANDER UNE RÉVISION D'UN PLAN VALIDÉ (§118.193 — audit 360°, R13).
 *
 * Un plan validé ne se réécrivait plus : un médecin absent toute la semaine, une réunion imposée, un congrès —
 * la tournée changeait sur le terrain et le plan restait faux jusqu'à la fin de la période, ou le KAM ne pouvait
 * rien en dire. La révision le ROUVRE, motif à l'appui : il repasse « En révision », se modifie, et se resoumet
 * à la validation — un accord ne couvre pas plus que ce qu'il a vu (§118.187). Ce qui a déjà eu lieu reste
 * (`retraitInterditApresRevision`), et le délai de resoumission est celui d'un rejet (48 h).
 *
 * Qui peut : quiconque peut écrire ce plan — le KAM, le superviseur de sa BU, la Direction (`peutEcrirePourLeKam`,
 * la même règle que la grille). La personne qui a validé est prévenue quand c'est le KAM qui rouvre ; le KAM est
 * prévenu quand c'est quelqu'un d'autre — on ne rouvre pas la tournée de quelqu'un sans le lui dire.
 */
export async function demanderRevisionPlanTournee(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, MODULE, "CREATE")) return { ok: false, error: "Non autorisé." };
  const planId = fdStr(formData, "planId");
  if (!planId) return { ok: false, error: "Plan introuvable." };
  const plan = await prisma.tourPlan.findUnique({
    where: { id: planId },
    select: {
      id: true, repId: true, status: true, reviewerId: true, decidedById: true, periodStart: true, periodEnd: true,
      rep: { select: { name: true } },
    },
  });
  if (!plan) return { ok: false, error: "Plan introuvable." };
  if (!(await peutEcrirePourLeKam(user, plan.repId))) return { ok: false, error: "Ce plan n'est pas dans votre périmètre." };
  // L'ÉTAT D'ABORD, LE MOTIF ENSUITE (§118.18) : demander pourquoi avant de dire que rien ne se rouvre d'ici
  // ferait écrire un motif pour rien.
  if (!gestesPossibles(plan.status as StatutPlan).revisable) {
    return {
      ok: false,
      error: plan.status === "SUBMITTED" || plan.status === "ESCALATED"
        ? "Ce plan attend la décision de son validateur : il ne se révise qu'une fois validé."
        : "Ce plan n'est pas validé : il se modifie déjà — changez ses visites, puis soumettez-le.",
    };
  }
  const note = fdStr(formData, "note");
  if (!note) return { ok: false, error: "Dites ce qui change dans la tournée : c'est ce que lira la personne qui l'a validée." };

  const maintenant = new Date();
  const limite = limiteResoumission(maintenant);
  const rouvert = await prisma.tourPlan.updateMany({
    where: { id: plan.id, status: "APPROVED" },
    data: {
      status: "REVISION", revisionNote: note, revisionRequestedAt: maintenant, revisionRequestedById: user.id,
      revisionCount: { increment: 1 }, resubmitDueAt: limite,
    },
  });
  if (rouvert.count === 0) return { ok: false, error: DEJA_CHANGE };

  await recordAudit({
    actorId: user.id, action: "UPDATE", module: MODULE_AUDIT_VISITE,
    entityType: "TOUR_PLAN", entityId: plan.id,
    summary: `Plan de tournée validé rouvert pour révision — ${note}`,
  });
  const periode = periodeLisible(plan.periodStart, plan.periodEnd);
  const avant = limite.toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short", timeZone: "Africa/Algiers" });
  const validateur = plan.decidedById ?? plan.reviewerId;
  if (user.id === plan.repId) {
    if (validateur && validateur !== user.id) {
      await notifyUser({
        userId: validateur, type: "MEDICAL_TOUR",
        title: `Plan de tournée rouvert pour révision — ${plan.rep.name}`,
        body: `Le plan du ${periode}, que vous aviez validé, est en révision : « ${note} ». Il vous reviendra en validation.`,
        link: lienDuPlan(plan.id),
      });
    }
  } else {
    await notifyUser({
      userId: plan.repId, type: "MEDICAL_TOUR",
      title: "Votre plan de tournée est rouvert pour révision",
      body: `Plan du ${periode} : « ${note} ».\n\nÀ resoumettre avant le ${avant} — les visites déjà passées restent au plan.`,
      link: lienDuPlan(plan.id),
    });
    if (validateur && validateur !== user.id && validateur !== plan.repId) {
      await notifyUser({
        userId: validateur, type: "MEDICAL_TOUR",
        title: `Plan de tournée rouvert pour révision — ${plan.rep.name}`,
        body: `Le plan du ${periode}, que vous aviez validé, est en révision : « ${note} ». Il vous reviendra en validation.`,
        link: lienDuPlan(plan.id),
      });
    }
  }
  revalidatePath(PATH_TOURNEE);
  return { ok: true, id: plan.id };
}

/**
 * SUPPRIMER UN PLAN EN BROUILLON (Direction, 10/2026) — un brouillon que le KAM ne veut plus ne doit pas rester
 * dans sa liste pour toujours.
 *
 * Qui : le KAM propriétaire, le Super Admin, et quiconque peut écrire son plan (`peutEcrirePourLeKam`). Quand :
 * `DRAFT` uniquement — un plan soumis, validé, rejeté ou en révision a une histoire de décision qui ne s'efface pas.
 * Ce qui part : le plan et ses visites encore `PLANNED` sans rapport. Une visite déjà rapportée (statut hors
 * `PLANNED`, ou rapport terrain rattaché) n'est JAMAIS supprimée : le refus le dit, et le plan reste.
 */
export async function supprimerPlanTourneeBrouillon(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, MODULE, "CREATE")) return { ok: false, error: "Non autorisé." };
  const planId = fdStr(formData, "planId");
  if (!planId) return { ok: false, error: "Plan introuvable." };
  const plan = await prisma.tourPlan.findUnique({
    where: { id: planId },
    select: { id: true, repId: true, status: true, periodStart: true, periodEnd: true, updatedAt: true, rep: { select: { name: true } } },
  });
  if (!plan) return { ok: false, error: "Plan introuvable." };
  if (user.role !== "SUPER_ADMIN" && !(await peutEcrirePourLeKam(user, plan.repId))) {
    return { ok: false, error: "Ce plan n'est pas dans votre périmètre." };
  }
  if (plan.status !== "DRAFT") {
    return { ok: false, error: "Seul un plan en brouillon se supprime : un plan soumis, validé ou rejeté garde sa trace de décision." };
  }
  const visites = await prisma.medicalVisit.findMany({
    where: { tourPlanId: plan.id },
    select: { id: true, status: true, _count: { select: { fieldReports: true } } },
  });
  const rapportees = visites.filter((v) => v.status !== "PLANNED" || v._count.fieldReports > 0);
  if (rapportees.length > 0) {
    return {
      ok: false,
      error: `${rapportees.length} visite(s) de ce plan ont déjà été rapportées : elles ne se suppriment pas, donc le plan non plus.`,
    };
  }

  try {
    await prisma.$transaction(async (tx) => {
      // LE PLAN QU'ON A LU, ET LUI SEUL : soumis entre-temps, il n'est plus un brouillon.
      const encore = await tx.tourPlan.updateMany({
        where: { id: plan.id, status: "DRAFT", updatedAt: plan.updatedAt },
        data: { updatedAt: new Date() },
      });
      if (encore.count === 0) throw new EtatChange();
      // Seules les visites encore planifiées partent ; si l'une a été rapportée entre-temps, tout s'annule.
      const retirees = await tx.medicalVisit.deleteMany({ where: { tourPlanId: plan.id, status: "PLANNED", fieldReports: { none: {} } } });
      if (retirees.count !== visites.length) throw new EtatChange();
      await tx.tourPlan.delete({ where: { id: plan.id } });
    });
  } catch (e) {
    if (e instanceof EtatChange) return { ok: false, error: DEJA_CHANGE };
    throw e;
  }

  await recordAudit({
    actorId: user.id, action: "DELETE", module: MODULE_AUDIT_VISITE,
    entityType: "TOUR_PLAN", entityId: plan.id,
    summary: `Plan de tournée en brouillon supprimé — ${plan.rep.name}, ${periodeLisible(plan.periodStart, plan.periodEnd)} (${visites.length} visite(s) planifiée(s) retirée(s))`,
  });
  revalidatePath(PATH_TOURNEE);
  revalidatePath(PATH_JOURNEE);
  return { ok: true, id: plan.id };
}