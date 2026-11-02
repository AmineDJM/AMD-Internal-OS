import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/session";
import { type Module, userCan } from "@/lib/rbac";
import { recordFieldChanges } from "@/lib/audit";
import { composer, conclure, type Changement, type CompteRendu, type EtatActuel, type PlanAnnulation } from "@/lib/annulation/plan";
import { sansBloquer } from "@/lib/journal";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE PONT DE L'ANNULATION (mandat 6 §48) — la seule couche qui a le droit d'écrire.
 *
 * ── TROIS PROPRIÉTÉS, ET AUCUNE N'EST NÉGOCIABLE ────────────────────────────────────────
 *
 * 1. **L'écriture est un COMPARE-AND-SWAP, pas une lecture suivie d'une écriture.** La
 *    condition « la valeur est encore celle qu'Adam a laissée » est dans le `where` de la
 *    requête, donc évaluée par PostgreSQL au moment de l'écriture. Un `findFirst` puis un
 *    `update` laisserait une fenêtre — courte, réelle, et c'est exactement pendant cette
 *    fenêtre qu'un collègue enregistre depuis son écran. `count === 0` veut dire « quelqu'un
 *    est passé avant » et le geste est refusé, nommément.
 *
 * 2. **Une annulation est un CHANGEMENT, jamais une gomme.** Elle passe par
 *    `recordFieldChanges` — le chemin qu'empruntent les cinq cents écritures de l'ERP — donc
 *    elle apparaît dans le journal, dans l'historique de l'écran, dans le modèle du monde
 *    (§45), et elle est elle-même annulable. On n'efface jamais une ligne d'audit : on en
 *    écrit une de plus. Une couche d'annulation qui réécrirait l'histoire serait pire que pas
 *    de couche du tout, parce qu'elle rendrait l'audit faux.
 *
 * 3. **Les champs restaurables sont une LISTE FERMÉE, avec leur type.** Le nom du champ vient
 *    d'une ligne de journal, c'est-à-dire d'une donnée ; le passer tel quel à Prisma laisserait
 *    une entrée écrire n'importe quelle colonne. La liste dit aussi comment CONVERTIR : le
 *    journal ne stocke que du texte, et remettre « 42000 » dans une colonne `Decimal` ou
 *    « 2026-03-01 » dans une `DateTime` demande une conversion qui peut échouer — auquel cas on
 *    refuse au lieu d'écrire une valeur approximative.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Le module qui garde chaque type d'entité — la même porte que l'écran correspondant. */
const MODULE_DE: Record<string, Module> = {
  PAYMENT_REQUEST: "VALIDATIONS",
  EXPENSE_ORDER: "FINANCES",
  LEGAL_DOCUMENT: "LEGAL",
  REGULATORY_PRODUCT: "REGULATORY",
  TASK: "WORKSPACE",
};

type Conversion = "texte" | "enum" | "nombre" | "date" | "reference";

/**
 * CE QU'ON ACCEPTE DE REMETTRE, ET RIEN D'AUTRE.
 *
 * La liste est volontairement courte : ce sont les champs pour lesquels « remettre la valeur
 * d'avant » a un sens métier évident et sans effet de bord. On n'y trouve ni `amount` d'un
 * paiement déjà validé, ni aucun champ dont la remise déclencherait un autre circuit — un
 * statut qui rouvrirait une validation, par exemple, se corrige depuis l'écran de validation,
 * là où la personne voit ce qu'elle relance.
 */
const RESTAURABLES: Readonly<Record<string, Readonly<Record<string, Conversion>>>> = {
  REGULATORY_PRODUCT: { status: "enum", priority: "enum", notes: "texte" },
  TASK: { status: "enum", priority: "enum", dueDate: "date", assignedToId: "reference", title: "texte" },
  LEGAL_DOCUMENT: { status: "enum", notes: "texte", title: "texte" },
  // `centralStatus` N'Y EST PLUS (§118.148). Le remettre, c'était rendre OU retirer une
  // autorisation du centre de paiement — le geste réservé à ceux qui y siègent — avec pour seule
  // garde le droit d'écrire sur les Finances. « Annule ce qu'Adam a modifié sur cet ordre »
  // pouvait donc remettre « Autorisé » sur un paiement que le centre venait de rouvrir. C'est
  // exactement le statut « qui rouvrirait une validation » que la règle ci-dessus exclut : il se
  // corrige au centre, là où siège celui qui en a le droit.
  EXPENSE_ORDER: { notes: "texte" },
  PAYMENT_REQUEST: { title: "texte" },
};

const TABLE_DE: Record<string, "regulatoryProduct" | "task" | "legalDocument" | "expenseOrder" | "paymentRequest"> = {
  REGULATORY_PRODUCT: "regulatoryProduct",
  TASK: "task",
  LEGAL_DOCUMENT: "legalDocument",
  EXPENSE_ORDER: "expenseOrder",
  PAYMENT_REQUEST: "paymentRequest",
};

export type Refus = { erreur: string; suite?: string };

/** Convertit une valeur de journal (du texte) vers ce que la colonne attend. `undefined` = refus. */
function convertir(valeur: string | null, comment: Conversion): unknown | undefined {
  if (valeur === null || valeur === "" || valeur === "—") {
    // Un champ obligatoire ne se vide pas : c'est au `where` de Prisma de le refuser si besoin.
    return comment === "texte" || comment === "date" || comment === "reference" ? null : undefined;
  }
  switch (comment) {
    case "texte": case "enum": case "reference": return valeur;
    case "nombre": { const n = Number(valeur.replace(/\s/g, "").replace(",", ".")); return Number.isFinite(n) ? n : undefined; }
    case "date": { const d = new Date(valeur); return Number.isNaN(d.getTime()) ? undefined : d; }
  }
}

/** Les lignes de journal converties en `Changement` — la forme que le moteur pur attend. */
function versChangement(l: {
  id: string; actorId: string | null; actor: { name: string } | null; createdAt: Date;
  action: string; module: string; entityType: string | null; entityId: string | null;
  field: string | null; oldValue: string | null; newValue: string | null; summary: string | null;
}, adamIds: ReadonlySet<string>): Changement {
  return {
    id: l.id, auteurId: l.actorId, auteurNom: l.actor?.name ?? null,
    parAdam: l.actorId !== null && adamIds.has(l.actorId),
    quand: l.createdAt, action: String(l.action), module: l.module,
    entite: l.entityType, entiteId: l.entityId, champ: l.field,
    avant: l.oldValue, apres: l.newValue, resume: l.summary,
  };
}

const CHAMPS = {
  id: true, actorId: true, createdAt: true, action: true, module: true,
  entityType: true, entityId: true, field: true, oldValue: true, newValue: true, summary: true,
  actor: { select: { name: true } },
} as const;

export interface Portee {
  /** L'entité visée — sans elle on ne compose pas de plan : « annule tout » n'est pas une demande. */
  entite: string;
  entiteId: string;
  depuis: Date;
  jusqua?: Date | null;
  /** Ne prendre que ce qu'ADAM a fait (le défaut) ou tout ce qui a bougé sur la période. */
  adamSeulement?: boolean;
}

/**
 * LIT L'HISTOIRE DU PÉRIMÈTRE, SOUS LES DROITS DE LA PERSONNE, et compose le plan.
 *
 * Ne modifie rien. C'est l'aperçu qu'on montre AVANT de demander « on y va ? » — §118.8 :
 * un accord, pas 99 confirmations, mais pas un chèque en blanc non plus.
 */
export async function preparerAnnulation(user: CurrentUser, p: Portee): Promise<{ plan: PlanAnnulation; module: Module } | Refus> {
  const module = MODULE_DE[p.entite];
  if (!module) return { erreur: `Le type « ${p.entite} » n'est pas de ceux dont on sait défaire les changements.`, suite: "Corriger depuis l'écran du module concerné." };
  if (!userCan(user, module, "VIEW")) return { erreur: `Vous n'avez pas accès au module ${module}.` };

  const jusqua = p.jusqua ?? new Date();
  const lignes = await prisma.auditLog.findMany({
    where: { entityType: p.entite as never, entityId: p.entiteId, createdAt: { gte: p.depuis, lte: jusqua } },
    select: CHAMPS,
    orderBy: { createdAt: "asc" },
    take: 500,
  });

  // QUI EST « ADAM » : les intentions d'assistant exécutées sur la période portent l'identité de
  // la personne pour le compte de qui il agissait. On ne devine pas sur le nom.
  const adamIds = new Set<string>();
  const intentions = await prisma.assistantActionIntent.findMany({
    where: { status: "EXECUTED", executedAt: { gte: p.depuis, lte: jusqua } },
    select: { userId: true },
    take: 500,
  });
  for (const i of intentions) adamIds.add(i.userId);

  const tous = lignes.map((l) => versChangement(l as never, adamIds));
  // Le résumé d'audit d'un geste d'assistant le dit : c'est la marque la plus fiable.
  for (const c of tous) if (/\badam\b|assistant/i.test(`${c.resume ?? ""} ${c.module}`)) c.parAdam = true;

  const vises = p.adamSeulement === false ? tous : tous.filter((c) => c.parAdam);
  if (vises.length === 0) {
    return { plan: { gestes: [], ecartes: [], resume: "Aucun changement d'Adam sur ce périmètre et cette période.", complet: false }, module };
  }

  // ── LES VALEURS ACTUELLES : lues une fois, pour la comparaison du moteur pur ─────────
  const etats: EtatActuel[] = [];
  const champsVises = [...new Set(vises.map((c) => c.champ).filter((x): x is string => Boolean(x)))];
  const permis = RESTAURABLES[p.entite] ?? {};
  const lisibles = champsVises.filter((c) => c in permis);
  if (lisibles.length > 0) {
    const table = TABLE_DE[p.entite]!;
    const select = Object.fromEntries(lisibles.map((c) => [c, true]));
    const row = await (prisma[table] as { findUnique: (a: unknown) => Promise<Record<string, unknown> | null> })
      .findUnique({ where: { id: p.entiteId }, select });
    if (row) {
      for (const c of lisibles) {
        const v = row[c];
        etats.push({ entite: p.entite, entiteId: p.entiteId, champ: c, valeur: v === null || v === undefined ? null : String(v instanceof Date ? v.toISOString() : v) });
      }
    }
  }

  // Les changements POSTÉRIEURS, pour pouvoir nommer qui est passé après Adam.
  const posterieurs = tous.filter((c) => !c.parAdam);
  return { plan: composer(vises, etats, posterieurs), module };
}

/**
 * APPLIQUE — et seulement ce qui a été montré.
 *
 * `gestesRetenus` porte les identifiants de changements que la personne a validés ; un
 * identifiant absent du plan est IGNORÉ, pas cherché ailleurs. C'est ce qui empêche un appel
 * de porter plus loin que l'aperçu sur lequel l'accord a été donné.
 */
export async function appliquerAnnulation(
  user: CurrentUser,
  p: Portee,
  gestesRetenus?: readonly string[],
): Promise<{ compteRendu: CompteRendu; plan: PlanAnnulation } | Refus> {
  const prep = await preparerAnnulation(user, p);
  if ("erreur" in prep) return prep;
  const { plan, module } = prep;

  // ÉCRIRE EXIGE LE DROIT D'ÉCRIRE — vérifié ICI, à l'application, et pas seulement à l'aperçu.
  if (!userCan(user, module, "UPDATE")) {
    return { erreur: `Vous pouvez consulter ${module} mais pas y écrire : l'annulation exige le droit de MODIFIER.`, suite: "Demander à une personne qui a le droit de modifier ce module." };
  }

  const retenus = gestesRetenus ? new Set(gestesRetenus) : null;
  const aFaire = retenus ? plan.gestes.filter((g) => retenus.has(g.changementId)) : plan.gestes;
  const echoues: { changementId: string; pourquoi: string }[] = [];

  for (const g of aFaire) {
    const permis = RESTAURABLES[g.entite]?.[g.champ];
    if (!permis) {
      echoues.push({ changementId: g.changementId, pourquoi: `le champ « ${g.champ} » n'est pas de ceux qu'on remet automatiquement` });
      continue;
    }
    const valeur = convertir(g.valeurCible, permis);
    if (valeur === undefined) {
      echoues.push({ changementId: g.changementId, pourquoi: `« ${g.valeurCible} » n'est pas convertible en ${permis} : écrire une approximation serait pire que ne rien faire` });
      continue;
    }
    const attendue = convertir(g.valeurAttendue, permis);
    const table = TABLE_DE[g.entite]!;

    try {
      // ── LE COMPARE-AND-SWAP ────────────────────────────────────────────────────────
      // La condition est DANS le `where` : PostgreSQL l'évalue au moment de l'écriture, et
      // `count === 0` signifie que quelqu'un est passé entre l'aperçu et maintenant.
      const r = await (prisma[table] as { updateMany: (a: unknown) => Promise<{ count: number }> }).updateMany({
        where: { id: g.entiteId, [g.champ]: attendue === undefined ? null : attendue },
        data: { [g.champ]: valeur },
      });
      if (r.count === 0) {
        echoues.push({ changementId: g.changementId, pourquoi: `« ${g.champ} » ne vaut plus « ${g.valeurAttendue ?? "vide"} » : quelqu'un l'a modifié entre l'aperçu et maintenant` });
        continue;
      }
      // ── L'ANNULATION EST UN CHANGEMENT : elle s'écrit dans le journal comme les autres ──
      await recordFieldChanges(
        { actorId: user.id, module: `${module} (annulation)`, entityType: g.entite as never, entityId: g.entiteId, summary: `Annulation d'un changement d'Adam du ${g.quand.toLocaleDateString("fr-FR")}` },
        { [g.champ]: g.valeurAttendue },
        { [g.champ]: g.valeurCible },
        [g.champ],
      ).catch(sansBloquer("annulation.appliquerAnnulation.recordFieldChanges"));
    } catch (e) {
      echoues.push({ changementId: g.changementId, pourquoi: e instanceof Error ? e.message.slice(0, 160) : "écriture refusée" });
    }
  }

  return { compteRendu: conclure({ ...plan, gestes: aFaire }, echoues), plan };
}

export type { Changement, CompteRendu, PlanAnnulation } from "@/lib/annulation/plan";
export { NATURES_GESTE, REVERSIBILITES } from "@/lib/annulation/reversibilite";
