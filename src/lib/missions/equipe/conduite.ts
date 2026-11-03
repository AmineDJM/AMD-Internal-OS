import { prisma } from "@/lib/prisma";
import { sansBloquer } from "@/lib/journal";
import { journaliser, transitionner } from "@/lib/missions/runtime/store";
import { prendreBail, rendreBail } from "@/lib/missions/runtime/bail";
import { mettreEnPause } from "@/lib/missions/runtime/control";
import { systemClock, type Clock } from "@/lib/missions/ports";
import { signalerUneFois } from "@/lib/missions/travaux/signaux";
import { refusChantier } from "@/lib/missions/chantiers/conduite";
import { approuverChantier, proposerChantier } from "@/lib/missions/chantiers/service";
import { lireDossier } from "@/lib/missions/chantiers/dossier";
import { MOTIF_BUDGET_CHANTIER, MOTIF_CONSIGNES_CHANTIER } from "@/lib/missions/chantiers/regles";
import { liberer, prolonger } from "@/lib/missions/chantiers/reservations";
import { cerveauReel, type CerveauChantier } from "@/lib/missions/chantiers/cerveau";
import { KIND_PROGRAMME, lirePlanProgramme, type PlanProgramme, type TacheProgramme } from "@/lib/missions/equipe/programme";
import { ordonnancer } from "@/lib/missions/equipe/ordonnanceur";
import { globsDeRessource, ressourcesDeTache } from "@/lib/missions/equipe/ressources";
import { planifier } from "@/lib/missions/equipe/planificateur";
import { brancheDeTache, ecrireDossierProgramme, etatsDesTaches, lireLeDossierProgramme, type DossierProgramme } from "@/lib/missions/equipe/dossier";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * CONDUIRE UN PROGRAMME (lot O2, décision 0059) — ÉVÉNEMENTIEL et DÉTERMINISTE. Un passage, sous le BAIL du programme
 * (un seul conducteur, quel que soit le nombre de processus) :
 *   1. relit ses chantiers enfants : fini vert → la tâche entre en file d'intégration ; mort → échec ;
 *   2. fait avancer la file d'intégration de sa cible (`integration`, une entrée active par cible) ;
 *   3. relit le budget (dollars du programme + de ses chantiers, lancements) ;
 *   4. demande à l'ORDONNANCEUR (pur) ce qui part, et lance ces chantiers (idempotent : un chantier par tâche et par
 *      essai, retrouvé par son origine s'il existe déjà — un redémarrage ne lance jamais deux sessions) ;
 *   5. sur dépendance cassée ou échec : REPLANIFIE (MiMo, borné), sinon pause « attend tes consignes » ;
 *   6. fini : TERMINÉ, réservations libérées, la Direction prévenue.
 * Réveillé par la fin d'un chantier enfant, un fait GitHub, une consigne ; le battement d'une minute en secours.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const REPLANIFICATIONS_MAX = 3;

export interface ContexteIntegration { programmeId: string; principalId: string; dossier: DossierProgramme; clock: Clock }
/** La file d'intégration (O2-3) : fait avancer les entrées du programme, met à jour l'état des tâches. */
export type Integrer = (ctx: ContexteIntegration) => Promise<void>;

export interface DepsProgramme {
  clock?: Clock;
  cerveau?: CerveauChantier;
  integrer?: Integrer;
}

export interface BilanProgramme { programmeId: string; lances: string[]; statut: string | null; arret?: "BAIL" | "DROITS" | "BUDGET" | "CONSIGNES" | "FINI" }

export const origineTache = (programmeId: string, cle: string, essai: number) => `programme:${programmeId}:${cle}:${essai}`;

/** Le plan du CHANTIER d'une tâche : sa branche, la cible pour base, le périmètre augmenté des ressources réservées, ni fusion ni déploiement. */
export function planDeChantier(p: PlanProgramme, t: TacheProgramme, branche: string, programmeId: string): Record<string, unknown> {
  const ressources = ressourcesDeTache(t);
  const perimetre = [...new Set([...t.perimetre, ...ressources.flatMap((r) => (r.startsWith("MODULE:") ? [] : globsDeRessource(r)))])].slice(0, 20);
  return {
    titre: `${p.titre} — ${t.titre}`.slice(0, 120),
    objectif: `${t.objectif}\n\n(Tâche « ${t.cle} » du programme ${programmeId} : son travail sera intégré dans ${p.cible} par la file d'intégration, après une CI complète du résultat.)`,
    depot: p.depot, branche, brancheBase: p.cible, perimetre, criteres: t.criteres, commandesVerif: t.commandesVerif,
    migrations: t.migrations, services: [], fusion: false, ressources,
    ...(p.travailleur === "managed-agents" ? { travailleur: "managed-agents" } : {}),
  };
}

async function consommation(programmeId: string): Promise<{ usd: number; lancements: number }> {
  const [p, enfants] = await Promise.all([
    prisma.mission.findUnique({ where: { id: programmeId }, select: { costUsd: true } }),
    prisma.mission.findMany({ where: { parentMissionId: programmeId, kind: "CHANTIER" }, select: { costUsd: true, carnet: true } }),
  ]);
  return {
    usd: (p?.costUsd ?? 0) + enfants.reduce((s, e) => s + e.costUsd, 0),
    lancements: enfants.reduce((s, e) => s + (lireDossier(e.carnet)?.compteurs.lancements ?? 1), 0),
  };
}

/** Lance le chantier d'une tâche — ou RETROUVE celui qu'un passage interrompu avait déjà créé (même origine). */
async function lancerTache(programmeId: string, principalId: string, d: DossierProgramme, t: TacheProgramme): Promise<{ ok: true; chantierId: string; branche: string } | { ok: false; erreur: string }> {
  const e = d.taches[t.cle]!;
  const essai = e.essai + 1;
  // Un nouvel essai (après replanification) part sur une branche NEUVE : l'ancienne garde la trace de l'essai raté.
  const branche = essai === 1 ? brancheDeTache(programmeId, t.cle) : `${brancheDeTache(programmeId, t.cle)}-e${essai}`.slice(0, 120);
  const origine = origineTache(programmeId, t.cle, essai);
  const existant = await prisma.mission.findFirst({ where: { parentMissionId: programmeId, kind: "CHANTIER", context: origine }, select: { id: true, status: true } });
  let chantierId = existant?.id;
  if (!chantierId) {
    const p = await proposerChantier(principalId, planDeChantier(d.plan, t, branche, programmeId), { origine, parentMissionId: programmeId });
    if (!p.ok) return { ok: false, erreur: p.fautes.join(" ") };
    chantierId = p.chantierId;
  }
  if (!existant || existant.status === "AWAITING_APPROVAL") {
    const a = await approuverChantier(chantierId, principalId);
    if (!a.ok) return { ok: false, erreur: a.erreur };
  }
  return { ok: true, chantierId, branche };
}

/** Relit les chantiers enfants : fini vert → EN_FILE ; mort → ECHEC (avec ce que le rapport en dit). */
async function relireEnfants(programmeId: string, principalId: string, d: DossierProgramme, maintenant: string): Promise<DossierProgramme> {
  const ids = Object.values(d.taches).filter((t) => t.chantierId && (t.etat === "LANCEE" || t.etat === "RETOUR")).map((t) => t.chantierId!);
  if (!ids.length) return d;
  const ms = await prisma.mission.findMany({ where: { id: { in: ids } }, select: { id: true, status: true, pausedReason: true, carnet: true } });
  const changements: { cle: string; etat: "EN_FILE" | "ECHEC" | null; raison: string | null }[] = [];
  for (const [cle, t] of Object.entries(d.taches)) {
    const m = ms.find((x) => x.id === t.chantierId);
    if (!m || t.etat !== "LANCEE") continue;
    const dossier = lireDossier(m.carnet);
    if (m.status === "COMPLETED") changements.push({ cle, etat: "EN_FILE", raison: `vert sur ${dossier?.vert?.sha.slice(0, 7) ?? "?"} — en file d'intégration` });
    else if (["FAILED", "BLOCKED", "PARTIAL", "CANCELLED"].includes(m.status)) changements.push({ cle, etat: "ECHEC", raison: (dossier?.blocage ?? dossier?.rapport?.texte ?? m.status).slice(0, 300) });
    else if (m.status === "PAUSED") changements.push({ cle, etat: null, raison: `chantier en pause : ${m.pausedReason ?? "?"}` });
  }
  if (!changements.length) return d;
  const nd = await ecrireDossierProgramme(programmeId, (x) => {
    for (const c of changements) {
      const t = x.taches[c.cle]!;
      if (c.etat) t.etat = c.etat;
      t.raison = c.raison;
      t.majLe = maintenant;
    }
  });
  for (const c of changements.filter((x) => x.etat)) {
    await journaliser(programmeId, c.etat === "EN_FILE" ? "PROGRAMME_TACHE_VERTE" : "PROGRAMME_TACHE_ECHEC", `Tâche « ${c.cle} » : ${c.raison}`.slice(0, 900), { tache: c.cle }, principalId);
  }
  return nd;
}

/**
 * LA REPLANIFICATION (MiMo, Sol en recours — bornée) : les tâches INTÉGRÉES sont figées ; MiMo propose les autres ;
 * le plan fusionné repasse le validateur. Une tâche gardée telle quelle conserve son état ; une tâche nouvelle ou
 * redéfinie repart d'ATTENTE à l'essai suivant.
 */
async function replanifier(programmeId: string, principalId: string, d: DossierProgramme, raison: string, cerveau: CerveauChantier): Promise<{ ok: true; dossier: DossierProgramme } | { ok: false; raison: string }> {
  if (d.replanifications >= REPLANIFICATIONS_MAX) return { ok: false, raison: `${REPLANIFICATIONS_MAX} replanifications déjà faites` };
  const figees = d.plan.taches.filter((t) => d.taches[t.cle]?.etat === "INTEGREE");
  const contexte = [
    `REPLANIFICATION (${raison}).`,
    figees.length ? `Tâches DÉJÀ INTÉGRÉES (ne pas les refaire, garder leurs clés) : ${figees.map((t) => `${t.cle} (${t.titre})`).join(" ; ")}.` : "",
    `Plan actuel : ${JSON.stringify(d.plan.taches.map((t) => ({ cle: t.cle, objectif: t.objectif.slice(0, 300), perimetre: t.perimetre, dependances: t.dependances, etat: d.taches[t.cle]?.etat, raison: d.taches[t.cle]?.raison })))}`,
    ...d.consignes.slice(-5).map((c) => `Consigne de la Direction : ${c.texte}`),
  ].filter(Boolean).join("\n");
  const r = await planifier({ texte: d.plan.objectif, depot: d.plan.depot, cible: d.plan.cible, contexte }, { cerveau, missionId: programmeId, userId: principalId });
  if (!r.lecture.ok) return { ok: false, raison: `replanification refusée : ${r.lecture.fautes.slice(0, 3).join(" ")}` };
  const neuves = r.lecture.plan.taches.filter((t) => !figees.some((f) => f.cle === t.cle));
  const fusion = lirePlanProgramme({ ...d.plan, taches: [...figees, ...neuves] });
  if (!fusion.ok) return { ok: false, raison: `plan fusionné refusé : ${fusion.fautes.slice(0, 3).join(" ")}` };
  const nd = await ecrireDossierProgramme(programmeId, (x) => {
    const anciennes = x.taches;
    x.plan = fusion.plan;
    x.conflits = fusion.conflits;
    x.replanifications += 1;
    x.taches = Object.fromEntries(fusion.plan.taches.map((t) => {
      const a = anciennes[t.cle];
      const inchangee = a && JSON.stringify(d.plan.taches.find((o) => o.cle === t.cle)) === JSON.stringify(t) && a.etat !== "ECHEC";
      return [t.cle, inchangee ? a : { etat: "ATTENTE" as const, chantierId: null, branche: a?.branche ?? brancheDeTache(programmeId, t.cle), essai: a?.essai ?? 0, renvois: 0, raison: "replanifiée", integreeSha: null, majLe: new Date().toISOString() }];
    }));
  });
  await journaliser(programmeId, "PROGRAMME_REPLANIFIE", `Replanifié par ${r.par} (${raison}) : ${neuves.length} tâche(s) non intégrée(s) revue(s).`, { raison }, principalId);
  return { ok: true, dossier: nd };
}

export async function conduireProgramme(programmeId: string, deps: DepsProgramme = {}): Promise<BilanProgramme> {
  const clock = deps.clock ?? systemClock;
  const bilan: BilanProgramme = { programmeId, lances: [], statut: null };
  const m = await prisma.mission.findFirst({ where: { id: programmeId, kind: KIND_PROGRAMME }, select: { status: true, principalId: true, title: true, plafondUsd: true, pausedReason: true } });
  if (!m?.principalId) return bilan;
  bilan.statut = m.status;
  const principalId = m.principalId;
  if (m.status !== "RUNNING") {
    if (m.status === "PAUSED") await prolonger(programmeId, clock.now());
    return bilan;
  }
  if (!(await prendreBail(programmeId, clock.now()))) return { ...bilan, arret: "BAIL" };
  try {
    const refus = await refusChantier(principalId);
    if (refus) {
      await mettreEnPause(programmeId, principalId, `DROITS — ${refus}`, "PROGRAMME");
      return { ...bilan, statut: "PAUSED", arret: "DROITS" };
    }
    await prolonger(programmeId, clock.now());
    const le = clock.now().toISOString();
    let d = await relireEnfants(programmeId, principalId, await lireLeDossierProgramme(programmeId), le);
    if (deps.integrer) {
      await deps.integrer({ programmeId, principalId, dossier: d, clock });
      d = await lireLeDossierProgramme(programmeId);
    }
    const conso = await consommation(programmeId);
    const plafond = m.plafondUsd ?? Infinity;
    if (conso.usd >= plafond) {
      await mettreEnPause(programmeId, principalId, `${MOTIF_BUDGET_CHANTIER} — ${conso.usd.toFixed(2)} $ dépensés sur ${plafond.toFixed(2)} $`, "PROGRAMME");
      await signalerUneFois(programmeId, principalId, `budget:${le.slice(0, 13)}`, `Programme en pause : « ${m.title} »`, `Plafond atteint (${conso.usd.toFixed(2)} $ / ${plafond.toFixed(2)} $) : aucun nouveau travailleur n'est lancé. Relevez-le pour reprendre — rien n'est perdu.`);
      return { ...bilan, statut: "PAUSED", arret: "BUDGET" };
    }
    const lancementsMax = d.plan.budget.lancements ?? Infinity;
    let decision = ordonnancer(d.plan, etatsDesTaches(d), { lancementsRestants: lancementsMax - conso.lancements, usdRestant: plafond - conso.usd });
    const echecs = Object.entries(d.taches).filter(([, t]) => t.etat === "ECHEC").map(([k]) => k);
    if (echecs.length || decision.orphelines.length) {
      const raison = echecs.length ? `échec de ${echecs.join(", ")}` : `dépendance cassée pour ${decision.orphelines.join(", ")}`;
      const r = await replanifier(programmeId, principalId, d, raison, deps.cerveau ?? cerveauReel);
      if (!r.ok) return await attendreConsignes(programmeId, principalId, m.title, `${raison} — ${r.raison}`, bilan);
      d = r.dossier;
      decision = ordonnancer(d.plan, etatsDesTaches(d), { lancementsRestants: lancementsMax - conso.lancements, usdRestant: plafond - conso.usd });
    }
    for (const cle of decision.lancer) {
      const t = d.plan.taches.find((x) => x.cle === cle)!;
      const r = await lancerTache(programmeId, principalId, d, t);
      if (!r.ok) {
        d = await ecrireDossierProgramme(programmeId, (x) => { x.taches[cle]!.raison = `lancement refusé : ${r.erreur}`.slice(0, 300); });
        continue;
      }
      d = await ecrireDossierProgramme(programmeId, (x) => {
        const e = x.taches[cle]!;
        Object.assign(e, { etat: "LANCEE", chantierId: r.chantierId, branche: r.branche, essai: e.essai + 1, raison: null, majLe: le });
      });
      await journaliser(programmeId, "PROGRAMME_TACHE_LANCEE", `Tâche « ${cle} » confiée à un travailleur (chantier ${r.chantierId}, branche ${d.taches[cle]!.branche}).`, { tache: cle, chantierId: r.chantierId }, principalId);
      bilan.lances.push(cle);
    }
    // Les raisons d'attente, pour le tableau (sans réécrire si rien ne change).
    const attentes = Object.entries(decision.attentes).filter(([k, v]) => d.taches[k]?.etat === "ATTENTE" && d.taches[k]!.raison !== v);
    if (attentes.length) d = await ecrireDossierProgramme(programmeId, (x) => { for (const [k, v] of attentes) x.taches[k]!.raison = v; });
    if (decision.fin === "COMPLETED") {
      await transitionner(programmeId, "COMPLETED", "toutes les tâches sont intégrées");
      await prisma.mission.update({ where: { id: programmeId }, data: { closedAt: clock.now() } });
      await liberer(programmeId);
      await journaliser(programmeId, "PROGRAMME_TERMINE", `Programme terminé : ${d.plan.taches.length} tâche(s) intégrée(s) dans ${d.plan.cible}.`, {}, principalId);
      await signalerUneFois(programmeId, principalId, "fin:COMPLETED", `Programme livré : « ${m.title} »`, `${d.plan.taches.length} tâche(s) intégrée(s) dans ${d.plan.cible}, chacune après une CI complète du résultat.`);
      return { ...bilan, statut: "COMPLETED", arret: "FINI" };
    }
    if (decision.fin === "BLOQUE") return await attendreConsignes(programmeId, principalId, m.title, Object.values(decision.attentes)[0] ?? "plus rien ne peut partir", bilan);
    return bilan;
  } finally {
    await rendreBail(programmeId);
  }
}

/** PAS D'ÉCHEC SEC (comme les chantiers, décision 0058) : pause « attend tes consignes », réservations gardées, Direction prévenue. */
async function attendreConsignes(programmeId: string, principalId: string, titre: string, raison: string, bilan: BilanProgramme): Promise<BilanProgramme> {
  await ecrireDossierProgramme(programmeId, (x) => { x.attenteConsignes = raison.slice(0, 600); });
  await mettreEnPause(programmeId, principalId, `${MOTIF_CONSIGNES_CHANTIER} — ${raison}`.slice(0, 300), "PROGRAMME");
  await signalerUneFois(programmeId, principalId, `consignes:${raison}`.slice(0, 190), `Programme en attente de vos consignes : « ${titre} »`, raison.slice(0, 400));
  return { ...bilan, statut: "PAUSED", arret: "CONSIGNES" };
}

/** Les programmes à conduire : vivants et signalés, ou tous les vivants au battement. */
export async function programmesAConduire(seulementSignales = false, limite = 6): Promise<string[]> {
  const ms = await prisma.mission.findMany({
    where: { kind: KIND_PROGRAMME, status: "RUNNING", ...(seulementSignales ? { reveilDemandeLe: { not: null } } : {}) },
    select: { id: true }, orderBy: { updatedAt: "asc" }, take: limite,
  });
  return ms.map((x) => x.id);
}

/** LE BATTEMENT DES PROGRAMMES — après celui des chantiers (leurs fins réveillent les programmes). */
export async function balayerProgrammes(o: { deps?: DepsProgramme; seulementSignales?: boolean; seulement?: readonly string[] } = {}): Promise<BilanProgramme[]> {
  const ids = (await programmesAConduire(o.seulementSignales)).filter((id) => !o.seulement || o.seulement.includes(id));
  const out: BilanProgramme[] = [];
  for (const id of ids) {
    await prisma.mission.updateMany({ where: { id }, data: { reveilDemandeLe: null } });
    out.push(await conduireProgramme(id, o.deps).catch((e) => { sansBloquer("equipe.conduite")(e); return { programmeId: id, lances: [], statut: null }; }));
  }
  return out;
}
