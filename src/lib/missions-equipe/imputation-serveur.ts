import { prisma } from "@/lib/prisma";
import { moneyEntityOf } from "@/lib/company";
import { enveloppeDuPolePour } from "@/lib/budget/enveloppes-pole";
import { toNumber } from "@/lib/utils";
import {
  CATEGORIE_EQUIPE_PAR_DEFAUT, categorieParDefaut, categoriesImputables, etatBudgetaireNoteFrais, optionsImputation,
  poleDeLImputation, type CategorieCandidate, type ImputationEquipe, type OptionImputation,
} from "@/lib/missions-equipe/imputation";

/**
 * L'IMPUTATION DES FRAIS DE L'ÉQUIPE ADVENTUM — côté SERVEUR (base). La règle vit dans `missions-equipe/imputation.ts`
 * (pur) : les frais des collaborateurs d'Adventum sur une opération Ad & Pro vont au budget Operations & Sales de
 * l'année, plus jamais à une ligne Ad & Pro. Ce module n'est jamais importé par un composant client.
 */

export interface ImputationsProposees {
  /** Les catégories Operations & Sales proposées, la catégorie par défaut d'abord. */
  options: OptionImputation[];
  /** La catégorie par défaut (enveloppe de l'année de la mission). */
  defaut: OptionImputation | null;
}

/** Les catégories des enveloppes Operations & Sales qui couvrent cette date (pour cette société, ou du groupe). */
async function candidates(date: Date, companyId: string | null | undefined, envelopeId?: string): Promise<CategorieCandidate[]> {
  const envs = await prisma.budgetEnvelope.findMany({
    where: {
      domaine: "OPERATIONS", periodStart: { lte: date }, periodEnd: { gte: date },
      ...(envelopeId ? { id: envelopeId } : companyId !== undefined ? { OR: [{ companyId }, { companyId: null }] } : {}),
    },
    orderBy: [{ isActive: "desc" }, { periodStart: "desc" }],
    select: {
      id: true, name: true, company: { select: { name: true, shortName: true } },
      categories: { orderBy: [{ createdAt: "asc" }, { name: "asc" }], select: { id: true, name: true, parentId: true, cle: true } },
    },
  });
  // Deux sociétés, deux « Operations & Sales 2026 » : le nom de la société les distingue.
  const homonymes = (nom: string) => envs.filter((e) => e.name === nom).length > 1;
  return envs.flatMap((e) => {
    const nom = homonymes(e.name) ? `${e.name} (${e.company ? e.company.shortName || e.company.name : "groupe"})` : e.name;
    return e.categories.map((c) => ({ ...c, envelopeName: nom }));
  });
}

/**
 * LA CATÉGORIE PAR DÉFAUT D'UNE MISSION — dans l'enveloppe Operations & Sales qui couvre sa date, ouverte d'office si
 * aucune n'existe ; si l'enveloppe n'a plus aucune catégorie imputable, « Frais de déplacement terrain » y est recréée.
 */
async function categorieParDefautPour(date: Date, companyId: string | null, actorId: string): Promise<OptionImputation | null> {
  const env = await enveloppeDuPolePour("OPERATIONS", { actorId, companyId, date });
  let cats = await candidates(date, companyId, env.id);
  if (categoriesImputables(cats).length === 0) {
    await prisma.budgetCategoryLine.create({ data: { envelopeId: env.id, name: CATEGORIE_EQUIPE_PAR_DEFAUT } });
    cats = await candidates(date, companyId, env.id);
  }
  const d = categorieParDefaut(cats);
  return d ? optionsImputation(cats).find((o) => o.id === d.id) ?? null : null;
}

/**
 * CE QUE L'ÉCRAN PROPOSE — les catégories Operations & Sales de l'année de la mission (toutes sociétés : la personne
 * peut appartenir à une autre entité que celle qui regarde), la catégorie par défaut d'abord. L'enveloppe de l'année est
 * ouverte d'office si elle manque.
 */
export async function imputationsProposees(p: { date: Date | null; actorId: string }): Promise<ImputationsProposees> {
  const date = p.date ?? new Date();
  const premier = await categorieParDefautPour(date, await moneyEntityOf(p.actorId), p.actorId);
  const options = optionsImputation(await candidates(date, undefined));
  const defaut = premier ? options.find((o) => o.id === premier.id) ?? premier : null;
  const tries = defaut ? [defaut, ...options.filter((o) => o.id !== defaut.id)] : options;
  return { options: tries, defaut };
}

/** La date qui choisit l'année du budget : le départ de la mission, sinon le début de l'opération, sinon aujourd'hui. */
export function dateImputation(a: { dateDepart: Date | null; dateRetour?: Date | null }, parentDebut: Date | null): Date {
  return a.dateDepart ?? a.dateRetour ?? parentDebut ?? new Date();
}

/**
 * POSE L'IMPUTATION PAR DÉFAUT d'un membre qui n'en a pas — Operations & Sales de l'année, catégorie par défaut, dans
 * l'enveloppe de la société de la PERSONNE (l'argent suit la personne, `moneyEntityOf`). Une imputation déjà posée
 * (choisie, ou ancienne imputation Ad & Pro) n'est jamais réécrite. Rend la catégorie retenue ; ne fait jamais échouer
 * l'appelant.
 */
export async function assurerImputationEquipe(assignmentId: string, actorId: string, parentDebut: Date | null): Promise<string | null> {
  try {
    const a = await prisma.missionAssignment.findUnique({
      where: { id: assignmentId },
      select: { id: true, userId: true, budgetCategoryId: true, dateDepart: true, dateRetour: true },
    });
    if (!a) return null;
    if (a.budgetCategoryId) return a.budgetCategoryId;
    const defaut = await categorieParDefautPour(dateImputation(a, parentDebut), await moneyEntityOf(a.userId), actorId);
    if (!defaut) return null;
    // Sans auteur (`budgetChoisiParId` nul) : c'est le défaut, pas un choix — la Direction peut le changer.
    const pris = await prisma.missionAssignment.updateMany({ where: { id: a.id, budgetCategoryId: null }, data: { budgetCategoryId: defaut.id, budgetChoisiParId: null, budgetChoisiLe: new Date() } });
    if (pris.count === 0) return (await prisma.missionAssignment.findUnique({ where: { id: a.id }, select: { budgetCategoryId: true } }))?.budgetCategoryId ?? null;
    return defaut.id;
  } catch (err) {
    console.error("[missions] imputation par défaut impossible", err);
    return null;
  }
}

/**
 * LA CATÉGORIE OÙ ÉCRIRE UNE DÉPENSE DU MEMBRE — celle choisie à l'écran si elle est valide ; sinon son imputation si
 * elle est Operations & Sales (posée par défaut au besoin) ; sinon (ancienne imputation Ad & Pro, qu'on ne réécrit pas)
 * la catégorie par défaut d'Operations & Sales. Jamais Ad & Pro.
 */
export async function categorieEquipePour(
  a: { id: string; userId: string; dateDepart: Date | null; dateRetour: Date | null },
  actorId: string, parentDebut: Date | null, choisie: string | null,
): Promise<{ ok: true; id: string; libelle: string } | { ok: false; error: string }> {
  if (choisie) {
    const v = await categorieEquipeValide(choisie);
    return v.ok ? { ok: true, id: choisie, libelle: v.libelle } : v;
  }
  const actuelle = await assurerImputationEquipe(a.id, actorId, parentDebut);
  if (actuelle) {
    const v = await categorieEquipeValide(actuelle);
    if (v.ok) return { ok: true, id: actuelle, libelle: v.libelle };
  }
  const d = await categorieParDefautPour(dateImputation(a, parentDebut), await moneyEntityOf(a.userId), actorId);
  return d ? { ok: true, id: d.id, libelle: d.label } : { ok: false, error: "Aucune catégorie Operations & Sales n'est disponible pour ces frais." };
}

/** Une catégorie est-elle imputable pour l'équipe (Operations & Sales, hors masse salariale) ? Rend son libellé. */
export async function categorieEquipeValide(categoryId: string): Promise<{ ok: true; libelle: string } | { ok: false; error: string }> {
  const cat = await prisma.budgetCategoryLine.findUnique({
    where: { id: categoryId },
    select: { id: true, name: true, parentId: true, cle: true, parent: { select: { name: true, cle: true } }, envelope: { select: { name: true, domaine: true } } },
  });
  if (!cat) return { ok: false, error: "Catégorie budgétaire introuvable." };
  if (cat.envelope.domaine !== "OPERATIONS") {
    return { ok: false, error: "Les frais de l'équipe Adventum s'imputent au budget Operations & Sales, plus à une ligne Ad & Pro." };
  }
  const candidate = { id: cat.id, name: cat.name, parentId: cat.parentId, cle: cat.cle, envelopeName: cat.envelope.name };
  const parent = cat.parentId && cat.parent ? [{ id: cat.parentId, name: cat.parent.name, parentId: null, cle: cat.parent.cle, envelopeName: cat.envelope.name }] : [];
  if (categoriesImputables([...parent, candidate]).every((c) => c.id !== cat.id)) {
    return { ok: false, error: "Les frais de mission ne s'imputent pas à la masse salariale." };
  }
  return { ok: true, libelle: [cat.envelope.name, cat.parent?.name, cat.name].filter(Boolean).join(" › ") };
}

/** Les imputations lisibles (libellé, pôle) des catégories posées sur des membres — `parDefaut` est à poser par l'appelant. */
export async function imputationsDe(categoryIds: readonly (string | null)[]): Promise<Map<string, Omit<ImputationEquipe, "parDefaut">>> {
  const ids = Array.from(new Set(categoryIds.filter((x): x is string => Boolean(x))));
  const out = new Map<string, Omit<ImputationEquipe, "parDefaut">>();
  if (ids.length === 0) return out;
  const cats = await prisma.budgetCategoryLine.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true, parent: { select: { name: true } }, envelope: { select: { name: true, domaine: true, module: true, modules: true } } },
  });
  for (const c of cats) {
    out.set(c.id, { categoryId: c.id, libelle: [c.envelope.name, c.parent?.name, c.name].filter(Boolean).join(" › "), pole: poleDeLImputation(c.envelope) });
  }
  return out;
}

/** Où sont les frais de clôture intégrés : une ligne du budget Operations & Sales, un ancien poste Ad & Pro, ou rien. */
export async function fraisIntegres(ids: readonly (string | null)[]): Promise<Map<string, "OPERATIONS" | "AD_PRO">> {
  const liste = Array.from(new Set(ids.filter((x): x is string => Boolean(x))));
  const out = new Map<string, "OPERATIONS" | "AD_PRO">();
  if (liste.length === 0) return out;
  const [lignes, postes] = await Promise.all([
    prisma.budgetExpenseLine.findMany({ where: { id: { in: liste } }, select: { id: true } }),
    prisma.adProItem.findMany({ where: { id: { in: liste } }, select: { id: true } }),
  ]);
  for (const l of lignes) out.set(l.id, "OPERATIONS");
  for (const p of postes) out.set(p.id, "AD_PRO");
  return out;
}

// ─────────────────────────────── Ce que le budget Operations & Sales en compte ───────────────────────────────

export interface FraisMissionBudget {
  consumed: Map<string, number>;
  committed: Map<string, number>;
  /** Les notes de frais consommées, une ligne par note (montant, date de la mission). */
  rows: { id: string; categoryId: string; date: Date; amount: number; label: string; assignmentId: string }[];
}

/**
 * LES NOTES DE FRAIS DE MISSION DE L'ÉQUIPE, dans le budget Operations & Sales — lues, jamais recopiées : la note de
 * frais (demande RH `EXPENSE_REPORT` reliée à la mission) compte dans la catégorie Operations & Sales de la mission,
 * ENGAGÉE tant qu'elle est en route (N+1, RH), CONSOMMÉE une fois validée par les RH. Seules les catégories d'une
 * enveloppe Operations & Sales comptent : une ancienne imputation Ad & Pro n'est comptée nulle part (elle ne l'était
 * pas avant), et Ad & Pro ne voit jamais ces frais. Datée par la mission (retour, sinon départ), bornée à la période.
 */
export async function fraisMissionConsumption(catIds: readonly string[], from?: Date | null, to?: Date | null): Promise<FraisMissionBudget> {
  const vide: FraisMissionBudget = { consumed: new Map(), committed: new Map(), rows: [] };
  if (catIds.length === 0) return vide;
  const ops = await prisma.budgetCategoryLine.findMany({ where: { id: { in: [...catIds] }, envelope: { domaine: "OPERATIONS" } }, select: { id: true } });
  if (ops.length === 0) return vide;
  const missions = await prisma.missionAssignment.findMany({
    where: { budgetCategoryId: { in: ops.map((c) => c.id) } },
    select: { id: true, budgetCategoryId: true, dateDepart: true, dateRetour: true, user: { select: { name: true } } },
  });
  if (missions.length === 0) return vide;
  const notes = await prisma.hrDocumentRequest.findMany({
    where: { type: "EXPENSE_REPORT", missionAssignmentId: { in: missions.map((m) => m.id) } },
    select: { id: true, status: true, managerGate: true, expenseAmount: true, missionAssignmentId: true, createdAt: true },
  });
  const mission = new Map(missions.map((m) => [m.id, m]));
  for (const n of notes) {
    const m = n.missionAssignmentId ? mission.get(n.missionAssignmentId) : undefined;
    if (!m?.budgetCategoryId) continue;
    const etat = etatBudgetaireNoteFrais(n.status, n.managerGate ?? null);
    const amount = toNumber(n.expenseAmount);
    if (!etat || !(amount > 0)) continue;
    const date = m.dateRetour ?? m.dateDepart ?? n.createdAt;
    if ((from && date < from) || (to && date > to)) continue;
    const map = etat === "CONSOMME" ? vide.consumed : vide.committed;
    map.set(m.budgetCategoryId, (map.get(m.budgetCategoryId) ?? 0) + amount);
    if (etat === "CONSOMME") {
      vide.rows.push({ id: n.id, categoryId: m.budgetCategoryId, date, amount, label: `Note de frais de mission — ${m.user.name}`, assignmentId: m.id });
    }
  }
  return vide;
}
