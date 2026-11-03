import { prisma } from "@/lib/prisma";
import type { Clock } from "@/lib/missions/ports";
import type { StepOutcome } from "@/lib/missions/runtime/engine";
import type { EtatEtape, EtatMission } from "@/lib/missions/runtime/store";
import { cloreEcriture, reclamerEcriture } from "@/lib/missions/travaux/ecritures";
import type { AgentDeveloppeur, ConsigneDev, ForgeGit, Hebergeur, Resultat } from "@/lib/missions/chantiers/ports-moteur";
import type { ServiceChantier, TypeEtapeChantier } from "@/lib/missions/chantiers/plan";
import { court, jugerPreuves, composerRapport, sessionParlable, type DossierChantier, type PreuveDeploiement } from "@/lib/missions/chantiers/dossier";
import { deciderAntiBoucle, delaiCroissantMs, estMigrationSql, gesteDestructif, motifBudgetChantier, signatureEchec, type ConsommationChantier, type ReglagesChantiers } from "@/lib/missions/chantiers/regles";
import { horsPerimetre } from "@/lib/missions/chantiers/perimetre";
import { ressourcesDeTache, ressourcesHorsReservation } from "@/lib/missions/equipe/ressources";
import type { ForgeIntegration } from "@/lib/missions/equipe/integration";
import { routerModele } from "@/lib/missions/chantiers/routeur";
import type { CerveauChantier } from "@/lib/missions/chantiers/cerveau";
import { demandesDuPlan, liberer, nomDepot, reservationTenue, reserver, transfererAuProgramme } from "@/lib/missions/chantiers/reservations";
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

/** `integration` (O2, décision 0059) : les gestes de branche de la file d'intégration des programmes, quand la forge les porte. */
export interface PortsDev { agent: AgentDeveloppeur; forge: ForgeGit; hebergeur: Hebergeur; integration?: ForgeIntegration }

/** Le dépôt du rapport au Drive (dossier « Travaux » de la personne) — `reprise` : un dépôt interrompu, à RETROUVER d'abord. */
export type DeposerRapport = (principalId: string, d: { chantierId: string; cle: string; titre: string; contenu: string; reprise: boolean }) =>
  Promise<{ ok: true; document: { nodeId: string; nom: string; lien: string } } | { ok: false; erreur: string }>;

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
  deposerRapport?: DeposerRapport;
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
  /** La Direction est PRÉVENUE (notification + carte de la conversation), une fois par clé ; le chantier continue. */
  prevenir(cle: string, titre: string, corps: string): Promise<void>;
  /** Adam ne sait plus avancer seul : pause « attend tes consignes » à la fin de la vague, branche gardée, Direction prévenue. */
  demanderConsignes(raison: string, detail: string): Promise<void>;
}

type Etat = Record<string, unknown>;
const etatDe = (step: EtatEtape): Etat => (step.result && typeof step.result === "object" && !Array.isArray(step.result) ? { ...(step.result as Etat) } : {});
const num = (v: unknown, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : d);

/** Le délai d'attente d'un sondage : 1 min, 2, 4… jusqu'à 10 min. */
const SONDAGE_MAX_MS = 10 * 60_000;
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
    // peut tourner) ; l'attente bornée (24 h par défaut, puis les consignes de la Direction) borne le cas où elle n'est jamais partie.
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

/** Une session que le relais dit archivée ou introuvable est MORTE (doc d'Anthropic : « Session not found », « archived »). */
const SESSION_MORTE = /archived|not found|introuvable|archiv/i;

/**
 * UN COMMIT NEUF SUR LA BRANCHE (SHA ≠ `base`) — partagée par DEV_ATTENDRE et DEV_CORRIGER. Direction, 02/11 : « l'ERP est
 * très gros, ça prend parfois 7, 8… 14 heures : mets plutôt 24 heures ; il doit être autonome ».
 *   • toutes les `relanceSansCommitHeures` (4 h) sans commit : « où en es-tu ? » à la MÊME session (relais, sinon fil de
 *     la PR) — JAMAIS une session neuve pour une question (elle doublerait une session qui travaille) ;
 *   • la session est MORTE (le relais répond « archivée » / « introuvable ») : relance, dans le budget ;
 *   • à `attenteCommitHeures` (24 h) : pas d'échec sec — pause « attend tes consignes », la branche reste réservée ;
 *   • une consigne de la Direction relance l'horloge (nouvelle approche).
 */
async function commitNeuf(ctx: ContexteEtape, base: string | null, etat: Etat): Promise<{ sha: string } | StepOutcome> {
  const d = await ctx.dossier();
  const maintenant = ctx.clock.now();
  let e: Etat = etat;
  if (d.consignes.length > num(e.consignesVues)) {
    e = { ...e, consignesVues: d.consignes.length, attenteDepuis: maintenant.toISOString(), points: 0, pointOrdre: null, consignesDemandees: false };
  }
  const debut = typeof e.attenteDepuis === "string" ? e.attenteDepuis : maintenant.toISOString();
  e = { ...e, attenteDepuis: debut };
  const r = await ctx.ports.forge.branche(d.plan.depot, d.plan.branche);
  if (!r.ok) return apresEchecPort(ctx, "Lecture de la branche", r, e);
  const sha = r.valeur.existe ? r.valeur.sha : null;
  if (sha && sha !== base) return { sha };
  const ecoule = maintenant.getTime() - new Date(debut).getTime();
  const heures = ctx.reglages.attenteCommitHeures;
  if (ecoule >= heures * 3600_000) {
    const raison = `aucun commit poussé sur ${d.plan.branche} en ${heures} h`;
    if (!e.consignesDemandees) {
      await ctx.demanderConsignes(raison, `La session a été interrogée ${num(e.points)} fois sans pousser. La branche reste réservée. Dites-moi quoi faire : attendre encore, relancer une session, changer d'approche (« dis-lui de … »), ou arrêter.`);
    }
    return attendre(ctx, `attend tes consignes : ${raison}`, 3600_000, { ...e, consignesDemandees: true });
  }
  const tick = Math.floor(ecoule / (ctx.reglages.relanceSansCommitHeures * 3600_000));
  if (tick > num(e.points)) e = await faireLePoint(ctx, d, tick, Math.round(ecoule / 3600_000), e);
  return sonder(ctx, `attend un commit sur ${d.plan.branche} (depuis ${Math.floor(ecoule / 3600_000)} h, au plus ${heures} h)`, e);
}

/** Le point d'étape d'une longue attente : relance d'une session morte (dans le budget), sinon « où en es-tu ? ». */
async function faireLePoint(ctx: ContexteEtape, d: DossierChantier, tick: number, heures: number, e: Etat): Promise<Etat> {
  const p = d.plan;
  const consigne = await consigneDev(ctx, d);
  const cle = `${ctx.chantierId}|${ctx.step.key}|point-${num(e.consignesVues)}-${tick}`;
  // L'issue du point précédent : un relais qui répond « archivée / introuvable » dit que la session est MORTE.
  const prec = typeof e.pointOrdre === "string" && ctx.ports.agent.ordre ? await ctx.ports.agent.ordre(e.pointOrdre) : null;
  const morte = !!prec && prec.ok && prec.valeur.statut === "ECHEC" && SESSION_MORTE.test(prec.valeur.erreur ?? "");
  if (morte) {
    const motif = motifBudgetChantier(await ctx.conso(), ctx.reglages, ctx.plafondUsd, "lancement");
    if (motif) { ctx.plafond(motif); return { ...e, points: tick }; }
    const r = await sousRecu(ctx, `point-${num(e.consignesVues)}-${tick}`, () => ctx.ports.agent.lancer({ ...consigne, contexte: [consigne.contexte, `## Reprise\nLa session précédente est terminée sans avoir poussé depuis ${heures} h (${prec!.ok ? prec!.valeur.erreur : ""}). Reprends la branche ${p.branche} là où elle en est, et pousse dès qu'une étape est vérifiée.`].filter(Boolean).join("\n\n") }, cle));
    if (r.etat === "FAIT") {
      await ctx.ecrire((x) => { x.sessions.push({ sessionId: r.valeur.sessionId, url: r.valeur.url, le: r.valeur.lanceeLe, moyen: r.valeur.moyen, motif: "reprise" }); x.compteurs.lancements += 1; });
      await ctx.journal("CHANTIER_REPRISE", `Session morte (${prec!.ok ? prec!.valeur.erreur : "?"}) : nouvelle session sur ${p.branche} après ${heures} h sans commit : ${r.valeur.url}`, { heures });
    }
    return { ...e, points: tick, pointOrdre: null };
  }
  const session = sessionParlable(d);
  const texte = `Point d'étape d'Adventum : aucun commit sur ${p.branche} depuis ${heures} h. Où en es-tu ? Si tu avances, pousse un commit intermédiaire dès qu'une étape passe les vérifications ; si tu es bloqué, dis-le dans la PR (ce qui bloque, ce que tu as essayé).`;
  const r = await sousRecu(ctx, `point-${num(e.consignesVues)}-${tick}`, () => ctx.ports.agent.relancer({ ...consigne, probleme: texte, sansNouvelleSession: true, ...(d.pr ? { pr: d.pr.numero } : {}), ...(session ? { session } : {}) }, cle));
  if (r.etat === "FAIT") {
    await ctx.journal("CHANTIER_POINT", `Aucun commit depuis ${heures} h : « où en es-tu ? » envoyé (${r.valeur.moyen}).`, { heures, moyen: r.valeur.moyen });
    return { ...e, points: tick, pointOrdre: r.valeur.ordreId ?? null };
  }
  if (!e.injoignableDit) await ctx.journal("CHANTIER_POINT", `Aucun commit depuis ${heures} h ; la session ne peut pas être jointe (routine sans PR) : Adam attend, sans en ouvrir une seconde.`, { heures });
  return { ...e, points: tick, injoignableDit: true };
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
  // O2 (décision 0059 § 5) : une ressource partagée NOMMÉE touchée sans réservation — rouge (le programme replanifie).
  const nonReservees = p.ressources ? ressourcesHorsReservation(b.valeur.fichiers, ressourcesDeTache({ perimetre: [], ressources: p.ressources })) : [];
  if (nonReservees.length) return rouge("ressources", `ressources partagées touchées sans réservation : ${nonReservees.join(", ")}`);
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
  // UNE CONSIGNE DE LA DIRECTION (`consigne_chantier`) a été transmise à la session : nouvelle approche — les tours
  // repartent de zéro, et l'on attend le commit qu'elle produit (la consigne EST la relance : rien n'est relancé en plus).
  const lu = await ctx.dossier();
  if (lu.consignes.length > num(etat.consignesVues)) {
    const echec0 = etat.echec as { sha: string | null } | undefined;
    etat = { ...etat, consignesVues: lu.consignes.length, phase: "ATTENDRE", tour: 0, base: echec0?.sha ?? lu.shaVu, attenteDepuis: ctx.clock.now().toISOString(), sondages: 0, graceFaite: false, consignesDemandees: false, points: 0, alerteFaite: false, signatureNotee: false };
  }
  for (let garde = 0; garde < 5; garde++) {
    const echec = etat.echec as { sha: string | null; signature: string; check: string | null; extrait: string };
    // L'AUTO-FIX D'ABORD : une fois par tour, on laisse à la session le temps de corriger SA PR elle-même (gratuit).
    if (etat.phase === "DECIDER" && !etat.graceFaite && ctx.reglages.autofixMinutes > 0) {
      etat = { ...etat, phase: "AUTOFIX", graceFaite: true, base: echec.sha, graceDepuis: ctx.clock.now().toISOString(), sondages: 0 };
    }
    if (etat.phase === "AUTOFIX") {
      const d = await ctx.dossier();
      const t = await ctx.ports.forge.branche(d.plan.depot, d.plan.branche);
      if (!t.ok) return apresEchecPort(ctx, "Lecture de la branche", t, etat);
      if (t.valeur.sha && t.valeur.sha !== etat.base) {
        await ctx.journal("CHANTIER_AUTOFIX", `Un commit est arrivé sans relance (${court(t.valeur.sha)}) : correction native de la session, vérifiée.`, { sha: t.valeur.sha });
        etat = { ...etat, phase: "CONTROLER", sondages: 0, sansCheck: 0 };
      } else if (ctx.clock.now().getTime() - new Date(String(etat.graceDepuis)).getTime() >= ctx.reglages.autofixMinutes * 60_000) {
        etat = { ...etat, phase: "DECIDER" };
      } else {
        return attendre(ctx, `laisse ${ctx.reglages.autofixMinutes} min à l'Auto-fix de la session avant de relancer`, Math.min(5 * 60_000, ctx.reglages.autofixMinutes * 60_000), etat);
      }
    }
    if (etat.phase === "DECIDER") {
      const d = await ctx.dossier();
      const decision = deciderAntiBoucle({ historique: d.signatures, nouvelle: echec.signature, tours: num(etat.tour), correctionsMax: ctx.reglages.correctionsMax, alerteApresEchecs: ctx.reglages.alerteApresEchecs, solDejaPour: d.solPour });
      if (!etat.signatureNotee) await ctx.ecrire((x) => { x.signatures.push(echec.signature); });
      etat = { ...etat, signatureNotee: true };
      const panne = `${echec.check ?? "ci"} sur ${court(echec.sha)} : ${(echec.extrait.split("\n").map((l) => l.trim()).find(Boolean) ?? "").slice(0, 200)}`;
      if (decision.action === "CONSIGNES") {
        // JAMAIS UN ÉCHEC SEC : Adam s'arrête, garde la branche, dit ce qu'il sait, et attend les consignes de la Direction.
        if (!etat.consignesDemandees) {
          await memoriser("incident", `${nomDepot(d.plan.depot)}:${echec.signature}`.slice(0, 200), `Chantier « ${d.plan.titre} » en attente de consignes : ${decision.raison}.\nDernier extrait :\n${echec.extrait.slice(0, 1_500)}`, { source: "chantier", missionId: ctx.chantierId });
          await ctx.demanderConsignes(decision.raison, `Ce qui casse : ${panne}. Essayé : ${num(etat.tour)} correction(s)${d.solPour.length ? ", dont une analyse de Sol" : ""}. Dites-moi quoi faire (« dis-lui de … », « change d'approche, fais … »), ou arrêtez.`);
        }
        return attendre(ctx, `attend tes consignes : ${decision.raison}`, 3600_000, { ...etat, consignesDemandees: true });
      }
      if (decision.alerte && !etat.alerteFaite) {
        // AU 3ᵉ ROUGE (réglable) : la Direction est PRÉVENUE — sans arrêt. Ce qui casse, ce qui a été essayé, ce qui suit.
        await ctx.prevenir(`alerte:${ctx.step.key}:${num(etat.consignesVues)}`, `Chantier : ${num(etat.tour) + 1}ᵉ échec — « ${d.plan.titre} »`,
          `Ce qui casse : ${panne}. Essayé : ${num(etat.tour)} correction(s)${d.solPour.length ? " (dont Sol)" : ""}. Je continue : ${decision.action === "ESCALADER_SOL" ? "analyse de Sol puis nouvelle correction" : "nouvelle correction"}, jusqu'à ${ctx.reglages.correctionsMax} tentatives. Vous pouvez me donner une consigne à tout moment.`);
        etat = { ...etat, alerteFaite: true };
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
      // LA MÊME SESSION d'abord (relais CLI, contexte gardé), sinon le fil de la PR, sinon une session neuve — l'adaptateur choisit.
      const session = sessionParlable(d);
      const r = await sousRecu(ctx, `tour-${tour}`, () => ctx.ports.agent.relancer({ ...consigne, probleme: texte, ...(d.pr ? { pr: d.pr.numero } : {}), ...(session ? { session } : {}) }, cle));
      if (r.etat === "ECHEC" && !r.r.incertain) return apresEchecPort(ctx, "Relance de Claude Code", r.r, etat);
      if (r.etat === "FAIT") {
        const s = r.valeur;
        await ctx.ecrire((x) => {
          if (!x.sessions.some((y) => y.sessionId === s.sessionId)) x.sessions.push({ sessionId: s.sessionId, url: s.url, le: s.lanceeLe, moyen: s.moyen, motif: "correction" });
          x.compteurs.lancements += 1;
        });
        await ctx.journal("CHANTIER_LANCEMENT", `Correction demandée (tour ${tour}${sol ? ", analyse Sol" : ""}) : ${s.url}`, { tour, sol, signature: echec.signature });
      }
      etat = { ...etat, phase: "ATTENDRE", tour, base: echec.sha, attenteDepuis: ctx.clock.now().toISOString(), sondages: 0, graceFaite: false, signatureNotee: false, points: 0, pointOrdre: null };
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

// ─────────────────────────────── LES MIGRATIONS À RISQUE ───────────────────────────────

/**
 * LES MIGRATIONS DU DIFF, LUES AVANT DE FUSIONNER OU DE DÉPLOYER (`gestesCritiques` : « destructive refusée sans
 * validation »). Chaque fichier SQL de migration touché par la branche (par rapport à la base) est lu au SHA vérifié :
 * un geste destructeur (DROP, TRUNCATE, DELETE FROM, ALTER … DROP / TYPE) — ou un fichier ILLISIBLE, par prudence — est
 * un risque, dit sur la carte de validation. Le résultat est gardé dans l'état de l'étape (une seule lecture).
 */
async function migrationsARisque(ctx: ContexteEtape, sha: string, etat: Etat): Promise<{ risques: string[]; etat: Etat } | StepOutcome> {
  if (Array.isArray(etat.migrationsRisque)) return { risques: etat.migrationsRisque as string[], etat };
  const p = (await ctx.dossier()).plan;
  const b = await ctx.ports.forge.branche(p.depot, p.branche, p.brancheBase);
  if (!b.ok) return apresEchecPort(ctx, "Lecture des fichiers de la branche", b, etat);
  const risques: string[] = [];
  for (const f of b.valeur.fichiers.filter(estMigrationSql).slice(0, 20)) {
    const r = await ctx.ports.forge.fichier(p.depot, sha, f);
    const geste = r.ok ? gesteDestructif(r.valeur.octets.toString("utf8")) : null;
    if (!r.ok) risques.push(`${f} (illisible : ${r.erreur.slice(0, 120)})`);
    else if (geste) risques.push(`${f} (${geste})`);
  }
  if (risques.length) await ctx.journal("CHANTIER_MIGRATION_DESTRUCTIVE", `Migration à risque dans ${p.branche} : ${risques.join(" ; ")} — validation de la Direction exigée.`, { risques });
  return { risques, etat: { ...etat, migrationsRisque: risques } };
}

const avertissementMigrations = (risques: readonly string[]): string =>
  risques.length ? ` — ⚠ MIGRATION DESTRUCTIVE : ${risques.join(" ; ")} (votre accord vaut aussi pour elle)` : "";

// ─────────────────────────────── DEV_FUSIONNER ───────────────────────────────

/**
 * LA FUSION (décision de la Direction, 01/11 : « tu la fais une fois que j'approuve ») — PR verte (checks verts sur le SHA
 * de tête, fusionnable, périmètre respecté) → carte « Fusionner la PR #n (titre) dans <base> », écrite ou orale ;
 * accordée : fusion AU SHA VÉRIFIÉ (GitHub refuse si la tête a bougé), puis CI de la BASE sur le commit de fusion.
 * Compensation : une PR de revert proposée (`proposerRevertFusion`), jamais un force-push.
 */
async function devFusionner(ctx: ContexteEtape): Promise<StepOutcome> {
  let etat = etatDe(ctx.step);
  const d = await ctx.dossier();
  const p = d.plan;
  if (d.fusion) return { status: "DONE", result: { fusionne: true, sha: d.fusion.sha }, receipt: "CHANTIER_FUSION" };
  if (!d.vert) return { status: "SKIPPED", raison: "aucune preuve verte : rien n'est fusionné" };
  if (!etat.shaFusion) {
    const lu = await ctx.ports.forge.pr(p.depot, p.branche);
    if (!lu.ok) return apresEchecPort(ctx, "Lecture de la PR", lu, etat);
    if (!lu.valeur) return echoue(`aucune PR ouverte depuis ${p.branche} : rien à fusionner`);
    const pr = lu.valeur;
    if (pr.etat === "fermee") return echoue(`la PR #${pr.numero} est fermée sans fusion`);
    if (pr.etat === "fusionnee") {
      // Fusionnée à la main entre-temps : la base dit le commit, la CI de la base le vérifie quand même.
      const t = await ctx.ports.forge.branche(p.depot, p.brancheBase);
      if (!t.ok || !t.valeur.sha) return t.ok ? echoue(`${p.brancheBase} introuvable`) : apresEchecPort(ctx, `Lecture de ${p.brancheBase}`, t, etat);
      etat = { ...etat, shaFusion: t.valeur.sha, numero: pr.numero, manuelle: true };
    } else {
      if (pr.mergeable === false) return echoue(`la PR #${pr.numero} est en conflit avec ${p.brancheBase} : rien n'est fusionné`);
      if (d.shaVu && d.shaVu !== d.vert.sha) return echoue(`la tête de ${p.branche} (${court(d.shaVu)}) n'est plus celle vérifiée (${court(d.vert.sha)})`);
      // Une migration destructive dans le diff est DITE sur la carte : l'accord de la Direction la couvre en connaissance.
      const m = await migrationsARisque(ctx, d.vert.sha, etat);
      if ("status" in m) return m;
      etat = m.etat;
      const v = await validation(ctx, "FUSION", `Fusionner la PR #${pr.numero}${pr.titre ? ` (« ${pr.titre} »)` : ""} dans ${p.brancheBase} — SHA vérifié ${court(d.vert.sha)}${avertissementMigrations(m.risques)}`, etat);
      if (v !== "ACCORDEE") return v;
      const f = await sousRecu(ctx, "fusion", () => ctx.ports.forge.fusionnerPr(p.depot, pr.numero, d.vert!.sha));
      if (f.etat === "INTERROMPU") return echoue("fusion interrompue par un redémarrage : vérifiez la PR avant de relancer (elle n'est pas rejouée)");
      if (f.etat === "ECHEC") {
        if (!f.r.definitif) return apresEchecPort(ctx, "Fusion de la PR", f.r, etat);
        await ctx.ecrire((x) => { x.blocage = `fusion refusée : ${f.r.erreur}`; });
        return echoue(`fusion refusée : ${f.r.erreur}`);
      }
      etat = { ...etat, shaFusion: f.valeur.sha, numero: pr.numero };
      await ctx.journal("CHANTIER_FUSION", `PR #${pr.numero} fusionnée dans ${p.brancheBase} : ${court(f.valeur.sha)} (validée par la Direction).`, { sha: f.valeur.sha, pr: pr.numero });
    }
  }
  const sha = String(etat.shaFusion);
  const c = await ctx.ports.forge.checks(p.depot, sha);
  if (!c.ok) return apresEchecPort(ctx, `Checks de ${p.brancheBase}`, c, etat);
  if (c.valeur.statut === "en_cours") return sonder(ctx, `CI de ${p.brancheBase} en cours sur le commit de fusion ${court(sha)}`, etat);
  if (c.valeur.statut === "aucun") {
    if (num(etat.sansCheck) < 6) return attendre(ctx, `aucun check encore sur le commit de fusion ${court(sha)}`, 60_000, { ...etat, sansCheck: num(etat.sansCheck) + 1 });
    await ctx.ecrire((x) => { x.blocage = `aucun check CI sur le commit de fusion ${court(sha)} : la base n'est pas vérifiée`; });
    return echoue(`aucun check CI sur ${p.brancheBase} après la fusion`);
  }
  if (c.valeur.statut === "rouge") {
    await ctx.ecrire((x) => { x.blocage = `${p.brancheBase} est ROUGE sur le commit de fusion ${court(sha)} — compensable par une PR de revert (« annuler la fusion »)`; x.fusion = { sha, pr: Number(etat.numero), base: p.brancheBase, le: ctx.clock.now().toISOString() }; x.vert = null; });
    await memoriser("incident", `${nomDepot(p.depot)}:fusion:${p.branche}`.slice(0, 200), `Fusion de la PR #${String(etat.numero)} dans ${p.brancheBase} (${court(sha)}) : CI de la base ROUGE.`, { source: "chantier", missionId: ctx.chantierId });
    return echoue(`CI de ${p.brancheBase} rouge sur le commit de fusion ${court(sha)} : rien n'est déployé`);
  }
  await ctx.ecrire((x) => {
    x.fusion = { sha, pr: Number(etat.numero), base: p.brancheBase, le: ctx.clock.now().toISOString() };
    x.vert = { sha, le: ctx.clock.now().toISOString() };
    x.shaVu = sha;
  });
  return { status: "DONE", result: { fusionne: true, sha, manuelle: etat.manuelle === true }, receipt: "CHANTIER_FUSION" };
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
  // UN SERVICE QUI SUIT LA BASE ne se déploie qu'après la fusion VALIDÉE (DEV_FUSIONNER) — jamais d'une PR non fusionnée.
  if (integre && !(d.fusion && d.fusion.base === s.branche)) return { status: "SKIPPED", raison: `la PR n'est pas fusionnée dans ${s.branche} : rien n'est déployé` };
  // UN PLAN QUI FUSIONNE ne déploie rien tant que la fusion n'a pas abouti (refusée, en échec, CI de la base rouge).
  if (!d.fusion && p.etapes.some((e) => e.type === "DEV_FUSIONNER")) return { status: "SKIPPED", raison: "la fusion n'a pas abouti : rien n'est déployé" };
  // LA REVÉRIFICATION ENSEMBLE : si d'autres chantiers ont fusionné par-dessus depuis, c'est la TÊTE de la base qui part
  // — après ses propres checks. L'absence de conflit Git n'est pas l'absence de conflit fonctionnel.
  if (integre && !etat.shaIntegre) {
    const t = await ctx.ports.forge.branche(p.depot, s.branche!);
    if (!t.ok) return apresEchecPort(ctx, `Lecture de ${s.branche}`, t, etat);
    const tete = t.valeur.sha ?? d.fusion!.sha;
    if (tete !== d.fusion!.sha) {
      const c = await ctx.ports.forge.checks(p.depot, tete);
      if (!c.ok) return apresEchecPort(ctx, "Checks de l'intégration", c, etat);
      if (c.valeur.statut === "en_cours" || c.valeur.statut === "aucun") return sonder(ctx, `revérification de ${s.branche} sur ${court(tete)} (d'autres fusions depuis)`, etat);
      if (c.valeur.statut === "rouge") {
        await ctx.ecrire((x) => { x.blocage = `${s.branche} est rouge sur ${court(tete)} après d'autres fusions (conflit fonctionnel probable)`; });
        return echoue(`intégration rouge sur ${court(tete)} : rien n'est déployé`);
      }
      d = await ctx.ecrire((x) => { x.vert = { sha: tete, le: ctx.clock.now().toISOString() }; x.shaVu = tete; });
    }
    etat = { ...etat, shaIntegre: tete };
  }
  // UNE BRANCHE DÉPLOYÉE SANS FUSION applique ses migrations telles quelles : une migration destructive exige la carte,
  // même hors production (après une fusion, la carte de la fusion l'a déjà dite).
  let risques: string[] = [];
  if (!d.fusion && !etat.deployId) {
    const m = await migrationsARisque(ctx, (etat.shaIntegre as string | undefined) ?? d.vert!.sha, etat);
    if ("status" in m) return m;
    etat = m.etat;
    risques = m.risques;
  }
  if (s.production || risques.length) {
    const sha0 = (etat.shaIntegre as string | undefined) ?? d.vert!.sha;
    const v = await validation(ctx, s.production ? "DEPLOIEMENT_PRODUCTION" : "DEPLOIEMENT_MIGRATION",
      `déployer ${s.nom}${s.production ? " en PRODUCTION" : ""} (SHA vérifié ${court(sha0)})${avertissementMigrations(risques)}`, etat);
    if (v !== "ACCORDEE") return v;
  }
  const sha = (etat.shaIntegre as string | undefined) ?? d.vert!.sha;
  // LE SERVICE EST EXCLUSIF, et l'app attend une migration en vol (ERP d'abord).
  if (!etat.deployId) {
    const autre = await prisma.chantierReservation.findFirst({
      where: { missionId: { not: ctx.chantierId }, AND: [{ OR: [{ cle: `DEPLOIEMENT:${s.id}` }, ...(s.role !== "erp" ? [{ cle: `MIGRATIONS:${nomDepot(p.depot)}` }] : [])] }, reservationTenue(ctx.clock.now())] },
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
export async function rapporter(
  ctx: Pick<ContexteEtape, "chantierId" | "principalId" | "clock" | "dossier" | "ecrire" | "journal" | "deposerRapport">, coutUsd: number, issueForcee?: "ANNULE",
): Promise<{ issue: string; texte: string; document: { nodeId: string; nom: string; lien: string } | null }> {
  const d = await ctx.dossier();
  const verdict = jugerPreuves(d, coutUsd);
  const issue = issueForcee ?? (verdict.satisfait ? "LIVRE" : d.vert || d.deploiements.length ? "PARTIEL" : "BLOQUE");
  const texte = `${composerRapport(d, coutUsd, issue)}\n${verdict.raison}`;
  // LE RAPPORT EN VRAI DOCUMENT au Drive (« Travaux »), sous reçu : un redémarrage ne le dépose jamais deux fois.
  const document = ctx.deposerRapport ? await deposerLeRapport(ctx, d, texte) : null;
  await ctx.ecrire((x) => { x.rapport = { le: ctx.clock.now().toISOString(), texte, issue, document }; });
  if (document) await ajouterLivrable(ctx.chantierId, { etape: "rapport", titre: `Rapport — ${d.plan.titre}`, contenu: texte, at: ctx.clock.now().toISOString(), document });
  const depot = nomDepot(d.plan.depot);
  // Les sessions Claude Code restent nommées (id + URL) : on peut leur reparler plus tard, contexte gardé (relais CLI).
  const sessions = d.sessions.map((x) => `${x.sessionId} ${x.url}`.trim()).join(" ; ");
  await memoriser("branche", `${depot}:${d.plan.branche}`, `Chantier « ${d.plan.titre} » (${issue}) — ${d.vert ? `vert sur ${d.vert.sha}` : "jamais vert"}${d.pr ? `, PR #${d.pr.numero}` : ""}.${sessions ? ` Sessions Claude Code : ${sessions}.` : ""}`, { source: "chantier", missionId: ctx.chantierId });
  if (d.plan.commandesVerif.length) {
    await memoriser("depot", depot, `Branche de base ${d.plan.brancheBase}. Commandes de vérification : ${d.plan.commandesVerif.join(" ; ")}.`, { source: "chantier", missionId: ctx.chantierId });
  }
  // O2 (décision 0059) : livré, l'enfant d'un programme PASSE ses réservations au programme (tenues jusqu'à l'intégration).
  if (issue === "LIVRE") await transfererAuProgramme(ctx.chantierId, ctx.clock.now());
  await liberer(ctx.chantierId);
  await ctx.journal("CHANTIER_RAPPORT", `Rapport : ${issue}${document ? ` — ${document.nom} (${document.lien})` : ""}.`, { issue, manquantes: verdict.manquantes, ...(document ? { nodeId: document.nodeId } : {}) });
  return { issue, texte, document };
}

async function deposerLeRapport(ctx: Pick<ContexteEtape, "chantierId" | "principalId" | "deposerRapport">, d: DossierChantier, texte: string) {
  const cle = `${ctx.chantierId}|rapport|document`;
  const recu = await reclamerEcriture(cle, ctx.chantierId, "rapport", "chantier:rapport");
  if (recu.etat === "FAIT") return (recu.resultat as { document?: { nodeId: string; nom: string; lien: string } } | null)?.document ?? null;
  const r = await ctx.deposerRapport!(ctx.principalId, { chantierId: ctx.chantierId, cle, titre: `Rapport du chantier — ${d.plan.titre}`, contenu: texte, reprise: recu.etat === "INTERROMPU" })
    .catch((e: unknown) => ({ ok: false as const, erreur: e instanceof Error ? e.message : String(e) }));
  if (recu.etat !== "INTERROMPU" || r.ok) await cloreEcriture(cle, r.ok ? "FAIT" : "ECHEC", r.ok ? { document: r.document } : { erreur: r.erreur });
  return r.ok ? r.document : null;
}

/** Le rapport rejoint les LIVRABLES du carnet : le tableau « Missions » et la synthèse de la conversation (K3) le lisent. */
async function ajouterLivrable(chantierId: string, l: { etape: string; titre: string; contenu: string; at: string; document: { nodeId: string; nom: string; lien: string } }) {
  const m = await prisma.mission.findUnique({ where: { id: chantierId }, select: { carnet: true } });
  const carnet = m?.carnet && typeof m.carnet === "object" && !Array.isArray(m.carnet) ? (m.carnet as Record<string, unknown>) : {};
  const avant = Array.isArray(carnet.livrables) ? (carnet.livrables as { etape?: string }[]).filter((x) => x.etape !== l.etape) : [];
  await prisma.mission.update({ where: { id: chantierId }, data: { carnet: { ...carnet, livrables: [...avant, { ...l, document: { ...l.document, format: "docx" } }] } as never } });
}

export async function executerEtape(type: TypeEtapeChantier, ctx: ContexteEtape, coutUsd: () => Promise<number>): Promise<StepOutcome> {
  switch (type) {
    case "DEV_LANCER": return devLancer(ctx);
    case "DEV_ATTENDRE": return devAttendre(ctx);
    case "DEV_VERIFIER": return devVerifier(ctx);
    case "DEV_CORRIGER": return devCorriger(ctx);
    case "DEV_FUSIONNER": return devFusionner(ctx);
    case "RENDER_DEPLOYER": return renderDeployer(ctx);
    case "RENDER_VERIFIER": return renderVerifier(ctx);
    case "RENDER_ROLLBACK": return renderRollback(ctx);
    case "RAPPORT": {
      const r = await rapporter(ctx, await coutUsd());
      return { status: "DONE", result: r, receipt: "CHANTIER_RAPPORT" };
    }
  }
}
