import { prisma } from "@/lib/prisma";
import type { Clock } from "@/lib/missions/ports";
import type { StepOutcome } from "@/lib/missions/runtime/engine";
import type { EtatEtape, EtatMission } from "@/lib/missions/runtime/store";
import { cloreEcriture, reclamerEcriture } from "@/lib/missions/travaux/ecritures";
import type { AgentDeveloppeur, ConsigneDev, ForgeGit, Hebergeur, Resultat } from "@/lib/missions/chantiers/ports-moteur";
import type { ServiceChantier, TypeEtapeChantier } from "@/lib/missions/chantiers/plan";
import { court, jugerPreuves, composerRapport, type DossierChantier, type PreuveDeploiement } from "@/lib/missions/chantiers/dossier";
import { deciderAntiBoucle, delaiCroissantMs, motifBudgetChantier, signatureEchec, type ConsommationChantier, type ReglagesChantiers } from "@/lib/missions/chantiers/regles";
import { horsPerimetre } from "@/lib/missions/chantiers/perimetre";
import { routerModele } from "@/lib/missions/chantiers/routeur";
import type { CerveauChantier } from "@/lib/missions/chantiers/cerveau";
import { demandesDuPlan, liberer, nomDepot, reserver } from "@/lib/missions/chantiers/reservations";
import { extraitMemoire, memoriser, noterEvenementDev } from "@/lib/missions/chantiers/memoire";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES ÉTAPES D'UN CHANTIER (lot C1, décision 0042) — un gestionnaire par type, appelé par le moteur (nœud WORKER).
 *
 * Trois règles, tenues ici et nulle part ailleurs :
 *   1. LA VÉRITÉ EST GITHUB ET RENDER. Une session Claude Code ne se lit pas par API : on lit la branche, la PR, les
 *      checks du SHA de tête, le statut du déploiement, la santé. Tout ce qui se lit sans modèle se lit sans modèle.
 *   2. ATTENDRE N'EST PAS ÉCHOUER. Un check « en cours », un commit pas encore poussé, une réservation tenue : l'étape
 *      rend `WAITING` avec `reessayerA` (délai croissant) ; le réveil la remet en file. Les essais MÉTIER se comptent
 *      dans sa sortie (`essais`), bornés par les tentatives de la console.
 *   3. AUCUN GESTE SANS SA PREUVE, AUCUN GESTE DEUX FOIS. Un déploiement exige des checks verts sur le SHA exact ; un
 *      lancement, une fusion, un déploiement, un rollback passent par un REÇU (`TravailEcriture`) réclamé avant, clos
 *      après — un redémarrage ne les double jamais. Production, fusion sur main, rollback de production : carte de
 *      validation de la Direction d'abord.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface PortsDev { agent: AgentDeveloppeur; forge: ForgeGit; hebergeur: Hebergeur }

export interface ContexteEtape {
  chantierId: string;
  principalId: string;
  mission: EtatMission;
  step: EtatEtape;
  clock: Clock;
  ports: PortsDev;
  cerveau: CerveauChantier;
  reglages: ReglagesChantiers;
  plafondUsd: number | null;
  dossier(): Promise<DossierChantier>;
  ecrire(maj: (d: DossierChantier) => void): Promise<DossierChantier>;
  conso(): Promise<ConsommationChantier>;
  journal(kind: string, texte: string, detail?: Record<string, unknown>): Promise<void>;
  /** Un plafond mord : le chantier DORT (BUDGET_HOLD) à la fin de la vague, et la Direction est prévenue. */
  plafond(motif: string): void;
  /** Un appel de modèle payé : compté sur le chantier (le journal K8, lui, l'a déjà par l'imputation). */
  compterModele(niveau: string, coutUsd: number | null): Promise<void>;
  /** Une validation de la Direction est demandée (carte écrite ou orale). */
  demanderValidation(geste: string, texte: string): Promise<void>;
}

type Etat = Record<string, unknown>;
const etatDe = (step: EtatEtape): Etat => (step.result && typeof step.result === "object" && !Array.isArray(step.result) ? { ...(step.result as Etat) } : {});
const num = (v: unknown, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : d);

/** Le délai d'attente d'un sondage : 1 min, 2, 4… jusqu'à 10 min. */
const SONDAGE_MAX_MS = 10 * 60_000;
/** Une session qui ne pousse rien en 6 h est un blocage réel, dit. */
const ATTENTE_COMMIT_MAX_MS = 6 * 3600_000;
const VALIDATION_RELUE_MS = 30 * 60_000;

function attendre(ctx: ContexteEtape, raison: string, ms: number, etat: Etat): StepOutcome {
  return { status: "WAITING", raison, result: { ...etat, reessayerA: new Date(ctx.clock.now().getTime() + ms).toISOString(), attente: raison } };
}

// Un échec de chantier est celui d'une capacité (taxinomie du moteur, `recovery/strategy.ts`) : non rejouable, il est DIT.
const echoue = (erreur: string): StepOutcome => ({ status: "FAILED", error: erreur, errorKind: "CAPABILITY_FAILURE", retryable: false });

/** Un port a échoué : définitif → échec dit ; sinon un essai de plus, délai croissant, borné par les tentatives. */
function apresEchecPort(ctx: ContexteEtape, quoi: string, r: Extract<Resultat<unknown>, { ok: false }>, etat: Etat): StepOutcome {
  const essais = num(etat.essais) + 1;
  if (r.definitif) return echoue(`${quoi} : ${r.erreur}`);
  if (essais >= ctx.reglages.tentativesMax) return echoue(`${quoi} : ${r.erreur} (${essais} essais)`);
  return attendre(ctx, `${quoi} : ${r.erreur} — nouvel essai`, r.reessayerApresMs ?? delaiCroissantMs(essais), { ...etat, essais });
}

const sonder = (ctx: ContexteEtape, raison: string, etat: Etat): StepOutcome => {
  const sondages = num(etat.sondages) + 1;
  return attendre(ctx, raison, delaiCroissantMs(sondages, 60_000, SONDAGE_MAX_MS), { ...etat, sondages });
};

/** La consigne de Claude Code — COMPOSÉE PAR LE CODE (aucun modèle) : objectif, périmètre, critères, mémoire ciblée. */
async function consigneDev(ctx: ContexteEtape, d: DossierChantier): Promise<ConsigneDev> {
  const p = d.plan;
  const depot = nomDepot(p.depot);
  const memoire = await extraitMemoire({
    cles: [{ type: "depot", cle: depot }, { type: "branche", cle: `${depot}:${p.branche}` }, ...p.services.map((s) => ({ type: "service" as const, cle: s.id }))],
    incidentsDe: depot,
  });
  return {
    depot: p.depot, branche: p.branche, brancheBase: p.brancheBase, objectif: p.objectif, perimetre: p.perimetre,
    criteres: p.criteres, commandesVerif: p.commandesVerif, chantierId: ctx.chantierId,
    contexte: [
      "Travaille UNIQUEMENT sur la branche indiquée (réservée pour ce chantier) et dans le périmètre de fichiers listé.",
      "Pousse tes commits sur cette branche et ouvre une PR vers la branche de base ; n'écris jamais sur main.",
      ...(p.migrations ? ["Migration : additive et idempotente, nom au-dessus de toutes les migrations existantes."] : []),
      ...(memoire ? [`Mémoire technique (extrait) :\n${memoire}`] : []),
    ].join("\n"),
  };
}

/** Un geste externe sous REÇU : fait une fois, jamais deux ; interrompu → `reprise` dit à l'appelant. */
async function sousRecu<T>(ctx: ContexteEtape, suffixe: string, faire: () => Promise<Resultat<T>>): Promise<{ etat: "FAIT"; valeur: T } | { etat: "INTERROMPU" } | { etat: "ECHEC"; r: Extract<Resultat<T>, { ok: false }> }> {
  const cle = `${ctx.chantierId}|${ctx.step.key}|${suffixe}`;
  const recu = await reclamerEcriture(cle, ctx.chantierId, ctx.step.key, `chantier:${suffixe}`);
  if (recu.etat === "FAIT") return { etat: "FAIT", valeur: recu.resultat as T };
  if (recu.etat === "INTERROMPU") return { etat: "INTERROMPU" };
  let r: Resultat<T>;
  try {
    r = await faire();
  } catch (e) {
    r = { ok: false, erreur: e instanceof Error ? e.message : String(e) };
  }
  await cloreEcriture(cle, r.ok ? "FAIT" : "ECHEC", r.ok ? r.valeur : { erreur: r.erreur });
  return r.ok ? { etat: "FAIT", valeur: r.valeur } : { etat: "ECHEC", r };
}

// ─────────────────────────────── DEV_LANCER ───────────────────────────────

async function devLancer(ctx: ContexteEtape): Promise<StepOutcome> {
  const etat = etatDe(ctx.step);
  let d = await ctx.dossier();
  const p = d.plan;
  // 1. LES DÉPENDANCES : un chantier qui en attend un autre ne part pas avant lui.
  if (p.dependances.length) {
    const deps = await prisma.mission.findMany({ where: { id: { in: p.dependances }, kind: "CHANTIER" }, select: { id: true, title: true, status: true } });
    const morte = deps.find((x) => x.status === "CANCELLED" || x.status === "FAILED");
    if (morte) return echoue(`le chantier dont celui-ci dépend (« ${morte.title} ») est ${morte.status === "CANCELLED" ? "annulé" : "en échec"}`);
    const enCours = deps.find((x) => x.status !== "COMPLETED");
    if (enCours || deps.length < p.dependances.length) return sonder(ctx, `attend la fin du chantier « ${enCours?.title ?? "introuvable"} »`, etat);
  }
  // 2. LES RÉSERVATIONS, tout ou rien : un recouvrement SÉRIALISE (on attend), il n'échoue pas.
  const res = await reserver(ctx.chantierId, demandesDuPlan(p), ctx.clock.now());
  if (!res.ok) {
    if (!etat.conflitDit) await ctx.journal("CHANTIER_ATTEND_RESERVATION", `En file : ${res.conflit.motif}.`, { cle: res.conflit.cle, chez: res.conflit.missionId });
    return sonder(ctx, `en file : ${res.conflit.motif}`, { ...etat, conflitDit: true });
  }
  d = await ctx.ecrire((x) => { x.reservations = res.cles; });
  // 3. LE LANCEMENT, sous reçu : un redémarrage ne lance JAMAIS une seconde session pour le même ordre.
  const recu = `${ctx.chantierId}|${ctx.step.key}|lancement`;
  const deja = await prisma.travailEcriture.findUnique({ where: { cle: recu }, select: { statut: true } });
  if (!deja || deja.statut === "ECHEC") {
    const motif = motifBudgetChantier(await ctx.conso(), ctx.reglages, ctx.plafondUsd, "lancement");
    if (motif) { ctx.plafond(motif); return attendre(ctx, `plafond : ${motif}`, 3600_000, etat); }
    const dispo = await ctx.ports.agent.disponible();
    if (!dispo.ok) return attendre(ctx, `Claude Code indisponible : ${dispo.raison ?? "aucun moyen de lancement"}`, 15 * 60_000, etat);
    const avant = await ctx.ports.forge.branche(p.depot, p.branche);
    if (avant.ok) d = await ctx.ecrire((x) => { x.shaVu = avant.valeur.existe ? avant.valeur.sha : null; });
  }
  const consigne = await consigneDev(ctx, d);
  const r = await sousRecu(ctx, "lancement", () => ctx.ports.agent.lancer(consigne, recu));
  if (r.etat === "ECHEC" && !r.r.incertain) return apresEchecPort(ctx, "Lancement de Claude Code", r.r, etat);
  if (r.etat === "INTERROMPU" || r.etat === "ECHEC") {
    // ON NE SAIT PAS si la session est partie : la branche le dit. Rien poussé → on attend quand même (la session
    // peut tourner) ; le blocage à 6 h et l'anti-boucle bornent le cas où elle n'est jamais partie.
    await ctx.journal("CHANTIER_REPRISE", "Lancement interrompu ou incertain (redémarrage, délai dépassé) : la session n'est pas relancée, GitHub dira si elle travaille.");
    return { status: "DONE", result: { session: null, reprise: true }, receipt: "CHANTIER_LANCER" };
  }
  const s = r.valeur;
  if (!d.sessions.some((x) => x.sessionId === s.sessionId)) {
    await ctx.ecrire((x) => {
      x.sessions.push({ sessionId: s.sessionId, url: s.url, le: s.lanceeLe, moyen: s.moyen, motif: "lancement" });
      x.compteurs.lancements += 1;
    });
    await ctx.journal("CHANTIER_LANCEMENT", `Claude Code lancé (${s.moyen}) sur ${p.branche} : ${s.url}`, { sessionId: s.sessionId, url: s.url });
  }
  return { status: "DONE", result: { session: s, reservations: res.cles }, receipt: "CHANTIER_LANCER" };
}

// ─────────────────────────────── DEV_ATTENDRE ───────────────────────────────

/** Attend un commit NEUF sur la branche (SHA différent de `base`). Partagée par DEV_ATTENDRE et DEV_CORRIGER. */
async function commitNeuf(ctx: ContexteEtape, base: string | null, etat: Etat): Promise<{ sha: string } | StepOutcome> {
  const d = await ctx.dossier();
  const debut = typeof etat.attenteDepuis === "string" ? etat.attenteDepuis : ctx.clock.now().toISOString();
  const r = await ctx.ports.forge.branche(d.plan.depot, d.plan.branche);
  if (!r.ok) return apresEchecPort(ctx, "Lecture de la branche", r, { ...etat, attenteDepuis: debut });
  const sha = r.valeur.existe ? r.valeur.sha : null;
  if (sha && sha !== base) return { sha };
  if (ctx.clock.now().getTime() - new Date(debut).getTime() > ATTENTE_COMMIT_MAX_MS) {
    await ctx.ecrire((x) => { x.blocage = `aucun commit sur ${d.plan.branche} en ${ATTENTE_COMMIT_MAX_MS / 3600_000} h`; });
    return echoue(`aucun commit poussé sur ${d.plan.branche} en ${ATTENTE_COMMIT_MAX_MS / 3600_000} h`);
  }
  return sonder(ctx, `attend un commit sur ${d.plan.branche}`, { ...etat, attenteDepuis: debut });
}

async function devAttendre(ctx: ContexteEtape): Promise<StepOutcome> {
  const etat = etatDe(ctx.step);
  const base = "base" in etat ? (etat.base as string | null) : (await ctx.dossier()).shaVu;
  const r = await commitNeuf(ctx, base, { ...etat, base });
  if ("status" in r) return r;
  await ctx.ecrire((x) => { x.shaVu = r.sha; });
  return { status: "DONE", result: { sha: r.sha, base }, receipt: "CHANTIER_COMMIT" };
}

// ─────────────────────────────── DEV_VERIFIER ───────────────────────────────

type Controle =
  | { issue: "attendre"; sortie: StepOutcome }
  | { issue: "vert"; sha: string }
  | { issue: "rouge"; sha: string; signature: string; check: string | null; extrait: string };

/** LE CONTRÔLE DÉTERMINISTE : périmètre, PR (ouverte au besoin), mergeable, checks du SHA de tête. Aucun modèle. */
async function controler(ctx: ContexteEtape, etat: Etat): Promise<Controle> {
  const d = await ctx.dossier();
  const p = d.plan;
  const b = await ctx.ports.forge.branche(p.depot, p.branche, p.brancheBase);
  if (!b.ok) return { issue: "attendre", sortie: apresEchecPort(ctx, "Lecture de la branche", b, etat) };
  const sha = b.valeur.sha;
  if (!b.valeur.existe || !sha) return { issue: "attendre", sortie: sonder(ctx, `la branche ${p.branche} n'existe pas encore`, etat) };
  await ctx.ecrire((x) => { x.shaVu = sha; });
  const hors = horsPerimetre(b.valeur.fichiers, p.perimetre);
  const rouge = (check: string | null, extrait: string): Controle => ({ issue: "rouge", sha, check, extrait, signature: signatureEchec({ etape: "verifier", check, erreur: extrait }) });
  if (hors.length) return rouge("perimetre", `fichiers hors du périmètre réservé : ${hors.slice(0, 10).join(", ")}`);
  let pr = d.pr;
  const lu = await ctx.ports.forge.pr(p.depot, p.branche);
  if (lu.ok && lu.valeur) {
    pr = { numero: lu.valeur.numero, url: lu.valeur.url };
    if (lu.valeur.mergeable === false) { await ctx.ecrire((x) => { x.pr = pr; }); return rouge("fusion", "la PR est en conflit avec la branche de base"); }
  } else if (lu.ok && !lu.valeur) {
    const o = await ctx.ports.forge.ouvrirPr(p.depot, p.branche, p.brancheBase, p.titre, `Chantier ${ctx.chantierId}\n\n${p.objectif}\n\nCritères :\n${p.criteres.map((c) => `- ${c}`).join("\n")}`);
    if (o.ok) { pr = o.valeur; await ctx.journal("CHANTIER_PR", `PR #${o.valeur.numero} ouverte : ${o.valeur.url}`, { pr: o.valeur.numero }); }
  }
  if (pr) await ctx.ecrire((x) => { x.pr = pr; });
  const c = await ctx.ports.forge.checks(p.depot, sha);
  if (!c.ok) return { issue: "attendre", sortie: apresEchecPort(ctx, "Lecture des checks", c, etat) };
  if (c.valeur.statut === "en_cours") return { issue: "attendre", sortie: sonder(ctx, `checks en cours sur ${court(sha)}`, etat) };
  if (c.valeur.statut === "aucun") {
    if (num(etat.sansCheck) < 3) return { issue: "attendre", sortie: attendre(ctx, `aucun check encore sur ${court(sha)}`, 60_000, { ...etat, sansCheck: num(etat.sansCheck) + 1 }) };
    return rouge("ci", "aucun check CI sur ce SHA : rien ne prouve que le code passe");
  }
  if (c.valeur.statut === "rouge") {
    const e = c.valeur.echecs[0];
    return rouge(e?.nom ?? "ci", c.valeur.echecs.map((x) => `${x.nom} : ${x.extrait}`).join("\n").slice(0, 12_000) || "check rouge");
  }
  await ctx.ecrire((x) => { x.vert = { sha, le: ctx.clock.now().toISOString() }; });
  return { issue: "vert", sha };
}

async function devVerifier(ctx: ContexteEtape): Promise<StepOutcome> {
  const c = await controler(ctx, etatDe(ctx.step));
  if (c.issue === "attendre") return c.sortie;
  if (c.issue === "vert") {
    await ctx.journal("CHANTIER_VERT", `Checks verts sur ${court(c.sha)}.`, { sha: c.sha });
    return { status: "DONE", result: { vert: true, sha: c.sha }, receipt: "CHANTIER_VERIFIE" };
  }
  await ctx.journal("CHANTIER_ROUGE", `Rouge sur ${court(c.sha)} : ${c.extrait.split("\n")[0]}`, { sha: c.sha, signature: c.signature });
  return { status: "DONE", result: { vert: false, sha: c.sha, signature: c.signature, check: c.check, extrait: c.extrait }, receipt: "CHANTIER_VERIFIE" };
}

// ─────────────────────────────── DEV_CORRIGER ───────────────────────────────

/** Le problème dit à Claude Code : l'extrait tel quel s'il est court, résumé par MiMo s'il est long, Sol à l'escalade. */
async function formulerProbleme(ctx: ContexteEtape, extrait: string, escalade: boolean): Promise<string> {
  const route = routerModele({ nature: escalade ? "arbitrage" : "lecture", caracteres: extrait.length, escalade, disponibles: ctx.cerveau.disponibles() });
  if (route.niveau === "DETERMINISTE") return extrait.slice(0, 4_000);
  const r = await ctx.cerveau.executer(route.niveau, {
    missionId: ctx.chantierId, userId: ctx.principalId, maxSortie: 900,
    consigne: escalade
      ? "Tu es l'expert de dernier recours d'un chantier logiciel. Le même échec de CI revient pour la deuxième fois. Explique en 10 lignes au plus la cause racine probable et la correction précise à faire. Pas de préambule."
      : "Extrais de ces journaux de CI l'erreur UTILE (fichier, ligne, message, test en échec) en 15 lignes au plus, sans commentaire.",
    texte: extrait.slice(0, 60_000),
  });
  await ctx.compterModele(route.niveau, r.ok ? r.coutUsd : null);
  return r.ok ? r.texte : extrait.slice(0, 4_000);
}

async function devCorriger(ctx: ContexteEtape): Promise<StepOutcome> {
  let etat = etatDe(ctx.step);
  // L'étape observée par la condition (« corriger si verifier.vert = false ») porte l'échec à corriger.
  const cleAmont = ctx.step.spec?.when?.step ?? ctx.step.dependsOn[0];
  const amont = ctx.mission.steps.find((s) => s.key === cleAmont);
  if (!etat.echec) {
    const r = (amont?.result ?? {}) as Etat;
    etat = { ...etat, phase: "DECIDER", tour: 0, echec: { sha: r.sha, signature: r.signature, check: r.check, extrait: r.extrait } };
  }
  for (let garde = 0; garde < 4; garde++) {
    const echec = etat.echec as { sha: string | null; signature: string; check: string | null; extrait: string };
    if (etat.phase === "DECIDER") {
      const d = await ctx.dossier();
      const decision = deciderAntiBoucle({ historique: d.signatures, nouvelle: echec.signature, tours: num(etat.tour), tentativesMax: ctx.reglages.tentativesMax, solDejaPour: d.solPour });
      await ctx.ecrire((x) => { x.signatures.push(echec.signature); });
      if (decision.action === "BLOQUER") {
        await ctx.ecrire((x) => { x.blocage = decision.raison; });
        await memoriser("incident", `${nomDepot(d.plan.depot)}:${echec.signature}`.slice(0, 200), `Blocage réel du chantier « ${d.plan.titre} » : ${decision.raison}.\nDernier extrait :\n${echec.extrait.slice(0, 1_500)}`, { source: "chantier", missionId: ctx.chantierId });
        await ctx.journal("CHANTIER_BLOQUE", `Blocage réel : ${decision.raison}.`, { signature: echec.signature });
        return echoue(`blocage réel : ${decision.raison}`);
      }
      const motif = motifBudgetChantier(await ctx.conso(), ctx.reglages, ctx.plafondUsd, "lancement");
      if (motif) { ctx.plafond(motif); return attendre(ctx, `plafond : ${motif}`, 3600_000, etat); }
      const sol = decision.action === "ESCALADER_SOL";
      const tour = num(etat.tour) + 1;
      const probleme = await formulerProbleme(ctx, echec.extrait, sol);
      if (sol) await ctx.ecrire((x) => { x.solPour.push(echec.signature); });
      const consigne = await consigneDev(ctx, d);
      // UNE PR EXISTE : le problème part dans SON fil (commentaire `@claude`, le fil porte le contexte) ; sinon une session
      // neuve reprend la branche. Clé d'idempotence par tour : un redémarrage ne double jamais la relance.
      const texte = `Le contrôle est rouge sur ${court(echec.sha)} (${echec.check ?? "ci"}). Corrige sur cette branche, dans le périmètre réservé, puis pousse :\n\n${probleme}`;
      const cle = `${ctx.chantierId}|${ctx.step.key}|tour-${tour}`;
      const r = await sousRecu(ctx, `tour-${tour}`, () => ctx.ports.agent.relancer({ ...consigne, probleme: texte, ...(d.pr ? { pr: d.pr.numero } : {}) }, cle));
      if (r.etat === "ECHEC" && !r.r.incertain) return apresEchecPort(ctx, "Relance de Claude Code", r.r, etat);
      if (r.etat === "FAIT") {
        const s = r.valeur;
        await ctx.ecrire((x) => {
          if (!x.sessions.some((y) => y.sessionId === s.sessionId)) x.sessions.push({ sessionId: s.sessionId, url: s.url, le: s.lanceeLe, moyen: s.moyen, motif: "correction" });
          x.compteurs.lancements += 1;
        });
        await ctx.journal("CHANTIER_LANCEMENT", `Correction demandée (tour ${tour}${sol ? ", analyse Sol" : ""}) : ${s.url}`, { tour, sol, signature: echec.signature });
      }
      etat = { ...etat, phase: "ATTENDRE", tour, base: echec.sha, attenteDepuis: ctx.clock.now().toISOString(), sondages: 0 };
    }
    if (etat.phase === "ATTENDRE") {
      const r = await commitNeuf(ctx, (etat.base as string | null) ?? null, etat);
      if ("status" in r) return r;
      etat = { ...etat, phase: "CONTROLER", sondages: 0, sansCheck: 0 };
    }
    if (etat.phase === "CONTROLER") {
      const c = await controler(ctx, etat);
      if (c.issue === "attendre") return c.sortie;
      if (c.issue === "vert") {
        await ctx.journal("CHANTIER_VERT", `Corrigé : checks verts sur ${court(c.sha)} au tour ${num(etat.tour)}.`, { sha: c.sha, tours: etat.tour });
        return { status: "DONE", result: { vert: true, sha: c.sha, tours: etat.tour }, receipt: "CHANTIER_CORRIGE" };
      }
      etat = { ...etat, phase: "DECIDER", echec: { sha: c.sha, signature: c.signature, check: c.check, extrait: c.extrait } };
    }
  }
  return attendre(ctx, "reprise de la boucle de correction", 60_000, etat);
}

// ─────────────────────────────── RENDER_* ───────────────────────────────

const serviceDe = (d: DossierChantier, id: unknown): ServiceChantier | null => d.plan.services.find((s) => s.id === id) ?? null;

/** La carte de validation : accordée → on passe ; refusée → l'étape est écartée ; absente → on la demande et on attend. */
async function validation(ctx: ContexteEtape, geste: string, texte: string, etat: Etat): Promise<"ACCORDEE" | StepOutcome> {
  const v = (await ctx.dossier()).validations[ctx.step.key];
  if (v?.decision === "ACCORDEE") return "ACCORDEE";
  if (v?.decision === "REFUSEE") return { status: "SKIPPED", raison: `refusé par la Direction (${v.par}, ${v.canal})${v.note ? ` : ${v.note}` : ""}` };
  if (!etat.validationDemandee) await ctx.demanderValidation(geste, texte);
  return attendre(ctx, `attend la validation de la Direction : ${texte}`, VALIDATION_RELUE_MS, { ...etat, validationDemandee: true });
}

async function renderDeployer(ctx: ContexteEtape): Promise<StepOutcome> {
  let etat = etatDe(ctx.step);
  let d = await ctx.dossier();
  const s = serviceDe(d, ctx.step.input.service);
  if (!s) return echoue("service inconnu du plan");
  if (!d.vert) return { status: "SKIPPED", raison: "aucune preuve verte : rien n'est déployé" };
  const p = d.plan;
  const integre = !!s.branche && s.branche !== p.branche;
  if (s.production || integre) {
    const texte = `${integre ? `fusionner la PR #${d.pr?.numero ?? "?"} sur ${s.branche} puis ` : ""}déployer ${s.nom}${s.production ? " en PRODUCTION" : ""} (SHA vérifié ${court(d.vert.sha)})`;
    const v = await validation(ctx, integre ? "FUSION_ET_DEPLOIEMENT" : "DEPLOIEMENT_PRODUCTION", texte, etat);
    if (v !== "ACCORDEE") return v;
  }
  // LA FUSION (validée), puis la REVÉRIFICATION ENSEMBLE : les checks du SHA d'intégration EXACT, qui porte peut-être
  // d'autres chantiers fusionnés entre-temps. L'absence de conflit Git n'est pas l'absence de conflit fonctionnel.
  if (integre && !etat.shaIntegre) {
    if (!d.pr) return echoue("aucune PR à fusionner");
    if (!etat.fusionManuelle) {
      const f = await sousRecu(ctx, "fusion", () => ctx.ports.forge.fusionnerPr(p.depot, d.pr!.numero));
      if (f.etat === "INTERROMPU") return echoue("fusion interrompue par un redémarrage : vérifiez la PR avant de relancer");
      if (f.etat === "ECHEC" && !f.r.definitif) return apresEchecPort(ctx, "Fusion de la PR", f.r, etat);
      if (f.etat === "FAIT") {
        etat = { ...etat, shaIntegre: f.valeur.sha };
        await ctx.journal("CHANTIER_FUSION", `PR #${d.pr.numero} fusionnée sur ${s.branche} : ${court(f.valeur.sha)}.`, { sha: f.valeur.sha });
      } else {
        // LA FORGE NE FUSIONNE PAS (connecteur sans ce geste, ou refus) : la Direction fusionne à la main, le chantier l'attend.
        await ctx.journal("CHANTIER_FUSION", `Fusion par la forge impossible (${f.r.erreur}) : fusionnez la PR #${d.pr.numero} sur ${s.branche}, le chantier reprend seul.`, {});
        etat = { ...etat, fusionManuelle: true };
      }
    }
    if (etat.fusionManuelle) {
      const lu = await ctx.ports.forge.pr(p.depot, p.branche);
      if (!lu.ok) return apresEchecPort(ctx, "Lecture de la PR", lu, etat);
      if (lu.valeur?.etat !== "fusionnee") return sonder(ctx, `attend la fusion de la PR #${d.pr.numero} sur ${s.branche}`, etat);
      const t = await ctx.ports.forge.branche(p.depot, s.branche!);
      if (!t.ok) return apresEchecPort(ctx, `Lecture de ${s.branche}`, t, etat);
      if (!t.valeur.sha) return echoue(`${s.branche} introuvable après la fusion`);
      etat = { ...etat, shaIntegre: t.valeur.sha };
    }
  }
  const sha = (etat.shaIntegre as string | undefined) ?? d.vert.sha;
  if (integre && !etat.integrationVerte) {
    const c = await ctx.ports.forge.checks(p.depot, sha);
    if (!c.ok) return apresEchecPort(ctx, "Checks de l'intégration", c, etat);
    if (c.valeur.statut === "en_cours" || c.valeur.statut === "aucun") return sonder(ctx, `revérification de ${s.branche} sur ${court(sha)}`, etat);
    if (c.valeur.statut === "rouge") {
      await ctx.ecrire((x) => { x.blocage = `l'intégration ${s.branche} est rouge sur ${court(sha)} (conflit fonctionnel probable)`; x.vert = null; });
      return echoue(`intégration rouge sur ${court(sha)} : rien n'est déployé`);
    }
    d = await ctx.ecrire((x) => { x.vert = { sha, le: ctx.clock.now().toISOString() }; x.shaVu = sha; });
    etat = { ...etat, integrationVerte: true };
  }
  // LE SERVICE EST EXCLUSIF, et l'app attend une migration en vol (ERP d'abord).
  if (!etat.deployId) {
    const autre = await prisma.chantierReservation.findFirst({
      where: { missionId: { not: ctx.chantierId }, OR: [{ cle: `DEPLOIEMENT:${s.id}` }, ...(s.role !== "erp" ? [{ cle: `MIGRATIONS:${nomDepot(p.depot)}` }] : [])], expireLe: { gt: ctx.clock.now() } },
      select: { cle: true, mission: { select: { title: true } } },
    });
    if (autre) return sonder(ctx, `en file : ${autre.cle} est tenu par « ${autre.mission.title} »`, etat);
    const res = await reserver(ctx.chantierId, [{ ressource: "DEPLOIEMENT", valeur: s.id }], ctx.clock.now());
    if (!res.ok) return sonder(ctx, `en file : ${res.conflit.motif}`, etat);
    const motif = motifBudgetChantier(await ctx.conso(), ctx.reglages, ctx.plafondUsd, "deploiement");
    const recuFait = await prisma.travailEcriture.findUnique({ where: { cle: `${ctx.chantierId}|${ctx.step.key}|deploiement` }, select: { statut: true } });
    if (motif && recuFait?.statut !== "FAIT") { ctx.plafond(motif); return attendre(ctx, `plafond : ${motif}`, 3600_000, etat); }
    const r = await sousRecu(ctx, "deploiement", () => ctx.ports.hebergeur.deployer(s.id, sha));
    if (r.etat === "ECHEC") return apresEchecPort(ctx, `Déploiement de ${s.nom}`, r.r, etat);
    if (r.etat === "INTERROMPU") {
      // Le dernier déploiement du service dit si l'ordre est parti : on le retrouve plutôt que d'en lancer un second.
      const l = await ctx.ports.hebergeur.deploiements(s.id, 3);
      const trouve = l.ok ? l.valeur.find((x) => x.commit === sha) : undefined;
      if (!trouve) return echoue(`déploiement de ${s.nom} interrompu par un redémarrage, introuvable chez Render : vérifiez avant de relancer`);
      etat = { ...etat, deployId: trouve.id };
    } else {
      etat = { ...etat, deployId: r.valeur.id };
      await ctx.ecrire((x) => { x.compteurs.deploiements += 1; });
      await ctx.journal("CHANTIER_DEPLOIEMENT", `Déploiement de ${s.nom} lancé sur ${court(sha)} (${r.valeur.id}).`, { service: s.id, deployId: r.valeur.id, sha });
    }
  }
  const suivi = await ctx.ports.hebergeur.deploiement(s.id, String(etat.deployId));
  if (!suivi.ok) return apresEchecPort(ctx, `Suivi du déploiement de ${s.nom}`, suivi, etat);
  const statut = suivi.valeur.statut;
  const preuve: PreuveDeploiement = { service: s.id, nom: s.nom, deployId: String(etat.deployId), commit: suivi.valeur.commit ?? sha, statut, le: suivi.valeur.le };
  if (statut === "live") {
    await ctx.ecrire((x) => { x.deploiements = [...x.deploiements.filter((y) => y.deployId !== preuve.deployId), preuve]; });
    return { status: "DONE", result: { live: true, deployId: preuve.deployId, sha: preuve.commit }, receipt: "CHANTIER_DEPLOYE" };
  }
  if (/fail|cancel|deactivated/.test(statut)) {
    await ctx.ecrire((x) => { x.deploiements = [...x.deploiements.filter((y) => y.deployId !== preuve.deployId), preuve]; x.blocage = `le déploiement de ${s.nom} a fini « ${statut} »`; });
    await liberer(ctx.chantierId, "DEPLOIEMENT");
    await memoriser("incident", `${nomDepot(p.depot)}:deploiement:${s.id}`, `Déploiement ${preuve.deployId} de ${s.nom} sur ${court(sha)} : ${statut}.`, { source: "chantier", missionId: ctx.chantierId });
    return echoue(`déploiement de ${s.nom} : ${statut}`);
  }
  return sonder(ctx, `déploiement de ${s.nom} : ${statut}`, etat);
}

/** Erreurs de journal au-delà desquelles un service fraîchement déployé est jugé malsain. */
export const ERREURS_LOGS_MAX = 3;

async function renderVerifier(ctx: ContexteEtape): Promise<StepOutcome> {
  const etat = etatDe(ctx.step);
  const d = await ctx.dossier();
  const s = serviceDe(d, ctx.step.input.service);
  const dep = [...d.deploiements].reverse().find((x) => x.service === s?.id);
  if (!s || !dep || dep.statut !== "live") return { status: "SKIPPED", raison: "aucun déploiement live à vérifier" };
  let url = s.url ?? null;
  let chemin = s.healthCheckPath ?? null;
  if (!url || !chemin) {
    const l = await ctx.ports.hebergeur.services();
    const info = l.ok ? l.valeur.find((x) => x.id === s.id) : undefined;
    url = url ?? info?.url ?? null;
    chemin = chemin ?? info?.healthCheckPath ?? "/";
    if (info) await noterEvenementDev({ type: "service", cle: s.id, contenu: `${info.nom} (${info.type}) — ${info.url ?? "sans URL"}, santé ${info.healthCheckPath ?? "/"}, branche ${info.branche ?? "?"}, autoDeploy ${info.autoDeploy ? "oui" : "non"}`, source: "render", missionId: ctx.chantierId });
  }
  if (!url) return echoue(`${s.nom} : aucune URL pour la santé`);
  const h = await ctx.ports.hebergeur.sante(url, chemin ?? "/");
  const essais = num(etat.essais) + 1;
  const ok = h.ok && h.valeur.statut >= 200 && h.valeur.statut < 400;
  if (!ok && essais < ctx.reglages.tentativesMax) return attendre(ctx, `santé de ${s.nom} : ${h.ok ? `HTTP ${h.valeur.statut}` : h.erreur} — nouvel essai`, delaiCroissantMs(essais, 30_000), { ...etat, essais });
  const logs = await ctx.ports.hebergeur.logs(s.id, dep.le, { niveau: "error", limite: 20 });
  const erreurs = logs.ok ? logs.valeur.length : 0;
  const sain = ok && erreurs < ERREURS_LOGS_MAX;
  const sante = h.ok ? { statut: h.valeur.statut, ms: h.valeur.ms, le: ctx.clock.now().toISOString() } : null;
  await ctx.ecrire((x) => { x.deploiements = x.deploiements.map((y) => (y.deployId === dep.deployId ? { ...y, sante, sain } : y)); });
  if (sain) await liberer(ctx.chantierId, "DEPLOIEMENT");
  await ctx.journal(sain ? "CHANTIER_SAIN" : "CHANTIER_MALSAIN", `${s.nom} : ${sante ? `HTTP ${sante.statut} en ${sante.ms} ms` : "injoignable"}, ${erreurs} erreur(s) au journal.`, { service: s.id, sain, erreurs });
  return { status: "DONE", result: { sain, statut: sante?.statut ?? null, erreurs }, receipt: "CHANTIER_SANTE" };
}

async function renderRollback(ctx: ContexteEtape): Promise<StepOutcome> {
  let etat = etatDe(ctx.step);
  const d = await ctx.dossier();
  const s = serviceDe(d, ctx.step.input.service);
  const dep = [...d.deploiements].reverse().find((x) => x.service === s?.id);
  if (!s || !dep) return { status: "SKIPPED", raison: "aucun déploiement à annuler" };
  if (s.production) {
    const v = await validation(ctx, "ROLLBACK_PRODUCTION", `rollback de ${s.nom} (production) : le déploiement ${dep.deployId} est malsain`, etat);
    if (v !== "ACCORDEE") return v;
  }
  if (!etat.cible) {
    const l = await ctx.ports.hebergeur.deploiements(s.id, 10);
    if (!l.ok) return apresEchecPort(ctx, "Liste des déploiements", l, etat);
    const cible = l.valeur.find((x) => x.id !== dep.deployId && x.commit !== dep.commit && /live|deactivated/.test(x.statut));
    if (!cible) return echoue(`${s.nom} : aucun déploiement sain antérieur vers lequel revenir`);
    etat = { ...etat, cible: cible.id };
  }
  const r = await sousRecu(ctx, "rollback", () => ctx.ports.hebergeur.rollback(s.id, String(etat.cible)));
  if (r.etat === "ECHEC") return apresEchecPort(ctx, `Rollback de ${s.nom}`, r.r, etat);
  if (r.etat === "INTERROMPU") return echoue(`rollback de ${s.nom} interrompu par un redémarrage : vérifiez l'état chez Render`);
  const suivi = await ctx.ports.hebergeur.deploiement(s.id, r.valeur.id);
  if (!suivi.ok) return apresEchecPort(ctx, "Suivi du rollback", suivi, etat);
  if (suivi.valeur.statut !== "live") return sonder(ctx, `rollback de ${s.nom} : ${suivi.valeur.statut}`, etat);
  // L'AUTODEPLOY EST COUPÉ jusqu'au correctif — sinon le prochain push redéploierait le défaut. C'est dit.
  const auto = await ctx.ports.hebergeur.autoDeploy(s.id, false);
  await ctx.ecrire((x) => {
    x.deploiements = x.deploiements.map((y) => (y.deployId === dep.deployId ? { ...y, rollback: { deployId: r.valeur.id, statut: "live", le: suivi.valeur.le } } : y));
    x.blocage = `${s.nom} malsain après déploiement : rollback vers ${String(etat.cible)} fait${auto.ok ? ", autoDeploy coupé jusqu'au correctif" : ""}`;
  });
  await liberer(ctx.chantierId, "DEPLOIEMENT");
  await memoriser("incident", `${nomDepot(d.plan.depot)}:rollback:${s.id}`, `Rollback de ${s.nom} : ${dep.deployId} (${court(dep.commit)}) malsain → ${String(etat.cible)}. autoDeploy ${auto.ok ? "coupé" : "inchangé"}.`, { source: "chantier", missionId: ctx.chantierId });
  await ctx.journal("CHANTIER_ROLLBACK", `Rollback de ${s.nom} fait (${r.valeur.id})${auto.ok ? " ; autoDeploy coupé" : ""}.`, { service: s.id, deployId: r.valeur.id });
  return { status: "DONE", result: { rollback: r.valeur.id, autoDeployCoupe: auto.ok }, receipt: "CHANTIER_ROLLBACK" };
}

// ─────────────────────────────── RAPPORT ───────────────────────────────

/** LE RAPPORT — composé par le code depuis le dossier ; la mémoire technique apprend ce que le chantier a établi. */
export async function rapporter(ctx: Pick<ContexteEtape, "chantierId" | "clock" | "dossier" | "ecrire" | "journal">, coutUsd: number, issueForcee?: "ANNULE"): Promise<{ issue: string; texte: string }> {
  const d = await ctx.dossier();
  const verdict = jugerPreuves(d, coutUsd);
  const issue = issueForcee ?? (verdict.satisfait ? "LIVRE" : d.vert || d.deploiements.length ? "PARTIEL" : "BLOQUE");
  const texte = `${composerRapport(d, coutUsd, issue)}\n${verdict.raison}`;
  await ctx.ecrire((x) => { x.rapport = { le: ctx.clock.now().toISOString(), texte, issue }; });
  const depot = nomDepot(d.plan.depot);
  await memoriser("branche", `${depot}:${d.plan.branche}`, `Chantier « ${d.plan.titre} » (${issue}) — ${d.vert ? `vert sur ${d.vert.sha}` : "jamais vert"}${d.pr ? `, PR #${d.pr.numero}` : ""}.`, { source: "chantier", missionId: ctx.chantierId });
  if (d.plan.commandesVerif.length) {
    await memoriser("depot", depot, `Branche de base ${d.plan.brancheBase}. Commandes de vérification : ${d.plan.commandesVerif.join(" ; ")}.`, { source: "chantier", missionId: ctx.chantierId });
  }
  await liberer(ctx.chantierId);
  await ctx.journal("CHANTIER_RAPPORT", `Rapport : ${issue}.`, { issue, manquantes: verdict.manquantes });
  return { issue, texte };
}

export async function executerEtape(type: TypeEtapeChantier, ctx: ContexteEtape, coutUsd: () => Promise<number>): Promise<StepOutcome> {
  switch (type) {
    case "DEV_LANCER": return devLancer(ctx);
    case "DEV_ATTENDRE": return devAttendre(ctx);
    case "DEV_VERIFIER": return devVerifier(ctx);
    case "DEV_CORRIGER": return devCorriger(ctx);
    case "RENDER_DEPLOYER": return renderDeployer(ctx);
    case "RENDER_VERIFIER": return renderVerifier(ctx);
    case "RENDER_ROLLBACK": return renderRollback(ctx);
    case "RAPPORT": {
      const r = await rapporter(ctx, await coutUsd());
      return { status: "DONE", result: r, receipt: "CHANTIER_RAPPORT" };
    }
  }
}
