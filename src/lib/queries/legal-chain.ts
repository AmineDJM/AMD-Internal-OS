import type { LegalDocKind, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { toNumber } from "@/lib/utils";
import { companyScopedWhere } from "@/lib/company";
import { natureLegale } from "@/lib/labels";
import { chainOf, type ChainDoc } from "@/lib/legal/chain";
import type { SessionUser } from "@/lib/rbac";
import { legalKindVisible } from "@/lib/lecteurs/legal";
import { perimetreLegal } from "@/lib/queries/visibilite-listes";
import { accesAuxPiecesLegalDetaille } from "@/lib/entity-access";
import type { AmontComposable } from "@/components/pieces/composer-piece";

/**
 * CHARGER LA CHAÎNE D'ACHAT d'un document — les maillons, leurs validateurs, le règlement.
 *
 * Le fil est court (devis → BC → facture, rarement plus de cinq pièces) : on le remonte par
 * requêtes successives plutôt qu'en SQL récursif — dix allers-retours au pire, bornés, lisibles.
 * L'ordre final vient du module pur `chainOf`, le même que testent les tests.
 */

export interface ChainValidator {
  name: string;
  state: string; // PENDING | APPROVED | REJECTED…
  decidedAt: string | null;
}

export interface ChainLink {
  id: string;
  kind: string;
  /** Le titre — le libellé NEUTRE `MAILLON_HORS_PERIMETRE` pour un maillon que la personne ne lit pas. */
  title: string;
  reference: string | null;
  amount: number | null;
  date: string | null; // startDate, à défaut createdAt — la date qui fait foi pour les délais
  isCurrent: boolean;
  validators: ChainValidator[];
  /**
   * La personne peut-elle LIRE ce maillon ? Faux : il garde sa PLACE et sa NATURE — sans elles la chaîne
   * mentirait (« Manque encore : Devis » sur un devis qui existe, une seconde facture saisie pour une
   * première restreinte) —, mais ni titre, ni référence, ni montant, ni date, ni validateurs.
   */
  lisible: boolean;
  /**
   * Sa fiche `/legal/[id]` s'ouvre-t-elle pour elle ? Faux pour un maillon illisible, ET pour un maillon
   * que seule une exception de lecture ouvre (`horsFiche`, §118.185) : un titre qui mène à une page
   * refusée est un geste offert puis retiré (§118.83) — il se rend sans lien.
   */
  ouvrable: boolean;
}

export interface ChainSettlement {
  id: string;
  status: string; // PENDING | PAID…
  centralStatus: string; // NOT_REQUIRED | AWAITING | APPROVED…
  paidAt: string | null;
  amount: number;
}

const MAX_HOPS = 10;

/** Ce qu'on dit d'une pièce qu'on ne peut pas lire — UNE formule, pour le menu « Fait suite à » et pour la chaîne. */
const HORS_PERIMETRE = "hors de votre périmètre";

/**
 * Le libellé d'un maillon de la chaîne que la personne ne peut pas lire (vague « restes »). Le menu « Fait
 * suite à » a le sien (`AMONT_HORS_PERIMETRE`, §118.168), mais il dit « amont actuelle » — faux d'une facture
 * qui SUIT la pièce regardée. Même fragment, donc même ton : deux rédactions finiraient par diverger (§118.5).
 */
export const MAILLON_HORS_PERIMETRE = `Pièce ${HORS_PERIMETRE}`;

export async function loadLegalChain(docId: string, user: SessionUser): Promise<{ links: ChainLink[]; settlement: ChainSettlement | null }> {
  type Row = {
    id: string; kind: string; title: string; reference: string | null;
    amount: unknown; startDate: Date | null; createdAt: Date; chainFromId: string | null; expenseOrderId: string | null;
  };
  const select = {
    id: true, kind: true, title: true, reference: true, amount: true,
    startDate: true, createdAt: true, chainFromId: true, expenseOrderId: true,
  } as const;

  const byId = new Map<string, Row>();
  const load = async (ids: string[]) => {
    const missing = ids.filter((i) => !byId.has(i));
    if (missing.length === 0) return;
    const rows = await prisma.legalDocument.findMany({ where: { id: { in: missing } }, select });
    for (const r of rows) byId.set(r.id, r);
  };

  await load([docId]);
  if (!byId.has(docId)) return { links: [], settlement: null };

  // Remonter les amonts, borné — un fil d'achat ne fait jamais dix maillons, une boucle si.
  for (let hop = 0; hop < MAX_HOPS; hop += 1) {
    const wanted = [...byId.values()].map((r) => r.chainFromId).filter((x): x is string => Boolean(x) && !byId.has(x!));
    if (wanted.length === 0) break;
    await load(wanted);
  }
  // Descendre : les pièces qui pointent vers ce qu'on connaît déjà.
  for (let hop = 0; hop < MAX_HOPS; hop += 1) {
    const children = await prisma.legalDocument.findMany({
      where: { chainFromId: { in: [...byId.keys()] }, id: { notIn: [...byId.keys()] } },
      select,
    });
    if (children.length === 0) break;
    for (const c of children) byId.set(c.id, c);
  }

  const docs: ChainDoc[] = [...byId.values()].map((r) => ({ id: r.id, kind: r.kind, chainFromId: r.chainFromId }));
  const ordered = chainOf(docs, docId);
  if (ordered.length === 0) return { links: [], settlement: null };

  // QUI LIT QUOI (vague « restes »). Chaque maillon montrait son titre, sa référence, son montant et ses
  // validateurs sans relire le droit de le lire : sur la fiche d'un bon de commande, les Finances — qui ne
  // lisent pas les devis — lisaient le titre et le montant du devis ; une facture restreinte à ses lecteurs
  // désignés exposait les siens sur la fiche de la pièce voisine. Le droit se lit par LA porte unique des
  // pièces (`accesAuxPiecesLegalDetaille`, en lot) : la même que la fiche, ses fichiers et les pièces liées
  // d'une demande — une seconde écriture de la règle finirait par diverger d'elle (§118.5).
  const ids = ordered.map((d) => d.id);
  const { droits, horsFiche } = await accesAuxPiecesLegalDetaille(user, ids, ["VIEW"]);
  const lisibles = droits.get("VIEW") ?? new Set<string>();

  // LES VALIDATEURS de chaque maillon LISIBLE : les étapes des demandes de validation qui le visent. Qui a
  // signé une pièce qu'on ne peut pas lire ne se dit pas non plus.
  const idsLisibles = ids.filter((i) => lisibles.has(i));
  const validations = idsLisibles.length === 0 ? [] : await prisma.validationRequest.findMany({
    where: { entityType: "LEGAL_DOCUMENT", entityId: { in: idsLisibles } },
    select: {
      entityId: true,
      steps: {
        select: { status: true, decidedAt: true, validator: { select: { name: true } } },
        orderBy: { order: "asc" },
      },
    },
  });
  const validatorsOf = new Map<string, ChainValidator[]>();
  for (const v of validations) {
    if (!v.entityId) continue;
    const list = validatorsOf.get(v.entityId) ?? [];
    for (const s of v.steps) {
      list.push({ name: s.validator.name, state: s.status, decidedAt: s.decidedAt?.toISOString() ?? null });
    }
    validatorsOf.set(v.entityId, list);
  }

  const links: ChainLink[] = ordered.map((d) => {
    const row = byId.get(d.id)!;
    // UN MAILLON ILLISIBLE GARDE SA PLACE, sans rien de ce qu'il porte : son montant ferait lire l'écart
    // devis → facture (donc le montant du devis), sa date le délai qui le sépare de ses voisins.
    if (!lisibles.has(row.id)) {
      return {
        id: row.id, kind: row.kind, title: MAILLON_HORS_PERIMETRE, reference: null, amount: null, date: null,
        isCurrent: row.id === docId, validators: [], lisible: false, ouvrable: false,
      };
    }
    return {
      id: row.id, kind: row.kind, title: row.title, reference: row.reference,
      amount: row.amount != null ? toNumber(row.amount as never) : null,
      date: (row.startDate ?? row.createdAt).toISOString(),
      isCurrent: row.id === docId,
      validators: validatorsOf.get(row.id) ?? [],
      lisible: true,
      ouvrable: !horsFiche.has(row.id),
    };
  });

  // LE RÈGLEMENT — l'ordre de dépense de la facture du fil (le dernier maillon LISIBLE qui en a un) : le
  // règlement d'une facture qu'on ne peut pas lire dirait son montant.
  const invoice = [...ordered].reverse().map((d) => byId.get(d.id)!).find((r) => r.expenseOrderId && lisibles.has(r.id));
  let settlement: ChainSettlement | null = null;
  if (invoice?.expenseOrderId) {
    const order = await prisma.expenseOrder.findUnique({
      where: { id: invoice.expenseOrderId },
      select: { id: true, status: true, centralStatus: true, paidDate: true, amount: true },
    });
    if (order) {
      settlement = {
        id: order.id, status: order.status, centralStatus: order.centralStatus,
        paidAt: order.paidDate?.toISOString() ?? null, amount: toNumber(order.amount),
      };
    }
  }

  return { links, settlement };
}

/** Les pièces amont proposées au menu : les plus récentes — un menu de trois mille pièces ne se lit pas. */
export const AMONT_PROPOSEES = 100;

export interface OptionAmont { value: string; label: string }

/** Le libellé d'une pièce amont qu'on ne peut pas lire : garder le lien n'en révèle pas le titre. */
export const AMONT_HORS_PERIMETRE = `Pièce amont actuelle (${HORS_PERIMETRE})`;

/** Le libellé d'une pièce amont dans un menu — un seul, pour la fiche Legal et pour le compositeur. */
export const libelleAmont = (r: { kind: string; reference: string | null; title: string }): string =>
  `${natureLegale(r.kind)} — ${r.reference ? `${r.reference} · ` : ""}${r.title}`;

/**
 * LES PIÈCES AMONT PROPOSÉES au menu « Fait suite à » — et, à la modification, la pièce ACTUELLE
 * toujours, en tête (§118.168).
 *
 * Le menu ne montre que les cent devis et bons de commande les plus récents. Une facture chaînée à
 * un BC plus ancien n'y retrouvait donc pas son BC : le navigateur affichait « — Pièce isolée — »,
 * et un simple « Enregistrer » (pour corriger une date) la DÉTACHAIT de son bon de commande, sans un
 * mot. Détachée, elle sortait de tout ce qui lit la chaîne : le cumul des factures d'un BC (on ne
 * paie pas plus que la commande), la règle « la facture d'un BC non validé ne part pas », l'écran
 * d'exécution d'un dossier. Un formulaire qui efface ce qu'on ne touche pas (§118.152c).
 *
 * La pièce actuelle hors du périmètre de la personne (une autre société, un document restreint)
 * reste proposée sous un libellé NEUTRE : garder un lien n'accorde rien, l'effacer parce qu'on ne
 * voit pas sa cible serait la perte silencieuse, et nommer son titre le révélerait.
 */
export async function piecesAmontProposees(opts: {
  userId: string;
  readerScope: Prisma.LegalDocumentWhereInput | null;
  /** La pièce qu'on modifie — jamais candidate à se suivre elle-même. */
  docId?: string;
  /** Sa pièce amont ACTUELLE, à la modification. */
  actuelId?: string | null;
}): Promise<OptionAmont[]> {
  // Même porte que la liste : le cloisonnement par entité ET les lecteurs désignés tiennent sur ce
  // que le menu propose — on ne chaîne pas une facture au bon de commande d'une autre société.
  const portee = (extra: Prisma.LegalDocumentWhereInput) =>
    companyScopedWhere<Prisma.LegalDocumentWhereInput>(opts.userId, {
      AND: [...(opts.readerScope ? [opts.readerScope] : []), extra],
    });
  const select = { id: true, kind: true, reference: true, title: true } as const;
  const [recentes, actuelle] = await Promise.all([
    prisma.legalDocument.findMany({
      where: await portee({ kind: { in: ["QUOTE", "PURCHASE_ORDER"] }, ...(opts.docId ? { id: { not: opts.docId } } : {}) }),
      select, orderBy: { createdAt: "desc" }, take: AMONT_PROPOSEES,
    }),
    opts.actuelId
      ? prisma.legalDocument.findFirst({ where: await portee({ id: opts.actuelId }), select })
      : Promise.resolve(null),
  ]);
  const options = recentes.map((r) => ({ value: r.id, label: libelleAmont(r) }));
  if (!opts.actuelId || options.some((o) => o.value === opts.actuelId)) return options;
  return [{ value: opts.actuelId, label: actuelle ? libelleAmont(actuelle) : AMONT_HORS_PERIMETRE }, ...options];
}

/**
 * LES PIÈCES AMONT DU COMPOSITEUR (audit 360°, lot D1c — F1) — par LA porte de la liste Legal (`perimetreLegal` :
 * société de l'en-tête, lecteurs désignés, natures ouvertes), sans les annulées, par nature, les plus récentes
 * d'abord (la coupe est DITE, §118.60). Une nature que la personne ne lit pas n'est pas interrogée : elle est
 * NOMMÉE, pour que l'écran dise pourquoi le menu est vide — les Finances ne lisent pas les devis, et un menu muet
 * leur ferait chercher un devis qui existe.
 */
export async function piecesAmontComposables(user: SessionUser, natures: readonly string[]): Promise<AmontComposable> {
  const { portee, where } = await perimetreLegal(user);
  const lisibles = where ? natures.filter((k) => legalKindVisible(portee, k)) : [];
  const fermees = natures.filter((k) => !lisibles.includes(k));
  const parNature = await Promise.all(lisibles.map((kind) => prisma.legalDocument.findMany({
    where: { AND: [where ?? {}, { kind: kind as LegalDocKind, status: { not: "CANCELLED" } }] },
    select: { id: true, kind: true, reference: true, title: true, companyId: true },
    orderBy: { createdAt: "desc" },
    take: AMONT_PROPOSEES + 1,
  })));
  const options: AmontComposable["options"] = [];
  const tronquees: string[] = [];
  parNature.forEach((rows, i) => {
    if (rows.length > AMONT_PROPOSEES) tronquees.push(lisibles[i]);
    for (const r of rows.slice(0, AMONT_PROPOSEES)) {
      options.push({ value: r.id, label: libelleAmont(r), kind: String(r.kind), companyId: r.companyId });
    }
  });
  return { options, tronquees, fermees, limite: AMONT_PROPOSEES };
}
