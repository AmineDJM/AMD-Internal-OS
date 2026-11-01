import { prismaBrut } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { journaliser, sansBloquer } from "@/lib/journal";
import type { CurrentUser } from "@/lib/session";
import { etatDuGeste, type EffetExterneCapture } from "./magasin";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA FENÊTRE D'ANNULATION DES EFFETS SORTANTS (K10b, décision 0040) — « Annuler l'envoi », façon messagerie.
 *
 * Un effet SORTANT (courriel SMTP, Microsoft Graph ou API, notification poussée, publication, diffusion d'offre, appel
 * d'API externe, ordre transmis) ne part pas au moment du geste : il entre dans la file `EffetSortantDiffere` avec une
 * échéance (`executeLe` = maintenant + délai réglé par le Super Admin, `AssistantIaReglage.fenetreAnnulationSecondes`,
 * défaut 120 s). Puis :
 *
 *   • ANNULÉ DANS LA FENÊTRE (`annulerEffetSortant`) — RIEN n'est parti. La ligne passe à ANNULE (qui, quand), l'audit
 *     le garde, et l'annulation elle-même se rétablit (`retablirEffetSortant` : l'effet repart pour une fenêtre neuve).
 *   • LA FENÊTRE PASSÉE — le worker (`executerEffetsSortantsDus`, tâche `effets.sortants`) prend la ligne (réclamation
 *     atomique : jamais deux envois) et appelle son EXÉCUTEUR (`executeurs.ts`), hors de tout geste : le port sort.
 *   • ANNULÉ APRÈS LE DÉPART (`compenserEffetSortant`) — on ne prétend JAMAIS qu'un courriel parti est effacé chez son
 *     destinataire. L'exécuteur dit sa COMPENSATION : un rectificatif au même destinataire (lui-même différé, donc
 *     annulable), une dépublication… ou, quand il n'y en a pas d'utile, la phrase qui le dit. La ligne passe à COMPENSE.
 *
 * ── DEUX FAÇONS D'Y ENTRER ───────────────────────────────────────────────────────────────
 *
 *   • `differerEffetSortant(demande)` — l'appel EXPLICITE (K10a, K10c, tout code qui veut une fenêtre) : l'effet est
 *     différé, où qu'on soit.
 *   • `differerSiFenetre(demande)` — le PORT : appelé par chaque primitive de sortie juste après `noterEffetExterne`.
 *     Sous un geste réversible (journal des effets, `fenetre: true`) il diffère et rend `true` (la primitive ne sort
 *     pas) ; hors geste — le worker qui exécute, un écran non migré — il rend `false` et la primitive sort.
 *
 * Le lien au journal J7 : l'effet externe capturé porte `differeId` (colonne `AssistantEffet.effetSortantId`) ;
 * `annulerGeste` lit la file — EN_ATTENTE → « annulé, rien n'est parti » ; PARTI → compensation. Pas de second système.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const STATUTS_EFFET_SORTANT = ["EN_ATTENTE", "EN_COURS", "PARTI", "ECHEC", "ANNULE", "COMPENSE"] as const;
export type StatutEffetSortant = (typeof STATUTS_EFFET_SORTANT)[number];

/** Défaut proposé à la Direction : 2 minutes (réglable dans Administration › IA › Accès). */
export const FENETRE_DEFAUT_SECONDES = 120;
export const FENETRE_MIN_SECONDES = 10;
export const FENETRE_MAX_SECONDES = 900;
/** Un exécuteur qui échoue est réessayé, puis la ligne passe à ECHEC (le dire vaut mieux qu'un envoi en double). */
export const TENTATIVES_MAX = 3;

export interface DemandeEffetSortant {
  /** La clé de l'exécuteur (`executeurs.ts`) : « courriel.smtp », « courriel.graph », « courriel.api », « push »… */
  type: string;
  acte: EffetExterneCapture["acte"];
  cible: string;
  apercu?: string | null;
  /** Ce que l'exécuteur recevra — passé par `enCharge` (les `Buffer` en base64). */
  charge: unknown;
  /** La personne au nom de qui l'effet part (défaut : le principal du geste en cours). */
  principalId?: string | null;
  /** L'objet métier concerné (l'écran de sa fiche montre l'envoi en attente). */
  objet?: { modele: string; id: string } | null;
  /** Le délai, en secondes — défaut : le réglage du Super Admin. */
  delaiSecondes?: number;
}

export interface EffetSortantProgramme {
  id: string;
  executeLe: Date;
  delaiSecondes: number;
}

// ── LA CHARGE : sérialisable, octets compris ──────────────────────────────────────────────

const OCTETS = "$octets64";

/** Rend une valeur sérialisable en JSON : `Buffer` / `Uint8Array` → `{ $octets64 }`, `Date` → ISO. */
export function enCharge(v: unknown): unknown {
  if (v === undefined || v === null) return v ?? null;
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return { [OCTETS]: Buffer.from(v).toString("base64") };
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(enCharge);
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (x !== undefined) out[k] = enCharge(x);
    return out;
  }
  return v;
}

/** L'inverse : `{ $octets64 }` → `Buffer`. */
export function deCharge<T = unknown>(v: unknown): T {
  const un = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(un);
    if (x && typeof x === "object") {
      const o = x as Record<string, unknown>;
      if (typeof o[OCTETS] === "string" && Object.keys(o).length === 1) return Buffer.from(o[OCTETS] as string, "base64");
      const out: Record<string, unknown> = {};
      for (const [k, y] of Object.entries(o)) out[k] = un(y);
      return out;
    }
    return x;
  };
  return un(v) as T;
}

// ── LE DÉLAI ──────────────────────────────────────────────────────────────────────────────

export const borneFenetre = (s: number): number =>
  Math.min(FENETRE_MAX_SECONDES, Math.max(FENETRE_MIN_SECONDES, Math.round(Number.isFinite(s) ? s : FENETRE_DEFAUT_SECONDES)));

/** Le délai de la fenêtre, en secondes — le réglage du Super Admin, borné. */
export async function delaiFenetre(): Promise<number> {
  const r = await prismaBrut.assistantIaReglage
    .findUnique({ where: { id: "global" }, select: { fenetreAnnulationSecondes: true } })
    .catch(sansBloquer("effets.fenetre.reglage", null));
  return borneFenetre(r?.fenetreAnnulationSecondes ?? FENETRE_DEFAUT_SECONDES);
}

// ── ENTRER DANS LA FENÊTRE ────────────────────────────────────────────────────────────────

/**
 * DIFFÈRE un effet sortant : il attendra sa fenêtre d'annulation. Rend l'identifiant et l'échéance. Sous un geste
 * journalisé, la ligne est liée au geste (`gesteId`) — l'annulation du geste l'annule avec le reste.
 */
export async function differerEffetSortant(d: DemandeEffetSortant): Promise<EffetSortantProgramme> {
  const etat = etatDuGeste();
  const delaiSecondes = d.delaiSecondes !== undefined ? Math.max(0, Math.round(d.delaiSecondes)) : await delaiFenetre();
  const executeLe = new Date(Date.now() + delaiSecondes * 1000);
  const ligne = await prismaBrut.effetSortantDiffere.create({
    data: {
      type: d.type, acte: d.acte, cible: d.cible.slice(0, 500), apercu: d.apercu?.slice(0, 500) ?? null,
      charge: (enCharge(d.charge) ?? {}) as never,
      principalId: d.principalId ?? etat?.principalId ?? null, gesteId: etat?.gesteId ?? null,
      objetModele: d.objet?.modele ?? null, objetId: d.objet?.id ?? null, executeLe,
    },
    select: { id: true },
  });
  programmerReveil(delaiSecondes);
  return { id: ligne.id, executeLe, delaiSecondes };
}

/**
 * LE PORT DE LA FENÊTRE — appelé par une primitive de sortie juste APRÈS `noterEffetExterne` (qui a noté l'effet au
 * geste) : sous un geste réversible en mode réel, l'effet est différé (`true` : la primitive rend un succès sans
 * sortir) et l'effet capturé reçoit `differeId`. Hors geste réversible : `false`, la primitive sort.
 */
export async function differerSiFenetre(d: DemandeEffetSortant): Promise<EffetSortantProgramme | null> {
  const etat = etatDuGeste();
  if (!etat || etat.mode !== "REEL" || !etat.fenetre) return null;
  const p = await differerEffetSortant(d);
  const effets = etat.capture?.effets ?? [];
  // L'effet que la primitive vient de noter (le dernier du même acte, pas encore lié).
  for (let i = effets.length - 1; i >= 0; i--) {
    if (effets[i]!.acte === d.acte && !effets[i]!.differeId) { effets[i]!.differeId = p.id; break; }
  }
  return p;
}

/**
 * UN EFFET EXTERNE QUI A LIEU TOUT DE SUITE MAIS SE DÉFAIT (K10b) — marquer lu, déplacer un message, poser un brouillon
 * chez Microsoft : différer serait faux (l'écran montre le résultat), mais le geste INVERSE existe. La ligne naît PARTIE
 * (type « inverse.… »), liée au geste ; l'annuler exécute la compensation de son exécuteur (le geste inverse), la
 * rétablir rejoue l'original. À appeler juste après l'effet, sous le geste (hors geste : rien n'est noté).
 */
export async function noterEffetFait(d: Omit<DemandeEffetSortant, "delaiSecondes">): Promise<string | null> {
  const etat = etatDuGeste();
  if (!etat || etat.mode !== "REEL" || !etat.capture) return null;
  // L'appel réseau de l'effet lui-même (noté par le port réseau juste avant) EST cet effet : il ne compte pas en double.
  while (etat.capture.effets.length && etat.capture.effets.at(-1)!.acte === "RESEAU" && !etat.capture.effets.at(-1)!.differeId) etat.capture.effets.pop();
  etat.capture.effets.push({ acte: d.acte, cible: d.cible, apercu: d.apercu ?? undefined, neutralise: false });
  const ligne = await prismaBrut.effetSortantDiffere.create({
    data: {
      type: d.type, acte: d.acte, cible: d.cible.slice(0, 500), apercu: d.apercu?.slice(0, 500) ?? null, charge: (enCharge(d.charge) ?? {}) as never,
      principalId: d.principalId ?? etat.principalId ?? null, gesteId: etat.gesteId ?? null,
      objetModele: d.objet?.modele ?? null, objetId: d.objet?.id ?? null, statut: "PARTI", executeLe: new Date(), parti: new Date(),
    },
    select: { id: true },
  });
  etat.capture.effets[etat.capture.effets.length - 1]!.differeId = ligne.id;
  return ligne.id;
}

/** RÉTABLIR un effet « inverse.… » compensé : l'original est rejoué (le message redevient lu, retourne dans le dossier…). */
export async function rejouerEffetFait(id: string, user: CurrentUser): Promise<IssueEffetSortant> {
  const l = await lire(id);
  if (!l || !l.type.startsWith("inverse.") || l.statut !== "COMPENSE") return { ok: false, issue: "SANS_OBJET", message: "Rien à rejouer." };
  if (!peutAgir(l, user)) return { ok: false, issue: "REFUS", message: "Seule la personne qui a fait le geste (ou le Super Admin) peut le rétablir." };
  const ex = await executeurDe(l.type);
  if (!ex) return { ok: false, issue: "IMPOSSIBLE", message: "Le geste n'est pas encore chargé dans ce processus : réessayez dans une minute." };
  const r = await ex.executer(deCharge(l.charge), ligneVue(l));
  await prismaBrut.effetSortantDiffere.update({ where: { id }, data: { statut: "PARTI", compensation: null, compenseLe: null, parti: new Date(), ...(r && "charge" in r ? { charge: enCharge(r.charge) as never } : {}) } });
  await auditer(user, l, "Geste externe rejoué (rétablissement)");
  return { ok: true, issue: "RETABLI", message: `${majuscule(libelleActe(l.acte, l.type))} : rejoué.` };
}

// ── LES GESTES SUR UN EFFET EN FILE ──────────────────────────────────────────────────────

export interface IssueEffetSortant {
  ok: boolean;
  /** ANNULE : rien n'est parti. COMPENSE : parti, compensé (ou la phrase qui dit pourquoi rien). REFUS : rien fait. */
  issue: "ANNULE" | "COMPENSE" | "RETABLI" | "SANS_OBJET" | "IMPOSSIBLE" | "REFUS";
  message: string;
  /** L'effet de compensation, quand il est lui-même différé (un rectificatif annulable). */
  compensationId?: string | null;
}

type LigneEffet = NonNullable<Awaited<ReturnType<typeof lire>>>;
const lire = (id: string) => prismaBrut.effetSortantDiffere.findUnique({ where: { id } });

const peutAgir = (l: { principalId: string | null }, user: CurrentUser) => l.principalId === user.id || user.role === "SUPER_ADMIN";
const libelleActe = (acte: string, type?: string): string => type?.startsWith("inverse.graph") ? "le geste dans la boîte Microsoft" :
  ({ COURRIEL: "le courriel", NOTIFICATION_PUSH: "la notification poussée", ECRITURE_EXTERNE: "la publication", RESEAU: "l'appel externe", PAIEMENT: "l'ordre de paiement", INVITATION_AGENDA: "l'invitation" } as Record<string, string>)[acte] ?? "l'effet";

async function auditer(user: CurrentUser, l: { id: string; acte: string; cible: string; apercu: string | null }, quoi: string) {
  await recordAudit({ actorId: user.id, action: "UPDATE", module: "ASSISTANT_IA", entityId: l.id, summary: `${quoi} — ${libelleActe(l.acte, l.type)} à ${l.cible}${l.apercu ? ` ${l.apercu}` : ""}`.slice(0, 500) });
}

/**
 * ANNULER un effet sortant. Dans la fenêtre : rien n'est parti (ANNULE). Déjà parti : la compensation de son exécuteur
 * (COMPENSE, ou IMPOSSIBLE avec ce qu'on peut faire à la place). Jamais un « effacé » de façade.
 */
export async function annulerEffetSortant(id: string, user: CurrentUser, opts: { motif?: string; compenser?: boolean } = {}): Promise<IssueEffetSortant> {
  const l = await lire(id);
  if (!l) return { ok: false, issue: "REFUS", message: "Cet envoi n'est plus dans la file." };
  if (!peutAgir(l, user)) return { ok: false, issue: "REFUS", message: "Seule la personne au nom de qui l'envoi part (ou le Super Admin) peut l'annuler." };
  const prise = await prismaBrut.effetSortantDiffere.updateMany({ where: { id, statut: "EN_ATTENTE" }, data: { statut: "ANNULE", annuleLe: new Date(), annuleParId: user.id } });
  if (prise.count === 1) {
    await auditer(user, l, "Envoi annulé dans la fenêtre : rien n'est parti");
    return { ok: true, issue: "ANNULE", message: `${majuscule(libelleActe(l.acte, l.type))} à ${l.cible} est annulé : rien n'est parti.` };
  }
  const relue = (await lire(id))!;
  if (relue.statut === "ANNULE") return { ok: true, issue: "SANS_OBJET", message: "Cet envoi était déjà annulé : rien n'est parti." };
  if (relue.statut === "COMPENSE") return { ok: true, issue: "SANS_OBJET", message: `Déjà compensé : ${relue.compensation ?? ""}`.trim() };
  if (relue.statut === "ECHEC") return { ok: true, issue: "SANS_OBJET", message: `Cet envoi n'est jamais parti (échec : ${relue.erreur ?? "inconnu"}).` };
  if (relue.statut === "EN_COURS") return { ok: false, issue: "IMPOSSIBLE", message: `${majuscule(libelleActe(l.acte, l.type))} est en train de partir : trop tard pour l'arrêter. Réessayez dans un instant pour le compenser.` };
  if (opts.compenser === false) return { ok: false, issue: "IMPOSSIBLE", message: `${majuscule(libelleActe(l.acte, l.type))} est déjà parti le ${dateFr(relue.parti)} : il n'est pas effacé chez son destinataire.` };
  return compenserEffetSortant(id, user, opts.motif);
}

/** APRÈS LE DÉPART : la compensation de l'exécuteur — un geste inverse, dit et tracé. */
export async function compenserEffetSortant(id: string, user: CurrentUser, motif?: string): Promise<IssueEffetSortant> {
  const l = await lire(id);
  if (!l) return { ok: false, issue: "REFUS", message: "Cet envoi n'est plus dans la file." };
  if (!peutAgir(l, user)) return { ok: false, issue: "REFUS", message: "Seule la personne au nom de qui l'envoi est parti (ou le Super Admin) peut le compenser." };
  if (l.statut !== "PARTI") return { ok: false, issue: "SANS_OBJET", message: l.statut === "COMPENSE" ? `Déjà compensé : ${l.compensation ?? ""}` : "Cet envoi n'est pas parti : il n'y a rien à compenser." };
  const ex = await executeurDe(l.type);
  if (!ex) return { ok: false, issue: "IMPOSSIBLE", message: "Le geste inverse de cet effet n'est pas encore chargé dans ce processus : réessayez dans une minute (rien n'a été écrit)." };
  const parti = l.type.startsWith("inverse.")
    ? `${majuscule(libelleActe(l.acte, l.type))} a eu lieu le ${dateFr(l.parti)}`
    : `${majuscule(libelleActe(l.acte, l.type))} est parti le ${dateFr(l.parti)} : il n'est pas effacé chez son destinataire`;
  const plan = ex.compensation ? await ex.compensation(deCharge(l.charge), ligneVue(l), motif ?? null) : null;
  if (!plan) {
    const phrase = ex.sansCompensation ?? "aucun geste inverse n'existe pour cet effet";
    const prise = await prismaBrut.effetSortantDiffere.updateMany({ where: { id, statut: "PARTI" }, data: { statut: "COMPENSE", compensation: `Impossible : ${phrase}`.slice(0, 1000), compenseLe: new Date(), annuleParId: user.id } });
    if (prise.count === 1) await auditer(user, l, `Annulation demandée après le départ — ${phrase}`);
    return { ok: false, issue: "IMPOSSIBLE", message: `${parti}. ${majuscule(phrase)}.` };
  }
  if ("fait" in plan) {
    const prise = await prismaBrut.effetSortantDiffere.updateMany({
      where: { id, statut: "PARTI" },
      data: { statut: "COMPENSE", compensation: plan.fait.slice(0, 1000), compenseLe: new Date(), annuleParId: user.id, ...(plan.charge !== undefined ? { charge: enCharge(plan.charge) as never } : {}) },
    });
    if (prise.count !== 1) return { ok: false, issue: "SANS_OBJET", message: "Déjà compensé, depuis un autre écran." };
    await auditer(user, l, `Compensé après le départ : ${plan.fait}`);
    return { ok: true, issue: "COMPENSE", message: `${parti}. ${plan.fait}` };
  }
  // La compensation est elle-même un effet sortant : différée, donc annulable dans SA fenêtre.
  const prise = await prismaBrut.effetSortantDiffere.updateMany({ where: { id, statut: "PARTI" }, data: { statut: "COMPENSE", compenseLe: new Date(), annuleParId: user.id } });
  if (prise.count !== 1) return { ok: false, issue: "SANS_OBJET", message: "Déjà compensé, depuis un autre écran." };
  const c = await differerEffetSortant({
    type: plan.type ?? l.type, acte: l.acte as EffetExterneCapture["acte"], cible: plan.cible ?? l.cible, apercu: plan.apercu,
    charge: plan.charge, principalId: l.principalId, objet: l.objetModele && l.objetId ? { modele: l.objetModele, id: l.objetId } : null,
  });
  const fait = `${plan.phrase} (part dans ${c.delaiSecondes} s, annulable d'ici là)`;
  await prismaBrut.effetSortantDiffere.update({ where: { id }, data: { compensation: `${fait} [${c.id}]`.slice(0, 1000) } });
  await auditer(user, l, `Compensé après le départ : ${plan.phrase}`);
  return { ok: true, issue: "COMPENSE", message: `${parti}. ${fait}.`, compensationId: c.id };
}

/** RÉTABLIR un envoi annulé dans sa fenêtre : il repart pour une fenêtre neuve (l'annulation s'annule). */
export async function retablirEffetSortant(id: string, user: CurrentUser): Promise<IssueEffetSortant> {
  const l = await lire(id);
  if (!l) return { ok: false, issue: "REFUS", message: "Cet envoi n'est plus dans la file." };
  if (!peutAgir(l, user)) return { ok: false, issue: "REFUS", message: "Seule la personne au nom de qui l'envoi part (ou le Super Admin) peut le rétablir." };
  const delai = await delaiFenetre();
  const prise = await prismaBrut.effetSortantDiffere.updateMany({
    where: { id, statut: "ANNULE" },
    data: { statut: "EN_ATTENTE", annuleLe: null, annuleParId: null, executeLe: new Date(Date.now() + delai * 1000) },
  });
  if (prise.count !== 1) return { ok: false, issue: "SANS_OBJET", message: "Cet envoi n'est pas annulé : rien à rétablir." };
  programmerReveil(delai);
  await auditer(user, l, "Envoi rétabli (l'annulation est annulée)");
  return { ok: true, issue: "RETABLI", message: `${majuscule(libelleActe(l.acte, l.type))} à ${l.cible} repart dans ${delai} s (annulable d'ici là).` };
}

// ── LE WORKER ────────────────────────────────────────────────────────────────────────────

/** Une ligne EN_COURS depuis plus longtemps : le processus est mort en route. On ne réessaie pas (double envoi). */
const EN_COURS_PERIME_MS = 10 * 60_000;

/** EXÉCUTE les effets dont la fenêtre est passée — tâche `effets.sortants` (et réveil du processus web). */
export async function executerEffetsSortantsDus(opts: { maintenant?: Date; limite?: number; ids?: string[] } = {}): Promise<{ partis: number; echecs: number; reportes: number }> {
  const maintenant = opts.maintenant ?? new Date();
  await prismaBrut.effetSortantDiffere.updateMany({
    where: { statut: "EN_COURS", executeLe: { lt: new Date(maintenant.getTime() - EN_COURS_PERIME_MS) } },
    data: { statut: "ECHEC", erreur: "Interrompu en route (processus arrêté) : on ne sait pas s'il est parti — à vérifier, pas renvoyé." },
  });
  const dus = await prismaBrut.effetSortantDiffere.findMany({
    where: { statut: "EN_ATTENTE", executeLe: { lte: maintenant }, ...(opts.ids ? { id: { in: opts.ids } } : {}) },
    orderBy: { executeLe: "asc" }, take: opts.limite ?? 50, select: { id: true },
  });
  let partis = 0, echecs = 0, reportes = 0;
  for (const { id } of dus) {
    // LA RÉCLAMATION ATOMIQUE : une annulation qui arrive au même instant gagne ou perd, jamais les deux.
    const prise = await prismaBrut.effetSortantDiffere.updateMany({ where: { id, statut: "EN_ATTENTE", executeLe: { lte: maintenant } }, data: { statut: "EN_COURS", tentatives: { increment: 1 } } });
    if (prise.count !== 1) continue;
    const l = (await lire(id))!;
    const ex = await executeurDe(l.type);
    if (!ex) {
      // L'exécuteur d'un domaine s'enregistre depuis son domaine (la tâche `effets.sortants` l'arme) : pas encore là
      // dans ce processus — la ligne RESTE en file, le prochain passage l'enverra. Jamais un échec pour si peu.
      await prismaBrut.effetSortantDiffere.update({ where: { id }, data: { statut: "EN_ATTENTE", tentatives: { decrement: 1 } } });
      continue;
    }
    try {
      await ex.executer(deCharge(l.charge), ligneVue(l));
      await prismaBrut.effetSortantDiffere.update({ where: { id }, data: { statut: "PARTI", parti: new Date(), erreur: null } });
      partis++;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const encore = l.tentatives < TENTATIVES_MAX && !/SortieInterdite/.test(`${(e as Error)?.name ?? ""} ${message}`);
      await prismaBrut.effetSortantDiffere.update({
        where: { id },
        data: encore ? { statut: "EN_ATTENTE", executeLe: new Date(Date.now() + 60_000 * l.tentatives), erreur: message.slice(0, 1000) } : { statut: "ECHEC", erreur: message.slice(0, 1000) },
      });
      if (encore) reportes++; else { echecs++; journaliser("erreur", "effets.sortant", { id, type: l.type }, e); }
    }
  }
  return { partis, echecs, reportes };
}

let reveil: ReturnType<typeof setTimeout> | null = null;
/** Le processus web se réveille à l'échéance (le battement de la tâche de fond reste le filet). */
function programmerReveil(delaiSecondes: number): void {
  if (process.env.VITEST || process.env.NODE_ENV === "test" || reveil) return;
  reveil = setTimeout(() => {
    reveil = null;
    void executerEffetsSortantsDus().catch((e) => journaliser("erreur", "effets.sortants.reveil", {}, e));
  }, (delaiSecondes + 1) * 1000);
  reveil.unref?.();
}

// ── L'ÉCRAN ──────────────────────────────────────────────────────────────────────────────

export interface EffetSortantVu {
  id: string;
  type: string;
  acte: string;
  quoi: string;
  cible: string;
  apercu: string | null;
  statut: StatutEffetSortant;
  creeLe: string;
  executeLe: string;
  parti: string | null;
  compensation: string | null;
  erreur: string | null;
  gesteId: string | null;
  principalId: string | null;
  objet: { modele: string; id: string } | null;
}

function ligneVue(l: LigneEffet): EffetSortantVu {
  return {
    id: l.id, type: l.type, acte: l.acte, quoi: libelleActe(l.acte, l.type), cible: l.cible, apercu: l.apercu, statut: l.statut as StatutEffetSortant,
    creeLe: l.creeLe.toISOString(), executeLe: l.executeLe.toISOString(), parti: l.parti?.toISOString() ?? null,
    compensation: l.compensation, erreur: l.erreur, gesteId: l.gesteId, principalId: l.principalId,
    objet: l.objetModele && l.objetId ? { modele: l.objetModele, id: l.objetId } : null,
  };
}

/** Les envois d'une personne : ceux qui attendent, et les récents (pour « Annuler l'envoi » et la fiche). */
export async function effetsSortantsDe(user: CurrentUser, opts: { objet?: { modele: string; id: string }; depuisMinutes?: number; gesteId?: string } = {}): Promise<EffetSortantVu[]> {
  const depuis = new Date(Date.now() - (opts.depuisMinutes ?? 30) * 60_000);
  const lignes = await prismaBrut.effetSortantDiffere.findMany({
    where: {
      ...(user.role === "SUPER_ADMIN" && (opts.objet || opts.gesteId) ? {} : { principalId: user.id }),
      ...(opts.objet ? { objetModele: opts.objet.modele, objetId: opts.objet.id } : {}),
      ...(opts.gesteId ? { gesteId: opts.gesteId } : { OR: [{ statut: { in: ["EN_ATTENTE", "EN_COURS"] } }, { creeLe: { gte: depuis } }] }),
    },
    orderBy: { creeLe: "desc" }, take: 30,
  });
  return lignes.map(ligneVue);
}

// ── LES EXÉCUTEURS ───────────────────────────────────────────────────────────────────────

/** Ce que la compensation fait : un effet INVERSE à différer, ou un geste déjà fait (`fait`). */
export type PlanCompensation =
  | { charge: unknown; phrase: string; apercu?: string; cible?: string; type?: string }
  | { fait: string; /** La charge à garder pour rejouer l'original (un message déplacé change d'identifiant). */ charge?: unknown };

export interface ExecuteurEffetSortant {
  /** Fait partir l'effet (hors de tout geste : le port sort réellement). Lève en cas d'échec. */
  executer: (charge: unknown, ligne: EffetSortantVu) => Promise<void | { charge: unknown }>;
  /** Le geste inverse après le départ — `null` : il n'y en a pas d'utile (`sansCompensation` le dit). */
  compensation?: (charge: unknown, ligne: EffetSortantVu, motif: string | null) => Promise<PlanCompensation | null>;
  /** La phrase honnête quand rien ne compense (« la notification s'est affichée sur son téléphone »). */
  sansCompensation?: string;
}

// UN SEUL registre par processus, même si Next charge deux copies du module (comme le magasin du geste).
const g = globalThis as { __amdExecuteursSortants?: Map<string, ExecuteurEffetSortant> };
const enregistres: Map<string, ExecuteurEffetSortant> = (g.__amdExecuteursSortants ??= new Map());

/** Pour un exécuteur qui n'est pas dans la table (`executeurs.ts`) — un test, un module qui s'enregistre. */
export function enregistrerExecuteur(type: string, ex: ExecuteurEffetSortant): void {
  enregistres.set(type, ex);
}

async function executeurDe(type: string): Promise<ExecuteurEffetSortant | null> {
  if (enregistres.has(type)) return enregistres.get(type)!;
  const { EXECUTEURS } = await import("./executeurs");
  const charger = EXECUTEURS[type];
  return charger ? charger() : null;
}

const majuscule = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const dateFr = (d: Date | null) => (d ? d.toLocaleString("fr-FR", { timeZone: "Africa/Algiers", dateStyle: "short", timeStyle: "short" }) : "?");
