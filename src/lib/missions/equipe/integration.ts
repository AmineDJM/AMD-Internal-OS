import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { sansBloquer } from "@/lib/journal";
import { INSTANCE } from "@/lib/missions/runtime/bail";
import { journaliser } from "@/lib/missions/runtime/store";
import type { Clock } from "@/lib/missions/ports";
import type { EtatChecks, RefDepot, Resultat } from "@/lib/missions/chantiers/ports-moteur";
import { nomDepot } from "@/lib/missions/chantiers/reservations";
import { recetteDeRegeneration } from "@/lib/missions/equipe/ressources";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA FILE D'INTÉGRATION (lot O2, décision 0059 § 6) — par (dépôt, branche cible), UNE intégration à la fois.
 *
 *   EN_FILE ─prise─▶ EN_COURS : tête ACTUELLE de la cible → branche `claude/integration/<cible>/<id>-<tour>` → fusion de
 *                    la branche de la tâche (conflit → RENVOYEE : régénération si seuls des fichiers générés, sinon
 *                    fusion à faire par la MÊME session)
 *            ─────▶ CI : checks du SHA d'INTÉGRATION — c'est elle qui attrape ce que Git ne voit pas (A renomme, B
 *                    appelle ; contrat régénéré qui diverge) ; rouge → RENVOYEE avec l'extrait
 *            ─────▶ vert : la cible a bougé → EN_FILE (on recommence sur la nouvelle tête) ; sinon cible protégée →
 *                    A_VALIDER (carte de la Direction) ; sinon AVANCE fast-forward (compare-et-échange de GitHub)
 *            ─────▶ FUSIONNEE.
 *
 * GARANTIES : (1) la base n'admet qu'UNE entrée active par cible (index unique partiel) — deux processus, deux
 * complétions à la même milliseconde : un seul gagne ; (2) la cible n'avance que vers un SHA dont la CI est verte et
 * dont la base est EXACTEMENT sa tête (fast-forward seul : GitHub refuse si elle a bougé) ; (3) chaque étape relit
 * GitHub avant d'agir : un superviseur tué au milieu reprend sans rejouer ni perdre (bail échu = reprise).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Les gestes de branche que la file demande à la forge — dans les termes du moteur. */
export interface ForgeIntegration {
  tete(d: RefDepot, branche: string): Promise<Resultat<string | null>>;
  creerBranche(d: RefDepot, branche: string, sha: string): Promise<Resultat<true>>;
  supprimerBranche(d: RefDepot, branche: string): Promise<Resultat<true>>;
  /** Fusionne `tete` DANS `base` (API merges de GitHub) : le SHA du commit de fusion, ou `conflit`. */
  fusionnerDans(d: RefDepot, base: string, tete: string, message: string): Promise<Resultat<{ sha: string } | { conflit: true }>>;
  /** `ancetre` est-il un ancêtre de `sha` (ou égal) ? — la tâche part-elle de la tête exacte de la cible ? */
  estAncetre(d: RefDepot, ancetre: string, sha: string): Promise<Resultat<boolean>>;
  /** Les fichiers modifiés de `base` à `tete` (depuis leur ancêtre commun). */
  fichiersModifies(d: RefDepot, base: string, tete: string): Promise<Resultat<string[]>>;
  /** Avance `branche` jusqu'à `sha`, FAST-FORWARD SEULEMENT (`definitif` + « non fast-forward » si elle a bougé). */
  avancer(d: RefDepot, branche: string, sha: string): Promise<Resultat<true>>;
  checks(d: RefDepot, sha: string): Promise<Resultat<EtatChecks>>;
  /** Cible protégée (main) : ouvre la PR intégration → cible et la fusionne AU SHA vérifié. */
  fusionnerParPr?(d: RefDepot, branche: string, cible: string, sha: string, titre: string): Promise<Resultat<{ sha: string }>>;
}

export const STATUTS_ACTIFS = ["EN_COURS", "CI", "A_VALIDER"] as const;
const PREFIXE = "claude/integration/";
export const BAIL_INTEGRATION_MS = 120_000;

/** Les branches que la file a le droit d'ÉCRIRE : les siennes, et la cible seulement par l'avance validée. */
export function gardeEcritureRef(branche: string, geste: "creer" | "supprimer" | "fusionner-dans" | "avancer", cible?: string): string | null {
  if (geste === "avancer") return branche === cible ? null : `refus : la file n'avance que sa cible (${cible ?? "?"}), pas ${branche}`;
  return branche.startsWith(PREFIXE) ? null : `refus : la file n'écrit que des branches ${PREFIXE}… (pas ${branche})`;
}

/** Une forge GARDÉE : toute écriture hors des branches d'intégration ou de la cible déclarée est refusée avant de partir. */
export function forgeGardee(f: ForgeIntegration, cible: string): ForgeIntegration {
  const refus = (m: string): Resultat<never> => ({ ok: false, erreur: m, definitif: true });
  return {
    ...f,
    creerBranche: (d, b, sha) => { const g = gardeEcritureRef(b, "creer"); return g ? Promise.resolve(refus(g)) : f.creerBranche(d, b, sha); },
    supprimerBranche: (d, b) => { const g = gardeEcritureRef(b, "supprimer"); return g ? Promise.resolve(refus(g)) : f.supprimerBranche(d, b); },
    fusionnerDans: (d, base, tete, m) => { const g = gardeEcritureRef(base, "fusionner-dans"); return g ? Promise.resolve(refus(g)) : f.fusionnerDans(d, base, tete, m); },
    avancer: (d, b, sha) => { const g = gardeEcritureRef(b, "avancer", cible); return g ? Promise.resolve(refus(g)) : f.avancer(d, b, sha); },
  };
}

export const cibleProtegee = (cible: string) => /^(main|master)$/.test(cible);

const slug = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
export const brancheIntegration = (cible: string, id: string, tour: number) => `${PREFIXE}${slug(cible)}/${id.slice(-8)}-${tour}`;

interface Detail { raison?: string; fichiers?: string[]; recette?: string[] | null; validation?: { decision: "ACCORDEE" | "REFUSEE"; par: string; le: string }; validationDemandee?: boolean; extrait?: string }

export interface DepsFile {
  forge: ForgeIntegration;
  clock: Clock;
  /** RÉSERVÉ AUX TESTS : un point d'arrêt entre deux gestes (SIGKILL simulé). */
  sonde?: (moment: "apres-fusion" | "avant-avance") => Promise<void>;
}

type Entree = Prisma.IntegrationFileGetPayload<object>;

const detail = (e: Entree): Detail => (e.detail && typeof e.detail === "object" ? (e.detail as Detail) : {});

async function poser(id: string, statut: string, donnees: Partial<Pick<Entree, "shaBase" | "shaIntegration" | "brancheIntegration" | "reessayerA" | "essais">> & { detail?: Detail }, clock: Clock): Promise<void> {
  const { detail: d, ...data } = donnees;
  await prisma.integrationFile.update({
    where: { id },
    data: {
      statut, ...data, ...(d ? { detail: d as Prisma.InputJsonValue } : {}),
      ...(STATUTS_ACTIFS.includes(statut as never) ? { bailJusqua: new Date(clock.now().getTime() + BAIL_INTEGRATION_MS), bailPar: INSTANCE } : { bailJusqua: null, bailPar: null }),
    },
  });
}

/**
 * PRENDRE LA TÊTE DE LA FILE — l'entrée active si son bail est à nous ou échu (REPRISE après coupure), sinon la plus
 * ancienne EN_FILE dont l'attente est passée. La prise passe par l'index unique partiel : si un autre processus a pris
 * la cible à la même milliseconde, la base refuse la nôtre (P2002) et on s'efface.
 */
export async function prendreLaTete(depot: string, cible: string, clock: Clock): Promise<Entree | null> {
  const maintenant = clock.now();
  const active = await prisma.integrationFile.findFirst({ where: { depot, cible, statut: { in: [...STATUTS_ACTIFS] } } });
  if (active) {
    if (active.bailPar !== INSTANCE && active.bailJusqua && active.bailJusqua > maintenant) return null;
    const r = await prisma.integrationFile.updateMany({
      where: { id: active.id, OR: [{ bailPar: INSTANCE }, { bailJusqua: null }, { bailJusqua: { lt: maintenant } }] },
      data: { bailPar: INSTANCE, bailJusqua: new Date(maintenant.getTime() + BAIL_INTEGRATION_MS) },
    });
    return r.count === 1 ? prisma.integrationFile.findUnique({ where: { id: active.id } }) : null;
  }
  const tete = await prisma.integrationFile.findFirst({
    where: { depot, cible, statut: "EN_FILE", OR: [{ reessayerA: null }, { reessayerA: { lte: maintenant } }] },
    orderBy: { createdAt: "asc" },
  });
  if (!tete) return null;
  try {
    const tour = tete.tour + 1;
    const r = await prisma.integrationFile.updateMany({
      where: { id: tete.id, statut: "EN_FILE" },
      data: { statut: "EN_COURS", tour, brancheIntegration: brancheIntegration(cible, tete.id, tour), shaBase: null, shaIntegration: null, reessayerA: null, bailPar: INSTANCE, bailJusqua: new Date(maintenant.getTime() + BAIL_INTEGRATION_MS) },
    });
    return r.count === 1 ? prisma.integrationFile.findUnique({ where: { id: tete.id } }) : null;
  } catch (e) {
    if ((e as { code?: string }).code === "P2002") return null;
    throw e;
  }
}

const refDe = (depot: string): RefDepot => { const [proprietaire, nom] = depot.split("/"); return { proprietaire: proprietaire!, nom: nom! }; };
const attendreUnPeu = (clock: Clock, ms: number) => new Date(clock.now().getTime() + ms);

/** Une erreur de forge non définitive : on garde la place, on réessaie plus tard ; définitive : on rend la tâche. */
async function apresErreur(e: Entree, quoi: string, r: Extract<Resultat<unknown>, { ok: false }>, deps: DepsFile): Promise<string> {
  if (r.definitif && !/non fast-forward/i.test(r.erreur)) {
    await poser(e.id, "RENVOYEE", { detail: { ...detail(e), raison: `${quoi} : ${r.erreur}` } }, deps.clock);
    return "RENVOYEE";
  }
  await poser(e.id, e.statut, { essais: e.essais + 1, reessayerA: attendreUnPeu(deps.clock, r.reessayerApresMs ?? 60_000) }, deps.clock);
  return e.statut;
}

/** Abandonne la branche d'intégration (elle n'a servi qu'à la CI) ; un échec de suppression n'arrête rien. */
async function nettoyer(e: Entree, deps: DepsFile): Promise<void> {
  if (e.brancheIntegration) await forgeGardee(deps.forge, e.cible).supprimerBranche(refDe(e.depot), e.brancheIntegration).catch(sansBloquer("equipe.integration.nettoyer"));
}

/**
 * UN PAS DE LA FILE pour une cible : prend la tête (ou reprend l'active), la fait avancer d'autant d'étapes que
 * possible sans attendre, et rend l'entrée touchée avec son statut. Rien à faire : `null`.
 */
export async function avancerFile(depot: string, cible: string, deps: DepsFile): Promise<{ id: string; statut: string } | null> {
  let e = await prendreLaTete(depot, cible, deps.clock);
  if (!e) return null;
  const forge = forgeGardee(deps.forge, cible);
  const d = refDe(depot);
  if (e.reessayerA && e.reessayerA > deps.clock.now()) return { id: e.id, statut: e.statut };
  for (let pas = 0; pas < 6; pas++) {
    if (e.statut === "EN_COURS") {
      // 1. LA TÊTE ACTUELLE de la cible — figée pour ce tour (la CI la valide, l'avance l'exige).
      if (!e.shaBase) {
        const t = await forge.tete(d, cible);
        if (!t.ok) return { id: e.id, statut: await apresErreur(e, `Lecture de ${cible}`, t, deps) };
        if (!t.valeur) { await poser(e.id, "RENVOYEE", { detail: { raison: `la cible ${cible} n'existe pas` } }, deps.clock); return { id: e.id, statut: "RENVOYEE" }; }
        await poser(e.id, "EN_COURS", { shaBase: t.valeur }, deps.clock);
        e = { ...e, shaBase: t.valeur };
      }
      // 2. LA BRANCHE D'INTÉGRATION depuis cette tête — relue d'abord : un passage tué l'a peut-être déjà créée, voire fusionnée.
      const integ = e.brancheIntegration!;
      // La tâche part de la tête EXACTE de la cible : rien à fusionner — le SHA intégré est celui de la tâche, déjà vérifié.
      const direct = await forge.estAncetre(d, e.shaBase!, e.shaTache);
      if (!direct.ok) return { id: e.id, statut: await apresErreur(e, "Comparaison avec la cible", direct, deps) };
      if (direct.valeur) {
        await poser(e.id, "CI", { shaIntegration: e.shaTache }, deps.clock);
        e = { ...e, statut: "CI", shaIntegration: e.shaTache };
        continue;
      }
      const deja = await forge.tete(d, integ);
      if (!deja.ok) return { id: e.id, statut: await apresErreur(e, "Lecture de la branche d'intégration", deja, deps) };
      let shaIntegration: string | null = deja.valeur && deja.valeur !== e.shaBase ? deja.valeur : null;
      if (!deja.valeur) {
        const c = await forge.creerBranche(d, integ, e.shaBase!);
        if (!c.ok) return { id: e.id, statut: await apresErreur(e, "Création de la branche d'intégration", c, deps) };
      }
      // 3. LA FUSION de la branche de la tâche — sauf si la reprise trouve la branche déjà fusionnée.
      if (!shaIntegration) {
        const f = await forge.fusionnerDans(d, integ, e.branche, `Intégration de ${e.branche} (${e.shaTache.slice(0, 7)}) dans ${cible} @ ${e.shaBase!.slice(0, 7)} — tâche ${e.tacheCle}`);
        if (!f.ok) return { id: e.id, statut: await apresErreur(e, "Fusion dans la branche d'intégration", f, deps) };
        if ("conflit" in f.valeur) {
          const [tache, cibleM] = await Promise.all([forge.fichiersModifies(d, e.shaBase!, e.shaTache), forge.fichiersModifies(d, e.shaTache, e.shaBase!)]);
          const fichiers = tache.ok && cibleM.ok ? tache.valeur.filter((x) => cibleM.valeur.includes(x)) : [];
          const recette = recetteDeRegeneration(fichiers);
          await nettoyer(e, deps);
          await poser(e.id, "RENVOYEE", { detail: { raison: recette ? "conflit limité aux fichiers générés : régénération" : "conflit de fusion avec la cible", fichiers, recette } }, deps.clock);
          return { id: e.id, statut: "RENVOYEE" };
        }
        shaIntegration = f.valeur.sha;
      }
      await deps.sonde?.("apres-fusion");
      await poser(e.id, "CI", { shaIntegration }, deps.clock);
      e = { ...e, statut: "CI", shaIntegration };
      continue;
    }
    if (e.statut === "CI") {
      // 4. LA CI DU RÉSULTAT INTÉGRÉ — la seule preuve que A et B tiennent ENSEMBLE.
      const c = await forge.checks(d, e.shaIntegration!);
      if (!c.ok) return { id: e.id, statut: await apresErreur(e, "Lecture des checks d'intégration", c, deps) };
      if (c.valeur.statut === "en_cours" || c.valeur.statut === "aucun") {
        await poser(e.id, "CI", { reessayerA: attendreUnPeu(deps.clock, 60_000) }, deps.clock);
        return { id: e.id, statut: "CI" };
      }
      if (c.valeur.statut === "rouge") {
        const extrait = c.valeur.echecs.map((x) => `${x.nom} : ${x.extrait}`).join("\n").slice(0, 4_000);
        await nettoyer(e, deps);
        await poser(e.id, "RENVOYEE", { detail: { raison: `CI rouge sur le résultat intégré avec ${cible} @ ${e.shaBase!.slice(0, 7)} (incompatibilité que Git ne signale pas)`, extrait } }, deps.clock);
        return { id: e.id, statut: "RENVOYEE" };
      }
      const t = await forge.tete(d, cible);
      if (!t.ok) return { id: e.id, statut: await apresErreur(e, `Lecture de ${cible}`, t, deps) };
      if (t.valeur === e.shaIntegration) return { id: e.id, statut: await conclure(e, deps) };
      if (t.valeur !== e.shaBase) return { id: e.id, statut: await recommencer(e, `${cible} a bougé (${e.shaBase!.slice(0, 7)} → ${(t.valeur ?? "?").slice(0, 7)})`, deps) };
      if (cibleProtegee(cible) && detail(e).validation?.decision !== "ACCORDEE") {
        await poser(e.id, "A_VALIDER", { detail: { ...detail(e), validationDemandee: true } }, deps.clock);
        return { id: e.id, statut: "A_VALIDER" };
      }
      e = { ...e, statut: "A_VALIDER" };
    }
    if (e.statut === "A_VALIDER") {
      const v = detail(e).validation;
      if (cibleProtegee(cible) && !v) return { id: e.id, statut: "A_VALIDER" };
      if (v?.decision === "REFUSEE") { await nettoyer(e, deps); await poser(e.id, "RENVOYEE", { detail: { ...detail(e), raison: "fusion refusée par la Direction" } }, deps.clock); return { id: e.id, statut: "RENVOYEE" }; }
      // 5. L'AVANCE — fast-forward seul : si la cible a bougé depuis la CI, GitHub refuse et on recommence.
      await deps.sonde?.("avant-avance");
      const t = await forge.tete(d, cible);
      if (!t.ok) return { id: e.id, statut: await apresErreur(e, `Lecture de ${cible}`, t, deps) };
      if (t.valeur === e.shaIntegration) return { id: e.id, statut: await conclure(e, deps) };
      if (t.valeur !== e.shaBase) return { id: e.id, statut: await recommencer(e, `${cible} a bougé avant l'avance`, deps) };
      const a = await forge.avancer(d, cible, e.shaIntegration!);
      if (a.ok) return { id: e.id, statut: await conclure(e, deps) };
      if (/non fast-forward/i.test(a.erreur)) return { id: e.id, statut: await recommencer(e, `${cible} a bougé pendant l'avance`, deps) };
      // Cible protégée qui refuse l'avance directe : la PR de la branche d'intégration, fusionnée AU SHA vérifié.
      if (forge.fusionnerParPr && /interdit|protect/i.test(a.erreur)) {
        const p = await forge.fusionnerParPr(d, e.brancheIntegration!, cible, e.shaIntegration!, `Intégration — tâche ${e.tacheCle}`);
        if (p.ok) return { id: e.id, statut: await conclure(e, deps, p.valeur.sha) };
        return { id: e.id, statut: await apresErreur(e, "Fusion par PR", p, deps) };
      }
      return { id: e.id, statut: await apresErreur(e, `Avance de ${cible}`, a, deps) };
    }
    return { id: e.id, statut: e.statut };
  }
  return { id: e.id, statut: e.statut };
}

async function recommencer(e: Entree, raison: string, deps: DepsFile): Promise<string> {
  await nettoyer(e, deps);
  // L'entrée garde son rang (createdAt) : elle repasse en TÊTE, sur la nouvelle tête de la cible.
  await poser(e.id, "EN_FILE", { shaBase: null, shaIntegration: null, detail: { ...detail(e), raison } }, deps.clock);
  return "EN_FILE";
}

async function conclure(e: Entree, deps: DepsFile, sha?: string): Promise<string> {
  await nettoyer(e, deps);
  await poser(e.id, "FUSIONNEE", { ...(sha ? { shaIntegration: sha } : {}), detail: { ...detail(e), raison: `intégrée dans ${e.cible} à ${(sha ?? e.shaIntegration ?? "").slice(0, 7)}` } }, deps.clock);
  await journaliser(e.programmeId, "PROGRAMME_INTEGRATION", `Tâche « ${e.tacheCle} » intégrée dans ${e.cible} : ${(sha ?? e.shaIntegration ?? "").slice(0, 7)} (CI verte sur le résultat, base ${e.shaBase?.slice(0, 7)}).`, { tache: e.tacheCle, sha: sha ?? e.shaIntegration });
  return "FUSIONNEE";
}

/** Dépose une tâche verte dans la file — idempotent : une entrée par (chantier, SHA). */
export async function deposerEnFile(e: { programmeId: string; chantierId: string; tacheCle: string; depot: RefDepot; cible: string; branche: string; shaTache: string }): Promise<void> {
  await prisma.integrationFile.createMany({
    data: [{ programmeId: e.programmeId, chantierId: e.chantierId, tacheCle: e.tacheCle, depot: nomDepot(e.depot), cible: e.cible, branche: e.branche, shaTache: e.shaTache }],
    skipDuplicates: true,
  });
}

/** La Direction valide (ou refuse) l'intégration qui attend sa carte (cible protégée). */
export async function validerIntegration(programmeId: string, decision: "ACCORDEE" | "REFUSEE", par: string, clock: Clock): Promise<{ ok: true; tache: string } | { ok: false; erreur: string }> {
  const e = await prisma.integrationFile.findFirst({ where: { programmeId, statut: "A_VALIDER" } });
  if (!e) return { ok: false, erreur: "Aucune intégration n'attend votre validation sur ce programme." };
  await prisma.integrationFile.update({ where: { id: e.id }, data: { detail: { ...detail(e), validation: { decision, par, le: clock.now().toISOString() } } as Prisma.InputJsonValue, bailJusqua: null, bailPar: null } });
  return { ok: true, tache: e.tacheCle };
}
